const express    = require('express');
const PDFDocument = require('pdfkit');
const { PDFDocument: PdfLib, rgb, StandardFonts } = require('pdf-lib');
const { Resend }  = require('resend');
const crypto      = require('crypto');
const bcrypt      = require('bcrypt');
const fs         = require('fs');
const path       = require('path');
const { pool }    = require('../db');
const { requireRole, authenticateToken } = require('../Middleware/auth');
const { getAnnoAccademico } = require('../utils/annoAccademico');
const { genUsernameUnique } = require('../utils/helpers');

const TEMPLATE_DIR = path.join(__dirname, '../assets/templates');
const NAVY  = rgb(0.118, 0.227, 0.373);
const GRAY  = rgb(0.333, 0.333, 0.333);
const LGRAY = rgb(0.753, 0.784, 0.847);
const BLACK = rgb(0.067, 0.067, 0.067);
const GREEN = rgb(0.0, 0.45, 0.1);

const router = express.Router();

// Prezzi materie per calcolo quota mensile automatica
const PREZZI_MATERIE = {
  'Canto 45min': 80, 'Canto 1h': 100,
  'Pianoforte 45min': 80, 'Pianoforte 1h': 100,
  'Violino 45min': 80, 'Violino 1h': 100,
  'Chitarra 45min': 80, 'Chitarra 1h': 100,
  'Batteria 45min': 80, 'Batteria 1h': 100,
  'Coro': 40, 'Coro Teen': 30, 'Band': 30, 'Trinity': 10,
};

function calcolaQuotaMensile(strumentoCSV) {
  if (!strumentoCSV) return 0;
  return strumentoCSV.split(',')
    .map(s => s.trim())
    .reduce((sum, nome) => sum + (PREZZI_MATERIE[nome] || 0), 0);
}

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

// ── Mailer (Resend HTTP API — no SMTP) ─────────────────────────────────────
function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// ── Helpers PDF ────────────────────────────────────────────────────────────
function fmtData(d) {
  if (!d) return '—';
  const dt = new Date(d);
  const mesi = ['','Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
    'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  return `${dt.getDate()} ${mesi[dt.getMonth()+1]} ${dt.getFullYear()}`;
}

// Genera le pagine del Regolamento con PDFKit (stile identico ai template AMA)
function generaRegolamentoPDFKit(isc) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const anno = getAnnoAccademico().replace('-', '/');
    const M = 30.5; const W = 534;

    function nuovaPagina(titolo, sottotitolo) {
      doc.addPage({ size: 'A4', margin: 0 });
      // Banda superiore grigia (come nei template)
      doc.rect(0, 0, 595, 60.5).fill('#f0f0f0');
      // Testo indirizzo in alto a destra
      doc.fontSize(6).font('Helvetica').fillColor('#555')
        .text('Viale Felissent, 14 — Treviso (TV)', 0, 25, { align: 'right', width: 565 });
      doc.fontSize(6).fillColor('#555')
        .text('amamusicacademy.it · WhatsApp 375 668 8094', 0, 35, { align: 'right', width: 565 });
      // "MODULO UFFICIALE..."
      doc.fontSize(6).font('Helvetica-Bold').fillColor('#1e3a5f')
        .text('MODULO UFFICIALE · AMA ACADEMY OF MUSICAL ARTS', M, 74, { width: W });
      // Titolo documento
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#1e3a5f')
        .text(titolo, M, 90, { width: W });
      if (sottotitolo) {
        doc.fontSize(7).font('Helvetica').fillColor('#555')
          .text(sottotitolo, M, 112, { width: W });
      }
      // Linea separatrice
      doc.moveTo(M, 125).lineTo(M + W, 125).strokeColor('#1e3a5f').lineWidth(0.6).stroke();
      // Footer
      doc.rect(0, 681, 595, 30).fill('#f0f0f0');
      doc.fontSize(6).font('Helvetica').fillColor('#555')
        .text('AMA · Academy of Musical Arts   Viale Felissent, 14 – Treviso   amamusicacademy.it   @ama_academy_of_musical_arts',
          0, 694, { align: 'center', width: 595 });
      doc.y = 138;
    }

    function sezione(titolo) {
      if (doc.y > 640) nuovaPagina('Regolamento Interno (continua)', `Anno accademico ${anno}`);
      doc.moveDown(0.4);
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1e3a5f')
        .text(titolo.toUpperCase(), M, doc.y, { width: W });
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor('#c0c8d8').lineWidth(0.4).stroke();
      doc.moveDown(0.3);
    }

    function paragrafo(testo) {
      const linee = testo.split('\n');
      for (const linea of linee) {
        if (doc.y > 650) nuovaPagina('Regolamento Interno (continua)', `Anno accademico ${anno}`);
        doc.fontSize(8).font('Helvetica').fillColor('#111')
          .text(linea.trim() || ' ', M, doc.y, { width: W, align: 'justify', lineGap: 1.5 });
        if (linea.trim() === '') doc.moveDown(0.2);
      }
      doc.moveDown(0.3);
    }

    nuovaPagina('Regolamento Interno', `Anno accademico ${anno}`);

    sezione('Iscrizione e tesseramento');
    paragrafo('L\'iscrizione al corso prescelto deve essere effettuata a seguito del tesseramento all\'associazione stessa, tramite versamento della quota associativa di 50 euro.');

    sezione('Corsi ordinari');
    paragrafo('Il percorso di studi si articola in 36 (trentasei) lezioni da settembre a maggio, secondo il calendario corsi annuale. Non rientrano nel percorso di studi eventuali masterclass o corsi extra organizzati dall\'associazione.\n\nLa durata delle lezioni è così articolata:\n— 45 o 60 minuti per i corsi individuali, in base alla tipologia di percorso scelto (€ 80 o € 100 mensili);\n— 60 minuti per i corsi di gruppo (€ 30 mensili).\n\nLe prove, i saggi, i concerti e gli eventi organizzati dall\'Accademia ai quali l\'allievo è convocato sono considerati attività didattiche a tutti gli effetti e vengono conteggiati tra le 36 lezioni previste. Gli allievi non coinvolti nello spettacolo finale potranno partecipare a concerti nella sala interna dell\'Accademia senza costo aggiuntivo. La partecipazione non dà diritto a lezioni aggiuntive, recuperi, riduzioni o rimborsi.');

    sezione('Modalità di pagamento');
    paragrafo('Il costo del percorso formativo è determinato su base annuale e comprende complessivamente 36 lezioni, distribuite nei 9 mesi dell\'anno accademico (settembre–maggio). L\'importo viene suddiviso in 9 quote mensili di pari importo, da versare entro la prima lezione di ciascun mese.\n\nLa quota mensile non corrisponde al numero effettivo di lezioni del singolo mese, ma rappresenta una rata del costo annuale complessivo. La programmazione prevede una media di 4 lezioni al mese: alcuni mesi potranno averne 3, altri 4 o 5, senza variazioni dell\'importo mensile.\n\nLa quota deve essere corrisposta integralmente, indipendentemente dalla presenza dell\'allievo. Non sono consentite riduzioni, compensazioni o ricalcoli. In caso di mancato pagamento nei termini, il tesseramento decade e le lezioni vengono sospese, senza diritto a rimborso.');

    sezione('Orari di frequenza');
    paragrafo('Gli orari delle lezioni vengono concordati tra alunno ed insegnante, secondo le disponibilità dell\'insegnante e dell\'Accademia. Nel rispetto di tutti gli studenti e degli insegnanti si chiede la massima puntualità.');

    sezione('Spettacolo finale di giugno (Loggia dei Cavalieri)');
    paragrafo('La partecipazione allo spettacolo finale è riservata agli allievi che abbiano frequentato con assiduità e siano ritenuti pronti dal proprio docente, in accordo con la Direttrice artistica.\n\nPer ciascun allievo coinvolto è prevista:\n— quota di partecipazione di € 50,00 (comprensiva di prova generale e spettacolo);\n— quota aggiuntiva di € 10,00 per la maglietta ufficiale dell\'Accademia.\n\nImporto complessivo: € 60,00, da versare entro il 15 maggio. Le quote versate non sono rimborsabili in caso di rinuncia, salvo annullamento dello spettacolo da parte dell\'Accademia.');

    sezione('Assenze e recupero delle lezioni');
    paragrafo('In caso di impossibilità a partecipare, l\'allievo deve informare tempestivamente il proprio docente. Per le lezioni individuali sono previsti massimo 3 (tre) recuperi per anno accademico, riconosciuti solo se l\'assenza è comunicata con almeno 24 ore di preavviso.\n\nAssenze comunicate con meno di 24 ore di preavviso, o in caso di assenza senza avviso, la lezione è considerata svolta e persa senza possibilità di recupero o rimborso.\n\nLe lezioni di recupero devono essere effettuate entro il 31 maggio, in data e orario stabiliti dal docente. Qualora l\'allievo non accetti la proposta, il recupero è definitivamente perso. In caso di mancata presentazione a un recupero concordato, la lezione è persa e non riprogrammabile.\n\nIn caso di ritiro anticipato, i recuperi devono essere effettuati entro l\'ultimo mese regolarmente pagato.\n\nLe lezioni di gruppo non sono recuperabili. In caso di assenza del docente, l\'Accademia garantirà una sostituzione o il recupero in data successiva, non conteggiato tra i 3 recuperi annuali.');

    sezione('Ritiro dalle lezioni');
    paragrafo('L\'iscrizione è riferita all\'intero percorso annuale. Le comunicazioni di ritiro devono pervenire entro 30 giorni: nel rispetto di tale termine le quote successive ai 30 giorni non saranno dovute. Con il ritiro decade anche il tesseramento annuale, senza possibilità di rimborso della quota di iscrizione.');

    sezione('Percorso di preparazione agli esami Trinity');
    paragrafo('Gli allievi interessati al percorso Trinity devono comunicarlo alla Segreteria all\'inizio dell\'anno accademico. Il percorso comprende: la consueta lezione individuale; un incontro mensile di solfeggio di gruppo (€ 10,00 ciascuno); l\'acquisto del materiale didattico Trinity.\n\nIl docente individuerà il grado più adeguato. L\'iscrizione all\'esame è subordinata alla valutazione del docente. Gli esami si svolgono in aprile, maggio o giugno. Al costo d\'esame si aggiunge un contributo di € 20,00 per spese di Segreteria. Trinity rilascerà la certificazione ufficiale con votazione e pergamena.');

    sezione('Crediti formativi');
    paragrafo('L\'Accademia rilascia idonea documentazione relativa ai crediti scolastici agli allievi che ne presentano specifica richiesta.');

    // Firma per presa visione
    doc.moveDown(0.8);
    if (doc.y > 580) nuovaPagina('Regolamento Interno (continua)', `Anno accademico ${anno}`);
    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor('#c0c8d8').lineWidth(0.4).stroke();
    doc.moveDown(0.5);

    const firmaY = doc.y;

    // Firma allievo/genitore
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#1e3a5f')
      .text('PER PRESA VISIONE — ALLIEVO / GENITORE', M, firmaY, { width: 250 });
    doc.fontSize(8).font('Helvetica').fillColor('#555')
      .text(`Treviso, ${fmtData(isc.created_at)}`, M, firmaY + 12, { width: 250 });

    // Immagine firma allievo (se presente)
    if (isc.firma_allievo) {
      try {
        const b64 = isc.firma_allievo.replace(/^data:image\/\w+;base64,/, '');
        doc.image(Buffer.from(b64, 'base64'), M, firmaY + 24, { fit: [200, 38] });
      } catch {}
    }
    // Riga firma allievo
    doc.moveTo(M, firmaY + 66).lineTo(M + 240, firmaY + 66).strokeColor('#c0c8d8').lineWidth(0.4).stroke();

    // Firma presidente
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#1e3a5f')
      .text('FIRMA DEL PRESIDENTE', M + 280, firmaY, { width: 250 });
    if (isc.firma_presidente) {
      try {
        const b64 = isc.firma_presidente.replace(/^data:image\/\w+;base64,/, '');
        doc.image(Buffer.from(b64, 'base64'), M + 280, firmaY + 24, { fit: [200, 38] });
      } catch {}
    }
    // Riga firma presidente
    doc.moveTo(M + 280, firmaY + 66).lineTo(M + 280 + 240, firmaY + 66).strokeColor('#c0c8d8').lineWidth(0.4).stroke();

    doc.end();
  });
}

async function generatePDF(isc, { withPresidente = false } = {}) {
  const H = 842; // altezza A4 in pt (pdf-lib usa y dal basso)

  // Converte coordinata y pdfplumber (origine in alto) → pdf-lib (origine in basso)
  const py = (ppy, fontSize = 10) => H - ppy - fontSize;

  // Helper embed firma base64
  async function embedFirma(pdfDoc, b64str) {
    if (!b64str) return null;
    try {
      const data = b64str.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(data, 'base64');
      return b64str.includes('image/png')
        ? await pdfDoc.embedPng(buf)
        : await pdfDoc.embedJpg(buf);
    } catch { return null; }
  }

  // ── 1. Modulo Iscrizione — overlay su template ──────────────────────────
  const modIscBytes = fs.readFileSync(path.join(TEMPLATE_DIR, 'AMA_Modulo_Iscrizione.pdf'));
  const modIscDoc = await PdfLib.load(modIscBytes);
  const [pageModulo] = modIscDoc.getPages();
  const fontM  = await modIscDoc.embedFont(StandardFonts.Helvetica);
  const fontMB = await modIscDoc.embedFont(StandardFonts.HelveticaBold);

  const drawM = (text, x, ppy, opts = {}) => {
    const size = opts.size || 9.5;
    pageModulo.drawText(String(text || ''), {
      x, y: py(ppy, size), size,
      font: opts.bold ? fontMB : fontM,
      color: opts.color || BLACK,
    });
  };
  const checkM = (val, x, ppy) => {
    if (!val) return;
    pageModulo.drawText('X', { x: x + 1, y: py(ppy, 9), size: 9, font: fontMB, color: NAVY });
  };

  // Helper: rettangolo bianco per coprire testo template
  const whiteM = (x, ppy, w, h) => pageModulo.drawRectangle({
    x, y: py(ppy, 0) - h, width: w, height: h + 2,
    color: rgb(1, 1, 1), borderWidth: 0,
  });

  // ── Data "Presentata il" (copre il placeholder ____/____/2026) ──
  whiteM(175, 111, 90, 11);
  drawM(fmtData(isc.created_at), 175, 111, { size: 9 });

  // Allievo
  drawM(`${isc.nome} ${isc.cognome}`, 46, 190);
  drawM(isc.codice_fiscale, 347, 190);
  drawM(fmtData(isc.data_nascita), 46, 222);
  drawM(isc.luogo_nascita, 347, 222);
  const indAllievo = [isc.indirizzo, isc.cap, isc.citta, isc.provincia ? `(${isc.provincia})` : ''].filter(Boolean).join(' ');
  drawM(indAllievo, 46, 254);
  drawM(isc.telefono, 46, 286);
  drawM(isc.email, 347, 286);

  // Genitore
  if (isc.minore) {
    drawM(`${isc.genitore_nome || ''} ${isc.genitore_cognome || ''}`.trim(), 46, 366);
    drawM(isc.genitore_cf, 347, 366);
    drawM(isc.genitore_telefono, 46, 398);
    drawM(isc.genitore_email, 347, 398);
  }

  // ── Sezione corso ───────────────────────────────────────────────────────
  // Copri "DURATA LEZIONE" e "INSEGNANTE (SE RICHIESTO)" dal template
  whiteM(217, 467.7, 360, 11); // copre entrambe le label
  // Scrivi nuova label "EROGAZIONE LIBERALE MENSILE" e corsi
  drawM('EROGAZIONE LIBERALE MENSILE', 217, 467.7, { size: 7.5, bold: true, color: NAVY });
  drawM(isc.strumento, 46, 479);
  const quotaMensile = isc.quota_mensile || calcolaQuotaMensile(isc.strumento);
  drawM(`€ ${quotaMensile},00 / mese`, 217, 479);

  // Checkboxes
  checkM(isc.acc_tesseramento, 47, 548);
  checkM(isc.acc_regolamento,  47, 566);
  checkM(isc.acc_privacy,      47, 584);
  checkM(isc.acc_immagini,     47, 602);

  // ── Firma ───────────────────────────────────────────────────────────────
  // La riga firma nel template è a pdfplumber y≈653.5 → pdf-lib y=188.5
  // Posizionare l'immagine firma SOPRA la riga (y dal basso = 188.5, altezza 40)
  const FIRMA_LINE_Y = 188.5; // pdf-lib y della riga firma (= py(653.5, 0))
  const FIRMA_H = 38;

  const firmaAllImg = await embedFirma(modIscDoc, isc.firma_allievo);
  if (firmaAllImg) {
    pageModulo.drawImage(firmaAllImg, { x: 31, y: FIRMA_LINE_Y, width: 170, height: FIRMA_H });
  }
  if (withPresidente) {
    const firmaPres = await embedFirma(modIscDoc, isc.firma_presidente);
    if (firmaPres) {
      pageModulo.drawImage(firmaPres, { x: 298, y: FIRMA_LINE_Y, width: 170, height: FIRMA_H });
    }
  }

  const modIscFinal = await modIscDoc.save();

  // ── 2. Informativa Privacy — overlay su template ────────────────────────
  const privacyBytes = fs.readFileSync(path.join(TEMPLATE_DIR, 'AMA_Informativa_Privacy.pdf'));
  const privacyDoc = await PdfLib.load(privacyBytes);
  const [pagePrivacy] = privacyDoc.getPages();
  const fontP  = await privacyDoc.embedFont(StandardFonts.Helvetica);
  const fontPB = await privacyDoc.embedFont(StandardFonts.HelveticaBold);

  const checkP = (val, x, ppy) => {
    if (!val) return;
    pagePrivacy.drawText('X', { x: x + 1, y: py(ppy, 9), size: 9, font: fontPB, color: NAVY });
  };

  checkP(isc.acc_privacy,  47, 506);
  checkP(isc.acc_immagini, 47, 524);

  // Riga firma privacy: RECT a pdfplumber y=586.1 → pdf-lib y=255.9
  const PRIV_LINE_Y = 842 - 586.1; // = 255.9
  const PRIV_FIRMA_H = 36;

  pagePrivacy.drawText(`Treviso, ${fmtData(isc.created_at)}`, {
    x: 31, y: PRIV_LINE_Y, size: 8.5, font: fontP, color: BLACK,
  });

  const firmaAllPriv = await embedFirma(privacyDoc, isc.firma_allievo);
  if (firmaAllPriv) {
    pagePrivacy.drawImage(firmaAllPriv, { x: 298, y: PRIV_LINE_Y, width: 170, height: PRIV_FIRMA_H });
  }

  const privacyFinal = await privacyDoc.save();

  // ── 3. Regolamento — overlay su template ──────────────────────────────
  const regBytes = fs.readFileSync(path.join(TEMPLATE_DIR, 'AMA_Regolamento_Interno.pdf'));
  const regDoc = await PdfLib.load(regBytes);
  const pages = regDoc.getPages();
  const lastPage = pages[pages.length - 1]; // firma sulla pagina finale
  const fontR  = await regDoc.embedFont(StandardFonts.Helvetica);

  // Riga firma regolamento: RECT a pdfplumber y=700.2 → pdf-lib y=141.8
  const REG_LINE_Y = 842 - 700.2; // = 141.8
  const REG_FIRMA_H = 38;

  // Data "Luogo e data"
  lastPage.drawText(`Treviso, ${fmtData(isc.created_at)}`, {
    x: 31, y: REG_LINE_Y, size: 8.5, font: fontR, color: BLACK,
  });

  // Firma allievo/richiedente
  const firmaAllReg = await embedFirma(regDoc, isc.firma_allievo);
  if (firmaAllReg) {
    lastPage.drawImage(firmaAllReg, { x: 298, y: REG_LINE_Y, width: 170, height: REG_FIRMA_H });
  }

  const regolamentoBuffer = await regDoc.save();

  // ── 4. Allegati documenti — generati con PDFKit ─────────────────────────
  const allegatiList = [
    { label: "Documento d'identità allievo/a — fronte", b64: isc.doc_allievo_fronte },
    { label: "Documento d'identità allievo/a — retro",  b64: isc.doc_allievo_retro },
    { label: "Documento d'identità genitore — fronte",  b64: isc.doc_genitore_fronte },
    { label: "Documento d'identità genitore — retro",   b64: isc.doc_genitore_retro },
  ].filter(a => a.b64);

  let allegatiBuffer = null;
  if (allegatiList.length > 0) {
    allegatiBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const LM = 30.5, LW = 534;
      for (const all of allegatiList) {
        doc.addPage({ size: 'A4', margin: 0 });
        doc.rect(0, 0, 595, 60.5).fill('#f0f0f0');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#1e3a5f')
          .text('MODULO UFFICIALE · AMA ACADEMY OF MUSICAL ARTS', LM, 74, { width: LW });
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f')
          .text('Allegati — Copie Documenti Identità', LM, 90, { width: LW });
        doc.fontSize(9).font('Helvetica').fillColor('#555')
          .text(all.label, LM, 115, { width: LW });
        doc.moveTo(LM, 130).lineTo(LM + LW, 130).strokeColor('#1e3a5f').lineWidth(0.6).stroke();
        try {
          const data = all.b64.replace(/^data:image\/\w+;base64,/, '');
          doc.image(Buffer.from(data, 'base64'), LM, 145, { fit: [LW, 520], align: 'center' });
        } catch {}
        doc.rect(0, 681, 595, 30).fill('#f0f0f0');
        doc.fontSize(6).font('Helvetica').fillColor('#555')
          .text('AMA · Academy of Musical Arts   Viale Felissent, 14 – Treviso   amamusicacademy.it', 0, 694, { align: 'center', width: 595 });
      }
      doc.end();
    });
  }

  // ── 5. Unisci tutto con pdf-lib ─────────────────────────────────────────
  const merged = await PdfLib.create();
  for (const pdfBytes of [modIscFinal, privacyFinal, regolamentoBuffer, allegatiBuffer].filter(Boolean)) {
    const src = await PdfLib.load(pdfBytes);
    const srcPages = await merged.copyPages(src, src.getPageIndices());
    srcPages.forEach(p => merged.addPage(p));
  }

  return Buffer.from(await merged.save());
}

// ── Invio email (Resend HTTP API) ───────────────────────────────────────────
async function inviaEmailDirezione(isc, pdfBuffer) {
  if (!process.env.RESEND_API_KEY) return;
  const resend = getResend();
  const from = process.env.EMAIL_FROM || 'AMA Music Academy <noreply@amamusicacademy.it>';
  await resend.emails.send({
    from,
    to:      process.env.SEGRETERIA_EMAIL || 'segreteria@amamusicacademy.it',
    subject: `Nuova domanda di iscrizione — ${isc.nome} ${isc.cognome}`,
    html: `
      <p>È stata ricevuta una nuova domanda di iscrizione da <strong>${isc.nome} ${isc.cognome}</strong>.</p>
      <p>Materie richieste: <strong>${isc.strumento || '—'}</strong></p>
      <p>Email: ${isc.email} — Telefono: ${isc.telefono}</p>
      <p>In allegato il modulo completo. Accedi all'app amministratore per accettare o rifiutare la domanda.</p>
    `,
    attachments: [{ filename: `iscrizione_${isc.nome}_${isc.cognome}.pdf`, content: pdfBuffer.toString('base64') }],
  });
  console.log('[email] Email direzione inviata');
}

async function inviaEmailAllievo(isc, pdfBuffer, tempPassword = null) {
  const dest = isc.minore ? isc.genitore_email : isc.email;
  console.log(`[email] inviaEmailAllievo → dest=${dest} RESEND_API_KEY=${process.env.RESEND_API_KEY ? 'configurata' : '(non configurata)'}`);
  if (!process.env.RESEND_API_KEY || !dest) {
    console.warn('[email] Invio saltato: RESEND_API_KEY o destinatario mancante');
    return;
  }
  const resend = getResend();
  const from = process.env.EMAIL_FROM || 'AMA Music Academy <noreply@amamusicacademy.it>';
  const usernameLogin = isc._username || (isc.email || '').toLowerCase().trim();
  const credenzialiHtml = tempPassword ? `
    <p style="margin-top:16px;padding:12px 16px;background:#f0f4ff;border-left:4px solid #3b5bdb;border-radius:4px;">
      <strong>Le tue credenziali di accesso all'app:</strong><br>
      Username: <code>${usernameLogin}</code><br>
      Password temporanea: <code>${tempPassword}</code><br>
      <small>Al primo accesso ti verrà chiesto di cambiarla.</small><br><br>
      <a href="https://amamusicacademy.it/guida-webapp/" style="color:#3b5bdb;">Guida all'accesso e utilizzo dell'app →</a>
    </p>` : '';
  await resend.emails.send({
    from,
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
    attachments: [{ filename: `conferma_iscrizione_${isc.nome}_${isc.cognome}.pdf`, content: pdfBuffer.toString('base64') }],
  });
  console.log(`[email] Email inviata a ${dest}`);
}

// ── POST /api/iscrizione — invio modulo (pubblico) ─────────────────────────
router.post('/iscrizione', async (req, res) => {
  const {
    nome, cognome, codice_fiscale, data_nascita, luogo_nascita,
    indirizzo, cap, citta, provincia, telefono, email, materie, note,
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
      indirizzo, cap, citta, provincia, telefono, email,
      Array.isArray(materie) ? materie.join(', ') : (materie || ''), note,
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
       FROM iscrizioni WHERE stato=$1 AND anno_accademico IS NULL ORDER BY created_at DESC`,
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

    // ── Crea o riattiva allievo + utente ─────────────────────────────────
    let tempPassword = null;
    let allievoId = null;
    let riattivato = false;
    try {
      // Cerca allievo esistente per codice fiscale (riiscrizione dopo chiusura anno)
      const esistente = isc.codice_fiscale
        ? await pool.query(`SELECT id FROM allievi WHERE codice_fiscale = $1 LIMIT 1`, [isc.codice_fiscale])
        : { rows: [] };

      if (esistente.rows.length > 0) {
        // Riattiva allievo esistente aggiornando i dati
        allievoId = esistente.rows[0].id;
        riattivato = true;
        await pool.query(`
          UPDATE allievi SET
            nome=$1, cognome=$2, email=$3, telefono=$4, strumento=$5,
            data_nascita=$6, note=$7, quota_mensile=$8,
            luogo_nascita=$9, indirizzo=$10, cap=$11, citta=$12, provincia=$13,
            minore=$14,
            genitore_nome=$15, genitore_cognome=$16, genitore_cf=$17,
            genitore_data_nascita=$18, genitore_luogo_nascita=$19, genitore_indirizzo=$20,
            genitore_telefono=$21, genitore_email=$22,
            attivo=TRUE, data_fine=NULL, data_iscrizione=NOW(),
            accettazione_reg=TRUE, data_accettazione_reg=NOW()
          WHERE id=$23
        `, [
          isc.nome, isc.cognome, isc.email, isc.telefono, isc.strumento,
          isc.data_nascita || null, isc.note, calcolaQuotaMensile(isc.strumento),
          isc.luogo_nascita, isc.indirizzo, isc.cap, isc.citta, isc.provincia,
          !!isc.minore,
          isc.genitore_nome, isc.genitore_cognome, isc.genitore_cf,
          isc.genitore_data_nascita || null, isc.genitore_luogo_nascita, isc.genitore_indirizzo,
          isc.genitore_telefono, isc.genitore_email,
          allievoId,
        ]);
      } else {
        // Nuovo allievo
        const { rows: ar } = await pool.query(
          `INSERT INTO allievi (nome, cognome, email, telefono, strumento, data_nascita, note, data_iscrizione, quota_mensile)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8) RETURNING id`,
          [isc.nome, isc.cognome, isc.email, isc.telefono, isc.strumento, isc.data_nascita || null, isc.note,
           calcolaQuotaMensile(isc.strumento)]
        );
        allievoId = ar[0].id;
        await pool.query(`
          UPDATE allievi SET
            codice_fiscale=$1, luogo_nascita=$2, indirizzo=$3, cap=$4, citta=$5, provincia=$6,
            minore=$7,
            genitore_nome=$8, genitore_cognome=$9, genitore_cf=$10,
            genitore_data_nascita=$11, genitore_luogo_nascita=$12, genitore_indirizzo=$13,
            genitore_telefono=$14, genitore_email=$15,
            attivo=TRUE, accettazione_reg=TRUE, data_accettazione_reg=NOW()
          WHERE id=$16
        `, [
          isc.codice_fiscale, isc.luogo_nascita, isc.indirizzo, isc.cap, isc.citta, isc.provincia,
          !!isc.minore,
          isc.genitore_nome, isc.genitore_cognome, isc.genitore_cf,
          isc.genitore_data_nascita || null, isc.genitore_luogo_nascita, isc.genitore_indirizzo,
          isc.genitore_telefono, isc.genitore_email,
          allievoId,
        ]);
      }

      // Crea nuovo account (vecchio è stato eliminato alla chiusura anno)
      tempPassword = crypto.randomBytes(5).toString('hex');
      const hash = await bcrypt.hash(tempPassword, 10);
      const username = await genUsernameUnique(isc.nome, isc.cognome, pool, allievoId);
      await pool.query(
        `INSERT INTO utenti (username, password, ruolo, allievo_id, must_change_password)
         VALUES ($1,$2,'allievo',$3,TRUE)
         ON CONFLICT (username) DO UPDATE SET password=EXCLUDED.password, allievo_id=EXCLUDED.allievo_id, must_change_password=TRUE`,
        [username, hash, allievoId]
      );
      isc._username = username; // usato nell'email

      await pool.query('UPDATE iscrizioni SET allievo_id=$1 WHERE id=$2', [allievoId, req.params.id]);
    } catch (e) {
      console.error('Errore creazione/riattivazione allievo:', e);
    }

    // Genera PDF con firma presidente e invia all'allievo
    generatePDF(isc, { withPresidente: true })
      .then(pdf => inviaEmailAllievo(isc, pdf, tempPassword))
      .catch(err => console.error('[email] Errore generazione PDF o invio email:', err.message));

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
