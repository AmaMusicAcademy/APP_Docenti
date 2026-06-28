const express    = require('express');
const PDFDocument = require('pdfkit');
const nodemailer  = require('nodemailer');
const crypto      = require('crypto');
const bcrypt      = require('bcrypt');
const { pool }    = require('../db');
const { requireRole, authenticateToken } = require('../Middleware/auth');

const router = express.Router();

// ── Tabella iscrizioni ─────────────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS iscrizioni (
    id                       SERIAL PRIMARY KEY,
    -- dati allievo
    nome                     TEXT NOT NULL,
    cognome                  TEXT NOT NULL,
    codice_fiscale           TEXT,
    data_nascita             DATE,
    luogo_nascita            TEXT,
    indirizzo                TEXT,
    cap                      TEXT,
    citta                    TEXT,
    provincia                TEXT,
    telefono                 TEXT,
    email                    TEXT,
    strumento                TEXT,
    note                     TEXT,
    -- minore
    minore                   BOOLEAN DEFAULT FALSE,
    -- genitore/tutore
    genitore_nome            TEXT,
    genitore_cognome         TEXT,
    genitore_cf              TEXT,
    genitore_data_nascita    DATE,
    genitore_luogo_nascita   TEXT,
    genitore_indirizzo       TEXT,
    genitore_telefono        TEXT,
    genitore_email           TEXT,
    -- consensi
    acc_tesseramento         BOOLEAN DEFAULT FALSE,
    acc_regolamento          BOOLEAN DEFAULT FALSE,
    acc_privacy              BOOLEAN DEFAULT FALSE,
    acc_immagini             BOOLEAN DEFAULT FALSE,
    -- documenti (base64 data-url)
    doc_allievo_fronte       TEXT,
    doc_allievo_retro        TEXT,
    doc_genitore_fronte      TEXT,
    doc_genitore_retro       TEXT,
    -- firme
    firma_allievo            TEXT,
    firma_presidente         TEXT,
    -- stato
    stato                    TEXT DEFAULT 'in_attesa',
    token_download           TEXT UNIQUE,
    -- date
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    accettata_il             TIMESTAMPTZ
  )
`).catch(() => {});

// Aggiunge cap/citta/provincia ad allievi se non presenti
pool.query(`
  ALTER TABLE allievi
  ADD COLUMN IF NOT EXISTS cap      TEXT,
  ADD COLUMN IF NOT EXISTS citta    TEXT,
  ADD COLUMN IF NOT EXISTS provincia TEXT
`).catch(() => {});

pool.query(`ALTER TABLE iscrizioni ADD COLUMN IF NOT EXISTS motivazione_rifiuto TEXT`).catch(() => {});
pool.query(`ALTER TABLE iscrizioni ADD COLUMN IF NOT EXISTS allievo_id INTEGER`).catch(() => {});

// ── Mailer ─────────────────────────────────────────────────────────────────
function createTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ── Generatore PDF ─────────────────────────────────────────────────────────
function fmtData(d) {
  if (!d) return '—';
  const dt = new Date(d);
  const mesi = ['','Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
    'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  return `${dt.getDate()} ${mesi[dt.getMonth()+1]} ${dt.getFullYear()}`;
}

function generatePDF(isc, { withPresidente = false } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Intestazione ──
    doc.fontSize(18).font('Helvetica-Bold')
      .fillColor('#1e3a5f')
      .text('AMA MUSIC ACADEMY', { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#555')
      .text('Via [indirizzo accademia] — info@amamusicacademy.it', { align: 'center' });
    doc.moveDown(0.5);

    // Linea separatrice
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#1e3a5f').lineWidth(1.5).stroke();
    doc.moveDown(0.8);

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e3a5f')
      .text('DOMANDA DI ISCRIZIONE', { align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor('#777')
      .text(`Presentata il ${fmtData(isc.created_at)}`, { align: 'center' });
    doc.moveDown(1);

    // ── Helper sezione ──
    const sezione = (titolo) => {
      doc.moveDown(0.4);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e3a5f').text(titolo.toUpperCase());
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#c0c8d8').lineWidth(0.5).stroke();
      doc.moveDown(0.3);
    };

    const riga = (label, val) => {
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#333').text(label + '  ', { continued: true });
      doc.font('Helvetica').fillColor('#111').text(val || '—');
    };

    // ── Dati allievo ──
    sezione('Dati personali allievo');
    riga('Nome e Cognome:', `${isc.nome} ${isc.cognome}`);
    riga('Codice Fiscale:', isc.codice_fiscale);
    riga('Data di nascita:', fmtData(isc.data_nascita));
    riga('Luogo di nascita:', isc.luogo_nascita);
    riga('Indirizzo:', `${isc.indirizzo || '—'}, ${isc.cap || ''} ${isc.citta || ''} (${isc.provincia || ''})`);
    riga('Telefono:', isc.telefono);
    riga('Email:', isc.email);
    riga('Strumento richiesto:', isc.strumento);

    // ── Genitore ──
    if (isc.minore) {
      sezione('Dati genitore / tutore (allievo minorenne)');
      riga('Nome e Cognome:', `${isc.genitore_nome || ''} ${isc.genitore_cognome || ''}`);
      riga('Codice Fiscale:', isc.genitore_cf);
      riga('Data di nascita:', fmtData(isc.genitore_data_nascita));
      riga('Luogo di nascita:', isc.genitore_luogo_nascita);
      riga('Indirizzo:', isc.genitore_indirizzo);
      riga('Telefono:', isc.genitore_telefono);
      riga('Email:', isc.genitore_email);
    }

    // ── Dichiarazioni ──
    sezione('Dichiarazioni e consensi');
    const checkmark = (val) => val ? '☑' : '☐';
    doc.fontSize(9).font('Helvetica').fillColor('#111');
    doc.text(`${checkmark(isc.acc_tesseramento)}  Sottoscrizione domanda di tesseramento`);
    doc.text(`${checkmark(isc.acc_regolamento)}  Accettazione del regolamento interno`);
    doc.text(`${checkmark(isc.acc_privacy)}  Consenso al trattamento dei dati personali (obbligatorio)`);
    doc.text(`${checkmark(isc.acc_immagini)}  Consenso all'uso delle immagini (facoltativo)`);

    // ── Firma allievo/genitore ──
    sezione(isc.minore ? 'Firma genitore/tutore' : 'Firma allievo');
    if (isc.firma_allievo) {
      try {
        const imgData = isc.firma_allievo.replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(imgData, 'base64');
        doc.image(imgBuf, { width: 200, height: 70 });
      } catch {}
    }

    // ── Firma presidente (solo se accettata) ──
    if (withPresidente && isc.firma_presidente) {
      sezione('Firma del Presidente');
      try {
        const imgData = isc.firma_presidente.replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(imgData, 'base64');
        doc.image(imgBuf, { width: 200, height: 70 });
      } catch {}
      riga('Data accettazione:', fmtData(isc.accettata_il));
    }

    // ── Note ──
    if (isc.note) {
      sezione('Note');
      doc.fontSize(9).font('Helvetica').fillColor('#111').text(isc.note);
    }

    // ── Footer ──
    doc.moveDown(2);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#c0c8d8').lineWidth(0.5).stroke();
    doc.moveDown(0.3);
    doc.fontSize(8).fillColor('#999')
      .text('AMA Music Academy — Documento generato automaticamente', { align: 'center' });

    doc.end();
  });
}

// ── Invio email ─────────────────────────────────────────────────────────────
async function inviaEmailDirezione(isc, pdfBuffer) {
  if (!process.env.SMTP_USER) return; // SMTP non configurato
  const transport = createTransport();
  await transport.sendMail({
    from:    `"AMA Music Academy" <${process.env.SMTP_USER}>`,
    to:      process.env.SEGRETERIA_EMAIL || 'segreteria@amamusicacademy.it',
    subject: `Nuova domanda di iscrizione — ${isc.nome} ${isc.cognome}`,
    html: `
      <p>È stata ricevuta una nuova domanda di iscrizione da <strong>${isc.nome} ${isc.cognome}</strong>.</p>
      <p>Strumento richiesto: <strong>${isc.strumento || '—'}</strong></p>
      <p>Email: ${isc.email} — Telefono: ${isc.telefono}</p>
      <p>In allegato il modulo completo. Accedi all'app amministratore per accettare o rifiutare la domanda.</p>
    `,
    attachments: [{ filename: `iscrizione_${isc.nome}_${isc.cognome}.pdf`, content: pdfBuffer }],
  });
}

async function inviaEmailAllievo(isc, pdfBuffer, tempPassword = null) {
  const dest = isc.minore ? isc.genitore_email : isc.email;
  if (!process.env.SMTP_USER || !dest) return;
  const transport = createTransport();
  const credenzialiHtml = tempPassword ? `
    <p style="margin-top:16px;padding:12px 16px;background:#f0f4ff;border-left:4px solid #3b5bdb;border-radius:4px;">
      <strong>Le tue credenziali di accesso all'app:</strong><br>
      Username: <code>${isc.email}</code><br>
      Password temporanea: <code>${tempPassword}</code><br>
      <small>Al primo accesso ti verrà chiesto di cambiarla.</small>
    </p>` : '';
  await transport.sendMail({
    from:    `"AMA Music Academy" <${process.env.SMTP_USER}>`,
    to:      dest,
    subject: 'Iscrizione AMA Music Academy — Conferma di accettazione',
    html: `
      <p>Gentile ${isc.nome} ${isc.cognome},</p>
      <p>La tua domanda di iscrizione all'<strong>AMA Music Academy</strong> è stata <strong>accettata</strong>.</p>
      ${credenzialiHtml}
      <p>In allegato trovi il modulo firmato dalla direzione.</p>
      <p>Benvenuto/a nella nostra accademia!</p>
      <br><p>AMA Music Academy</p>
    `,
    attachments: [{ filename: `conferma_iscrizione_${isc.nome}_${isc.cognome}.pdf`, content: pdfBuffer }],
  });
}

// ── POST /api/iscrizione — invio modulo (pubblico) ─────────────────────────
router.post('/iscrizione', async (req, res) => {
  const {
    nome, cognome, codice_fiscale, data_nascita, luogo_nascita,
    indirizzo, cap, citta, provincia, telefono, email, strumento, note,
    minore,
    genitore_nome, genitore_cognome, genitore_cf, genitore_data_nascita,
    genitore_luogo_nascita, genitore_indirizzo, genitore_telefono, genitore_email,
    acc_tesseramento, acc_regolamento, acc_privacy, acc_immagini,
    doc_allievo_fronte, doc_allievo_retro,
    doc_genitore_fronte, doc_genitore_retro,
    firma_allievo,
  } = req.body;

  if (!nome || !cognome || !acc_privacy) {
    return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  }

  const token = crypto.randomBytes(24).toString('hex');

  try {
    const { rows } = await pool.query(`
      INSERT INTO iscrizioni (
        nome, cognome, codice_fiscale, data_nascita, luogo_nascita,
        indirizzo, cap, citta, provincia, telefono, email, strumento, note,
        minore,
        genitore_nome, genitore_cognome, genitore_cf, genitore_data_nascita,
        genitore_luogo_nascita, genitore_indirizzo, genitore_telefono, genitore_email,
        acc_tesseramento, acc_regolamento, acc_privacy, acc_immagini,
        doc_allievo_fronte, doc_allievo_retro, doc_genitore_fronte, doc_genitore_retro,
        firma_allievo, token_download
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32
      ) RETURNING *
    `, [
      nome, cognome, codice_fiscale, data_nascita || null, luogo_nascita,
      indirizzo, cap, citta, provincia, telefono, email, strumento, note,
      !!minore,
      genitore_nome, genitore_cognome, genitore_cf, genitore_data_nascita || null,
      genitore_luogo_nascita, genitore_indirizzo, genitore_telefono, genitore_email,
      !!acc_tesseramento, !!acc_regolamento, !!acc_privacy, !!acc_immagini,
      doc_allievo_fronte, doc_allievo_retro, doc_genitore_fronte, doc_genitore_retro,
      firma_allievo, token,
    ]);

    const isc = rows[0];

    // Genera PDF e invia email in background
    generatePDF(isc).then(pdf => inviaEmailDirezione(isc, pdf)).catch(console.error);

    res.json({ ok: true, id: isc.id, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel salvataggio della domanda' });
  }
});

// ── GET /api/admin/iscrizioni — lista per admin ────────────────────────────
router.get('/admin/iscrizioni', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Accesso negato' });
  try {
    const { stato = 'in_attesa' } = req.query;
    const { rows } = await pool.query(
      `SELECT id, nome, cognome, email, telefono, strumento, minore, stato, created_at, accettata_il
       FROM iscrizioni WHERE stato=$1 ORDER BY created_at DESC`,
      [stato]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Errore' }); }
});

// ── GET /api/admin/iscrizioni/:id — dettaglio per admin ───────────────────
router.get('/admin/iscrizioni/:id', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Accesso negato' });
  try {
    const { rows } = await pool.query('SELECT * FROM iscrizioni WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Non trovata' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Errore' }); }
});

// ── PATCH /api/admin/iscrizioni/:id/accetta ────────────────────────────────
router.patch('/admin/iscrizioni/:id/accetta', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Accesso negato' });
  const { firma_presidente } = req.body;
  if (!firma_presidente) return res.status(400).json({ error: 'Firma presidente richiesta' });

  try {
    const { rows } = await pool.query(
      `UPDATE iscrizioni SET stato='accettata', firma_presidente=$1, accettata_il=NOW()
       WHERE id=$2 RETURNING *`,
      [firma_presidente, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Non trovata' });
    const isc = rows[0];

    // ── Crea allievo + utente ──────────────────────────────────────────────
    let tempPassword = null;
    let allievoId = null;
    try {
      // INSERT con soli campi base (sempre presenti) — crea sempre un nuovo allievo
      // (email/telefono condivisi sono ammessi, es. fratelli minorenni con contatti del genitore)
      const { rows: ar } = await pool.query(
        `INSERT INTO allievi (nome, cognome, email, telefono, strumento, data_nascita, note, data_iscrizione, quota_mensile)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),0) RETURNING id`,
        [isc.nome, isc.cognome, isc.email, isc.telefono, isc.strumento, isc.data_nascita || null, isc.note]
      );
      allievoId = ar[0].id;

      // UPDATE con campi estesi
      await pool.query(`
        UPDATE allievi SET
          codice_fiscale=$1, luogo_nascita=$2, indirizzo=$3, cap=$4, citta=$5, provincia=$6,
          minore=$7,
          genitore_nome=$8, genitore_cognome=$9, genitore_cf=$10,
          genitore_data_nascita=$11, genitore_luogo_nascita=$12, genitore_indirizzo=$13,
          genitore_telefono=$14, genitore_email=$15,
          accettazione_reg=TRUE, data_accettazione_reg=NOW()
        WHERE id=$16
      `, [
        isc.codice_fiscale, isc.luogo_nascita, isc.indirizzo, isc.cap, isc.citta, isc.provincia,
        !!isc.minore,
        isc.genitore_nome, isc.genitore_cognome, isc.genitore_cf,
        isc.genitore_data_nascita || null, isc.genitore_luogo_nascita, isc.genitore_indirizzo,
        isc.genitore_telefono, isc.genitore_email,
        allievoId,
      ]);

      // Crea credenziali: username = email se disponibile, altrimenti allievo_{id}
      tempPassword = crypto.randomBytes(5).toString('hex');
      const hash = await bcrypt.hash(tempPassword, 10);
      const username = (isc.email || `allievo_${allievoId}`).toLowerCase().trim();
      await pool.query(
        `INSERT INTO utenti (username, password, ruolo, allievo_id) VALUES ($1,$2,'allievo',$3) ON CONFLICT (username) DO UPDATE SET allievo_id=EXCLUDED.allievo_id`,
        [username, hash, allievoId]
      );

      await pool.query('UPDATE iscrizioni SET allievo_id=$1 WHERE id=$2', [allievoId, req.params.id]);
    } catch (e) {
      console.error('Errore creazione allievo/utente:', e);
    }

    // Genera PDF con firma presidente e invia all'allievo
    generatePDF(isc, { withPresidente: true })
      .then(pdf => inviaEmailAllievo(isc, pdf, tempPassword))
      .catch(console.error);

    res.json({ ok: true, allievoId });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

// ── PATCH /api/admin/iscrizioni/:id/rifiuta ────────────────────────────────
router.patch('/admin/iscrizioni/:id/rifiuta', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Accesso negato' });
  const { motivazione } = req.body || {};
  try {
    // Cerca allievo_id collegato a questa iscrizione
    const { rows } = await pool.query('SELECT allievo_id FROM iscrizioni WHERE id=$1', [req.params.id]);
    const allievoId = rows[0]?.allievo_id;

    await pool.query(
      `UPDATE iscrizioni SET stato='rifiutata', motivazione_rifiuto=$1 WHERE id=$2`,
      [motivazione || null, req.params.id]
    );

    // Cancella allievo e utente creati da questa iscrizione
    if (allievoId) {
      await pool.query('DELETE FROM utenti WHERE allievo_id=$1', [allievoId]);
      await pool.query('DELETE FROM allievi WHERE id=$1', [allievoId]);
    }

    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

// ── GET /api/iscrizione/:token/pdf — download PDF allievo ─────────────────
router.get('/iscrizione/:token/pdf', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM iscrizioni WHERE token_download=$1 AND stato='accettata'`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Non trovata o non ancora accettata' });
    const pdf = await generatePDF(rows[0], { withPresidente: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="iscrizione_${rows[0].nome}_${rows[0].cognome}.pdf"`);
    res.send(pdf);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

module.exports = router;
