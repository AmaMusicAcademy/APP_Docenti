const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../Middleware/auth');

const router = express.Router();

const QONTO_LOGIN           = process.env.QONTO_LOGIN;
const QONTO_SECRET_KEY      = process.env.QONTO_SECRET_KEY;
const QONTO_BANK_ACCOUNT_ID = process.env.QONTO_BANK_ACCOUNT_ID; // ID conto da get_organization

// ── setup tabelle ──────────────────────────────────────────────────────────
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qonto_transazioni (
      id              TEXT PRIMARY KEY,        -- transaction_id Qonto
      importo         NUMERIC(10,2),
      mittente        TEXT,
      causale         TEXT,
      data            DATE,
      allievo_id      INTEGER REFERENCES allievi(id) ON DELETE SET NULL,
      tipo_pagamento  TEXT,                    -- 'mensile' | 'associativa' | null
      anno            INTEGER,
      mese            INTEGER,
      abbinata        BOOLEAN DEFAULT FALSE,
      creata_il       TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS qonto_non_abbinate (
      id              SERIAL PRIMARY KEY,
      qonto_tx_id     TEXT REFERENCES qonto_transazioni(id) ON DELETE CASCADE,
      importo         NUMERIC(10,2),
      mittente        TEXT,
      causale         TEXT,
      data            DATE,
      creata_il       TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ── normalizza stringa per confronto ──────────────────────────────────────
function norm(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // rimuove accenti
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ritorna true se il nome completo è contenuto nella stringa target
function containsName(target, nome, cognome) {
  const t = norm(target);
  const n = norm(nome);
  const c = norm(cognome);
  if (!n && !c) return false;
  return t.includes(`${n} ${c}`) || t.includes(`${c} ${n}`);
}

// ── cerca allievo dal mittente o causale ──────────────────────────────────
async function trovaAllievo(mittente, causale) {
  const { rows: allievi } = await pool.query(`
    SELECT id, nome, cognome, genitore_nome, genitore_cognome
    FROM allievi WHERE attivo IS DISTINCT FROM FALSE
  `);

  const match = [];
  for (const a of allievi) {
    // 1. mittente = nome allievo
    if (containsName(mittente, a.nome, a.cognome)) {
      match.push({ id: a.id, via: 'mittente_allievo' });
      continue;
    }
    // 2. mittente = nome genitore (per i minori)
    if (a.genitore_nome && a.genitore_cognome &&
        containsName(mittente, a.genitore_nome, a.genitore_cognome)) {
      match.push({ id: a.id, via: 'mittente_genitore' });
      continue;
    }
    // 3. causale contiene nome allievo
    if (containsName(causale, a.nome, a.cognome)) {
      match.push({ id: a.id, via: 'causale_allievo' });
      continue;
    }
  }

  if (match.length === 1) return match[0];
  return null; // 0 = nessuno, >1 = ambiguo → entrambi non abbinati
}

// ── chiama API Qonto ───────────────────────────────────────────────────────
async function fetchQontoTransazioni(after) {
  if (!QONTO_LOGIN || !QONTO_SECRET_KEY) {
    throw new Error('Credenziali Qonto non configurate (QONTO_LOGIN / QONTO_SECRET_KEY)');
  }
  const base64 = Buffer.from(`${QONTO_LOGIN}:${QONTO_SECRET_KEY}`).toString('base64');
  const params = new URLSearchParams({
    side:     'credit',
    per_page: '100',
    sort_by:  'settled_at:desc',
  });
  if (QONTO_BANK_ACCOUNT_ID) params.set('bank_account_id', QONTO_BANK_ACCOUNT_ID);
  if (after) params.set('settled_at_from', after);

  const url = `https://thirdparty.qonto.com/v2/transactions?${params}`;
  const res  = await fetch(url, {
    headers: { Authorization: `Basic ${base64}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Qonto API error ${res.status}: ${text}`);
  }
  const json = await res.json();
  // filtra solo credit per sicurezza (l'API può restituire anche debit)
  return (json.transactions || []).filter(tx => tx.side === 'credit');
}

// ── inferisci tipo pagamento dalla causale/importo ─────────────────────────
function inferTipo(causale) {
  const c = norm(causale);
  if (c.includes('associat') || c.includes('tesseramento') || c.includes('annuale')) return 'associativa';
  return 'mensile'; // default
}

function meseCorrente() {
  const d = new Date();
  return { anno: d.getFullYear(), mese: d.getMonth() + 1 };
}

// ── POST /api/qonto/sync — esegui sync manuale o da cron ─────────────────
router.post('/qonto/sync', ...requireRole('admin'), async (req, res) => {
  try {
    await ensureTables();

    // Prende l'ultima transazione già salvata per scaricare solo le nuove
    const { rows: last } = await pool.query(
      `SELECT data FROM qonto_transazioni ORDER BY data DESC LIMIT 1`
    );
    const after = last.length ? last[0].data : null;

    const transazioni = await fetchQontoTransazioni(after);

    let nuove = 0, abbinate = 0, nonAbbinate = 0;

    for (const tx of transazioni) {
      const txId    = tx.transaction_id || tx.id;
      const importo = parseFloat(tx.amount || tx.local_amount || 0);
      const mittente = tx.label || tx.counterparty?.name || '';
      const causale  = tx.reference || '';
      const data     = (tx.settled_at || tx.emitted_at || '').slice(0, 10);

      // Salta se già registrata
      const { rows: exist } = await pool.query(
        'SELECT id FROM qonto_transazioni WHERE id=$1', [txId]
      );
      if (exist.length) continue;
      nuove++;

      // Cerca allievo
      const found = await trovaAllievo(mittente, causale);
      const { anno, mese } = meseCorrente();
      const tipo = inferTipo(causale);

      if (found) {
        // Inserisci transazione abbinata
        await pool.query(`
          INSERT INTO qonto_transazioni (id, importo, mittente, causale, data, allievo_id, tipo_pagamento, anno, mese, abbinata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
        `, [txId, importo, mittente, causale, data, found.id, tipo, anno, mese]);

        // Registra pagamento nel sistema
        if (tipo === 'mensile') {
          await pool.query(`
            INSERT INTO pagamenti_mensili (allievo_id, anno, mese, data_pagamento)
            VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
          `, [found.id, anno, mese, data]);
        } else {
          await pool.query(`
            INSERT INTO quote_associative (allievo_id, anno, pagata, data_pagamento)
            VALUES ($1,$2,TRUE,$3) ON CONFLICT (allievo_id, anno) DO UPDATE SET pagata=TRUE, data_pagamento=$3
          `, [found.id, anno, data]);
        }
        abbinate++;
      } else {
        // Salva come non abbinata
        await pool.query(`
          INSERT INTO qonto_transazioni (id, importo, mittente, causale, data, abbinata)
          VALUES ($1,$2,$3,$4,$5,FALSE)
        `, [txId, importo, mittente, causale, data]);
        await pool.query(`
          INSERT INTO qonto_non_abbinate (qonto_tx_id, importo, mittente, causale, data)
          VALUES ($1,$2,$3,$4,$5)
        `, [txId, importo, mittente, causale, data]);
        nonAbbinate++;
      }
    }

    res.json({ ok: true, nuove, abbinate, nonAbbinate });
  } catch (err) {
    console.error('Qonto sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/qonto/non-abbinate ───────────────────────────────────────────
router.get('/qonto/non-abbinate', ...requireRole('admin'), async (_req, res) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(`
      SELECT n.id, n.qonto_tx_id, n.importo, n.mittente, n.causale, n.data
      FROM qonto_non_abbinate n
      JOIN qonto_transazioni t ON t.id = n.qonto_tx_id
      WHERE t.abbinata = FALSE
      ORDER BY n.data DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/qonto/abbina — abbinamento manuale da admin ─────────────────
router.post('/qonto/abbina', ...requireRole('admin'), async (req, res) => {
  const { qonto_tx_id, allievo_id, tipo_pagamento, anno, mese } = req.body;
  if (!qonto_tx_id || !allievo_id || !tipo_pagamento || !anno) {
    return res.status(400).json({ error: 'Parametri mancanti' });
  }
  try {
    const { rows: tx } = await pool.query(
      'SELECT * FROM qonto_transazioni WHERE id=$1', [qonto_tx_id]
    );
    if (!tx.length) return res.status(404).json({ error: 'Transazione non trovata' });

    // Aggiorna transazione
    await pool.query(`
      UPDATE qonto_transazioni
      SET allievo_id=$1, tipo_pagamento=$2, anno=$3, mese=$4, abbinata=TRUE
      WHERE id=$5
    `, [allievo_id, tipo_pagamento, anno, mese || null, qonto_tx_id]);

    // Rimuovi da non abbinate
    await pool.query('DELETE FROM qonto_non_abbinate WHERE qonto_tx_id=$1', [qonto_tx_id]);

    // Registra pagamento
    if (tipo_pagamento === 'mensile') {
      await pool.query(`
        INSERT INTO pagamenti_mensili (allievo_id, anno, mese, data_pagamento)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
      `, [allievo_id, anno, mese, tx[0].data]);
    } else {
      await pool.query(`
        INSERT INTO quote_associative (allievo_id, anno, pagata, data_pagamento)
        VALUES ($1,$2,TRUE,$3) ON CONFLICT (allievo_id, anno) DO UPDATE SET pagata=TRUE, data_pagamento=$3
      `, [allievo_id, anno, tx[0].data]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/qonto/storico — ultime transazioni abbinate ─────────────────
router.get('/qonto/storico', ...requireRole('admin'), async (_req, res) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(`
      SELECT t.id, t.importo, t.mittente, t.causale, t.data,
             t.tipo_pagamento, t.anno, t.mese,
             a.nome, a.cognome
      FROM qonto_transazioni t
      LEFT JOIN allievi a ON a.id = t.allievo_id
      WHERE t.abbinata = TRUE
      ORDER BY t.data DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
