const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../Middleware/auth');
const webpush = require('web-push');

webpush.setVapidDetails(
  'mailto:admin@accademiamusica.it',
  process.env.VAPID_PUBLIC_KEY  || 'BMgEDEnpAym0uU7vHTkp-2L4cCiQDNAFd4xHoaFyoFez8oOoA_07yjdiBoijawwx0IN2Y5Cd8Nn64qPD7wm33Mk',
  process.env.VAPID_PRIVATE_KEY || 'l85YTsJL_zNYuDmONQE5P7jjOexKrzwu3A6_lIaLMfE'
);

async function inviaPushAllievo(allievoId, titolo, corpo) {
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
        if (e.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
        }
      }
    }
  } catch {}
}

const router = express.Router();

const dateOnly = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch { return String(d).slice(0, 10); }
};

// GET /api/allievo/me
router.get('/allievo/me', ...requireRole('allievo'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nome, cognome, email, telefono, indirizzo, cap, citta, provincia, strumento,
              data_nascita, luogo_nascita, codice_fiscale, data_iscrizione, quota_mensile,
              minore, genitore_nome, genitore_cognome, genitore_cf, genitore_data_nascita,
              genitore_luogo_nascita, genitore_indirizzo, genitore_telefono, genitore_email,
              accettazione_reg, data_accettazione_reg
       FROM allievi WHERE id = $1`,
      [req.user.allievoId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore server' });
  }
});

// GET /api/allievo/lezioni?stato=future|passate|tutte
router.get('/allievo/lezioni', ...requireRole('allievo'), async (req, res) => {
  const { stato = 'tutte' } = req.query;
  const id = req.user.allievoId;

  let statoCondition = '';
  const oggi = new Date().toISOString().slice(0, 10);

  if (stato === 'future') {
    // lezioni future: data futura, oppure oggi ma ancora da svolgere (appuntamentata)
    statoCondition = `AND (l.data > '${oggi}' OR (l.data = '${oggi}' AND l.stato = 'appuntamentata'))`;
  } else if (stato === 'passate') {
    // lezioni passate: date precedenti, oppure oggi ma già completate/annullate/rimandate
    statoCondition = `AND (l.data < '${oggi}' OR (l.data = '${oggi}' AND l.stato != 'appuntamentata'))`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT
         l.id,
         TO_CHAR(l.data, 'YYYY-MM-DD') AS data,
         l.ora_inizio, l.ora_fine, l.aula, l.stato, l.motivazione,
         i.nome AS nome_insegnante, i.cognome AS cognome_insegnante,
         l.tipo, l.nome_gruppo
       FROM lezioni l
       LEFT JOIN insegnanti i ON l.id_insegnante = i.id
       WHERE l.id_allievo = $1 ${statoCondition}
       UNION
       SELECT
         l.id,
         TO_CHAR(l.data, 'YYYY-MM-DD') AS data,
         l.ora_inizio, l.ora_fine, l.aula, l.stato, l.motivazione,
         i.nome AS nome_insegnante, i.cognome AS cognome_insegnante,
         l.tipo, l.nome_gruppo
       FROM lezioni l
       JOIN lezioni_partecipanti lp ON lp.lezione_id = l.id AND lp.allievo_id = $1
       LEFT JOIN insegnanti i ON l.id_insegnante = i.id
       WHERE l.tipo = 'collettiva' ${statoCondition}
       ORDER BY data DESC, ora_inizio DESC`,
      [id]
    );

    const lezioni = rows.map((l) => ({
      ...l,
      ora_inizio: l.ora_inizio ? String(l.ora_inizio).slice(0, 5) : null,
      ora_fine: l.ora_fine ? String(l.ora_fine).slice(0, 5) : null,
    }));

    res.json(lezioni);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero lezioni' });
  }
});

// GET /api/allievo/pagamenti
router.get('/allievo/pagamenti', ...requireRole('allievo'), async (req, res) => {
  const id = req.user.allievoId;
  try {
    // Dati allievo (quota e data iscrizione)
    const allRes = await pool.query(
      'SELECT quota_mensile, data_iscrizione FROM allievi WHERE id = $1',
      [id]
    );
    if (allRes.rows.length === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    const { quota_mensile, data_iscrizione } = allRes.rows[0];

    // Pagamenti effettuati
    const pagRes = await pool.query(
      `SELECT anno, mese, data_pagamento FROM pagamenti_mensili
       WHERE allievo_id = $1 ORDER BY anno DESC, mese DESC`,
      [id]
    );

    const pagatiSet = new Set(pagRes.rows.map((p) => `${p.anno}-${p.mese}`));

    // Genera griglia mesi dall'iscrizione ad oggi
    const oggi = new Date();
    const start = data_iscrizione ? new Date(data_iscrizione) : oggi;
    const mesi = [];
    let cur = new Date(start.getFullYear(), start.getMonth(), 1);
    const fine = new Date(oggi.getFullYear(), oggi.getMonth(), 1);

    while (cur <= fine) {
      const anno = cur.getFullYear();
      const mese = cur.getMonth() + 1;
      const chiave = `${anno}-${mese}`;
      const pagamento = pagRes.rows.find((p) => p.anno === anno && p.mese === mese);
      mesi.push({
        anno,
        mese,
        pagato: pagatiSet.has(chiave),
        data_pagamento: pagamento?.data_pagamento || null,
        importo: quota_mensile,
      });
      cur.setMonth(cur.getMonth() + 1);
    }

    mesi.reverse(); // più recente prima

    // Stato abbonamento Stripe
    const { rows: subRow } = await pool.query(
      'SELECT stripe_subscription_id FROM allievi WHERE id=$1', [id]
    );
    const abbonamentoAttivo = !!(subRow[0]?.stripe_subscription_id);

    res.json({ quota_mensile, pagamenti: mesi, abbonamentoAttivo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero pagamenti' });
  }
});

// POST /api/allievo/conferma-pagamento — marca mesi come pagati subito dopo Stripe (backup webhook)
router.post('/allievo/conferma-pagamento', ...requireRole('allievo'), async (req, res) => {
  const { mesi = [] } = req.body;
  const id = req.user.allievoId;
  try {
    for (const { anno, mese } of mesi) {
      await pool.query(
        `INSERT INTO pagamenti_mensili (allievo_id, anno, mese, data_pagamento)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [id, anno, mese]
      );
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

// GET /api/allievo/notifiche
router.get('/allievo/notifiche', ...requireRole('allievo'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, tipo, messaggio, letto, created_at
       FROM notifiche
       WHERE dest_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.allievoId]
    );
    const nonLette = rows.filter((n) => !n.letto).length;
    res.json({ notifiche: rows, nonLette });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero notifiche' });
  }
});

// PATCH /api/allievo/notifiche/:id/letto
router.patch('/allievo/notifiche/:notificaId/letto', ...requireRole('allievo'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifiche SET letto=TRUE WHERE id=$1 AND dest_id=$2`,
      [req.params.notificaId, req.user.allievoId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore' });
  }
});

// PATCH /api/allievo/notifiche/letto-tutte
router.patch('/allievo/notifiche/letto-tutte', ...requireRole('allievo'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifiche SET letto=TRUE WHERE dest_id=$1 AND letto=FALSE`,
      [req.user.allievoId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore' });
  }
});

// ── Migration nuovi campi profilo ──────────────────────────────────────────
pool.query(`
  ALTER TABLE allievi
  ADD COLUMN IF NOT EXISTS codice_fiscale        TEXT,
  ADD COLUMN IF NOT EXISTS luogo_nascita         TEXT,
  ADD COLUMN IF NOT EXISTS minore                BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS genitore_nome         TEXT,
  ADD COLUMN IF NOT EXISTS genitore_cognome      TEXT,
  ADD COLUMN IF NOT EXISTS genitore_cf           TEXT,
  ADD COLUMN IF NOT EXISTS genitore_data_nascita DATE,
  ADD COLUMN IF NOT EXISTS genitore_luogo_nascita TEXT,
  ADD COLUMN IF NOT EXISTS genitore_indirizzo    TEXT,
  ADD COLUMN IF NOT EXISTS genitore_telefono     TEXT,
  ADD COLUMN IF NOT EXISTS genitore_email        TEXT,
  ADD COLUMN IF NOT EXISTS accettazione_reg      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS data_accettazione_reg TIMESTAMPTZ
`).catch(() => {});

pool.query(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         SERIAL PRIMARY KEY,
    allievo_id INTEGER NOT NULL REFERENCES allievi(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL,
    keys       JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(allievo_id, endpoint)
  )
`).catch(() => {});

// PATCH /api/allievo/profilo  — aggiornamento profilo da parte dell'allievo
router.patch('/allievo/profilo', ...requireRole('allievo'), async (req, res) => {
  const id = req.user.allievoId;
  const campi = [
    'email','telefono','indirizzo','cap','citta','provincia','codice_fiscale','luogo_nascita','data_nascita',
    'minore',
    'genitore_nome','genitore_cognome','genitore_cf','genitore_data_nascita',
    'genitore_luogo_nascita','genitore_indirizzo','genitore_telefono','genitore_email',
  ];
  const sets = []; const vals = [];
  campi.forEach(c => {
    if (req.body[c] !== undefined) { sets.push(`${c} = $${vals.length+1}`); vals.push(req.body[c] ?? null); }
  });
  // Accettazione regolamento: si può solo attivare, mai disattivare
  if (req.body.accettazione_reg === true) {
    sets.push(`accettazione_reg = TRUE`);
    sets.push(`data_accettazione_reg = NOW()`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nessun campo' });
  vals.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE allievi SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals
    );
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

// GET /api/allievo/me — esteso con tutti i campi profilo
// (sovrascrive la route esistente — inserita prima, questa viene ignorata; la sistemiamo qui sotto)

// GET /api/allievo/riepilogo-anno — statistiche anno accademico corrente
router.get('/allievo/riepilogo-anno', ...requireRole('allievo'), async (req, res) => {
  const id = req.user.allievoId;
  const now = new Date();
  // Anno accademico: 1 set anno-1 → 30 giu anno se siamo gen-giu, altrimenti 1 set anno → 30 giu anno+1
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  const annoInizio = m >= 9 ? y : y - 1;
  const inizio = `${annoInizio}-09-01`;
  const fine   = `${annoInizio + 1}-08-31`;
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE stato = 'svolta')         AS svolte,
         COUNT(*) FILTER (WHERE stato = 'rimandata')      AS rimandate,
         COUNT(*) FILTER (WHERE stato = 'annullata')      AS annullate,
         COUNT(*) FILTER (WHERE stato = 'appuntamentata') AS future
       FROM (
         SELECT stato FROM lezioni WHERE id_allievo = $1 AND data BETWEEN $2 AND $3
         UNION ALL
         SELECT l.stato FROM lezioni l
         JOIN lezioni_partecipanti lp ON lp.lezione_id = l.id AND lp.allievo_id = $1
         WHERE l.tipo = 'collettiva' AND l.data BETWEEN $2 AND $3
       ) sub`,
      [id, inizio, fine]
    );
    res.json({ ...rows[0], inizio, fine, annoInizio, annoFine: annoInizio + 1 });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

// GET /api/allievo/pagamenti-arretrati
router.get('/allievo/pagamenti-arretrati', ...requireRole('allievo'), async (req, res) => {
  const id = req.user.allievoId;
  try {
    const { rows: allRow } = await pool.query(
      'SELECT quota_mensile, data_iscrizione FROM allievi WHERE id=$1', [id]
    );
    if (!allRow.length) return res.status(404).json({ error: 'Non trovato' });
    const { quota_mensile, data_iscrizione } = allRow[0];

    const { rows: pagati } = await pool.query(
      'SELECT anno, mese FROM pagamenti_mensili WHERE allievo_id=$1', [id]
    );
    const pagatiSet = new Set(pagati.map(p=>`${p.anno}-${p.mese}`));

    const now = new Date();
    const start = data_iscrizione ? new Date(`${String(data_iscrizione).slice(0,10)}T00:00:00Z`) : now;
    const arretrati = [];
    let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    // fino al mese precedente (il corrente è ancora in corso)
    const limiteMese = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));

    while (cur < limiteMese) {
      const a = cur.getUTCFullYear(), m = cur.getUTCMonth() + 1;
      if (!pagatiSet.has(`${a}-${m}`)) arretrati.push({ anno: a, mese: m, importo: quota_mensile });
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }

    // Tassa associativa anno corrente
    const annoCorrente = now.getFullYear();
    const { rows: qa } = await pool.query(
      `SELECT pagata FROM quote_associative WHERE allievo_id=$1 AND anno=$2`, [id, annoCorrente]
    );
    const tassaPagata = qa.length > 0 && qa[0].pagata;

    res.json({ arretrati, quota_mensile, tassaPagata, annoCorrente });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

// POST /api/allievo/push-subscribe — salva subscription push
router.post('/allievo/push-subscribe', ...requireRole('allievo'), async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'Dati mancanti' });
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (allievo_id, endpoint, keys)
       VALUES ($1, $2, $3)
       ON CONFLICT (allievo_id, endpoint) DO UPDATE SET keys = $3`,
      [req.user.allievoId, endpoint, JSON.stringify(keys)]
    );
    // Push di conferma iscrizione
    await inviaPushAllievo(req.user.allievoId, '🔔 Notifiche attive', 'Riceverai aggiornamenti su pagamenti e lezioni direttamente qui.');
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});

// POST /api/allievo/push-test — invia push di test all'utente corrente
router.post('/allievo/push-test', ...requireRole('allievo'), async (req, res) => {
  try {
    await inviaPushAllievo(req.user.allievoId, '🧪 Test notifica', 'Le notifiche push funzionano correttamente!');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/allievo/richiesta-pagamento — allievo segnala arretrati da regolarizzare
router.post('/allievo/richiesta-pagamento', ...requireRole('allievo'), async (req, res) => {
  const id = req.user.allievoId;
  const { mesi = [] } = req.body;
  try {
    const { rows } = await pool.query('SELECT nome, cognome FROM allievi WHERE id=$1', [id]);
    const nome = rows[0] ? `${rows[0].nome} ${rows[0].cognome}` : `Allievo #${id}`;
    const MESI_NOME = ['','Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
      'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
    const elenco = mesi.map(m => `${MESI_NOME[m.mese]} ${m.anno}`).join(', ');
    const msg = `L'allievo ${nome} ha inviato una richiesta di regolarizzazione per le quote: ${elenco}. Contattare per concordare il pagamento.`;

    // Notifica all'admin (tabella utenti con ruolo admin)
    const { rows: admins } = await pool.query(`SELECT id FROM utenti WHERE ruolo='admin'`);
    for (const a of admins) {
      await pool.query(
        `INSERT INTO notifiche (dest_id, tipo, messaggio) VALUES ($1, 'richiesta_pagamento', $2)`,
        [a.id, msg]
      ).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore' }); }
});


// GET /api/allievo/iscrizione-pdf — token download PDF iscrizione (lato allievo)
router.get('/allievo/iscrizione-pdf', ...requireRole('allievo'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT token_download FROM iscrizioni WHERE allievo_id=$1 AND stato='accettata' ORDER BY accettata_il DESC LIMIT 1`,
      [req.user.allievoId]
    );
    if (!rows.length || !rows[0].token_download) return res.json({ token: null });
    res.json({ token: rows[0].token_download });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
