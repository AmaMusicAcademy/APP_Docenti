const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../Middleware/auth');

const router = express.Router();

const QONTO_LOGIN           = process.env.QONTO_LOGIN;
const QONTO_SECRET_KEY      = process.env.QONTO_SECRET_KEY;
const QONTO_BANK_ACCOUNT_ID = process.env.QONTO_BANK_ACCOUNT_ID;

// ── setup tabelle ──────────────────────────────────────────────────────────
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qonto_transazioni (
      id              TEXT PRIMARY KEY,
      importo         NUMERIC(10,2),
      mittente        TEXT,
      causale         TEXT,
      data            DATE,
      allievo_id      INTEGER REFERENCES allievi(id) ON DELETE SET NULL,
      tipo_pagamento  TEXT,
      mesi_registrati JSONB,          -- [{anno, mese}] per poter fare rollback
      abbinata        BOOLEAN DEFAULT FALSE,
      scartata        BOOLEAN DEFAULT FALSE,
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
    CREATE TABLE IF NOT EXISTS qonto_mittenti_noti (
      id              SERIAL PRIMARY KEY,
      mittente_norm   TEXT UNIQUE,    -- nome mittente normalizzato
      allievo_id      INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
      aggiornato_il   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE qonto_transazioni ADD COLUMN IF NOT EXISTS mesi_registrati JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE qonto_transazioni ADD COLUMN IF NOT EXISTS scartata BOOLEAN DEFAULT FALSE`).catch(() => {});
}

// ── normalizza stringa ────────────────────────────────────────────────────
function norm(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsName(target, nome, cognome) {
  const t = norm(target);
  const n = norm(nome);
  const c = norm(cognome);
  if (!n && !c) return false;
  return t.includes(`${n} ${c}`) || t.includes(`${c} ${n}`);
}

// ── cerca allievo (prima in mittenti noti, poi per nome) ─────────────────
async function trovaAllievo(mittente, causale) {
  const mittenteNorm = norm(mittente);

  // 0. Mittente già noto da abbinamento manuale precedente
  if (mittenteNorm) {
    const { rows: noti } = await pool.query(
      `SELECT allievo_id FROM qonto_mittenti_noti WHERE mittente_norm=$1`, [mittenteNorm]
    );
    if (noti.length) return { id: noti[0].allievo_id, via: 'mittente_noto' };
  }

  const { rows: allievi } = await pool.query(`
    SELECT id, nome, cognome, genitore_nome, genitore_cognome
    FROM allievi WHERE attivo IS DISTINCT FROM FALSE
  `);

  const match = [];
  for (const a of allievi) {
    if (containsName(mittente, a.nome, a.cognome))                                    { match.push({ id: a.id, via: 'mittente_allievo' }); continue; }
    if (a.genitore_nome && a.genitore_cognome &&
        containsName(mittente, a.genitore_nome, a.genitore_cognome))                  { match.push({ id: a.id, via: 'mittente_genitore' }); continue; }
    if (containsName(causale, a.nome, a.cognome))                                     { match.push({ id: a.id, via: 'causale_allievo' }); continue; }
  }

  if (match.length === 1) return match[0];
  return null;
}

// ── mesi non pagati più vecchi per un allievo ────────────────────────────
async function mesiNonPagati(allievoId, quanti) {
  // Cerca i mesi non pagati partendo da 12 mesi fa fino ad oggi
  const oggi = new Date();
  const risultato = [];
  let anno = oggi.getFullYear();
  let mese = oggi.getMonth() + 1;

  // scorri indietro fino a 24 mesi
  for (let i = 0; i < 24 && risultato.length < quanti; i++) {
    const { rows } = await pool.query(
      `SELECT id FROM pagamenti_mensili WHERE allievo_id=$1 AND anno=$2 AND mese=$3`,
      [allievoId, anno, mese]
    );
    if (!rows.length) risultato.unshift({ anno, mese }); // più vecchio prima

    mese--;
    if (mese === 0) { mese = 12; anno--; }
  }

  return risultato.slice(0, quanti);
}

function inferTipo(causale) {
  const c = norm(causale);
  if (c.includes('associat') || c.includes('tesseramento') || c.includes('annuale')) return 'associativa';
  return 'mensile';
}

// ── registra N mesi per un allievo — ritorna array di {anno,mese} registrati
async function registraMesi(allievoId, mesiDaRegistrare, dataPagamento) {
  for (const { anno, mese } of mesiDaRegistrare) {
    await pool.query(`
      INSERT INTO pagamenti_mensili (allievo_id, anno, mese, data_pagamento)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
    `, [allievoId, anno, mese, dataPagamento]);
  }
}

// ── cancella mesi registrati da una transazione (rollback) ───────────────
async function rollbackMesi(mesiRegistrati, allievoId) {
  for (const { anno, mese } of (mesiRegistrati || [])) {
    await pool.query(
      `DELETE FROM pagamenti_mensili WHERE allievo_id=$1 AND anno=$2 AND mese=$3`,
      [allievoId, anno, mese]
    );
  }
}

// ── chiama API Qonto ──────────────────────────────────────────────────────
async function fetchQontoTransazioni(after) {
  if (!QONTO_LOGIN || !QONTO_SECRET_KEY) {
    throw new Error('Credenziali Qonto non configurate (QONTO_LOGIN / QONTO_SECRET_KEY)');
  }
  const params = new URLSearchParams({ side: 'credit', per_page: '100', sort_by: 'settled_at:desc' });
  if (QONTO_BANK_ACCOUNT_ID) params.set('bank_account_id', QONTO_BANK_ACCOUNT_ID);
  if (after) params.set('settled_at_from', after);

  const res = await fetch(`https://thirdparty.qonto.com/v2/transactions?${params}`, {
    headers: { Authorization: `${QONTO_LOGIN}:${QONTO_SECRET_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Qonto API error ${res.status}: ${text}`);
  }
  const json = await res.json();
  return (json.transactions || []).filter(tx => tx.side === 'credit');
}

// ── logica core abbinamento (usata sia da sync che dal cron) ─────────────
async function processaTransazione(txId, importo, mittente, causale, data) {
  const { rows: exist } = await pool.query('SELECT id FROM qonto_transazioni WHERE id=$1', [txId]);
  if (exist.length) return 'gia_presente';

  const found = await trovaAllievo(mittente, causale);
  const tipo  = inferTipo(causale);

  if (!found) {
    await pool.query(
      `INSERT INTO qonto_transazioni (id,importo,mittente,causale,data,abbinata) VALUES ($1,$2,$3,$4,$5,FALSE)`,
      [txId, importo, mittente, causale, data]
    );
    await pool.query(
      `INSERT INTO qonto_non_abbinate (qonto_tx_id,importo,mittente,causale,data) VALUES ($1,$2,$3,$4,$5)`,
      [txId, importo, mittente, causale, data]
    );
    return 'non_abbinata';
  }

  if (tipo === 'associativa') {
    const anno = new Date(data).getFullYear();
    const mesiReg = [{ anno, mese: null }];
    await pool.query(
      `INSERT INTO qonto_transazioni (id,importo,mittente,causale,data,allievo_id,tipo_pagamento,mesi_registrati,abbinata)
       VALUES ($1,$2,$3,$4,$5,$6,'associativa',$7,TRUE)`,
      [txId, importo, mittente, causale, data, found.id, JSON.stringify(mesiReg)]
    );
    await pool.query(
      `INSERT INTO quote_associative (allievo_id,anno,pagata,data_pagamento)
       VALUES ($1,$2,TRUE,$3) ON CONFLICT (allievo_id,anno) DO UPDATE SET pagata=TRUE,data_pagamento=$3`,
      [found.id, anno, data]
    );
    return 'abbinata';
  }

  // Tipo mensile: controlla quota e calcola quanti mesi copre
  const { rows: allievoRow } = await pool.query(
    `SELECT quota_mensile FROM allievi WHERE id=$1`, [found.id]
  );
  const quota = parseFloat(allievoRow[0]?.quota_mensile || 0);

  if (!quota || quota <= 0) {
    // Quota non configurata → coda manuale
    await pool.query(
      `INSERT INTO qonto_transazioni (id,importo,mittente,causale,data,abbinata) VALUES ($1,$2,$3,$4,$5,FALSE)`,
      [txId, importo, mittente, causale, data]
    );
    await pool.query(
      `INSERT INTO qonto_non_abbinate (qonto_tx_id,importo,mittente,causale,data) VALUES ($1,$2,$3,$4,$5)`,
      [txId, importo, mittente, causale, data]
    );
    return 'non_abbinata';
  }

  const numMesi = Math.round(importo / quota);
  const resto   = Math.abs(importo - numMesi * quota);

  if (resto > 0.01 || numMesi < 1) {
    // Importo non è multiplo esatto → coda manuale
    await pool.query(
      `INSERT INTO qonto_transazioni (id,importo,mittente,causale,data,abbinata) VALUES ($1,$2,$3,$4,$5,FALSE)`,
      [txId, importo, mittente, causale, data]
    );
    await pool.query(
      `INSERT INTO qonto_non_abbinate (qonto_tx_id,importo,mittente,causale,data) VALUES ($1,$2,$3,$4,$5)`,
      [txId, importo, mittente, causale, data]
    );
    return 'non_abbinata';
  }

  // Registra i N mesi arretrati non pagati più vecchi
  const mesiDaRegistrare = await mesiNonPagati(found.id, numMesi);
  if (!mesiDaRegistrare.length) {
    // Nessun mese arretrato → usa il mese corrente
    const oggi = new Date();
    mesiDaRegistrare.push({ anno: oggi.getFullYear(), mese: oggi.getMonth() + 1 });
  }

  await pool.query(
    `INSERT INTO qonto_transazioni (id,importo,mittente,causale,data,allievo_id,tipo_pagamento,mesi_registrati,abbinata)
     VALUES ($1,$2,$3,$4,$5,$6,'mensile',$7,TRUE)`,
    [txId, importo, mittente, causale, data, found.id, JSON.stringify(mesiDaRegistrare)]
  );
  await registraMesi(found.id, mesiDaRegistrare, data);
  return 'abbinata';
}

// ── POST /api/qonto/sync ──────────────────────────────────────────────────
router.post('/qonto/sync', ...requireRole('admin'), async (req, res) => {
  try {
    await ensureTables();
    const { rows: last } = await pool.query(`SELECT data FROM qonto_transazioni ORDER BY data DESC LIMIT 1`);
    const after = last.length ? last[0].data : null;
    const transazioni = await fetchQontoTransazioni(after);

    let nuove = 0, abbinate = 0, nonAbbinate = 0;
    for (const tx of transazioni) {
      const txId    = tx.transaction_id || tx.id;
      const importo = parseFloat(tx.amount || 0);
      const mittente = tx.label || '';
      const causale  = tx.reference || '';
      const data     = (tx.settled_at || '').slice(0, 10);

      const esito = await processaTransazione(txId, importo, mittente, causale, data);
      if (esito === 'gia_presente') continue;
      nuove++;
      if (esito === 'abbinata') abbinate++; else nonAbbinate++;
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
      WHERE t.abbinata = FALSE AND t.scartata IS NOT TRUE
      ORDER BY n.data DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/qonto/abbina — abbinamento manuale ─────────────────────────
router.post('/qonto/abbina', ...requireRole('admin'), async (req, res) => {
  const { qonto_tx_id, allievo_id, tipo_pagamento, mesi } = req.body;
  // mesi: [{anno, mese}] per mensile  |  [{anno}] per associativa
  if (!qonto_tx_id || !allievo_id || !tipo_pagamento || !mesi?.length) {
    return res.status(400).json({ error: 'Parametri mancanti' });
  }
  try {
    const { rows: tx } = await pool.query('SELECT * FROM qonto_transazioni WHERE id=$1', [qonto_tx_id]);
    if (!tx.length) return res.status(404).json({ error: 'Transazione non trovata' });

    await pool.query(`
      UPDATE qonto_transazioni
      SET allievo_id=$1, tipo_pagamento=$2, mesi_registrati=$3, abbinata=TRUE, scartata=FALSE
      WHERE id=$4
    `, [allievo_id, tipo_pagamento, JSON.stringify(mesi), qonto_tx_id]);

    await pool.query('DELETE FROM qonto_non_abbinate WHERE qonto_tx_id=$1', [qonto_tx_id]);

    if (tipo_pagamento === 'mensile') {
      await registraMesi(allievo_id, mesi, tx[0].data);
    } else {
      const anno = mesi[0].anno;
      await pool.query(`
        INSERT INTO quote_associative (allievo_id,anno,pagata,data_pagamento)
        VALUES ($1,$2,TRUE,$3) ON CONFLICT (allievo_id,anno) DO UPDATE SET pagata=TRUE,data_pagamento=$3
      `, [allievo_id, anno, tx[0].data]);
    }

    // Salva il mittente come noto per il futuro
    const mittenteNorm = norm(tx[0].mittente);
    if (mittenteNorm) {
      await pool.query(`
        INSERT INTO qonto_mittenti_noti (mittente_norm, allievo_id, aggiornato_il)
        VALUES ($1,$2,NOW())
        ON CONFLICT (mittente_norm) DO UPDATE SET allievo_id=$2, aggiornato_il=NOW()
      `, [mittenteNorm, allievo_id]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/qonto/abbina/:txId — annulla abbinamento ─────────────────
router.delete('/qonto/abbina/:txId', ...requireRole('admin'), async (req, res) => {
  const { txId } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM qonto_transazioni WHERE id=$1', [txId]);
    if (!rows.length) return res.status(404).json({ error: 'Non trovata' });
    const tx = rows[0];

    if (tx.allievo_id && tx.mesi_registrati) {
      if (tx.tipo_pagamento === 'mensile') {
        await rollbackMesi(tx.mesi_registrati, tx.allievo_id);
      } else {
        // rollback quota associativa: solo se pagata tramite questa transazione
        for (const { anno } of tx.mesi_registrati) {
          await pool.query(
            `UPDATE quote_associative SET pagata=FALSE, data_pagamento=NULL WHERE allievo_id=$1 AND anno=$2`,
            [tx.allievo_id, anno]
          );
        }
      }
    }

    await pool.query(`
      UPDATE qonto_transazioni
      SET abbinata=FALSE, allievo_id=NULL, tipo_pagamento=NULL, mesi_registrati=NULL
      WHERE id=$1
    `, [txId]);

    // Reinserisce in coda non abbinate se non c'è già
    const { rows: already } = await pool.query('SELECT id FROM qonto_non_abbinate WHERE qonto_tx_id=$1', [txId]);
    if (!already.length) {
      await pool.query(`
        INSERT INTO qonto_non_abbinate (qonto_tx_id, importo, mittente, causale, data)
        VALUES ($1,$2,$3,$4,$5)
      `, [txId, tx.importo, tx.mittente, tx.causale, tx.data]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/qonto/non-abbinate/:id — scarta transazione non abbinata ─
router.delete('/qonto/non-abbinate/:id', ...requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT qonto_tx_id FROM qonto_non_abbinate WHERE id=$1', [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Non trovata' });

    await pool.query('DELETE FROM qonto_non_abbinate WHERE id=$1', [id]);
    await pool.query('UPDATE qonto_transazioni SET scartata=TRUE WHERE id=$1', [rows[0].qonto_tx_id]);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/qonto/storico ────────────────────────────────────────────────
router.get('/qonto/storico', ...requireRole('admin'), async (_req, res) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(`
      SELECT t.id, t.importo, t.mittente, t.causale, t.data,
             t.tipo_pagamento, t.mesi_registrati,
             a.nome, a.cognome, a.id AS allievo_id
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

module.exports = { router, processaTransazione, ensureTables };
