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

// ── Middleware credenziali ────────────────────────────────────────────────
function requireSwitchbot(req, res, next) {
  if (!SWITCHBOT_TOKEN || !SWITCHBOT_SECRET) {
    return res.status(503).json({ error: 'Credenziali SwitchBot non configurate (SWITCHBOT_TOKEN / SWITCHBOT_SECRET)' });
  }
  next();
}

// ── GET /api/clima/dispositivi ────────────────────────────────────────────
// Restituisce tutti i dispositivi SwitchBot, arricchiti con l'aula corrispondente
router.get('/clima/dispositivi', authenticateToken, requireSwitchbot, async (req, res) => {
  try {
    const [sbRes, auleRes] = await Promise.all([
      switchbotRequest('/v1.1/devices'),
      pool.query('SELECT id, nome FROM aule ORDER BY nome'),
    ]);

    const devices = sbRes?.body?.deviceList ?? [];
    const infra   = sbRes?.body?.infraredRemoteList ?? [];
    const tutti   = [...devices, ...infra];
    const aule    = auleRes.rows;

    // Associa ogni dispositivo all'aula il cui nome è contenuto nel deviceName
    const enriched = tutti.map(d => {
      const nomeDevice = (d.deviceName || '').toLowerCase();
      const aula = aule.find(a => nomeDevice.includes(a.nome.toLowerCase()));
      return { ...d, aula_id: aula?.id ?? null, aula_nome: aula?.nome ?? null };
    });

    res.json({ ok: true, dispositivi: enriched, aule });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore comunicazione SwitchBot' });
  }
});

// ── GET /api/clima/stato/:deviceId ────────────────────────────────────────
router.get('/clima/stato/:deviceId', authenticateToken, requireSwitchbot, async (req, res) => {
  const { deviceId } = req.params;

  // Restrizione insegnanti: deve avere lezione in corso o entro 30 min nell'aula del dispositivo
  if (req.user.ruolo === 'insegnante') {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const oggi = now.toISOString().slice(0, 10);
    const { rows } = await pool.query(`
      SELECT l.id FROM lezioni l
      WHERE l.id_insegnante = $1
        AND l.data = $2
        AND l.ora_inizio <= $3::time + interval '30 minutes'
        AND l.ora_fine   >= $3::time - interval '30 minutes'
        AND l.stato NOT IN ('annullata')
      LIMIT 1
    `, [req.user.insegnanteId, oggi, hhmm]);
    if (rows.length === 0) {
      return res.status(403).json({ error: 'Controllo disponibile solo durante le ore di lezione' });
    }
  }

  try {
    const data = await switchbotRequest(`/v1.1/devices/${deviceId}/status`);
    res.json(data?.body ?? data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore lettura stato dispositivo' });
  }
});

// ── POST /api/clima/comando/:deviceId ─────────────────────────────────────
// body: { commandType, command, parameter }
// es. { commandType: "command", command: "setPosition", parameter: "0,ff,80" }
router.post('/clima/comando/:deviceId', authenticateToken, requireSwitchbot, async (req, res) => {
  const { deviceId } = req.params;
  const { commandType = 'command', command, parameter = 'default' } = req.body;

  if (!command) return res.status(400).json({ error: 'Campo "command" obbligatorio' });

  // Restrizione insegnanti
  if (req.user.ruolo === 'insegnante') {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const oggi = now.toISOString().slice(0, 10);
    const { rows } = await pool.query(`
      SELECT l.id FROM lezioni l
      WHERE l.id_insegnante = $1
        AND l.data = $2
        AND l.ora_inizio <= $3::time + interval '30 minutes'
        AND l.ora_fine   >= $3::time - interval '30 minutes'
        AND l.stato NOT IN ('annullata')
      LIMIT 1
    `, [req.user.insegnanteId, oggi, hhmm]);
    if (rows.length === 0) {
      return res.status(403).json({ error: 'Controllo disponibile solo durante le ore di lezione' });
    }
  }

  try {
    const data = await switchbotRequest(
      `/v1.1/devices/${deviceId}/commands`,
      'POST',
      { commandType, command, parameter }
    );
    res.json(data?.body ?? data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore invio comando SwitchBot' });
  }
});

module.exports = router;
