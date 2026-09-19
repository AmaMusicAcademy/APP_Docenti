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

// Parole rumore da ignorare nell'estrazione del nome
const PAROLE_RUMORE = new Set([
  'paga','pagato','ha','pagato','pago','ha pagato','hanno pagato',
  'versato','ha versato','saldato','ha saldato',
  'e','il','la','lo','i','le','gli','di','da','per','con','in',
  'tassa','associativa','quota','quote','mese','mesi',
]);

// Parsa il testo del messaggio in modo flessibile.
// Estrae: nome allievo, mese, anno (default anno corrente), tassa
// Esempi gestiti:
//   "mario rossi gen 2026"
//   "mario rossi gen 2026 + tassa"
//   "Rossi paga gennaio"
//   "Mario ha pagato gennaio e tassa"
//   "mario rossi ha saldato febbraio 2026 e tassa associativa"
function parsaMessaggio(testo) {
  const t = normalizza(testo);

  // Anno: 4 cifre tipo 20xx — opzionale, default anno corrente
  const annoMatch = t.match(/\b(20\d{2})\b/);
  const anno = annoMatch ? parseInt(annoMatch[1], 10) : new Date().getFullYear();

  // Mese: cerca tutte le chiavi ordinate per lunghezza decrescente (evita match parziali)
  const chiavi = Object.keys(MESI_IT).sort((a, b) => b.length - a.length);
  let mese = null;
  let meseLabel = null;
  let meseChiave = null;
  for (const chiave of chiavi) {
    if (new RegExp(`\\b${chiave}\\b`).test(t)) {
      mese = MESI_IT[chiave];
      meseLabel = MESI_LABEL[mese];
      meseChiave = chiave;
      break;
    }
  }
  if (!mese) return null;

  // Tassa: qualsiasi menzione di "tassa" o "associativa"
  const tassa = /\btassa\b|\bassociativa\b/.test(t);

  // Estrai nome: rimuovi anno, mese, tassa, parole rumore, punteggiatura
  let candidato = t
    .replace(/\b20\d{2}\b/, '')
    .replace(new RegExp(`\\b${meseChiave}\\b`), '')
    .replace(/\btassa\b|\bassociativa\b|\bquota\b|\bquote\b/, '')
    .replace(/[+\-,]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !PAROLE_RUMORE.has(w))
    .join(' ')
    .trim();

  if (!candidato) return null;

  return { nomeRicercato: candidato, mese, anno, meseLabel, tassa, testoOriginale: testo };
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

// ── GET /api/admin/pagamenti-contanti-storico ─────────────────────────────
router.get('/admin/pagamenti-contanti-storico', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, a.nome AS allievo_nome, a.cognome AS allievo_cognome
      FROM pagamenti_contanti_pending p
      LEFT JOIN allievi a ON a.id = p.allievo_id
      WHERE p.stato = 'confermato'
      ORDER BY p.aggiornato_il DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/pagamenti-contanti-storico/:id/annulla ────────────────
router.post('/admin/pagamenti-contanti-storico/:id/annulla', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM pagamenti_contanti_pending WHERE id = $1 AND stato = 'confermato'`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Non trovato' });
    const p = rows[0];

    // Rimuovi pagamento mensile
    await pool.query(
      `DELETE FROM pagamenti_mensili WHERE allievo_id = $1 AND anno = $2 AND mese = $3`,
      [p.allievo_id, p.anno, p.mese]
    );
    // Rimuovi tassa se era inclusa
    if (p.include_tassa) {
      await pool.query(
        `UPDATE quote_associative SET pagata = FALSE, data_pagamento = NULL WHERE allievo_id = $1 AND anno = $2`,
        [p.allievo_id, p.anno]
      );
    }
    // Riporta in stato rifiutato (rimosso dallo storico)
    await pool.query(
      `UPDATE pagamenti_contanti_pending SET stato = 'annullato', aggiornato_il = NOW() WHERE id = $1`,
      [req.params.id]
    );
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
