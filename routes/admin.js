const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { requireRole } = require('../Middleware/auth');
const { genUsernameFrom } = require('../utils/helpers');

const router = express.Router();

// GET /api/utenti
router.get('/utenti', ...requireRole('admin'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, ruolo, allievo_id FROM utenti ORDER BY username'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// POST /api/utenti
router.post('/utenti', ...requireRole('admin'), async (req, res) => {
  const { username, password, ruolo } = req.body;
  if (!username || !password || !['admin', 'insegnante', 'allievo'].includes(ruolo)) {
    return res.status(400).json({ message: 'Dati non validi' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO utenti (username, password, ruolo)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      [String(username).toLowerCase(), hashedPassword, ruolo]
    );
    res.json({ message: 'Utente creato' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// POST /api/admin/allievi/:id/credenziali
// Crea (o reimposta) le credenziali di accesso per un allievo esistente
router.post('/admin/allievi/:id/credenziali', ...requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  try {
    const allRes = await pool.query('SELECT * FROM allievi WHERE id = $1', [id]);
    if (allRes.rows.length === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    const allievo = allRes.rows[0];

    const username = genUsernameFrom(allievo.nome, allievo.cognome);
    const pwd = password || 'amamusic';
    const hash = await bcrypt.hash(pwd, 10);

    // Upsert utente con ruolo allievo
    const upsert = await pool.query(
      `INSERT INTO utenti (username, password, ruolo, allievo_id)
       VALUES ($1, $2, 'allievo', $3)
       ON CONFLICT (username)
       DO UPDATE SET password = EXCLUDED.password, allievo_id = EXCLUDED.allievo_id
       RETURNING id, username, ruolo, allievo_id`,
      [username, hash, id]
    );

    res.status(201).json({
      message: 'Credenziali create',
      username,
      password_iniziale: pwd,
      utente: upsert.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore creazione credenziali allievo' });
  }
});

// GET /api/admin/dashboard — KPI sintetici
router.get('/admin/dashboard', ...requireRole('admin'), async (_req, res) => {
  try {
    const [lezioniSettimana, pagamentiMancanti, allieviAttivi, insegnantiCount, iscrizioniAttesa] = await Promise.all([
      // Lezioni questa settimana
      pool.query(`
        SELECT COUNT(*) FROM lezioni
        WHERE data >= date_trunc('week', CURRENT_DATE)
          AND data < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'
          AND stato NOT IN ('annullata')
      `),
      // Allievi con quota mensile mancante per il mese corrente
      pool.query(`
        SELECT COUNT(DISTINCT a.id) FROM allievi a
        WHERE a.quota_mensile > 0
          AND (a.attivo IS NULL OR a.attivo = TRUE)
          AND NOT EXISTS (
            SELECT 1 FROM pagamenti_mensili p
            WHERE p.allievo_id = a.id
              AND p.anno = EXTRACT(YEAR FROM CURRENT_DATE)
              AND p.mese = EXTRACT(MONTH FROM CURRENT_DATE)
          )
      `),
      // Allievi attivi
      pool.query(`SELECT COUNT(*) FROM allievi WHERE attivo IS DISTINCT FROM FALSE`),
      // Insegnanti
      pool.query(`SELECT COUNT(*) FROM insegnanti`),
      // Iscrizioni in attesa
      pool.query(`SELECT COUNT(*) FROM iscrizioni WHERE stato='in_attesa'`),
    ]);

    res.json({
      lezioniSettimana: parseInt(lezioniSettimana.rows[0].count, 10),
      pagamentiMancanti: parseInt(pagamentiMancanti.rows[0].count, 10),
      allieviAttivi: parseInt(allieviAttivi.rows[0].count, 10),
      insegnanti: parseInt(insegnantiCount.rows[0].count, 10),
      iscrizioniAttesa: parseInt(iscrizioniAttesa.rows[0].count, 10),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore caricamento dashboard' });
  }
});

// GET /api/admin/pagamenti-overview?anno=YYYY&mese=M
// Lista allievi con stato pagamento per un mese specifico
router.get('/admin/pagamenti-overview', ...requireRole('admin'), async (req, res) => {
  const anno = parseInt(req.query.anno) || new Date().getFullYear();
  const mese = parseInt(req.query.mese) || (new Date().getMonth() + 1);

  try {
    const { rows } = await pool.query(
      `SELECT
         a.id, a.nome, a.cognome, a.quota_mensile,
         CASE WHEN p.id IS NOT NULL THEN TRUE ELSE FALSE END AS pagato,
         p.data_pagamento
       FROM allievi a
       LEFT JOIN pagamenti_mensili p
         ON p.allievo_id = a.id AND p.anno = $1 AND p.mese = $2
       WHERE a.quota_mensile > 0 AND (a.attivo IS DISTINCT FROM FALSE)
       ORDER BY pagato ASC, a.cognome, a.nome`,
      [anno, mese]
    );
    res.json({ anno, mese, allievi: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero overview pagamenti' });
  }
});

// GET /api/admin/quote-associative-overview?anno=YYYY
router.get('/admin/quote-associative-overview', ...requireRole('admin'), async (req, res) => {
  const anno = parseInt(req.query.anno) || new Date().getFullYear();
  try {
    const { rows } = await pool.query(
      `SELECT
         a.id, a.nome, a.cognome,
         CASE WHEN qa.pagata IS TRUE THEN TRUE ELSE FALSE END AS pagata,
         qa.data_pagamento
       FROM allievi a
       LEFT JOIN quote_associative qa ON qa.allievo_id = a.id AND qa.anno = $1
       WHERE a.attivo IS DISTINCT FROM FALSE
       ORDER BY pagata ASC, a.cognome, a.nome`,
      [anno]
    );
    res.json({ anno, allievi: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero quote associative' });
  }
});

// POST /api/admin/notifiche-pagamento
// Crea notifiche in-app per allievi con pagamento mancante
router.post('/admin/notifiche-pagamento', ...requireRole('admin'), async (req, res) => {
  const anno = parseInt(req.body.anno) || new Date().getFullYear();
  const mese = parseInt(req.body.mese) || (new Date().getMonth() + 1);
  const nomiMesi = ['','Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
                    'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

  try {
    const { rows } = await pool.query(
      `SELECT a.id FROM allievi a
       WHERE a.quota_mensile > 0 AND (a.attivo IS DISTINCT FROM FALSE)
         AND NOT EXISTS (
           SELECT 1 FROM pagamenti_mensili p
           WHERE p.allievo_id = a.id AND p.anno = $1 AND p.mese = $2
         )`,
      [anno, mese]
    );

    let create = 0;
    for (const r of rows) {
      // Evita duplicati
      const exists = await pool.query(
        `SELECT 1 FROM notifiche WHERE dest_id=$1 AND tipo='pagamento_mancante'
         AND messaggio LIKE $2 LIMIT 1`,
        [r.id, `%${nomiMesi[mese]} ${anno}%`]
      );
      if (exists.rows.length === 0) {
        await pool.query(
          `INSERT INTO notifiche (dest_id, tipo, messaggio) VALUES ($1, 'pagamento_mancante', $2)`,
          [r.id, `Il pagamento di ${nomiMesi[mese]} ${anno} non risulta ancora registrato.`]
        );
        create++;
      }
    }

    res.json({ message: `${create} notifiche create`, totaleAllievi: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore creazione notifiche pagamento' });
  }
});

// GET /api/admin/cron-status — stato ultima esecuzione notifiche automatiche
router.get('/admin/cron-status', ...requireRole('admin'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT eseguito_il, notifiche_inviate FROM cron_log WHERE job = 'notifiche_pagamento'`
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Errore' });
  }
});

// POST /api/admin/notifiche-pagamento-auto — trigger manuale del cron
router.post('/admin/notifiche-pagamento-auto', ...requireRole('admin'), async (_req, res) => {
  try {
    const { inviaNotifichePagamento } = require('../cron/notifiche-pagamento');
    const totale = await inviaNotifichePagamento();
    res.json({ ok: true, notifiche_inviate: totale });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nell\'invio notifiche' });
  }
});

// ----------------------
// Legacy / Setup endpoints
// ----------------------
router.get('/setup-utenti', async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS utenti (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        ruolo VARCHAR(20) CHECK (ruolo IN ('admin', 'insegnante', 'allievo')) NOT NULL,
        allievo_id INTEGER
      )
    `);
    const hash = await bcrypt.hash('admin', 10);
    await pool.query(
      `INSERT INTO utenti (username, password, ruolo) VALUES ('admin', $1, 'admin') ON CONFLICT DO NOTHING`,
      [hash]
    );
    const hash2 = await bcrypt.hash('amamusic', 10);
    await pool.query(
      `INSERT INTO utenti (username, password, ruolo) VALUES ('segreteria', $1, 'admin') ON CONFLICT DO NOTHING`,
      [hash2]
    );
    res.json({ message: 'Setup utenti completato' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Errore setup utenti' });
  }
});

router.get('/debug-utenti', async (_req, res) => {
  try {
    const result = await pool.query('SELECT id, username, ruolo, allievo_id FROM utenti');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore debug' });
  }
});

module.exports = router;
