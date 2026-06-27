const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/aule
router.get('/aule', authenticateToken, async (req, res) => {
  if (!['admin', 'insegnante'].includes(req.user.ruolo)) {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  try {
    const { rows } = await pool.query('SELECT id, nome FROM aule ORDER BY nome ASC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero aule' });
  }
});

// GET /api/aule/:id/disponibilita?data=YYYY-MM-DD
// Restituisce le lezioni occupate per quell'aula in quella data
router.get('/aule/:id/disponibilita', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { data } = req.query;
  if (!data) return res.status(400).json({ error: 'Parametro data obbligatorio (YYYY-MM-DD)' });
  try {
    // Ottieni il nome aula dall'id
    const aulaRes = await pool.query('SELECT nome FROM aule WHERE id = $1', [id]);
    if (aulaRes.rows.length === 0) return res.status(404).json({ error: 'Aula non trovata' });
    const nomeAula = aulaRes.rows[0].nome;

    const { rows } = await pool.query(
      `SELECT l.id, l.ora_inizio, l.ora_fine, l.stato,
              a.nome AS nome_allievo, a.cognome AS cognome_allievo,
              i.nome AS nome_insegnante, i.cognome AS cognome_insegnante
       FROM lezioni l
       LEFT JOIN allievi a ON l.id_allievo = a.id
       LEFT JOIN insegnanti i ON l.id_insegnante = i.id
       WHERE l.aula = $1 AND l.data = $2 AND l.stato NOT IN ('annullata')
       ORDER BY l.ora_inizio`,
      [nomeAula, data]
    );
    res.json({ aula: nomeAula, data, lezioni: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero disponibilità' });
  }
});

// POST /api/aule
router.post('/aule', ...requireRole('admin'), async (req, res) => {
  const { nome } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome aula obbligatorio' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO aule (nome) VALUES ($1) RETURNING id, nome`,
      [nome.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (String(err?.message || '').includes('duplicate')) {
      return res.status(409).json({ error: "Esiste già un'aula con questo nome" });
    }
    console.error(err);
    res.status(500).json({ error: 'Errore creazione aula' });
  }
});

// PUT /api/aule/:id
router.put('/aule/:id', ...requireRole('admin'), async (req, res) => {
  const { nome } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome aula obbligatorio' });
  try {
    const { rows } = await pool.query(
      `UPDATE aule SET nome = $1 WHERE id = $2 RETURNING id, nome`,
      [nome.trim(), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Aula non trovata' });
    res.json(rows[0]);
  } catch (err) {
    if (String(err?.message || '').includes('duplicate')) {
      return res.status(409).json({ error: "Esiste già un'aula con questo nome" });
    }
    console.error(err);
    res.status(500).json({ error: 'Errore aggiornamento aula' });
  }
});

// DELETE /api/aule/:id
router.delete('/aule/:id', ...requireRole('admin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM aule WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Aula non trovata' });
    res.json({ message: 'Aula eliminata' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore cancellazione aula' });
  }
});

// GET /api/setup-aule (legacy/idempotente)
router.get('/setup-aule', async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aule (
        id SERIAL PRIMARY KEY,
        nome TEXT UNIQUE NOT NULL
      )
    `);
    await pool.query(`
      INSERT INTO aule (nome)
      SELECT DISTINCT TRIM(aula) AS nome
      FROM lezioni
      WHERE aula IS NOT NULL AND TRIM(aula) <> ''
      ON CONFLICT (nome) DO NOTHING
    `);
    res.json({ message: 'Tabella aule pronta' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore setup aule' });
  }
});

module.exports = router;
