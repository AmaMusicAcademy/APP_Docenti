const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../Middleware/auth');
const { getAnnoAccademico } = require('../utils/annoAccademico');

// Migrazione tabelle lezioni collettive (idempotente)
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gruppi (
        id            SERIAL PRIMARY KEY,
        nome          TEXT NOT NULL,
        id_insegnante INTEGER REFERENCES insegnanti(id) ON DELETE SET NULL,
        attivo        BOOLEAN DEFAULT TRUE
      );
      CREATE TABLE IF NOT EXISTS gruppi_allievi (
        gruppo_id  INTEGER REFERENCES gruppi(id) ON DELETE CASCADE,
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        data_ingresso DATE DEFAULT CURRENT_DATE,
        PRIMARY KEY (gruppo_id, allievo_id)
      );
      CREATE TABLE IF NOT EXISTS lezioni_partecipanti (
        id         SERIAL PRIMARY KEY,
        lezione_id INTEGER REFERENCES lezioni(id) ON DELETE CASCADE,
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        presente   BOOLEAN DEFAULT TRUE,
        UNIQUE(lezione_id, allievo_id)
      );
    `);
    await pool.query(`ALTER TABLE lezioni ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'individuale'`).catch(() => {});
    await pool.query(`ALTER TABLE lezioni ADD COLUMN IF NOT EXISTS gruppo_id INTEGER REFERENCES gruppi(id) ON DELETE SET NULL`).catch(() => {});
    await pool.query(`ALTER TABLE lezioni ADD COLUMN IF NOT EXISTS nome_gruppo TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE lezioni ALTER COLUMN id_allievo DROP NOT NULL`).catch(() => {});
  } catch (e) {
    console.error('[lezioni] migration error:', e.message);
  }
})();
const webpush = require('web-push');

webpush.setVapidDetails(
  'mailto:admin@accademiamusica.it',
  process.env.VAPID_PUBLIC_KEY  || 'BMgEDEnpAym0uU7vHTkp-2L4cCiQDNAFd4xHoaFyoFez8oOoA_07yjdiBoijawwx0IN2Y5Cd8Nn64qPD7wm33Mk',
  process.env.VAPID_PRIVATE_KEY || 'l85YTsJL_zNYuDmONQE5P7jjOexKrzwu3A6_lIaLMfE'
);

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
const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

const parseHistory = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
};

const TITOLI_PUSH = {
  lezione_annullata: '❌ Lezione annullata',
  lezione_rimandato: '🔄 Lezione spostata',
};

async function creaNotificaLezione(id_allievo, tipo, messaggio) {
  try {
    await pool.query(
      `INSERT INTO notifiche (dest_id, tipo, messaggio)
       VALUES ($1, $2, $3)`,
      [id_allievo, tipo, messaggio]
    );
    // Push contestuale
    const titolo = TITOLI_PUSH[tipo] || '📚 Accademia Musicale';
    await inviaPush(id_allievo, titolo, messaggio);
  } catch (err) {
    console.error('Errore creazione notifica:', err);
  }
}

// GET /api/lezioni
router.get('/lezioni', async (_req, res) => {
  const annoCorrente = getAnnoAccademico();
  try {
    const { rows } = await pool.query(`
      SELECT
        l.id,
        TO_CHAR(l.data, 'YYYY-MM-DD') AS data,
        l.ora_inizio, l.ora_fine, l.aula, l.stato,
        l.motivazione, l.riprogrammata, l.storico_programmazioni,
        l.id_insegnante, l.id_allievo,
        COALESCE(l.tipo, 'individuale') AS tipo,
        l.gruppo_id, COALESCE(l.nome_gruppo, g.nome) AS nome_gruppo,
        i.nome AS nome_insegnante, i.cognome AS cognome_insegnante,
        a.nome AS nome_allievo, a.cognome AS cognome_allievo,
        (SELECT COUNT(*) FROM lezioni_partecipanti lp WHERE lp.lezione_id = l.id)::int AS num_partecipanti
      FROM lezioni l
      LEFT JOIN insegnanti i ON l.id_insegnante = i.id
      LEFT JOIN allievi a ON l.id_allievo = a.id
      LEFT JOIN gruppi g ON g.id = l.gruppo_id
      WHERE (l.anno_accademico IS NULL OR l.anno_accademico = $1)
    `, [annoCorrente]);

    const eventi = rows
      .filter((l) => l.data && l.ora_inizio && l.ora_fine)
      .map((l) => {
        const ymd = dateOnly(l.data);
        const oi = hhmm(l.ora_inizio);
        const of = hhmm(l.ora_fine);
        const isCollettiva = l.tipo === 'collettiva';
        return {
          id: l.id,
          tipo: l.tipo || 'individuale',
          id_insegnante: l.id_insegnante,
          id_allievo: l.id_allievo,
          gruppo_id: l.gruppo_id,
          nome_gruppo: l.nome_gruppo,
          num_partecipanti: l.num_partecipanti || 0,
          nome_insegnante: l.nome_insegnante,
          cognome_insegnante: l.cognome_insegnante,
          nome_allievo: l.nome_allievo,
          cognome_allievo: l.cognome_allievo,
          aula: l.aula,
          stato: l.stato,
          motivazione: l.motivazione,
          riprogrammata: l.riprogrammata,
          storico_programmazioni: Array.isArray(l.storico_programmazioni)
            ? l.storico_programmazioni
            : (l.storico_programmazioni || []),
          title: isCollettiva
            ? `${l.nome_gruppo || 'Gruppo'}${l.aula ? ` - Aula ${l.aula}` : ''}`
            : `Lezione con ${l.nome_allievo || 'Allievo'}${l.aula ? ` - Aula ${l.aula}` : ''}`,
          start: ymd && oi ? `${ymd}T${oi}` : null,
          end: ymd && of ? `${ymd}T${of}` : null,
          data: ymd,
          ora_inizio: oi,
          ora_fine: of,
        };
      });

    res.json(eventi);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero lezioni' });
  }
});

// POST /api/lezioni
router.post('/lezioni', authenticateToken, async (req, res) => {
  try {
    const {
      id_insegnante,
      id_allievo,
      gruppo_id,
      data,
      ora_inizio,
      ora_fine,
      aula,
      stato = 'appuntamentata',
      motivazione = null,
    } = req.body;

    const isCollettiva = Boolean(gruppo_id);

    if (!id_insegnante || !data || !ora_inizio || !ora_fine || !aula) {
      return res.status(400).json({ error: 'Dati incompleti per creare la lezione' });
    }
    if (!isCollettiva && !id_allievo) {
      return res.status(400).json({ error: 'Dati incompleti per creare la lezione' });
    }

    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }

    // Conflict detection aula
    const conflict = await pool.query(
      `SELECT 1 FROM lezioni
       WHERE data = $1 AND aula = $2
         AND ($3 < ora_fine AND $4 > ora_inizio)
         AND stato NOT IN ('annullata')
       LIMIT 1`,
      [data, aula, ora_inizio, ora_fine]
    );
    if (conflict.rows.length > 0) {
      return res.status(409).json({ error: "L'aula è già occupata in questo orario." });
    }

    let nomeGruppo = null;
    if (isCollettiva) {
      const gRes = await pool.query('SELECT nome FROM gruppi WHERE id=$1', [gruppo_id]);
      nomeGruppo = gRes.rows[0]?.nome || null;
    }

    const insert = await pool.query(
      `INSERT INTO lezioni (id_insegnante, id_allievo, gruppo_id, nome_gruppo, tipo, data, ora_inizio, ora_fine, aula, stato, motivazione, riprogrammata, anno_accademico)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,$12) RETURNING *`,
      [
        id_insegnante,
        isCollettiva ? null : id_allievo,
        isCollettiva ? gruppo_id : null,
        isCollettiva ? nomeGruppo : null,
        isCollettiva ? 'collettiva' : 'individuale',
        data, ora_inizio, ora_fine, aula, stato, motivazione,
        getAnnoAccademico(),
      ]
    );
    const row = insert.rows[0];
    const dataSolo = String(row.data).slice(0, 10);

    if (isCollettiva) {
      // Snapshot partecipanti dal gruppo
      const { rows: membri } = await pool.query(
        'SELECT allievo_id FROM gruppi_allievi WHERE gruppo_id=$1', [gruppo_id]
      );
      for (const m of membri) {
        await pool.query(
          `INSERT INTO lezioni_partecipanti (lezione_id, allievo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [row.id, m.allievo_id]
        );
      }
      return res.status(201).json({
        ...row,
        nome_gruppo: nomeGruppo,
        num_partecipanti: membri.length,
        start: `${dataSolo}T${row.ora_inizio}`,
        end: `${dataSolo}T${row.ora_fine}`,
      });
    }

    // Lezione individuale — notifica push esistente
    const dett = await pool.query(
      `SELECT nome AS nome_allievo, cognome AS cognome_allievo FROM allievi WHERE id = $1`,
      [row.id_allievo]
    );
    const allievo = dett.rows[0] || {};
    res.status(201).json({
      ...row,
      nome_allievo: allievo.nome_allievo,
      cognome_allievo: allievo.cognome_allievo,
      start: `${dataSolo}T${row.ora_inizio}`,
      end: `${dataSolo}T${row.ora_fine}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella creazione lezione' });
  }
});

// GET /api/lezioni/:id
router.get('/lezioni/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM lezioni WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel recupero lezione' });
  }
});

// PUT /api/lezioni/:id (con conflict detection aula)
router.put('/lezioni/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato, motivazione = '' } = req.body;

  try {
    const curRes = await pool.query('SELECT * FROM lezioni WHERE id = $1', [id]);
    if (curRes.rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    const cur = curRes.rows[0];

    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(cur.id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }

    if (data && ora_inizio && ora_fine && aula) {
      const conflict = await pool.query(
        `SELECT 1 FROM lezioni
         WHERE id != $1 AND data = $2 AND aula = $3
           AND ($4 < ora_fine AND $5 > ora_inizio)
           AND stato NOT IN ('annullata')
         LIMIT 1`,
        [id, data, aula, ora_inizio, ora_fine]
      );
      if (conflict.rows.length > 0) {
        return res.status(409).json({ error: "L'aula è già occupata in questo orario." });
      }
    }

    const newData      = data ?? cur.data;
    const newInizio    = ora_inizio ?? cur.ora_inizio;
    const newFine      = ora_fine ?? cur.ora_fine;
    const newAula      = aula ?? cur.aula;
    const newStato     = stato ?? cur.stato;

    const dateChanged  = hhmm(data)       !== hhmm(cur.data);
    const startChanged = hhmm(ora_inizio) !== hhmm(cur.ora_inizio);
    const endChanged   = hhmm(ora_fine)   !== hhmm(cur.ora_fine);
    const roomChanged  = aula && String(aula).trim() !== String(cur.aula || '').trim();
    const scheduleChanged = dateChanged || startChanged || endChanged || roomChanged;

    let newRiprogrammata = false;
    let newOld = parseHistory(cur.old_schedules);

    if (newStato === 'rimandata' && scheduleChanged) {
      newRiprogrammata = true;
      newOld = [
        ...newOld,
        {
          data: dateOnly(cur.data),
          ora_inizio: hhmm(cur.ora_inizio),
          ora_fine: hhmm(cur.ora_fine),
          aula: cur.aula,
          changed_at: new Date().toISOString(),
        },
      ];
    }

    const { rows } = await pool.query(
      `UPDATE lezioni SET
        id_insegnante=$1, id_allievo=$2, data=$3, ora_inizio=$4, ora_fine=$5,
        aula=$6, stato=$7, motivazione=$8, riprogrammata=$9, old_schedules=$10
       WHERE id=$11 RETURNING *`,
      [
        id_insegnante ?? cur.id_insegnante,
        id_allievo ?? cur.id_allievo,
        newData, newInizio, newFine, newAula, newStato,
        motivazione,
        newRiprogrammata,
        JSON.stringify(newOld),
        id,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nell'aggiornamento lezione" });
  }
});

// PATCH /api/lezioni/:id/rimanda
router.patch('/lezioni/:id/rimanda', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { motivazione = '' } = req.body;
  try {
    const curRes = await pool.query('SELECT * FROM lezioni WHERE id = $1', [id]);
    if (curRes.rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    const cur = curRes.rows[0];

    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(cur.id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }

    const update = await pool.query(
      `UPDATE lezioni SET stato='rimandata', riprogrammata=false, motivazione=$1 WHERE id=$2
       RETURNING *, TO_CHAR(data, 'YYYY-MM-DD') AS data_str`,
      [motivazione, id]
    );

    // Notifica all'allievo
    if (cur.id_allievo) {
      const dataStr = update.rows[0].data_str || dateOnly(cur.data);
      await creaNotificaLezione(
        cur.id_allievo,
        'lezione_rimandata',
        `La tua lezione del ${dataStr} è stata rimandata${motivazione ? ': ' + motivazione : '.'}`
      );
    }

    res.json(update.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel rimandare la lezione' });
  }
});

// PATCH /api/lezioni/:id/annulla
router.patch('/lezioni/:id/annulla', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { motivazione = '' } = req.body;
  try {
    const curRes = await pool.query('SELECT * FROM lezioni WHERE id = $1', [id]);
    if (curRes.rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    const cur = curRes.rows[0];

    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(cur.id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }

    const update = await pool.query(
      `UPDATE lezioni SET stato='annullata', riprogrammata=false, motivazione=$1 WHERE id=$2
       RETURNING *, TO_CHAR(data, 'YYYY-MM-DD') AS data_str`,
      [motivazione, id]
    );

    // Notifica all'allievo
    if (cur.id_allievo) {
      const dataStr = update.rows[0].data_str || dateOnly(cur.data);
      await creaNotificaLezione(
        cur.id_allievo,
        'lezione_annullata',
        `La tua lezione del ${dataStr} è stata annullata${motivazione ? ': ' + motivazione : '.'}`
      );
    }

    res.json(update.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nell'annullare la lezione" });
  }
});

// PATCH /api/lezioni/:id/presente — segna lezione come svolta
router.patch('/lezioni/:id/presente', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const cur = await pool.query('SELECT * FROM lezioni WHERE id=$1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(cur.rows[0].id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }
    const result = await pool.query(
      `UPDATE lezioni SET stato='svolta' WHERE id=$1 RETURNING *, TO_CHAR(data,'YYYY-MM-DD') AS data`,
      [id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel segnare la presenza' });
  }
});

// PATCH /api/lezioni/:id/annulla-presenza
// Ripristina stato "appuntamentata" se la presenza è stata segnata per errore
router.patch('/lezioni/:id/annulla-presenza', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const cur = await pool.query('SELECT * FROM lezioni WHERE id=$1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    if (cur.rows[0].stato !== 'svolta') return res.status(400).json({ error: 'La lezione non è in stato svolta' });
    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(cur.rows[0].id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }
    const result = await pool.query(
      `UPDATE lezioni SET stato='appuntamentata' WHERE id=$1 RETURNING *, TO_CHAR(data,'YYYY-MM-DD') AS data`,
      [id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel ripristino' });
  }
});

// PATCH /api/lezioni/:id/riprogramma
// Riprogramma una lezione rimandata: salva log, imposta stato "appuntamentata"
router.patch('/lezioni/:id/riprogramma', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { data, ora_inizio, ora_fine, aula } = req.body;

  if (!data || !ora_inizio || !ora_fine || !aula) {
    return res.status(400).json({ error: 'data, ora_inizio, ora_fine e aula sono obbligatori' });
  }

  try {
    const curRes = await pool.query('SELECT * FROM lezioni WHERE id=$1', [id]);
    if (curRes.rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    const cur = curRes.rows[0];

    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(cur.id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }

    // controlla conflitto aula
    const conflict = await pool.query(
      `SELECT 1 FROM lezioni
       WHERE id != $1 AND data=$2 AND aula=$3
         AND ($4 < ora_fine AND $5 > ora_inizio)
         AND stato NOT IN ('annullata')
       LIMIT 1`,
      [id, data, aula, ora_inizio, ora_fine]
    );
    if (conflict.rows.length > 0) {
      return res.status(409).json({ error: "L'aula è già occupata in questo orario." });
    }

    // costruisce voce di log
    const history = parseHistory(cur.old_schedules);
    const logEntry = {
      data_originale:   dateOnly(cur.data),
      ora_inizio:       hhmm(cur.ora_inizio),
      ora_fine:         hhmm(cur.ora_fine),
      aula:             cur.aula,
      stato_precedente: cur.stato,           // "rimandata"
      motivazione:      cur.motivazione || null,
      data_rimandata:   cur.aggiornata_il ? dateOnly(cur.aggiornata_il) : null,
      riprogrammata_il: new Date().toISOString(),
      n_riprogrammazione: history.length + 1,
    };

    const { rows } = await pool.query(
      `UPDATE lezioni SET
         data=$1, ora_inizio=$2, ora_fine=$3, aula=$4,
         stato='appuntamentata', riprogrammata=true,
         old_schedules=$5, motivazione=''
       WHERE id=$6
       RETURNING *, TO_CHAR(data,'YYYY-MM-DD') AS data`,
      [data, ora_inizio, ora_fine, aula, JSON.stringify([...history, logEntry]), id]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella riprogrammazione' });
  }
});

// GET /api/lezioni/:id/partecipanti
router.get('/lezioni/:id/partecipanti', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT lp.allievo_id, lp.presente,
             a.nome, a.cognome
      FROM lezioni_partecipanti lp
      JOIN allievi a ON a.id = lp.allievo_id
      WHERE lp.lezione_id = $1
      ORDER BY a.cognome, a.nome
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/lezioni/:id/partecipanti/:allievoId — toggle presenza
router.patch('/lezioni/:id/partecipanti/:allievoId', authenticateToken, async (req, res) => {
  const { presente } = req.body;
  try {
    await pool.query(
      `UPDATE lezioni_partecipanti SET presente=$1 WHERE lezione_id=$2 AND allievo_id=$3`,
      [presente, req.params.id, req.params.allievoId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/lezioni/:id
router.delete('/lezioni/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM lezioni WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    res.json({ message: 'Lezione eliminata' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella cancellazione lezione' });
  }
});

module.exports = router;
