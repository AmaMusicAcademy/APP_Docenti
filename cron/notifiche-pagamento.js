const schedule  = require('node-schedule');
const webpush   = require('web-push');
const { pool }  = require('../db');

webpush.setVapidDetails(
  'mailto:admin@accademiamusica.it',
  'BMgEDEnpAym0uU7vHTkp-2L4cCiQDNAFd4xHoaFyoFez8oOoA_07yjdiBoijawwx0IN2Y5Cd8Nn64qPD7wm33Mk',
  'l85YTsJL_zNYuDmONQE5P7jjOexKrzwu3A6_lIaLMfE'
);

const MESI = ['','Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
               'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

// Costruisce il messaggio per i mesi arretrati
function buildMessaggio(mesiArretrati, anno) {
  const now = new Date();
  const annoCorrente = now.getFullYear();

  if (mesiArretrati.length === 1) {
    const { anno: a, mese: m } = mesiArretrati[0];
    return `Gentile allievo, ti ricordiamo che la quota mensile di ${MESI[m]} ${a} non risulta ancora registrata. ` +
      `Ti chiediamo gentilmente di provvedere alla regolarizzazione nei prossimi giorni. Grazie per la tua collaborazione!`;
  }

  const etichette = mesiArretrati.map(({ anno: a, mese: m }) => `${MESI[m]} ${a}`).join(', ');
  return `Gentile allievo, ti ricordiamo che le quote mensili di ${etichette} non risultano ancora registrate. ` +
    `Ti invitiamo a regolarizzare la tua posizione il prima possibile per continuare a godere serenamente delle lezioni. ` +
    `Siamo a tua disposizione per qualsiasi informazione. Grazie!`;
}

// Costruisce messaggio per tassa associativa
function buildMessaggioTassa(anno) {
  return `Gentile allievo, ti ricordiamo che la tassa associativa ${anno} non risulta ancora versata. ` +
    `Ti chiediamo gentilmente di provvedere al pagamento per mantenere la tua iscrizione in regola. Grazie mille!`;
}

async function inviaPush(allievoId, titolo, corpo) {
  try {
    const { rows } = await pool.query(
      'SELECT endpoint, keys FROM push_subscriptions WHERE allievo_id=$1', [allievoId]
    );
    for (const sub of rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify({ title: titolo, body: corpo })
        );
      } catch (e) {
        // Subscription scaduta: la rimuoviamo
        if (e.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
        }
      }
    }
  } catch {}
}

async function inviaNotifichePagamento() {
  const now = new Date();
  const annoCorrente = now.getFullYear();
  const meseCorrente = now.getMonth() + 1;

  console.log(`[CRON] Avvio invio notifiche pagamento — ${now.toISOString()}`);

  try {
    // Prende tutti gli allievi attivi con quota mensile
    const { rows: allievi } = await pool.query(
      `SELECT id, nome, cognome, data_iscrizione FROM allievi
       WHERE attivo IS DISTINCT FROM FALSE AND quota_mensile > 0`
    );

    let totaleNotifiche = 0;

    for (const allievo of allievi) {
      if (!allievo.data_iscrizione) continue;

      const inizio = new Date(`${String(allievo.data_iscrizione).slice(0,10)}T00:00:00Z`);
      const y0 = inizio.getUTCFullYear();
      const m0 = inizio.getUTCMonth() + 1;

      // Recupera mesi pagati
      const { rows: pagamenti } = await pool.query(
        `SELECT anno, mese FROM pagamenti_mensili WHERE allievo_id = $1`,
        [allievo.id]
      );
      const pagatiSet = new Set(pagamenti.map(p => `${p.anno}-${p.mese}`));

      // Trova mesi arretrati (dal mese di iscrizione al mese precedente a quello corrente)
      const arretrati = [];
      for (let y = y0; y <= annoCorrente; y++) {
        const mStart = y === y0 ? m0 : 1;
        // Non includere il mese corrente (ancora in corso)
        const mEnd = y === annoCorrente ? meseCorrente - 1 : 12;
        for (let m = mStart; m <= mEnd; m++) {
          if (!pagatiSet.has(`${y}-${m}`)) {
            arretrati.push({ anno: y, mese: m });
          }
        }
      }

      if (arretrati.length === 0) continue;

      // Controlla se già inviata una notifica mensile questa settimana
      const inizioSettimana = new Date(now);
      inizioSettimana.setDate(now.getDate() - now.getDay());
      inizioSettimana.setHours(0, 0, 0, 0);

      const { rows: giàInviata } = await pool.query(
        `SELECT 1 FROM notifiche
         WHERE dest_id = $1 AND tipo = 'pagamento_mancante'
           AND created_at >= $2 LIMIT 1`,
        [allievo.id, inizioSettimana.toISOString()]
      );

      if (giàInviata.length > 0) continue;

      const messaggio = buildMessaggio(arretrati, annoCorrente);
      await pool.query(
        `INSERT INTO notifiche (dest_id, tipo, messaggio) VALUES ($1, 'pagamento_mancante', $2)`,
        [allievo.id, messaggio]
      );
      await inviaPush(allievo.id, '💳 Promemoria pagamento', messaggio);
      totaleNotifiche++;
    }

    // --- Tassa associativa ---
    const { rows: senzaTassa } = await pool.query(
      `SELECT a.id FROM allievi a
       WHERE a.attivo IS DISTINCT FROM FALSE
         AND NOT EXISTS (
           SELECT 1 FROM quote_associative qa
           WHERE qa.allievo_id = a.id AND qa.anno = $1 AND qa.pagata = TRUE
         )`,
      [annoCorrente]
    );

    for (const a of senzaTassa) {
      const inizioSettimana = new Date(now);
      inizioSettimana.setDate(now.getDate() - now.getDay());
      inizioSettimana.setHours(0, 0, 0, 0);

      const { rows: giàInviata } = await pool.query(
        `SELECT 1 FROM notifiche
         WHERE dest_id = $1 AND tipo = 'tassa_associativa'
           AND created_at >= $2 LIMIT 1`,
        [a.id, inizioSettimana.toISOString()]
      );
      if (giàInviata.length > 0) continue;

      const msgTassa = buildMessaggioTassa(annoCorrente);
      await pool.query(
        `INSERT INTO notifiche (dest_id, tipo, messaggio) VALUES ($1, 'tassa_associativa', $2)`,
        [a.id, msgTassa]
      );
      await inviaPush(a.id, '🪪 Tassa associativa', msgTassa);
      totaleNotifiche++;
    }

    // Salva log ultima esecuzione
    await pool.query(
      `INSERT INTO cron_log (job, eseguito_il, notifiche_inviate)
       VALUES ('notifiche_pagamento', NOW(), $1)
       ON CONFLICT (job) DO UPDATE SET eseguito_il = NOW(), notifiche_inviate = $1`,
      [totaleNotifiche]
    );

    console.log(`[CRON] Notifiche inviate: ${totaleNotifiche}`);
    return totaleNotifiche;
  } catch (err) {
    console.error('[CRON] Errore notifiche pagamento:', err);
    return 0;
  }
}

function avviaCron() {
  // Ogni lunedì alle 09:00  (sec min hour dom month dow)
  schedule.scheduleJob('0 9 * * 1', inviaNotifichePagamento);
  console.log('[CRON] Notifiche pagamento programmate ogni lunedì alle 09:00');
}

module.exports = { avviaCron, inviaNotifichePagamento };
