const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../Middleware/auth');
const { genUsernameFrom } = require('../utils/helpers');

const router = express.Router();

// Migration automatica all'avvio
pool.query(`
  ALTER TABLE insegnanti
  ADD COLUMN IF NOT EXISTS tariffa_oraria    NUMERIC(8,2) DEFAULT 15,
  ADD COLUMN IF NOT EXISTS attivo            BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS data_inizio       DATE,
  ADD COLUMN IF NOT EXISTS data_fine         DATE,
  ADD COLUMN IF NOT EXISTS telefono          TEXT,
  ADD COLUMN IF NOT EXISTS email             TEXT,
  ADD COLUMN IF NOT EXISTS indirizzo         TEXT,
  ADD COLUMN IF NOT EXISTS data_nascita      DATE
`).catch(() => {});

// GET /api/insegnante/me
router.get('/insegnante/me', authenticateToken, async (req, res) => {
  try {
    let row;
    const id = req.user.insegnanteId;
    if (id) {
      const { rows } = await pool.query(
        'SELECT id, nome, cognome, username, avatar_url FROM insegnanti WHERE id = $1',
        [id]
      );
      row = rows[0];
    }
    if (!row && req.user.username) {
      const { rows } = await pool.query(
        'SELECT id, nome, cognome, username, avatar_url FROM insegnanti WHERE LOWER(username) = $1',
        [String(req.user.username).toLowerCase()]
      );
      row = rows[0];
    }
    if (!row) return res.status(404).json({ message: 'Utente non trovato' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// GET /api/insegnanti
router.get('/insegnanti', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM insegnanti ORDER BY cognome, nome');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero insegnanti' });
  }
});

// POST /api/insegnanti (admin)
router.post('/insegnanti', ...requireRole('admin'), async (req, res) => {
  const { nome, cognome } = req.body;
  if (!nome || !cognome) return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  try {
    const username = genUsernameFrom(nome, cognome);
    const password = 'amamusic';
    const password_hash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      'INSERT INTO insegnanti (nome, cognome, username, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
      [nome, cognome, username, password_hash]
    );

    await pool.query(
      `INSERT INTO utenti (username, password, ruolo)
       VALUES ($1, $2, 'insegnante')
       ON CONFLICT (username) DO NOTHING`,
      [username, password_hash]
    );

    res.status(201).json({ ...rows[0], password_iniziale: password });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella creazione insegnante' });
  }
});

// GET /api/insegnanti/:id
router.get('/insegnanti/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (String(req.user.insegnanteId || '') !== String(id) && req.user.ruolo !== 'admin') {
    return res.status(403).json({ error: 'Accesso non autorizzato' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM insegnanti WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel recupero insegnante' });
  }
});

// GET /api/insegnanti/:id/allievi
router.get('/insegnanti/:id/allievi', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.nome, a.cognome
       FROM allievi a
       JOIN allievi_insegnanti ai ON a.id = ai.allievo_id
       WHERE ai.insegnante_id = $1`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero allievi assegnati' });
  }
});

// GET /api/insegnanti/:id/lezioni
router.get('/insegnanti/:id/lezioni', authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (String(req.user.insegnanteId || '') !== String(id) && req.user.ruolo !== 'admin') {
    return res.status(403).json({ error: 'Accesso non autorizzato' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT lezioni.*,
              COALESCE(lezioni.tipo, 'individuale') AS tipo,
              allievi.nome AS nome_allievo, allievi.cognome AS cognome_allievo,
              COALESCE(lezioni.nome_gruppo, g.nome) AS nome_gruppo,
              (SELECT COUNT(*) FROM lezioni_partecipanti lp WHERE lp.lezione_id = lezioni.id)::int AS num_partecipanti
       FROM lezioni
       LEFT JOIN allievi ON lezioni.id_allievo = allievi.id
       LEFT JOIN gruppi g ON g.id = lezioni.gruppo_id
       WHERE lezioni.id_insegnante = $1
       ORDER BY lezioni.data DESC, lezioni.ora_inizio DESC`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero lezioni' });
  }
});

// PATCH /api/insegnanti/:id  — aggiorna anagrafica (solo admin)
router.patch('/insegnanti/:id', ...requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const campi = ['nome','cognome','username','telefono','email','indirizzo','data_nascita','data_inizio'];
  const sets = []; const vals = [];
  campi.forEach(c => {
    if (req.body[c] !== undefined) { sets.push(`${c} = $${vals.length+1}`); vals.push(req.body[c] || null); }
  });
  if (!sets.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });
  vals.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE insegnanti SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel salvataggio' });
  }
});

// PATCH /api/insegnanti/:id/termina  — termina collaborazione (solo admin)
router.patch('/insegnanti/:id/termina', ...requireRole('admin'), async (req, res) => {
  const { data_fine } = req.body;
  if (!data_fine) return res.status(400).json({ error: 'data_fine obbligatoria' });
  try {
    const { rows } = await pool.query(
      `UPDATE insegnanti SET attivo = FALSE, data_fine = $1 WHERE id = $2 RETURNING *`,
      [data_fine, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore' });
  }
});

// PATCH /api/insegnanti/:id/riattiva  — riattiva collaborazione (solo admin)
router.patch('/insegnanti/:id/riattiva', ...requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE insegnanti SET attivo = TRUE, data_fine = NULL WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore' });
  }
});

// PATCH /api/insegnanti/:id/tariffa  (solo admin)
router.patch('/insegnanti/:id/tariffa', ...requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const tariffa = parseFloat(req.body.tariffa_oraria);
  if (isNaN(tariffa) || tariffa < 0) {
    return res.status(400).json({ error: 'Tariffa non valida' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE insegnanti SET tariffa_oraria = $1 WHERE id = $2 RETURNING id, nome, cognome, tariffa_oraria',
      [tariffa, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel salvataggio tariffa' });
  }
});

// GET /api/insegnanti/:id/compenso?mese=YYYY-MM
router.get('/insegnanti/:id/compenso', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { mese } = req.query;
  if (!mese || !/^\d{4}-\d{2}$/.test(mese)) {
    return res.status(400).json({ error: 'Parametro "mese" non valido (YYYY-MM)' });
  }
  try {
    // Recupera tariffa oraria dell'insegnante
    const insRes = await pool.query('SELECT tariffa_oraria FROM insegnanti WHERE id = $1', [id]);
    const tariffaOraria = parseFloat(insRes.rows[0]?.tariffa_oraria ?? 15);

    // Lezioni conteggiate: svolte + annullate nel mese di riferimento
    const result = await pool.query(
      `SELECT l.id, l.data, l.ora_inizio, l.ora_fine, l.stato, l.aula, l.riprogrammata,
              a.nome AS nome_allievo, a.cognome AS cognome_allievo,
              TO_CHAR(l.data, 'YYYY-MM-DD') AS data_str
       FROM lezioni l
       LEFT JOIN allievi a ON l.id_allievo = a.id
       WHERE l.id_insegnante = $1
         AND l.stato IN ('svolta', 'annullata')
         AND DATE_TRUNC('month', l.data) = DATE_TRUNC('month', $2::DATE)
       ORDER BY l.data, l.ora_inizio`,
      [id, `${mese}-01`]
    );

    let oreTotali = 0;
    const lezioni = result.rows.map((row) => {
      const ore =
        (new Date(`1970-01-01T${row.ora_fine}Z`) - new Date(`1970-01-01T${row.ora_inizio}Z`)) /
        (1000 * 60 * 60);
      oreTotali += ore;
      return {
        id: row.id,
        data: row.data_str,
        ora_inizio: row.ora_inizio?.slice(0, 5),
        ora_fine: row.ora_fine?.slice(0, 5),
        aula: row.aula || '—',
        allievo: `${row.cognome_allievo || ''} ${row.nome_allievo || ''}`.trim() || 'Allievo',
        stato: row.stato,
        ore: Math.round(ore * 100) / 100,
        compenso: Math.round(ore * tariffaOraria * 100) / 100,
      };
    });

    const compensoTotale = Math.round(oreTotali * tariffaOraria * 100) / 100;
    res.json({
      mese,
      tariffaOraria,
      lezioniSvolte: result.rowCount,
      oreTotali: Math.round(oreTotali * 100) / 100,
      compensoTotale,
      lezioni,
      // alias per compatibilità con versione precedente del frontend
      lezioniPagate: result.rowCount,
      compenso: compensoTotale,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel calcolo compenso' });
  }
});

// POST /api/allievi/:id/insegnanti (associazioni)
router.post('/allievi/:id/insegnanti', async (req, res) => {
  const { id } = req.params;
  const { insegnanti } = req.body;
  if (!Array.isArray(insegnanti)) return res.status(400).json({ error: 'Formato non valido' });
  try {
    await pool.query('DELETE FROM allievi_insegnanti WHERE allievo_id = $1', [id]);
    await Promise.all(
      insegnanti.map((insId) =>
        pool.query(
          'INSERT INTO allievi_insegnanti (allievo_id, insegnante_id) VALUES ($1, $2)',
          [id, insId]
        )
      )
    );
    res.json({ message: 'Assegnazioni salvate' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel salvataggio assegnazioni' });
  }
});

// GET /api/allievi/:id/insegnanti
router.get('/allievi/:id/insegnanti', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.nome, i.cognome
       FROM insegnanti i
       JOIN allievi_insegnanti ai ON i.id = ai.insegnante_id
       WHERE ai.allievo_id = $1`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero assegnazioni' });
  }
});

// POST /api/admin/align-insegnanti-utenti
router.post('/admin/align-insegnanti-utenti', ...requireRole('admin'), async (req, res) => {
  const { normalize, apply } = req.query;
  try {
    const insRes = await pool.query('SELECT id, nome, cognome, username, password_hash FROM insegnanti');
    const utentiRes = await pool.query('SELECT username FROM utenti');
    const userSet = new Set(utentiRes.rows.map((u) => u.username.toLowerCase()));
    const adminNames = new Set(['admin', 'segreteria', 'direzione']);
    const updates = [];
    for (const ins of insRes.rows) {
      let desired = normalize === 'true' ? genUsernameFrom(ins.nome, ins.cognome) : (ins.username || genUsernameFrom(ins.nome, ins.cognome));
      if (adminNames.has(desired)) desired = `${desired}.${ins.id}`;
      const exists = userSet.has(desired.toLowerCase());
      if (!exists && apply === 'true') {
        const pwd = ins.password_hash || (await bcrypt.hash('amamusic', 10));
        await pool.query(
          `INSERT INTO utenti (username, password, ruolo) VALUES ($1, $2, 'insegnante') ON CONFLICT (username) DO NOTHING`,
          [desired, pwd]
        );
      }
      if (normalize === 'true' && desired !== ins.username) {
        await pool.query('UPDATE insegnanti SET username = $1 WHERE id = $2', [desired, ins.id]);
      }
      updates.push({ insegnanteId: ins.id, username: desired, createdUser: !exists });
    }
    res.json({ ok: true, updates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore allineamento' });
  }
});

// Legacy setup endpoints
router.get('/alter-insegnanti-auth', async (_req, res) => {
  try {
    await pool.query(`
      ALTER TABLE insegnanti
      ADD COLUMN IF NOT EXISTS username TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS password_hash TEXT
    `);
    res.json({ message: 'Colonne username e password_hash aggiunte' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore' });
  }
});

router.post('/setup-credentials', async (req, res) => {
  const { nome, cognome, username, password } = req.body;
  if (!nome || !cognome || !username || !password) {
    return res.status(400).json({ error: 'Dati obbligatori mancanti' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `UPDATE insegnanti SET username = $1, password_hash = $2 WHERE nome = $3 AND cognome = $4 RETURNING *`,
      [username, hash, nome, cognome]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json({ message: 'Credenziali aggiornate', insegnante: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore aggiornamento credenziali' });
  }
});

module.exports = router;
