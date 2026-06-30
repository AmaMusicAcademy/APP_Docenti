const schedule = require('node-schedule');
const { processaTransazione, ensureTables } = require('../routes/qonto');

const QONTO_LOGIN           = process.env.QONTO_LOGIN;
const QONTO_SECRET_KEY      = process.env.QONTO_SECRET_KEY;
const QONTO_BANK_ACCOUNT_ID = process.env.QONTO_BANK_ACCOUNT_ID;
const { pool } = require('../db');

async function eseguiSyncQonto() {
  if (!QONTO_LOGIN || !QONTO_SECRET_KEY) {
    console.log('[qonto-sync] Credenziali non configurate, skip.');
    return;
  }

  await ensureTables();

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

  let abbinate = 0, nonAbbinate = 0;
  for (const tx of crediti) {
    const esito = await processaTransazione(
      tx.transaction_id || tx.id,
      parseFloat(tx.amount || 0),
      tx.label || '',
      tx.reference || '',
      (tx.settled_at || '').slice(0, 10)
    );
    if (esito === 'gia_presente') continue;
    if (esito === 'abbinata') abbinate++; else nonAbbinate++;
  }

  console.log(`[qonto-sync] Completato: ${abbinate} abbinate, ${nonAbbinate} da verificare`);
}

function avviaQontoCron() {
  schedule.scheduleJob('0 8 * * *', async () => {
    console.log('[qonto-sync] Avvio sync automatica...');
    try { await eseguiSyncQonto(); }
    catch (err) { console.error('[qonto-sync] Errore:', err.message); }
  });
  console.log('[qonto-sync] Cron registrato (ogni giorno alle 08:00)');
}

module.exports = { avviaQontoCron, eseguiSyncQonto };
