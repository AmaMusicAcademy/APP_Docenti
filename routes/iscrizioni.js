const express    = require('express');
const PDFDocument = require('pdfkit');
const nodemailer  = require('nodemailer');
const crypto      = require('crypto');
const bcrypt      = require('bcrypt');
const { pool }    = require('../db');
const { requireRole, authenticateToken } = require('../Middleware/auth');
const { getAnnoAccademico } = require('../utils/annoAccademico');

const router = express.Router();

// Prezzi materie per calcolo quota mensile automatica
const PREZZI_MATERIE = {
  'Canto 45min': 80, 'Canto 1h': 100,
  'Pianoforte 45min': 80, 'Pianoforte 1h': 100,
  'Violino 45min': 80, 'Violino 1h': 100,
  'Chitarra 45min': 80, 'Chitarra 1h': 100,
  'Batteria 45min': 80, 'Batteria 1h': 100,
  'Coro': 30, 'Band': 30, 'Teoria e Solfeggio': 30,
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
    const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: false });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const M = 50;           // margine laterale
    const W = 595 - M * 2; // larghezza utile
    const NAVY  = '#1e3a5f';
    const GRAY  = '#555555';
    const LGRAY = '#c0c8d8';
    const BLACK = '#111111';
    const anno  = getAnnoAccademico().replace('-', '/');

    // ── Helper: intestazione AMA ──────────────────────────────────────────
    function intestazione(titoloDoc, sottotitolo = '') {
      doc.addPage();
      doc.fontSize(7).font('Helvetica').fillColor(GRAY)
        .text('Viale Felissent, 14 — Treviso (TV)   |   amamusicacademy.it · WhatsApp 375 668 8094', M, 40, { align: 'center', width: W });
      doc.moveDown(0.3);
      doc.fontSize(7).font('Helvetica-Bold').fillColor(NAVY)
        .text('MODULO UFFICIALE · AMA ACADEMY OF MUSICAL ARTS', { align: 'center', width: W });
      doc.moveDown(0.5);
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor(NAVY).lineWidth(1.5).stroke();
      doc.moveDown(0.8);
      doc.fontSize(15).font('Helvetica-Bold').fillColor(NAVY).text(titoloDoc, { align: 'center', width: W });
      if (sottotitolo) {
        doc.moveDown(0.2);
        doc.fontSize(8.5).font('Helvetica').fillColor(GRAY).text(sottotitolo, { align: 'center', width: W });
      }
      doc.moveDown(0.9);
    }

    // ── Helper: footer AMA ────────────────────────────────────────────────
    function footer() {
      const y = 820;
      doc.moveTo(M, y).lineTo(M + W, y).strokeColor(LGRAY).lineWidth(0.5).stroke();
      doc.fontSize(7).font('Helvetica').fillColor(GRAY)
        .text('AMA · Academy of Musical Arts   Viale Felissent, 14 – Treviso   amamusicacademy.it   @ama_academy_of_musical_arts', M, y + 4, { align: 'center', width: W });
    }

    // ── Helper: sezione ───────────────────────────────────────────────────
    function sezione(titolo) {
      if (doc.y > 730) { footer(); intestazione('(continua)'); }
      doc.moveDown(0.5);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text(titolo.toUpperCase(), M, doc.y, { width: W });
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor(LGRAY).lineWidth(0.5).stroke();
      doc.moveDown(0.35);
    }

    // ── Helper: riga label/valore ─────────────────────────────────────────
    function riga(label, val) {
      if (doc.y > 750) { footer(); intestazione('(continua)'); }
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#333').text(label + '  ', M, doc.y, { continued: true, width: W });
      doc.font('Helvetica').fillColor(BLACK).text(val || '—');
    }

    // ── Helper: paragrafo testo ───────────────────────────────────────────
    function paragrafo(testo, opts = {}) {
      if (doc.y > 750) { footer(); intestazione('(continua)'); }
      doc.fontSize(8.5).font('Helvetica').fillColor(BLACK)
        .text(testo, M, doc.y, { width: W, align: 'justify', lineGap: 2, ...opts });
      doc.moveDown(0.4);
    }

    // ── Helper: immagine base64 ───────────────────────────────────────────
    function imgBase64(b64, maxW = 220, maxH = 80) {
      if (!b64) return false;
      try {
        const data = b64.replace(/^data:image\/\w+;base64,/, '');
        doc.image(Buffer.from(data, 'base64'), { width: maxW, height: maxH, fit: [maxW, maxH] });
        return true;
      } catch { return false; }
    }

    // ══════════════════════════════════════════════════════════════════════
    // PAGINA 1 — DOMANDA DI ISCRIZIONE
    // ══════════════════════════════════════════════════════════════════════
    intestazione(
      'Domanda di Iscrizione',
      `Anno accademico ${anno} — Presentata il ${fmtData(isc.created_at)}`
    );

    sezione('Dati personali allievo/a');
    riga('Nome e Cognome:', `${isc.nome} ${isc.cognome}`);
    riga('Codice Fiscale:', isc.codice_fiscale);
    riga('Data di nascita:', fmtData(isc.data_nascita));
    riga('Luogo di nascita:', isc.luogo_nascita);
    const indAllievo = [isc.indirizzo, isc.cap, isc.citta, isc.provincia ? `(${isc.provincia})` : ''].filter(Boolean).join(' ');
    riga('Indirizzo:', indAllievo || '—');
    riga('Telefono:', isc.telefono);
    riga('Email:', isc.email);

    if (isc.minore) {
      sezione('Dati genitore / tutore (allievo/a minorenne)');
      riga('Nome e Cognome:', `${isc.genitore_nome || ''} ${isc.genitore_cognome || ''}`.trim());
      riga('Codice Fiscale:', isc.genitore_cf);
      riga('Data di nascita:', fmtData(isc.genitore_data_nascita));
      riga('Luogo di nascita:', isc.genitore_luogo_nascita);
      riga('Indirizzo:', isc.genitore_indirizzo);
      riga('Telefono:', isc.genitore_telefono);
      riga('Email:', isc.genitore_email);
    }

    sezione('Corso richiesto');
    riga('Materia / Corso:', isc.strumento);
    if (isc.note) riga('Note:', isc.note);

    sezione('Dichiarazioni e consensi');
    const chk = (v) => v ? '[X]' : '[ ]';
    doc.fontSize(8.5).font('Helvetica').fillColor(BLACK);
    doc.text(`${chk(isc.acc_tesseramento)}  Sottoscrizione domanda di tesseramento                               obbligatorio`, M, doc.y, { width: W });
    doc.moveDown(0.25);
    doc.text(`${chk(isc.acc_regolamento)}  Accettazione del regolamento interno                                  obbligatorio`, M, doc.y, { width: W });
    doc.moveDown(0.25);
    doc.text(`${chk(isc.acc_privacy)}  Consenso al trattamento dei dati personali (Informativa Privacy allegata)  obbligatorio`, M, doc.y, { width: W });
    doc.moveDown(0.25);
    doc.text(`${chk(isc.acc_immagini)}  Consenso all'uso delle immagini per canali social e promozionali AMA       facoltativo`, M, doc.y, { width: W });
    doc.moveDown(0.8);

    // Firme affiancate
    const firmaY = doc.y;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(NAVY)
      .text('FIRMA ALLIEVO / GENITORE', M, firmaY, { width: 230 });
    doc.fontSize(8).font('Helvetica-Bold').fillColor(NAVY)
      .text('FIRMA DEL PRESIDENTE', M + 280, firmaY, { width: 230 });
    doc.moveDown(0.3);
    if (isc.firma_allievo) {
      imgBase64(isc.firma_allievo, 200, 60);
    } else {
      doc.moveTo(M, doc.y + 40).lineTo(M + 200, doc.y + 40).strokeColor(LGRAY).lineWidth(0.5).stroke();
    }
    if (withPresidente && isc.firma_presidente) {
      const yFirma = firmaY + 14;
      try {
        const data = isc.firma_presidente.replace(/^data:image\/\w+;base64,/, '');
        doc.image(Buffer.from(data, 'base64'), M + 280, yFirma, { width: 200, height: 60, fit: [200, 60] });
      } catch {}
    }
    if (withPresidente && isc.accettata_il) {
      doc.moveDown(0.4);
      doc.fontSize(8).font('Helvetica').fillColor(GRAY)
        .text(`Accettata il: ${fmtData(isc.accettata_il)}`, { align: 'right', width: W });
    }

    footer();

    // ══════════════════════════════════════════════════════════════════════
    // PAGINA 2 — INFORMATIVA PRIVACY
    // ══════════════════════════════════════════════════════════════════════
    intestazione(
      'Informativa sul Trattamento dei Dati Personali',
      'Ai sensi degli artt. 13-14 del Regolamento (UE) 2016/679 (GDPR)'
    );

    function articolo(num, titolo, testo) {
      sezione(`${num}. ${titolo}`);
      paragrafo(testo);
    }

    articolo('1', 'Titolare del trattamento',
      'Titolare del trattamento dei dati è AMA – Academy of Musical Arts, con sede in Viale Felissent 14, 31100 Treviso (TV), contattabile all\'indirizzo email indicato sul sito amamusicacademy.it.');

    articolo('2', 'Finalità del trattamento',
      'I dati personali forniti in sede di iscrizione sono trattati per: gestione amministrativa dell\'iscrizione e della frequenza ai corsi; organizzazione delle attività didattiche, sessioni d\'esame e saggi; comunicazioni relative ai servizi dell\'accademia; adempimenti contabili e fiscali previsti dalla legge.');

    articolo('3', 'Base giuridica',
      'Il trattamento si basa sull\'esecuzione del contratto di iscrizione ai corsi e sull\'adempimento di obblighi di legge. Il trattamento delle immagini per finalità promozionali si basa sul consenso specifico, facoltativo e revocabile in ogni momento.');

    articolo('4', 'Modalità e conservazione',
      'I dati sono trattati con strumenti cartacei e informatici, con misure di sicurezza adeguate a prevenirne la perdita, l\'uso illecito o l\'accesso non autorizzato, e sono conservati per il tempo necessario alle finalità indicate e nel rispetto dei termini di legge.');

    articolo('5', 'Comunicazione a terzi',
      'I dati non sono diffusi. Possono essere comunicati a soggetti terzi solo per adempimenti amministrativi, contabili o assicurativi strettamente connessi all\'attività didattica (es. Trinity College London per le certificazioni d\'esame).');

    articolo('6', 'Diritti dell\'interessato',
      'L\'interessato può in qualsiasi momento esercitare i diritti di accesso, rettifica, cancellazione, limitazione, portabilità e opposizione al trattamento, oltre al diritto di revocare il consenso prestato, scrivendo al Titolare ai recapiti indicati in intestazione.');

    sezione('Consenso');
    doc.fontSize(8.5).font('Helvetica').fillColor(BLACK);
    doc.text(`${chk(isc.acc_privacy)}  Dichiaro di aver letto l'informativa e presto il consenso al trattamento dei dati personali per le finalità di cui ai punti 2 e 3          obbligatorio`, M, doc.y, { width: W });
    doc.moveDown(0.3);
    doc.text(`${chk(isc.acc_immagini)}  Presto il consenso all'uso della mia immagine (o di quella del minore rappresentato) su canali social e materiali promozionali AMA      facoltativo`, M, doc.y, { width: W });
    doc.moveDown(0.8);

    const privacyFirmaY = doc.y;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(NAVY)
      .text('LUOGO E DATA', M, privacyFirmaY, { width: 230 });
    doc.fontSize(8).font('Helvetica-Bold').fillColor(NAVY)
      .text('FIRMA ALLIEVO / GENITORE', M + 280, privacyFirmaY, { width: 230 });
    doc.moveDown(0.3);
    doc.fontSize(8.5).font('Helvetica').fillColor(BLACK)
      .text(`Treviso, ${fmtData(isc.created_at)}`, M, doc.y, { width: 230 });
    if (isc.firma_allievo) {
      try {
        const data = isc.firma_allievo.replace(/^data:image\/\w+;base64,/, '');
        doc.image(Buffer.from(data, 'base64'), M + 280, privacyFirmaY + 10, { width: 200, height: 55, fit: [200, 55] });
      } catch {}
    }

    footer();

    // ══════════════════════════════════════════════════════════════════════
    // PAGINA 3+ — REGOLAMENTO INTERNO
    // ══════════════════════════════════════════════════════════════════════
    intestazione('Regolamento Interno', `Anno accademico ${anno}`);

    function regArticolo(titolo, testo) {
      sezione(titolo);
      paragrafo(testo);
    }

    regArticolo('Iscrizione e tesseramento',
      'L\'iscrizione al corso prescelto deve essere effettuata a seguito del tesseramento all\'associazione stessa, tramite versamento della quota associativa di 50 euro.');

    regArticolo('Corsi ordinari',
      'Il percorso di studi si articola in 36 (trentasei) lezioni da settembre a maggio, secondo il calendario corsi annuale. Non rientrano nel percorso di studi eventuali masterclass o corsi extra organizzati dall\'associazione.\n\nLa durata delle lezioni è così articolata:\n— 45 o 60 minuti per i corsi individuali, in base alla tipologia di percorso scelto (€ 80 o € 100 mensili);\n— 60 minuti per i corsi di gruppo (€ 30 mensili).\n\nLe prove, i saggi, i concerti e gli eventi organizzati dall\'Accademia ai quali l\'allievo è convocato sono considerati attività didattiche a tutti gli effetti e vengono conteggiati tra le 36 lezioni previste dal percorso annuale, in sostituzione della normale lezione individuale o di gruppo.\n\nGli allievi non coinvolti nello spettacolo finale potranno partecipare a concerti o esibizioni organizzati nella sala concerti interna dell\'Accademia, senza alcun costo aggiuntivo. La partecipazione a tali attività non dà diritto a lezioni aggiuntive, recuperi, riduzioni o rimborsi delle quote versate.');

    regArticolo('Modalità di pagamento',
      'Il costo del percorso formativo è determinato su base annuale e comprende complessivamente 36 lezioni, distribuite nei 9 mesi dell\'anno accademico, da settembre a maggio.\n\nL\'importo annuale viene suddiviso in 9 quote mensili di pari importo, da versare entro la prima lezione di ciascun mese. La quota mensile non corrisponde al numero effettivo di lezioni svolte nel singolo mese, ma rappresenta una rata del costo complessivo dell\'intero percorso annuale.\n\nLa programmazione prevede una media di 4 lezioni al mese calcolata sull\'intero anno accademico. Di conseguenza, alcuni mesi potranno prevedere 3 lezioni, altri 4 oppure 5, in relazione al calendario, alle festività e alla distribuzione delle settimane, senza che ciò comporti variazioni dell\'importo mensile dovuto.\n\nLa quota deve essere corrisposta integralmente, indipendentemente dalla presenza o dall\'assenza dell\'allievo e dal numero di lezioni previste nel singolo mese. Non sono pertanto consentite riduzioni, compensazioni o ricalcoli della quota mensile.\n\nIn caso di mancato pagamento entro i termini stabiliti, il tesseramento annuale all\'Associazione decade e le lezioni vengono sospese, senza diritto al rimborso delle somme già versate.');

    regArticolo('Orari di frequenza',
      'Gli orari delle lezioni vengono concordati tra alunno ed insegnante, secondo le disponibilità dell\'insegnante e dell\'Accademia. Nel rispetto di tutti gli studenti ed insegnanti si chiede la massima puntualità.');

    regArticolo('Spettacolo finale di giugno (Loggia dei Cavalieri)',
      'La partecipazione allo spettacolo finale è riservata agli allievi che abbiano frequentato con assiduità le lezioni durante l\'intero anno accademico e che siano ritenuti pronti all\'esibizione dal proprio docente, in accordo con la Direttrice artistica.\n\nPer ciascun allievo coinvolto è prevista:\n— una quota di partecipazione di € 50,00, comprensiva della prova generale e della partecipazione allo spettacolo;\n— una quota aggiuntiva di € 10,00 per l\'acquisto della maglietta ufficiale dell\'Accademia.\n\nL\'importo complessivo è pertanto pari a € 60,00, da versare presso la Segreteria entro e non oltre il 15 maggio. Le quote versate non saranno rimborsabili in caso di rinuncia o mancata partecipazione dell\'allievo, salvo annullamento dello spettacolo disposto dall\'Accademia.');

    regArticolo('Assenze e recupero delle lezioni',
      'In caso di impossibilità a partecipare a una lezione individuale o di gruppo, l\'allievo è tenuto a informare tempestivamente il proprio docente.\n\nPer le lezioni individuali sono previsti un massimo di 3 (tre) recuperi complessivi per ciascun anno accademico. Il recupero è riconosciuto esclusivamente quando l\'assenza viene comunicata con almeno 24 ore di preavviso rispetto all\'orario previsto per la lezione.\n\nQualora l\'assenza venga comunicata con un preavviso inferiore alle 24 ore, a ridosso della lezione, oppure l\'allievo non si presenti senza avvisare, la lezione sarà considerata svolta e definitivamente persa, senza possibilità di recupero, rimborso, riduzione o eccezione.\n\nLe lezioni di recupero dovranno essere effettuate entro la conclusione dell\'anno accademico, fissata al 31 maggio. La data e l\'orario del recupero saranno stabiliti dal docente in base alla propria disponibilità e a quella degli spazi dell\'Accademia.\n\nIl docente potrà formulare una proposta di data e orario per ciascuna lezione da recuperare. Qualora l\'allievo non accetti, la lezione di recupero sarà considerata definitivamente persa. In caso di mancata presentazione a un recupero già concordato, la lezione sarà ugualmente considerata persa e non potrà essere riprogrammata.\n\nIn caso di ritiro anticipato dai corsi, gli eventuali recuperi maturati dovranno essere effettuati entro l\'ultimo mese regolarmente pagato.\n\nLe lezioni di gruppo non sono recuperabili in caso di assenza dell\'allievo e non danno diritto a rimborsi, riduzioni o compensazioni sulle quote versate.\n\nIn caso di assenza del docente, l\'Accademia potrà affidare la lezione a un insegnante sostituto. Qualora non fosse possibile garantire la sostituzione, la lezione non svolta sarà recuperata in una data successiva e non sarà conteggiata tra i tre recuperi annuali riconosciuti all\'allievo.');

    regArticolo('Ritiro dalle lezioni',
      'L\'iscrizione effettuata all\'inizio dell\'anno accademico è riferita all\'intero percorso di studi. Eventuali comunicazioni di ritiro dal percorso intrapreso dovranno pervenire entro 30 giorni. Nel rispetto di tale termine le quote da versare oltre i 30 giorni non saranno dovute.\n\nCon la comunicazione di ritiro dal percorso decade anche il tesseramento annuale all\'associazione, senza la possibilità di rimborso dell\'iscrizione.');

    regArticolo('Percorso di preparazione agli esami Trinity',
      'All\'inizio dell\'anno accademico, gli allievi interessati al percorso Trinity dovranno comunicarlo alla Segreteria, così da consentire l\'organizzazione e l\'avvio della preparazione specifica prevista dal programma d\'esame.\n\nIl percorso Trinity comprende: la consueta lezione individuale; un incontro mensile di solfeggio di gruppo, finalizzato alla preparazione teorico-musicale richiesta dal programma d\'esame, al costo aggiuntivo di € 10,00 per ciascun incontro; l\'acquisto del libro e dell\'eventuale materiale didattico Trinity.\n\nIl docente individuerà il grado Trinity più adeguato e definirà il programma di studio. L\'iscrizione all\'esame sarà subordinata alla valutazione del docente circa l\'effettivo raggiungimento del livello di preparazione richiesto.\n\nGli esami potranno svolgersi nei mesi di aprile, maggio o giugno, di fronte a una commissione composta da docenti presso la nostra accademia. Il costo dell\'esame varia in base al grado prescelto e sarà comunicato dalla Segreteria prima dell\'iscrizione. Alla quota d\'esame dovrà essere aggiunto un contributo di € 20,00 per le spese di Segreteria.\n\nAl termine della procedura, Trinity rilascerà la certificazione ufficiale con la votazione conseguita e la relativa pergamena.');

    regArticolo('Crediti formativi',
      'L\'Accademia rilascia idonea documentazione relativa ai crediti scolastici agli allievi che ne presentano specifica richiesta.');

    // Firma presa visione
    doc.moveDown(0.8);
    sezione('Per presa visione');
    const regFirmaY = doc.y;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(NAVY)
      .text('ALLIEVO / GENITORE', M, regFirmaY, { width: 230 });
    doc.fontSize(8).font('Helvetica-Bold').fillColor(NAVY)
      .text('FIRMA DEL PRESIDENTE', M + 280, regFirmaY, { width: 230 });
    doc.moveDown(0.3);
    doc.fontSize(8.5).font('Helvetica').fillColor(BLACK)
      .text(`Treviso, ${fmtData(isc.created_at)}`, M, doc.y, { width: 230 });
    if (isc.firma_allievo) {
      try {
        const data = isc.firma_allievo.replace(/^data:image\/\w+;base64,/, '');
        doc.image(Buffer.from(data, 'base64'), M + 280, regFirmaY + 10, { width: 200, height: 55, fit: [200, 55] });
      } catch {}
    }

    footer();

    // ══════════════════════════════════════════════════════════════════════
    // PAGINE DOCUMENTI ALLEGATI
    // ══════════════════════════════════════════════════════════════════════
    const allegati = [
      { label: 'Documento d\'identità allievo/a — fronte', b64: isc.doc_allievo_fronte },
      { label: 'Documento d\'identità allievo/a — retro',  b64: isc.doc_allievo_retro },
      { label: 'Documento d\'identità genitore — fronte',  b64: isc.doc_genitore_fronte },
      { label: 'Documento d\'identità genitore — retro',   b64: isc.doc_genitore_retro },
    ];

    for (const all of allegati) {
      if (!all.b64) continue;
      doc.addPage();
      doc.fontSize(7).font('Helvetica-Bold').fillColor(NAVY)
        .text('MODULO UFFICIALE · AMA ACADEMY OF MUSICAL ARTS', M, 40, { align: 'center', width: W });
      doc.moveDown(0.5);
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor(NAVY).lineWidth(1.5).stroke();
      doc.moveDown(1);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(NAVY)
        .text('Allegati — Copie Documenti Identità', { align: 'center', width: W });
      doc.moveDown(0.5);
      doc.fontSize(9).font('Helvetica').fillColor(GRAY)
        .text(all.label, { align: 'center', width: W });
      doc.moveDown(0.8);
      try {
        const data = all.b64.replace(/^data:image\/\w+;base64,/, '');
        const maxW = W, maxH = 550;
        doc.image(Buffer.from(data, 'base64'), M, doc.y, { fit: [maxW, maxH], align: 'center' });
      } catch {}
      footer();
    }

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
      <p>Materie richieste: <strong>${isc.strumento || '—'}</strong></p>
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
      const username = (isc.email || `allievo_${allievoId}`).toLowerCase().trim();
      await pool.query(
        `INSERT INTO utenti (username, password, ruolo, allievo_id)
         VALUES ($1,$2,'allievo',$3)
         ON CONFLICT (username) DO UPDATE SET password=EXCLUDED.password, allievo_id=EXCLUDED.allievo_id`,
        [username, hash, allievoId]
      );

      await pool.query('UPDATE iscrizioni SET allievo_id=$1 WHERE id=$2', [allievoId, req.params.id]);
    } catch (e) {
      console.error('Errore creazione/riattivazione allievo:', e);
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
