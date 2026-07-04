const express = require('express');
const { pool } = require('../db');
const { authenticateToken } = require('../Middleware/auth');
const { getAnnoAccademico } = require('../utils/annoAccademico');

const router = express.Router();

// Middleware admin check
function requireAdmin(req, res, next) {
  if (!req.user || req.user.ruolo !== 'admin') {
    return res.status(403).json({ error: 'Accesso riservato agli amministratori' });
  }
  next();
}

// GET /api/admin/anno-corrente — restituisce l'anno accademico corrente
router.get('/admin/anno-corrente', authenticateToken, requireAdmin, (_req, res) => {
  res.json({ anno: getAnnoAccademico() });
});

// GET /api/admin/anni-accademici — lista tutti gli anni presenti nel DB
router.get('/admin/anni-accademici', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT anno_accademico FROM (
        SELECT anno_accademico FROM lezioni            WHERE anno_accademico IS NOT NULL
        UNION
        SELECT anno_accademico FROM pagamenti_mensili  WHERE anno_accademico IS NOT NULL
        UNION
        SELECT anno_accademico FROM quote_associative  WHERE anno_accademico IS NOT NULL
        UNION
        SELECT anno_accademico FROM gruppi             WHERE anno_accademico IS NOT NULL
        UNION
        SELECT anno_accademico FROM iscrizioni         WHERE anno_accademico IS NOT NULL
      ) sub
      ORDER BY anno_accademico DESC
    `);
    res.json({ anni: rows.map(r => r.anno_accademico) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero anni accademici' });
  }
});

// POST /api/admin/termina-anno-accademico — chiude l'anno corrente
router.post('/admin/termina-anno-accademico', authenticateToken, requireAdmin, async (_req, res) => {
  const anno = getAnnoAccademico();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const [lezioni, pagamenti, quote, gruppiRes, iscrizioni] = await Promise.all([
      client.query(
        `UPDATE lezioni SET anno_accademico = $1 WHERE anno_accademico IS NULL`,
        [anno]
      ),
      client.query(
        `UPDATE pagamenti_mensili SET anno_accademico = $1 WHERE anno_accademico IS NULL`,
        [anno]
      ),
      client.query(
        `UPDATE quote_associative SET anno_accademico = $1 WHERE anno_accademico IS NULL`,
        [anno]
      ),
      client.query(
        `UPDATE gruppi SET anno_accademico = $1 WHERE anno_accademico IS NULL`,
        [anno]
      ),
      client.query(
        `UPDATE iscrizioni SET anno_accademico = $1 WHERE anno_accademico IS NULL`,
        [anno]
      ),
    ]);

    await client.query('COMMIT');

    res.json({
      ok: true,
      anno,
      riepilogo: {
        lezioni: lezioni.rowCount,
        pagamenti: pagamenti.rowCount,
        quote_associative: quote.rowCount,
        gruppi: gruppiRes.rowCount,
        iscrizioni: iscrizioni.rowCount,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Errore nella chiusura anno accademico' });
  } finally {
    client.release();
  }
});

// GET /api/admin/archivio/:anno — riepilogo di un anno accademico specifico
router.get('/admin/archivio/:anno', authenticateToken, requireAdmin, async (req, res) => {
  const { anno } = req.params;
  // Valida formato YYYY-YYYY
  if (!/^\d{4}-\d{4}$/.test(anno)) {
    return res.status(400).json({ error: 'Formato anno non valido (es. 2024-2025)' });
  }
  try {
    const [lezioniStats, pagamentiCount, allieviLezioni] = await Promise.all([
      // Conteggio lezioni per stato
      pool.query(
        `SELECT stato, COUNT(*)::int AS totale
         FROM lezioni
         WHERE anno_accademico = $1
         GROUP BY stato
         ORDER BY stato`,
        [anno]
      ),
      // Conteggio pagamenti
      pool.query(
        `SELECT COUNT(*)::int AS totale FROM pagamenti_mensili WHERE anno_accademico = $1`,
        [anno]
      ),
      // Allievi con riepilogo lezioni
      pool.query(
        `SELECT
           a.id, a.nome, a.cognome,
           COUNT(l.id) FILTER (WHERE l.stato = 'svolta')      ::int AS svolte,
           COUNT(l.id) FILTER (WHERE l.stato = 'annullata')   ::int AS annullate,
           COUNT(l.id) FILTER (WHERE l.stato = 'rimandata')   ::int AS rimandate
         FROM allievi a
         LEFT JOIN lezioni l ON l.id_allievo = a.id AND l.anno_accademico = $1
         GROUP BY a.id, a.nome, a.cognome
         HAVING COUNT(l.id) > 0
         ORDER BY a.cognome, a.nome`,
        [anno]
      ),
    ]);

    // Costruisci mappa stati lezioni
    const lezioniPerStato = {};
    for (const row of lezioniStats.rows) {
      lezioniPerStato[row.stato] = row.totale;
    }

    res.json({
      anno,
      lezioni: lezioniPerStato,
      pagamenti: pagamentiCount.rows[0].totale,
      allievi: allieviLezioni.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero archivio' });
  }
});

module.exports = router;
