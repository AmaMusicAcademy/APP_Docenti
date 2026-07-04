const express = require('express');
const PDFDocument = require('pdfkit');
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

// ── Helper: carica tutti i dati di un anno ────────────────────────────────
async function caricaDatiAnno(anno) {
  const [lezioni, pagamenti, quote, iscrizioni, allievi] = await Promise.all([
    pool.query(`
      SELECT l.*,
        i.nome AS nome_insegnante, i.cognome AS cognome_insegnante,
        a.nome AS nome_allievo, a.cognome AS cognome_allievo
      FROM lezioni l
      LEFT JOIN insegnanti i ON i.id = l.id_insegnante
      LEFT JOIN allievi a ON a.id = l.id_allievo
      WHERE l.anno_accademico = $1
      ORDER BY l.data, l.ora_inizio
    `, [anno]),
    pool.query(`
      SELECT pm.*, a.nome AS nome_allievo, a.cognome AS cognome_allievo
      FROM pagamenti_mensili pm
      LEFT JOIN allievi a ON a.id = pm.allievo_id
      WHERE pm.anno_accademico = $1
      ORDER BY pm.anno, pm.mese
    `, [anno]),
    pool.query(`
      SELECT qa.*, a.nome AS nome_allievo, a.cognome AS cognome_allievo
      FROM quote_associative qa
      LEFT JOIN allievi a ON a.id = qa.allievo_id
      WHERE qa.anno_accademico = $1
    `, [anno]),
    pool.query(`SELECT * FROM iscrizioni WHERE anno_accademico = $1 ORDER BY created_at`, [anno]),
    pool.query(`
      SELECT a.id, a.nome, a.cognome, a.strumento,
        COUNT(l.id) FILTER (WHERE l.stato = 'svolta')    ::int AS svolte,
        COUNT(l.id) FILTER (WHERE l.stato = 'annullata') ::int AS annullate,
        COUNT(l.id) FILTER (WHERE l.stato = 'rimandata') ::int AS rimandate
      FROM allievi a
      LEFT JOIN lezioni l ON l.id_allievo = a.id AND l.anno_accademico = $1
      GROUP BY a.id, a.nome, a.cognome, a.strumento
      HAVING COUNT(l.id) > 0
      ORDER BY a.cognome, a.nome
    `, [anno]),
  ]);
  return {
    anno,
    generato_il: new Date().toISOString(),
    lezioni: lezioni.rows,
    pagamenti: pagamenti.rows,
    quote_associative: quote.rows,
    iscrizioni: iscrizioni.rows,
    allievi: allievi.rows,
  };
}

// GET /api/admin/archivio/:anno/export-json
router.get('/admin/archivio/:anno/export-json', authenticateToken, requireAdmin, async (req, res) => {
  const { anno } = req.params;
  if (!/^\d{4}-\d{4}$/.test(anno)) return res.status(400).json({ error: 'Formato anno non valido' });
  try {
    const dati = await caricaDatiAnno(anno);
    const json = JSON.stringify(dati, null, 2);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="AMA_backup_${anno}.json"`);
    res.send(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore export JSON' });
  }
});

// GET /api/admin/archivio/:anno/export-pdf
router.get('/admin/archivio/:anno/export-pdf', authenticateToken, requireAdmin, async (req, res) => {
  const { anno } = req.params;
  if (!/^\d{4}-\d{4}$/.test(anno)) return res.status(400).json({ error: 'Formato anno non valido' });
  try {
    const d = await caricaDatiAnno(anno);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="AMA_report_${anno}.pdf"`);
    doc.pipe(res);

    const fmtData = (v) => {
      if (!v) return '—';
      return String(v).slice(0, 10).split('-').reverse().join('/');
    };

    // ── Intestazione ──
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#1e3a5f')
      .text('AMA MUSIC ACADEMY', { align: 'center' });
    doc.fontSize(13).font('Helvetica').fillColor('#555')
      .text(`Report Anno Accademico ${anno}`, { align: 'center' });
    doc.fontSize(9).fillColor('#888')
      .text(`Generato il ${new Date().toLocaleDateString('it-IT')}`, { align: 'center' });
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#1e3a5f').lineWidth(1.5).stroke();
    doc.moveDown(1);

    const sezione = (titolo) => {
      doc.moveDown(0.6);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e3a5f').text(titolo.toUpperCase());
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#c0c8d8').lineWidth(0.5).stroke();
      doc.moveDown(0.4);
    };

    // ── Riepilogo ──
    sezione('Riepilogo generale');
    const svolte    = d.lezioni.filter(l => l.stato === 'svolta').length;
    const annullate = d.lezioni.filter(l => l.stato === 'annullata').length;
    const rimandate = d.lezioni.filter(l => l.stato === 'rimandata').length;
    doc.fontSize(9).font('Helvetica').fillColor('#111');
    doc.text(`Lezioni totali archiviate: ${d.lezioni.length}  (svolte: ${svolte}, annullate: ${annullate}, rimandate: ${rimandate})`);
    doc.text(`Pagamenti mensili: ${d.pagamenti.length}`);
    doc.text(`Quote associative: ${d.quote_associative.length}`);
    doc.text(`Iscrizioni: ${d.iscrizioni.length}`);
    doc.text(`Allievi con lezioni: ${d.allievi.length}`);

    // ── Allievi ──
    sezione('Dettaglio allievi');
    for (const a of d.allievi) {
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#222')
        .text(`${a.cognome} ${a.nome}`, { continued: true });
      doc.font('Helvetica').fillColor('#555')
        .text(`   svolte: ${a.svolte}  annullate: ${a.annullate}  rimandate: ${a.rimandate}`);
    }

    // ── Lezioni ──
    sezione('Lezioni');
    doc.fontSize(8).font('Helvetica').fillColor('#111');
    for (const l of d.lezioni) {
      const chi = l.nome_allievo ? `${l.cognome_allievo} ${l.nome_allievo}` : (l.nome_gruppo || 'Gruppo');
      const ins = l.cognome_insegnante ? `${l.cognome_insegnante} ${l.nome_insegnante}` : '—';
      doc.text(`${fmtData(l.data)}  ${String(l.ora_inizio||'').slice(0,5)}–${String(l.ora_fine||'').slice(0,5)}  ${chi}  [${l.stato}]  ins: ${ins}`);
      if (doc.y > 750) { doc.addPage(); }
    }

    // ── Pagamenti ──
    sezione('Pagamenti mensili');
    doc.fontSize(8).font('Helvetica').fillColor('#111');
    for (const p of d.pagamenti) {
      const allievo = p.cognome_allievo ? `${p.cognome_allievo} ${p.nome_allievo}` : `allievo #${p.allievo_id}`;
      const stato = p.pagato ? 'PAGATO' : 'NON PAGATO';
      doc.text(`${p.anno}/${String(p.mese).padStart(2,'0')}  ${allievo}  €${p.importo ?? '—'}  [${stato}]`);
      if (doc.y > 750) { doc.addPage(); }
    }

    doc.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Errore generazione PDF' });
  }
});

module.exports = router;
