const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../Middleware/auth');

const router = express.Router();

// ── GET /api/gruppi ───────────────────────────────────────────────────────
router.get('/gruppi', authenticateToken, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT g.id, g.nome, g.attivo,
             i.id AS insegnante_id, i.nome AS insegnante_nome, i.cognome AS insegnante_cognome,
             COUNT(ga.allievo_id)::int AS num_allievi
      FROM gruppi g
      LEFT JOIN insegnanti i ON i.id = g.id_insegnante
      LEFT JOIN gruppi_allievi ga ON ga.gruppo_id = g.id
      GROUP BY g.id, i.id
      ORDER BY g.nome
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/gruppi ──────────────────────────────────────────────────────
router.post('/gruppi', ...requireRole('admin'), async (req, res) => {
  const { nome, id_insegnante } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO gruppi (nome, id_insegnante) VALUES ($1,$2) RETURNING *`,
      [nome, id_insegnante || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/gruppi/:id ───────────────────────────────────────────────────
router.get('/gruppi/:id', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT g.id, g.nome, g.attivo,
             i.id AS insegnante_id, i.nome AS insegnante_nome, i.cognome AS insegnante_cognome
      FROM gruppi g
      LEFT JOIN insegnanti i ON i.id = g.id_insegnante
      WHERE g.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Gruppo non trovato' });

    const { rows: allievi } = await pool.query(`
      SELECT a.id, a.nome, a.cognome, ga.data_ingresso
      FROM gruppi_allievi ga
      JOIN allievi a ON a.id = ga.allievo_id
      WHERE ga.gruppo_id = $1
      ORDER BY a.cognome, a.nome
    `, [req.params.id]);

    res.json({ ...rows[0], allievi });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/gruppi/:id ───────────────────────────────────────────────────
router.put('/gruppi/:id', ...requireRole('admin'), async (req, res) => {
  const { nome, id_insegnante, attivo } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE gruppi SET nome=COALESCE($1,nome), id_insegnante=$2, attivo=COALESCE($3,attivo)
      WHERE id=$4 RETURNING *
    `, [nome, id_insegnante || null, attivo, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Gruppo non trovato' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/gruppi/:id ────────────────────────────────────────────────
router.delete('/gruppi/:id', ...requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM gruppi WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/gruppi/:id/allievi/:allievoId ───────────────────────────────
router.post('/gruppi/:id/allievi/:allievoId', ...requireRole('admin'), async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO gruppi_allievi (gruppo_id, allievo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.params.allievoId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/gruppi/:id/allievi/:allievoId ─────────────────────────────
router.delete('/gruppi/:id/allievi/:allievoId', ...requireRole('admin'), async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM gruppi_allievi WHERE gruppo_id=$1 AND allievo_id=$2`,
      [req.params.id, req.params.allievoId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
