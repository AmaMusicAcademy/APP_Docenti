const schedule = require('node-schedule');
const { pool } = require('../db');

const QONTO_LOGIN           = process.env.QONTO_LOGIN;
const QONTO_SECRET_KEY      = process.env.QONTO_SECRET_KEY;
const QONTO_BANK_ACCOUNT_ID = process.env.QONTO_BANK_ACCOUNT_ID;

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

async function trovaAllievo(mittente, causale) {
  const { rows } = await pool.query(
    `SELECT id, nome, cognome, genitore_nome, genitore_cognome
     FROM allievi WHERE attivo IS DISTINCT FROM FALSE`
  );
  const match = [];
  for (const a of rows) {
    if (containsName(mittente, a.nome, a.cognome))             { match.push(a.id); continue; }
    if (a.genitore_nome && a.genitore_cognome &&
        containsName(mittente, a.genitore_nome, a.genitore_cognome)) { match.push(a.id); continue; }
    if (containsName(causale,  a.nome, a.cognome))             { match.push(a.id); continue; }
  }
  return match.length === 1 ? match[0] : null;
}

function inferTipo(causale) {
  const c = norm(causale);
  if (c.includes('associat') || c.includes('tesseramento') || c.includes('annuale')) return 'associativa';
  return 'mensile';
}

async function eseguiSyncQonto() {
  if (!QONTO_LOGIN || !QONTO_SECRET_KEY) {
    console.log('[qonto-sync] Credenziali non configurate, skip.');
    return;
  }

  const { rows: last } = await pool.query(
    `SELECT data FROM qonto_transazioni ORDER BY data DESC LIMIT 1`
  );
  const after = last.length ? last[0].data : null;

  const params = new URLSearchParams({ side: 'credit', per_page: '100', sort_by: 'settled_at:desc' });
  if (QONTO_BANK_ACCOUNT_ID) params.set('bank_account_id', QONTO_BANK_ACCOUNT_ID);
  if (after) params.set('settled_at_from', after);

  const res = await fetch(`https://thirdparty.qonto.com/v2/transactions?${params}`, {
    headers: { Authorization: `${QONTO_LOGIN}:${QONTO_SECRET_KEY}` },
  });
  if (!res.ok) { console.error('[qonto-sync] API error', res.status); return; }

  const { transactions = [] } = await res.json();
  const crediti = transactions.filter(tx => tx.side === 'credit');

  const now = new Date();
  const anno = now.getFullYear();
  const mese = now.getMonth() + 1;
  let abbinate = 0, nonAbbinate = 0;

  for (const tx of crediti) {
    const txId    = tx.transaction_id || tx.id;
    const importo = parseFloat(tx.amount || 0);
    const mittente = tx.label || '';
    const causale  = tx.reference || '';
    const data     = (tx.settled_at || '').slice(0, 10);

    const { rows: exist } = await pool.query('SELECT id FROM qonto_transazioni WHERE id=$1', [txId]);
    if (exist.length) continue;

    const allievoId = await trovaAllievo(mittente, causale);
    const tipo = inferTipo(causale);

    if (allievoId) {
      await pool.query(
        `INSERT INTO qonto_transazioni (id,importo,mittente,causale,data,allievo_id,tipo_pagamento,anno,mese,abbinata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)`,
        [txId, importo, mittente, causale, data, allievoId, tipo, anno, mese]
      );
      if (tipo === 'mensile') {
        await pool.query(
          `INSERT INTO pagamenti_mensili (allievo_id,anno,mese,data_pagamento)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [allievoId, anno, mese, data]
        );
      } else {
        await pool.query(
          `INSERT INTO quote_associative (allievo_id,anno,pagata,data_pagamento)
           VALUES ($1,$2,TRUE,$3) ON CONFLICT (allievo_id,anno) DO UPDATE SET pagata=TRUE,data_pagamento=$3`,
          [allievoId, anno, data]
        );
      }
      abbinate++;
    } else {
      await pool.query(
        `INSERT INTO qonto_transazioni (id,importo,mittente,causale,data,abbinata)
         VALUES ($1,$2,$3,$4,$5,FALSE)`,
        [txId, importo, mittente, causale, data]
      );
      await pool.query(
        `INSERT INTO qonto_non_abbinate (qonto_tx_id,importo,mittente,causale,data)
         VALUES ($1,$2,$3,$4,$5)`,
        [txId, importo, mittente, causale, data]
      );
      nonAbbinate++;
    }
  }

  console.log(`[qonto-sync] Completato: ${abbinate} abbinate, ${nonAbbinate} da verificare`);
}

function avviaQontoCron() {
  // Ogni giorno alle 08:00
  schedule.scheduleJob('0 8 * * *', async () => {
    console.log('[qonto-sync] Avvio sync automatica...');
    try {
      await eseguiSyncQonto();
    } catch (err) {
      console.error('[qonto-sync] Errore:', err.message);
    }
  });
  console.log('[qonto-sync] Cron registrato (ogni giorno alle 08:00)');
}

module.exports = { avviaQontoCron, eseguiSyncQonto };
