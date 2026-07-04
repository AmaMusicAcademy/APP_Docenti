const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../Middleware/auth');

const router = express.Router();

// Migration automatica
pool.query(`
  ALTER TABLE allievi
  ADD COLUMN IF NOT EXISTS indirizzo  TEXT,
  ADD COLUMN IF NOT EXISTS data_fine  DATE
`).catch(() => {});

// GET /api/allievi/iscrizioni-attesa  — richieste in attesa di approvazione
router.get('/allievi/iscrizioni-attesa', ...requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nome, cognome, email, telefono, strumento, data_nascita
       FROM allievi WHERE stato_iscrizione = 'in_attesa' ORDER BY id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero iscrizioni' });
  }
});

// PATCH /api/allievi/:id/iscrizione  — accetta o rifiuta un'iscrizione
router.patch('/allievi/:id/iscrizione', ...requireRole('admin'), async (req, res) => {
  const { stato } = req.body; // 'attivo' | 'rifiutato'
  if (!['attivo', 'rifiutato'].includes(stato)) {
    return res.status(400).json({ error: 'Stato non valido' });
  }
  try {
    const { rowCount } = await pool.query(
      'UPDATE allievi SET stato_iscrizione = $1 WHERE id = $2',
      [stato, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore aggiornamento iscrizione' });
  }
});

// GET /api/allievi
router.get('/allievi', authenticateToken, async (req, res) => {
  if (!['admin', 'insegnante'].includes(req.user.ruolo)) {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM allievi ORDER BY cognome, nome');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero allievi' });
  }
});

// GET /api/allievi/:id
router.get('/allievi/:id', authenticateToken, async (req, res) => {
  if (!['admin', 'insegnante'].includes(req.user.ruolo)) {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM allievi WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel recupero allievo' });
  }
});

// POST /api/allievi
router.post('/allievi', ...requireRole('admin'), async (req, res) => {
  const {
    nome,
    cognome,
    email = '',
    telefono = '',
    note = '',
    strumento = '',
    data_nascita = null,
    data_iscrizione = new Date().toISOString().split('T')[0],
    quota_mensile = 0,
  } = req.body;
  if (!nome || !cognome) return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO allievi (nome, cognome, email, telefono, note, strumento, data_nascita, data_iscrizione, quota_mensile)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [nome, cognome, email, telefono, note, strumento, data_nascita, data_iscrizione, quota_mensile]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella creazione allievo' });
  }
});

// PUT /api/allievi/:id
router.put('/allievi/:id', ...requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const {
    nome, cognome, email = '', telefono = '', note = '', strumento = '',
    data_nascita = null, quota_mensile = 0,
    codice_fiscale = '', luogo_nascita = '',
    indirizzo = '', cap = '', citta = '', provincia = '',
    minore = false,
    genitore_nome = '', genitore_cognome = '', genitore_cf = '',
    genitore_data_nascita = null, genitore_luogo_nascita = '',
    genitore_indirizzo = '', genitore_telefono = '', genitore_email = '',
  } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE allievi SET
        nome=$1, cognome=$2, email=$3, telefono=$4, note=$5, strumento=$6,
        data_nascita=$7, quota_mensile=$8,
        codice_fiscale=$9, luogo_nascita=$10,
        indirizzo=$11, cap=$12, citta=$13, provincia=$14,
        minore=$15,
        genitore_nome=$16, genitore_cognome=$17, genitore_cf=$18,
        genitore_data_nascita=$19, genitore_luogo_nascita=$20,
        genitore_indirizzo=$21, genitore_telefono=$22, genitore_email=$23
       WHERE id=$24 RETURNING *`,
      [nome, cognome, email, telefono, note, strumento, data_nascita, quota_mensile,
       codice_fiscale, luogo_nascita, indirizzo, cap, citta, provincia, !!minore,
       genitore_nome, genitore_cognome, genitore_cf, genitore_data_nascita || null,
       genitore_luogo_nascita, genitore_indirizzo, genitore_telefono, genitore_email, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nell'aggiornamento allievo" });
  }
});

// DELETE /api/allievi/:id
router.delete('/allievi/:id', ...requireRole('admin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM allievi WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json({ message: 'Allievo eliminato' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore eliminazione allievo' });
  }
});

// PATCH /api/allievi/:id  — aggiornamento parziale anagrafica (solo admin)
router.patch('/allievi/:id', ...requireRole('admin'), async (req, res) => {
  const campi = ['nome','cognome','email','telefono','indirizzo','strumento','data_nascita','data_iscrizione','quota_mensile','note'];
  const sets = []; const vals = [];
  campi.forEach(c => {
    if (req.body[c] !== undefined) { sets.push(`${c} = $${vals.length+1}`); vals.push(req.body[c] ?? null); }
  });
  if (!sets.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });
  vals.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE allievi SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

// PATCH /api/allievi/:id/termina  — disattiva allievo con data fine
router.patch('/allievi/:id/termina', ...requireRole('admin'), async (req, res) => {
  const { data_fine } = req.body;
  if (!data_fine) return res.status(400).json({ error: 'data_fine obbligatoria' });
  try {
    const { rows } = await pool.query(
      `UPDATE allievi SET attivo = FALSE, data_fine = $1 WHERE id = $2 RETURNING *`,
      [data_fine, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

// PATCH /api/allievi/:id/riattiva
router.patch('/allievi/:id/riattiva', ...requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE allievi SET attivo = TRUE, data_fine = NULL WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

// PATCH /api/allievi/:id/stato
router.patch('/allievi/:id/stato', ...requireRole('admin'), async (req, res) => {
  const { attivo } = req.body;
  try {
    const { rowCount } = await pool.query(
      'UPDATE allievi SET attivo = $1 WHERE id = $2',
      [attivo, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore aggiornamento stato" });
  }
});

// GET /api/allievi/:id/conteggio-lezioni
router.get('/allievi/:id/conteggio-lezioni', async (req, res) => {
  const { id } = req.params;
  const { start, end } = req.query;
  const params = [id];
  const conditions = [];
  if (start) { conditions.push(`data >= $${params.length + 1}`); params.push(start); }
  if (end)   { conditions.push(`data <= $${params.length + 1}`); params.push(end); }
  const where = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
  try {
    const { rows } = await pool.query(
      `SELECT stato, riprogrammata, COUNT(*) FROM (
         SELECT stato, riprogrammata FROM lezioni WHERE id_allievo = $1${where}
         UNION ALL
         SELECT l.stato, l.riprogrammata FROM lezioni l
         JOIN lezioni_partecipanti lp ON lp.lezione_id = l.id AND lp.allievo_id = $1
         WHERE l.tipo = 'collettiva'${where.replace(/data/g, 'l.data')}
       ) sub GROUP BY stato, riprogrammata`,
      params
    );
    const result = { svolte: 0, annullate: 0, rimandate: 0, riprogrammate: 0 };
    for (const row of rows) {
      const n = parseInt(row.count, 10);
      if (row.stato === 'svolta') result.svolte += n;
      else if (row.stato === 'annullata') result.annullate += n;
      else if (row.stato === 'rimandata') {
        if (row.riprogrammata) result.riprogrammate += n;
        else result.rimandate += n;
      }
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel conteggio lezioni' });
  }
});

// GET /api/allievi/:id/lezioni-per-stato?stato=svolta|annullata|rimandata
router.get('/allievi/:id/lezioni-per-stato', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { stato } = req.query;
  try {
    let whereStato;
    if (stato === 'svolta')    whereStato = `l.stato = 'svolta'`;
    else if (stato === 'annullata') whereStato = `l.stato = 'annullata'`;
    else if (stato === 'rimandata') whereStato = `l.stato = 'rimandata' AND l.riprogrammata = FALSE`;
    else whereStato = '1=1';

    const { rows } = await pool.query(
      `SELECT l.id, TO_CHAR(l.data,'YYYY-MM-DD') AS data, l.ora_inizio, l.ora_fine,
              l.stato, l.aula, l.motivazione, l.tipo, l.nome_gruppo,
              i.nome AS nome_insegnante, i.cognome AS cognome_insegnante
       FROM lezioni l
       LEFT JOIN insegnanti i ON l.id_insegnante = i.id
       WHERE l.id_allievo = $1 AND ${whereStato}
       UNION
       SELECT l.id, TO_CHAR(l.data,'YYYY-MM-DD') AS data, l.ora_inizio, l.ora_fine,
              l.stato, l.aula, l.motivazione, l.tipo, l.nome_gruppo,
              i.nome AS nome_insegnante, i.cognome AS cognome_insegnante
       FROM lezioni l
       JOIN lezioni_partecipanti lp ON lp.lezione_id = l.id AND lp.allievo_id = $1
       LEFT JOIN insegnanti i ON l.id_insegnante = i.id
       WHERE l.tipo = 'collettiva' AND ${whereStato}
       ORDER BY data DESC, ora_inizio DESC`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero lezioni' });
  }
});

// GET /api/allievi/:id/pagamenti
router.get('/allievi/:id/pagamenti', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT anno, mese, data_pagamento FROM pagamenti_mensili
       WHERE allievo_id = $1 ORDER BY anno DESC, mese DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero pagamenti' });
  }
});

// POST /api/allievi/:id/pagamenti
router.post('/allievi/:id/pagamenti', async (req, res) => {
  const { anno, mese } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO pagamenti_mensili (allievo_id, anno, mese)
       VALUES ($1, $2, $3)
       ON CONFLICT (allievo_id, anno, mese) DO NOTHING
       RETURNING *`,
      [req.params.id, anno, mese]
    );
    res.status(201).json(rows[0] || { message: 'Pagamento già registrato' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel salvataggio pagamento' });
  }
});

// DELETE /api/allievi/:id/pagamenti
router.delete('/allievi/:id/pagamenti', async (req, res) => {
  const { anno, mese } = req.query;
  try {
    const result = await pool.query(
      `DELETE FROM pagamenti_mensili WHERE allievo_id = $1 AND anno = $2 AND mese = $3`,
      [req.params.id, anno, mese]
    );
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella cancellazione pagamento' });
  }
});

// GET /api/allievi/:id/quote-associative
router.get('/allievi/:id/quote-associative', authenticateToken, async (req, res) => {
  if (!['admin', 'insegnante'].includes(req.user.ruolo)) {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT anno, pagata, data_pagamento FROM quote_associative
       WHERE allievo_id = $1 ORDER BY anno DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore recupero quote associative' });
  }
});

// POST /api/allievi/:id/quota-associativa
router.post('/allievi/:id/quota-associativa', ...requireRole('admin'), async (req, res) => {
  const { anno, pagata } = req.body;
  if (!anno || !Number.isInteger(anno)) return res.status(400).json({ error: 'Anno non valido' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO quote_associative (allievo_id, anno, pagata, data_pagamento)
       VALUES ($1, $2, $3, CASE WHEN $3 THEN CURRENT_DATE ELSE NULL END)
       ON CONFLICT (allievo_id, anno)
       DO UPDATE SET
         pagata = EXCLUDED.pagata,
         data_pagamento = CASE WHEN EXCLUDED.pagata THEN CURRENT_DATE ELSE NULL END
       RETURNING anno, pagata, data_pagamento`,
      [req.params.id, anno, !!pagata]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore salvataggio quota associativa' });
  }
});

// DELETE /api/allievi/:id/quota-associativa
router.delete('/allievi/:id/quota-associativa', ...requireRole('admin'), async (req, res) => {
  const { anno } = req.query;
  if (!anno) return res.status(400).json({ error: 'Anno mancante' });
  try {
    const result = await pool.query(
      `DELETE FROM quote_associative WHERE allievo_id = $1 AND anno = $2`,
      [req.params.id, parseInt(anno, 10)]
    );
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore eliminazione quota associativa' });
  }
});

// GET /api/allievi/:id/iscrizione-pdf — token download PDF iscrizione accettata
router.get('/allievi/:id/iscrizione-pdf', ...requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT token_download FROM iscrizioni WHERE allievo_id=$1 AND stato='accettata' ORDER BY accettata_il DESC LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length || !rows[0].token_download) return res.json({ token: null });
    res.json({ token: rows[0].token_download });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
