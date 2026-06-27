const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../Middleware/auth');

const router = express.Router();

// Crea tabella se non esiste
pool.query(`
  CREATE TABLE IF NOT EXISTS giorni_chiusura (
    id SERIAL PRIMARY KEY,
    data DATE NOT NULL UNIQUE,
    descrizione TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(console.error);

// GET /api/giorni-chiusura  (tutti i ruoli autenticati)
router.get('/giorni-chiusura', authenticateToken, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, TO_CHAR(data,'YYYY-MM-DD') AS data, descrizione FROM giorni_chiusura ORDER BY data`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero giorni di chiusura' });
  }
});

// POST /api/giorni-chiusura  (solo admin)
router.post('/giorni-chiusura', ...requireRole('admin'), async (req, res) => {
  const { data, descrizione = '' } = req.body;
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return res.status(400).json({ error: 'Data non valida (YYYY-MM-DD)' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO giorni_chiusura (data, descrizione)
       VALUES ($1, $2)
       ON CONFLICT (data) DO UPDATE SET descrizione = EXCLUDED.descrizione
       RETURNING id, TO_CHAR(data,'YYYY-MM-DD') AS data, descrizione`,
      [data, descrizione]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel salvataggio' });
  }
});

// POST /api/giorni-chiusura/intervallo  (solo admin) — inserisce tutte le date in un range
router.post('/giorni-chiusura/intervallo', ...requireRole('admin'), async (req, res) => {
  const { data_inizio, data_fine, descrizione = '' } = req.body;
  if (!data_inizio || !data_fine || data_inizio > data_fine) {
    return res.status(400).json({ error: 'Intervallo date non valido' });
  }
  try {
    const cur = new Date(`${data_inizio}T00:00:00Z`);
    const end = new Date(`${data_fine}T00:00:00Z`);
    const inserted = [];
    while (cur <= end) {
      const ymd = cur.toISOString().slice(0, 10);
      const { rows } = await pool.query(
        `INSERT INTO giorni_chiusura (data, descrizione)
         VALUES ($1, $2)
         ON CONFLICT (data) DO UPDATE SET descrizione = EXCLUDED.descrizione
         RETURNING id, TO_CHAR(data,'YYYY-MM-DD') AS data, descrizione`,
        [ymd, descrizione]
      );
      inserted.push(rows[0]);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    res.status(201).json({ inserted: inserted.length, giorni: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel salvataggio intervallo' });
  }
});

// DELETE /api/giorni-chiusura/:id  (solo admin)
router.delete('/giorni-chiusura/:id', ...requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM giorni_chiusura WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Non trovato' });
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella cancellazione' });
  }
});

module.exports = router;
