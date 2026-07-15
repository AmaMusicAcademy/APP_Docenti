const express  = require('express');
const crypto   = require('crypto');
const https    = require('https');
const { pool } = require('../db');
const { authenticateToken } = require('../Middleware/auth');

const router = express.Router();

const SWITCHBOT_TOKEN  = process.env.SWITCHBOT_TOKEN;
const SWITCHBOT_SECRET = process.env.SWITCHBOT_SECRET;
const SWITCHBOT_BASE   = 'api.switch-bot.com';

// ── Autenticazione SwitchBot v1.1 ─────────────────────────────────────────
function buildHeaders() {
  const t     = Date.now().toString();
  const nonce = crypto.randomBytes(8).toString('hex');
  const sign  = crypto.createHmac('sha256', SWITCHBOT_SECRET)
    .update(SWITCHBOT_TOKEN + t + nonce)
    .digest('base64');
  return {
    'Authorization': SWITCHBOT_TOKEN,
    'sign': sign,
    'nonce': nonce,
    't': t,
    'Content-Type': 'application/json',
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────
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

// ── Posizione valvola (Relay Switch 2PM in modalità tapparella) ───────────
// position: 0 (chiusa) … 100 (aperta)
async function setValvePosition(deviceId, position) {
  const pos = Math.round(Math.min(100, Math.max(0, position)));
  return switchbotRequest(
    `/v1.1/devices/${deviceId}/commands`,
    'POST',
    { commandType: 'command', command: 'setPosition', parameter: `0,ff,${pos}` }
  );
}

// ── Logica proporzionale: temperatura → posizione valvola ─────────────────
// Isteresi ±0.3°C per evitare oscillazioni continue
function calcolaPosizioneValvola(tempAttuale, tempTarget, posizioneAttuale) {
  const errore = tempTarget - tempAttuale;

  if (errore > 2.0)  return 100;               // freddo: apri completamente
  if (errore > 0.3)  return Math.round(Math.min(100, 40 + (errore / 2.0) * 60)); // proporzionale 40-100%
  if (errore >= -0.3) return posizioneAttuale; // nella finestra target: mantieni
  if (errore > -1.5) return Math.round(Math.max(0, 40 + (errore / 1.5) * 40));  // caldo: riduci
  return 0;                                    // troppo caldo: chiudi
}

// ── Setup tabella clima_target ────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS clima_target (
    aula_nome            TEXT PRIMARY KEY,
    device_id_termometro TEXT,
    device_id_valvola    TEXT,
    temperatura_target   NUMERIC(4,1),
    posizione_attuale    INTEGER DEFAULT 0,
    attivo               BOOLEAN DEFAULT FALSE,
    updated_at           TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(() => {});

// ── Middleware credenziali ────────────────────────────────────────────────
function requireSwitchbot(req, res, next) {
  if (!SWITCHBOT_TOKEN || !SWITCHBOT_SECRET) {
    return res.status(503).json({ error: 'Credenziali SwitchBot non configurate (SWITCHBOT_TOKEN / SWITCHBOT_SECRET)' });
  }
  next();
}

// ── Middleware restrizione insegnanti ─────────────────────────────────────
async function checkInsegnante(req) {
  if (req.user.ruolo !== 'insegnante') return true;
  const { rows } = await pool.query(`
    SELECT l.id FROM lezioni l
    WHERE l.id_insegnante = $1
      AND l.data = (NOW() AT TIME ZONE 'Europe/Rome')::date
      AND l.ora_inizio <= (NOW() AT TIME ZONE 'Europe/Rome')::time + interval '30 minutes'
      AND l.ora_fine   >= (NOW() AT TIME ZONE 'Europe/Rome')::time - interval '30 minutes'
      AND l.stato NOT IN ('annullata')
    LIMIT 1
  `, [req.user.insegnanteId]);
  return rows.length > 0;
}

// ── GET /api/clima/dispositivi ────────────────────────────────────────────
router.get('/clima/dispositivi', authenticateToken, requireSwitchbot, async (req, res) => {
  try {
    const [sbRes, auleRes, targetsRes] = await Promise.all([
      switchbotRequest('/v1.1/devices'),
      pool.query('SELECT id, nome FROM aule ORDER BY nome'),
      pool.query('SELECT * FROM clima_target'),
    ]);

    const devices = sbRes?.body?.deviceList ?? [];
    const infra   = sbRes?.body?.infraredRemoteList ?? [];
    const tutti   = [...devices, ...infra];
    const aule    = auleRes.rows;
    const targets = targetsRes.rows;

    const enriched = tutti.map(d => {
      const nomeDevice = (d.deviceName || '').toLowerCase();
      const aula = aule.find(a => nomeDevice.includes(a.nome.toLowerCase()));
      return { ...d, aula_id: aula?.id ?? null, aula_nome: aula?.nome ?? null };
    });

    res.json({ ok: true, dispositivi: enriched, aule, targets });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore comunicazione SwitchBot' });
  }
});

// ── GET /api/clima/stato/:deviceId ────────────────────────────────────────
router.get('/clima/stato/:deviceId', authenticateToken, requireSwitchbot, async (req, res) => {
  if (!(await checkInsegnante(req))) {
    return res.status(403).json({ error: 'Controllo disponibile solo durante le ore di lezione' });
  }
  try {
    const data = await switchbotRequest(`/v1.1/devices/${req.params.deviceId}/status`);
    res.json(data?.body ?? data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore lettura stato dispositivo' });
  }
});

// ── POST /api/clima/comando/:deviceId ─────────────────────────────────────
router.post('/clima/comando/:deviceId', authenticateToken, requireSwitchbot, async (req, res) => {
  if (!(await checkInsegnante(req))) {
    return res.status(403).json({ error: 'Controllo disponibile solo durante le ore di lezione' });
  }

  const { deviceId } = req.params;
  const { command, parameter } = req.body;
  if (!command) return res.status(400).json({ error: 'Campo "command" obbligatorio' });

  try {
    const data = await switchbotRequest(
      `/v1.1/devices/${deviceId}/commands`,
      'POST',
      { commandType: 'command', command, parameter: parameter ?? 'default' }
    );
    res.json(data?.body ?? data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore invio comando SwitchBot' });
  }
});

// ── POST /api/clima/valvola/:deviceId/posizione ───────────────────────────
// body: { posizione: 0-100 }  — imposta direttamente la percentuale di apertura
router.post('/clima/valvola/:deviceId/posizione', authenticateToken, requireSwitchbot, async (req, res) => {
  if (!(await checkInsegnante(req))) {
    return res.status(403).json({ error: 'Controllo disponibile solo durante le ore di lezione' });
  }
  const pos = parseInt(req.body.posizione ?? 0, 10);
  try {
    await setValvePosition(req.params.deviceId, pos);
    // Aggiorna posizione_attuale nel DB se esiste un target per questo device
    await pool.query(
      `UPDATE clima_target SET posizione_attuale = $1 WHERE device_id_valvola = $2`,
      [pos, req.params.deviceId]
    );
    res.json({ ok: true, posizione: pos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore impostazione posizione valvola' });
  }
});

// ── POST /api/clima/valvola/:deviceId/spegni ─────────────────────────────
// Chiude completamente la valvola (0%) e disattiva il controllo automatico
router.post('/clima/valvola/:deviceId/spegni', authenticateToken, requireSwitchbot, async (req, res) => {
  if (!(await checkInsegnante(req))) {
    return res.status(403).json({ error: 'Controllo disponibile solo durante le ore di lezione' });
  }
  try {
    await setValvePosition(req.params.deviceId, 0);
    await pool.query(
      `UPDATE clima_target SET attivo = FALSE, posizione_attuale = 0 WHERE device_id_valvola = $1`,
      [req.params.deviceId]
    );
    res.json({ ok: true, posizione: 0, attivo: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore spegnimento valvola' });
  }
});

// ── GET /api/clima/targets ────────────────────────────────────────────────
router.get('/clima/targets', authenticateToken, async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clima_target ORDER BY aula_nome');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Errore lettura targets' });
  }
});

// ── POST /api/clima/target ────────────────────────────────────────────────
// body: { aula_nome, device_id_termometro, device_id_valvola, temperatura_target, attivo }
router.post('/clima/target', authenticateToken, requireSwitchbot, async (req, res) => {
  if (!(await checkInsegnante(req))) {
    return res.status(403).json({ error: 'Controllo disponibile solo durante le ore di lezione' });
  }

  const { aula_nome, device_id_termometro, device_id_valvola, temperatura_target, attivo = true } = req.body;
  if (!aula_nome || !device_id_valvola || !temperatura_target) {
    return res.status(400).json({ error: 'Campi obbligatori: aula_nome, device_id_valvola, temperatura_target' });
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO clima_target (aula_nome, device_id_termometro, device_id_valvola, temperatura_target, attivo, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (aula_nome) DO UPDATE SET
        device_id_termometro = EXCLUDED.device_id_termometro,
        device_id_valvola    = EXCLUDED.device_id_valvola,
        temperatura_target   = EXCLUDED.temperatura_target,
        attivo               = EXCLUDED.attivo,
        updated_at           = NOW()
      RETURNING *
    `, [aula_nome, device_id_termometro || null, device_id_valvola, temperatura_target, attivo]);

    // Se attivato, avvia subito un ciclo di controllo
    if (attivo) avviaControlloClima().catch(console.error);

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore salvataggio target' });
  }
});

// ── Logica cron: controlla e regola tutte le valvole attive ───────────────
async function avviaControlloClima() {
  if (!SWITCHBOT_TOKEN || !SWITCHBOT_SECRET) return;

  const { rows: targets } = await pool.query(
    `SELECT * FROM clima_target WHERE attivo = TRUE AND device_id_valvola IS NOT NULL`
  );

  for (const t of targets) {
    try {
      let tempAttuale = null;

      // Leggi temperatura dal termometro se configurato
      if (t.device_id_termometro) {
        const statoTermometro = await switchbotRequest(`/v1.1/devices/${t.device_id_termometro}/status`);
        const body = statoTermometro?.body ?? statoTermometro;
        tempAttuale = body?.temperature ?? body?.tempC ?? null;
      }

      if (tempAttuale === null) continue; // skip se non si riesce a leggere la temperatura

      const nuovaPosizione = calcolaPosizioneValvola(
        tempAttuale,
        parseFloat(t.temperatura_target),
        t.posizione_attuale ?? 50
      );

      // Invia comando solo se la posizione cambia di almeno 5 punti (evita rumore)
      if (Math.abs(nuovaPosizione - (t.posizione_attuale ?? 50)) >= 5) {
        await setValvePosition(t.device_id_valvola, nuovaPosizione);
        await pool.query(
          `UPDATE clima_target SET posizione_attuale = $1, updated_at = NOW() WHERE aula_nome = $2`,
          [nuovaPosizione, t.aula_nome]
        );
        console.log(`[clima] ${t.aula_nome}: ${tempAttuale}°C → target ${t.temperatura_target}°C → valvola ${nuovaPosizione}%`);
      }
    } catch (e) {
      console.error(`[clima] errore aula ${t.aula_nome}:`, e.message);
    }
  }
}

module.exports = { router, avviaControlloClima };
