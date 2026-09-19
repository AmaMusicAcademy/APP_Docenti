const express = require('express');
const crypto  = require('crypto');
const { pool } = require('../db');

const router = express.Router();

const MESI_IT = {
  gen: 1, gennaio: 1,
  feb: 2, febbraio: 2,
  mar: 3, marzo: 3,
  apr: 4, aprile: 4,
  mag: 5, maggio: 5,
  giu: 6, giugno: 6,
  lug: 7, luglio: 7,
  ago: 8, agosto: 8,
  set: 9, settembre: 9,
  ott: 10, ottobre: 10,
  nov: 11, novembre: 11,
  dic: 12, dicembre: 12,
};
const MESI_LABEL = ['','Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
  'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

// Verifica firma Twilio (sicurezza webhook)
function verificaFirmaTwilio(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true; // skip in dev se non configurato
  const url = `https://app-docenti.onrender.com${req.originalUrl}`;
  const params = req.body;
  const sortedKeys = Object.keys(params).sort();
  let str = url;
  for (const k of sortedKeys) str += k + params[k];
  const firma = crypto.createHmac('sha1', token).update(str).digest('base64');
  return firma === req.headers['x-twilio-signature'];
}

// Normalizza stringa: minuscolo, rimuove accenti, spazi multipli
function normalizza(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Parsa il testo del messaggio
// Formato atteso: "nome cognome gen 2026" oppure "nome cognome gen 2026 + tassa"
function parsaMessaggio(testo) {
  const t = normalizza(testo);

  // Cerca anno (4 cifre)
  const annoMatch = t.match(/\b(20\d{2})\b/);
  if (!annoMatch) return null;
  const anno = parseInt(annoMatch[1], 10);

  // Cerca nome mese prima dell'anno
  let mese = null;
  let meseLabel = null;
  for (const [chiave, num] of Object.entries(MESI_IT)) {
    const re = new RegExp(`\\b${chiave}\\b`);
    if (re.test(t)) { mese = num; meseLabel = MESI_LABEL[num]; break; }
  }
  if (!mese) return null;

  // Tassa: "+ tassa" presente?
  const tassa = /[+]\s*tassa/.test(t);

  // Nome allievo: tutto prima del mese
  const partiPrimaDiMese = t.split(/\b(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/)[0].trim();

  if (!partiPrimaDiMese) return null;

  return { nomeRicercato: partiPrimaDiMese, mese, anno, meseLabel, tassa, testoOriginale: testo };
}

// Cerca allievo nel DB per nome+cognome (fuzzy: entrambe le parole devono essere presenti)
async function cercaAllievo(nomeRicercato) {
  const parti = nomeRicercato.split(' ').filter(Boolean);
  if (parti.length < 2) return null;

  const { rows } = await pool.query(`
    SELECT id, nome, cognome FROM allievi
    WHERE attivo IS DISTINCT FROM FALSE
  `);

  for (const a of rows) {
    const completo = normalizza(`${a.nome} ${a.cognome}`);
    const inverso  = normalizza(`${a.cognome} ${a.nome}`);
    const cercato  = normalizza(nomeRicercato);
    if (completo === cercato || inverso === cercato) return a;
  }

  // Fallback: tutte le parole cercate sono contenute nel nome completo
  for (const a of rows) {
    const completo = normalizza(`${a.nome} ${a.cognome}`);
    if (parti.every(p => completo.includes(p))) return a;
  }

  return null;
}

// Cerca insegnante per numero telefono mittente
async function cercaInsegnante(numeroDa) {
  const pulito = numeroDa.replace('whatsapp:', '').replace(/\s/g, '');
  const { rows } = await pool.query(
    `SELECT id, nome, cognome FROM insegnanti WHERE REPLACE(telefono,' ','') = $1 OR REPLACE(telefono,' ','') = $2`,
    [pulito, pulito.replace('+39', '').replace('+', '')]
  );
  return rows[0] ?? null;
}

// ── POST /api/whatsapp/inbound ─────────────────────────────────────────────
router.post('/whatsapp/inbound', express.urlencoded({ extended: false }), async (req, res) => {
  // Rispondi subito a Twilio (evita retry)
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  if (!verificaFirmaTwilio(req)) {
    console.warn('[WA-inbound] firma non valida, messaggio ignorato');
    return;
  }

  const from  = req.body.From ?? '';   // es. whatsapp:+393391234567
  const testo = (req.body.Body ?? '').trim();

  if (!testo) return;

  console.log(`[WA-inbound] da ${from}: "${testo}"`);

  try {
    // Cerca insegnante mittente
    const insegnante = await cercaInsegnante(from);

    // Parsa messaggio
    const parsed = parsaMessaggio(testo);
    if (!parsed) {
      console.log('[WA-inbound] formato non riconosciuto, ignorato');
      return;
    }

    // Cerca allievo
    const allievo = await cercaAllievo(parsed.nomeRicercato);

    // Inserisce pending (anche se allievo non trovato — la segreteria lo abbina)
    await pool.query(`
      INSERT INTO pagamenti_contanti_pending
        (from_numero, insegnante_id, insegnante_nome, testo_originale,
         allievo_id, allievo_cercato, mese, anno, include_tassa, stato, ricevuto_il)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'in_attesa', NOW())
    `, [
      from,
      insegnante?.id ?? null,
      insegnante ? `${insegnante.nome} ${insegnante.cognome}` : null,
      parsed.testoOriginale,
      allievo?.id ?? null,
      parsed.nomeRicercato,
      parsed.mese,
      parsed.anno,
      parsed.tassa,
    ]);

    console.log(`[WA-inbound] pending creato: allievo=${allievo?.id ?? 'non trovato'} ${parsed.meseLabel} ${parsed.anno} tassa=${parsed.tassa}`);
  } catch (err) {
    console.error('[WA-inbound] errore:', err.message);
  }
});

// ── GET /api/admin/pagamenti-contanti-pending ──────────────────────────────
router.get('/admin/pagamenti-contanti-pending', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamenti_contanti_pending (
        id               SERIAL PRIMARY KEY,
        from_numero      TEXT,
        insegnante_id    INTEGER,
        insegnante_nome  TEXT,
        testo_originale  TEXT,
        allievo_id       INTEGER REFERENCES allievi(id),
        allievo_cercato  TEXT,
        mese             INTEGER,
        anno             INTEGER,
        include_tassa    BOOLEAN DEFAULT FALSE,
        stato            TEXT DEFAULT 'in_attesa',
        confermato_da    TEXT,
        ricevuto_il      TIMESTAMPTZ DEFAULT NOW(),
        aggiornato_il    TIMESTAMPTZ
      )
    `);
    const { rows } = await pool.query(`
      SELECT p.*, a.nome AS allievo_nome, a.cognome AS allievo_cognome
      FROM pagamenti_contanti_pending p
      LEFT JOIN allievi a ON a.id = p.allievo_id
      WHERE p.stato = 'in_attesa'
      ORDER BY p.ricevuto_il DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/pagamenti-contanti-pending/:id/conferma ───────────────
router.post('/admin/pagamenti-contanti-pending/:id/conferma', async (req, res) => {
  const { id } = req.params;
  const { allievo_id } = req.body; // può essere sovrascritto dalla segreteria

  try {
    const { rows } = await pool.query(
      `SELECT * FROM pagamenti_contanti_pending WHERE id = $1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Non trovato' });
    const p = rows[0];
    const allId = allievo_id ?? p.allievo_id;
    if (!allId) return res.status(400).json({ error: 'Allievo non abbinato' });

    // Registra pagamento mensile
    await pool.query(`
      INSERT INTO pagamenti_mensili (allievo_id, anno, mese, data_pagamento)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT DO NOTHING
    `, [allId, p.anno, p.mese]);

    // Registra tassa se richiesta
    if (p.include_tassa) {
      await pool.query(`
        INSERT INTO quote_associative (allievo_id, anno, pagata, data_pagamento)
        VALUES ($1, $2, TRUE, NOW())
        ON CONFLICT (allievo_id, anno) DO UPDATE SET pagata = TRUE, data_pagamento = NOW()
      `, [allId, p.anno]);
    }

    // Aggiorna stato pending
    await pool.query(`
      UPDATE pagamenti_contanti_pending
      SET stato = 'confermato', allievo_id = $1, aggiornato_il = NOW()
      WHERE id = $2
    `, [allId, id]);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/pagamenti-contanti-pending/:id/rifiuta ────────────────
router.post('/admin/pagamenti-contanti-pending/:id/rifiuta', async (req, res) => {
  try {
    await pool.query(`
      UPDATE pagamenti_contanti_pending
      SET stato = 'rifiutato', aggiornato_il = NOW()
      WHERE id = $1
    `, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/allievi-attivi — lista compatta per abbinamento ─────────
router.get('/admin/allievi-attivi', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nome, cognome FROM allievi WHERE attivo IS DISTINCT FROM FALSE ORDER BY cognome, nome`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
