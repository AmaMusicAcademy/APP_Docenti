const express  = require('express');
const crypto   = require('crypto');
const https    = require('https');
const { pool } = require('../db');
const { authenticateToken } = require('../Middleware/auth');

const router = express.Router();

// ── SwitchBot helpers (condivisi con clima.js) ────────────────────────────
const SWITCHBOT_TOKEN  = process.env.SWITCHBOT_TOKEN;
const SWITCHBOT_SECRET = process.env.SWITCHBOT_SECRET;
const SWITCHBOT_BASE   = 'api.switch-bot.com';

function buildHeaders() {
  const t     = Date.now().toString();
  const nonce = crypto.randomBytes(8).toString('hex');
  const sign  = crypto.createHmac('sha256', SWITCHBOT_SECRET)
    .update(SWITCHBOT_TOKEN + t + nonce)
    .digest('base64');
  return {
    'Authorization': SWITCHBOT_TOKEN,
    'sign': sign, 'nonce': nonce, 't': t,
    'Content-Type': 'application/json',
  };
}

function switchbotRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const headers = buildHeaders();
    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(
      { hostname: SWITCHBOT_BASE, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Risposta SwitchBot non valida')); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Invio comando a un singolo dispositivo ────────────────────────────────
async function comandaDispositivo(deviceId, tipo, comando) {
  let body;
  if (tipo === 'smart_switch') {
    // Relay Switch / Smart Switch: turnOn / turnOff
    body = { commandType: 'command', command: comando === 'on' ? 'turnOn' : 'turnOff', parameter: 'default' };
  } else if (tipo === 'ir_ac') {
    // Hub Mini con telecomando IR - Air Conditioner
    body = { commandType: 'command', command: comando === 'on' ? 'turnOn' : 'turnOff', parameter: 'default' };
  }
  const result = await switchbotRequest(`/v1.1/devices/${deviceId}/commands`, 'POST', body);
  const statusCode = result?.statusCode ?? result?.status ?? '?';
  console.log(`[AC] deviceId=${deviceId} tipo=${tipo} cmd=${comando} → ${statusCode}`);
  return result;
}

// ── Migrazione tabelle ────────────────────────────────────────────────────
async function migrazioniAc() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ac_dispositivi (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      device_id TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ir_ac',
      attivo BOOLEAN DEFAULT true,
      ordine INTEGER DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ac_stato (
      data DATE PRIMARY KEY,
      acceso BOOLEAN DEFAULT false,
      ora_accensione TIME,
      ora_spegnimento TIME,
      ultima_azione TEXT,
      aggiornato_il TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
migrazioniAc().catch(console.error);

// ── Logica principale: controlla orari e agisce ───────────────────────────
async function controllaAC() {
  const { rows: dispositivi } = await pool.query(
    `SELECT * FROM ac_dispositivi WHERE attivo = true ORDER BY ordine, id`
  );
  if (dispositivi.length === 0) return;

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  const oggi = now.toISOString().slice(0, 10);
  const oraStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:00`;

  // Lezioni di oggi (tutte, indipendentemente dall'aula)
  const { rows: lezioni } = await pool.query(`
    SELECT ora_inizio, ora_fine FROM lezioni
    WHERE data = $1 AND stato NOT IN ('annullata')
    ORDER BY ora_inizio
  `, [oggi]);

  if (lezioni.length === 0) {
    // Nessuna lezione oggi: spegni se accesi
    const { rows: stato } = await pool.query(
      `SELECT acceso FROM ac_stato WHERE data = $1`, [oggi]
    );
    if (stato[0]?.acceso) {
      await eseguiSpegnimento(dispositivi, oggi, '-- nessuna lezione');
    }
    return;
  }

  // Calcola finestra operativa
  const primaOra = lezioni[0].ora_inizio.slice(0, 5);
  const ultimaOra = lezioni[lezioni.length - 1].ora_fine.slice(0, 5);

  const onTime  = sottraiMinuti(primaOra, 30);
  const offTime = aggiungiMinuti(ultimaOra, 30);

  // Upsert programma giornaliero
  await pool.query(`
    INSERT INTO ac_stato (data, ora_accensione, ora_spegnimento)
    VALUES ($1, $2, $3)
    ON CONFLICT (data) DO UPDATE
      SET ora_accensione = EXCLUDED.ora_accensione,
          ora_spegnimento = EXCLUDED.ora_spegnimento
  `, [oggi, onTime, offTime]);

  const { rows: stato } = await pool.query(
    `SELECT acceso FROM ac_stato WHERE data = $1`, [oggi]
  );
  const acceso = stato[0]?.acceso ?? false;

  const deveEssereAcceso = oraStr >= onTime + ':00' && oraStr < offTime + ':00';

  if (deveEssereAcceso && !acceso) {
    await eseguiAccensione(dispositivi, oggi, onTime);
  } else if (!deveEssereAcceso && acceso) {
    await eseguiSpegnimento(dispositivi, oggi, offTime);
  }
}

async function eseguiAccensione(dispositivi, oggi, motivo) {
  console.log(`[AC] ACCENSIONE schedulata (on_time=${motivo})`);
  // Prima i Smart Switch, poi gli IR
  const ordinati = [
    ...dispositivi.filter(d => d.tipo === 'smart_switch'),
    ...dispositivi.filter(d => d.tipo === 'ir_ac'),
  ];
  for (const d of ordinati) {
    try { await comandaDispositivo(d.device_id, d.tipo, 'on'); }
    catch (e) { console.error(`[AC] errore accensione ${d.nome}:`, e.message); }
    await delay(1500); // pausa tra comandi
  }
  await pool.query(
    `UPDATE ac_stato SET acceso = true, ultima_azione = 'accensione', aggiornato_il = NOW() WHERE data = $1`,
    [oggi]
  );
}

async function eseguiSpegnimento(dispositivi, oggi, motivo) {
  console.log(`[AC] SPEGNIMENTO schedulato (off_time=${motivo})`);
  // Prima gli IR, poi i Smart Switch
  const ordinati = [
    ...dispositivi.filter(d => d.tipo === 'ir_ac'),
    ...dispositivi.filter(d => d.tipo === 'smart_switch'),
  ];
  for (const d of ordinati) {
    try { await comandaDispositivo(d.device_id, d.tipo, 'off'); }
    catch (e) { console.error(`[AC] errore spegnimento ${d.nome}:`, e.message); }
    await delay(1500);
  }
  await pool.query(
    `UPDATE ac_stato SET acceso = false, ultima_azione = 'spegnimento', aggiornato_il = NOW() WHERE data = $1`,
    [oggi]
  );
}

// ── Helpers orario ────────────────────────────────────────────────────────
function parseMinuti(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function toHHMM(minuti) {
  const h = Math.floor(minuti / 60) % 24;
  const m = minuti % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function sottraiMinuti(hhmm, mins) { return toHHMM(parseMinuti(hhmm) - mins); }
function aggiungiMinuti(hhmm, mins) { return toHHMM(parseMinuti(hhmm) + mins); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Route: GET /api/ac/stato ──────────────────────────────────────────────
router.get('/ac/stato', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const oggi = now.toISOString().slice(0, 10);

    const [statoRes, dispositiviRes, lezioniRes] = await Promise.all([
      pool.query(`SELECT * FROM ac_stato WHERE data = $1`, [oggi]),
      pool.query(`SELECT * FROM ac_dispositivi ORDER BY ordine, id`),
      pool.query(`
        SELECT MIN(ora_inizio) as prima, MAX(ora_fine) as ultima
        FROM lezioni WHERE data = $1 AND stato NOT IN ('annullata')
      `, [oggi]),
    ]);

    const lezione = lezioniRes.rows[0];
    const primaOra = lezione?.prima?.slice(0,5);
    const ultimaOra = lezione?.ultima?.slice(0,5);

    res.json({
      stato: statoRes.rows[0] || null,
      dispositivi: dispositiviRes.rows,
      oggi: {
        prima_lezione: primaOra || null,
        ultima_lezione: ultimaOra || null,
        on_time: primaOra ? sottraiMinuti(primaOra, 30) : null,
        off_time: ultimaOra ? aggiungiMinuti(ultimaOra, 30) : null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Route: POST /api/ac/accendi (manuale) ─────────────────────────────────
router.post('/ac/accendi', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const oggi = now.toISOString().slice(0, 10);
    const { rows: dispositivi } = await pool.query(`SELECT * FROM ac_dispositivi WHERE attivo = true ORDER BY ordine, id`);
    await eseguiAccensione(dispositivi, oggi, 'manuale');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Route: POST /api/ac/spegni (manuale) ─────────────────────────────────
router.post('/ac/spegni', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const oggi = now.toISOString().slice(0, 10);
    const { rows: dispositivi } = await pool.query(`SELECT * FROM ac_dispositivi WHERE attivo = true ORDER BY ordine, id`);
    await eseguiSpegnimento(dispositivi, oggi, 'manuale');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Route: GET/POST /api/ac/dispositivi (CRUD admin) ─────────────────────
router.get('/ac/dispositivi', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const { rows } = await pool.query(`SELECT * FROM ac_dispositivi ORDER BY ordine, id`);
  res.json(rows);
});

router.post('/ac/dispositivi', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const { nome, device_id, tipo, ordine } = req.body;
  if (!nome || !device_id || !tipo) return res.status(400).json({ error: 'nome, device_id e tipo obbligatori' });
  const { rows } = await pool.query(
    `INSERT INTO ac_dispositivi (nome, device_id, tipo, ordine) VALUES ($1, $2, $3, $4) RETURNING *`,
    [nome, device_id, tipo, ordine ?? 0]
  );
  res.json(rows[0]);
});

router.put('/ac/dispositivi/:id', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const { nome, device_id, tipo, attivo, ordine } = req.body;
  const { rows } = await pool.query(
    `UPDATE ac_dispositivi SET nome=$1, device_id=$2, tipo=$3, attivo=$4, ordine=$5 WHERE id=$6 RETURNING *`,
    [nome, device_id, tipo, attivo, ordine ?? 0, req.params.id]
  );
  res.json(rows[0]);
});

router.delete('/ac/dispositivi/:id', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  await pool.query(`DELETE FROM ac_dispositivi WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// ── Route: GET /api/ac/devices-switchbot (lista dispositivi SwitchBot) ───
router.get('/ac/devices-switchbot', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  try {
    const data = await switchbotRequest('/v1.1/devices');
    const devs = data?.body?.deviceList ?? [];
    const ir   = data?.body?.infraredRemoteList ?? [];
    res.json({ devices: devs, infrared: ir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, controllaAC };
