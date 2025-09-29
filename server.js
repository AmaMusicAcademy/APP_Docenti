
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersegreto';

// CORS
app.use(cors({
  origin: ["https://accademia-frontend.vercel.app"], // in dev puoi usare "*"
  credentials: true,
}));

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ----------------------
// Multer storage per avatar
// ----------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, 'uploads/'); },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `avatar_${Date.now()}${ext}`;
    cb(null, filename);
  }
});
const upload = multer({ storage });

// ----------------------
// Helpers
// ----------------------
function authenticateToken(req, res, next) {
  const token = req.headers['authorization'] && req.headers['authorization'].split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Normalizza "iniziale.cognome" → minuscolo, senza accenti/spazi
function genUsernameFrom(nome, cognome) {
  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // rimuove accenti
    .replace(/['’`]/g, '')                            // rimuove apostrofi
    .toLowerCase().trim();
  const n = norm(nome);
  const c = norm(cognome).replace(/\s+/g, '');        // niente spazi nel cognome
  const initial = n ? n[0] : '';
  return `${initial}.${c}`;
}

// ----------------------
// Health + Routes debug
// ----------------------
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/_routes', (_req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).join(',').toUpperCase();
      routes.push(`${methods} ${m.route.path}`);
    }
  });
  res.json(routes);
});

// ----------------------
// LOGIN
// ----------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const uname = String(username || '').trim().toLowerCase();
    if (!uname || !password) return res.status(400).json({ message: 'Dati mancanti' });

    // 🔍 Cerca prima negli utenti (admin o insegnanti con login)
    const result = await pool.query('SELECT * FROM utenti WHERE LOWER(username) = $1', [uname]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenziali non valide' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Credenziali non valide' });

    // Trova l'ID insegnante collegato (se ruolo è insegnante)
    let insegnanteId = null;
    if (user.ruolo === 'insegnante') {
      const r2 = await pool.query('SELECT id FROM insegnanti WHERE LOWER(username) = $1', [uname]);
      if (r2.rows.length) insegnanteId = r2.rows[0].id;
    }

    // Token SENZA scadenza (logout manuale lato client)
    const token = jwt.sign(
      { userId: user.id, username: user.username, ruolo: user.ruolo, insegnanteId },
      JWT_SECRET
    );

    res.json({
      message: 'Login riuscito',
      token,
      ruolo: user.ruolo,
      username: user.username,
      insegnanteId
    });
  } catch (err) {
    console.error('Errore login:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// ----------------------
// CARICARE AVATAR (usa insegnanteId dal token)
// ----------------------
app.post('/api/avatar', upload.single('avatar'), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || !req.file) return res.status(400).json({ message: 'Token o file mancante' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const id = decoded.insegnanteId;
    if (!id) return res.status(400).json({ message: 'Nessun insegnante collegato' });

    const avatarUrl = `/uploads/${req.file.filename}`;
    await pool.query(
      'UPDATE insegnanti SET avatar_url = $1 WHERE id = $2',
      [avatarUrl, id]
    );

    res.json({ message: 'Avatar aggiornato', avatarUrl });
  } catch (err) {
    console.error('Errore upload avatar:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// Setup colonna avatar (idempotente)
app.post('/api/setup-avatar-column', async (req, res) => {
  try {
    await pool.query(`ALTER TABLE insegnanti ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
    res.json({ message: 'Colonna avatar_url aggiunta con successo' });
  } catch (err) {
    console.error('Errore creazione colonna avatar_url:', err);
    res.status(500).json({ message: 'Errore nel setup' });
  }
});

// ----------------------
// INSEGNANTE ME (robusto)
// ----------------------
app.get('/api/insegnante/me', authenticateToken, async (req, res) => {
  try {
    let id = req.user.insegnanteId || null;
    let row;
    if (id) {
      const { rows } = await pool.query(
        'SELECT id, nome, cognome, username, avatar_url FROM insegnanti WHERE id = $1',
        [id]
      );
      row = rows[0];
    }
    if (!row && req.user.username) {
      const { rows } = await pool.query(
        'SELECT id, nome, cognome, username, avatar_url FROM insegnanti WHERE LOWER(username) = $1',
        [String(req.user.username).toLowerCase()]
      );
      row = rows[0];
    }
    if (!row) return res.status(404).json({ message: 'Utente non trovato' });
    res.json(row);
  } catch (err) {
    console.error('Errore caricamento dati utente:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// ----------------------
// CREAZIONE INSEGNANTE con username/password (ADMIN)
// ----------------------
app.post('/api/insegnanti', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  const { nome, cognome } = req.body;
  try {
    const username = genUsernameFrom(nome, cognome);
    const password = 'amamusic';
    const password_hash = await bcrypt.hash(password, 10);

    // Inserisci nella tabella "insegnanti"
    const { rows } = await pool.query(
      'INSERT INTO insegnanti (nome, cognome, username, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
      [nome, cognome, username, password_hash]
    );

    // Inserisci anche nella tabella "utenti"
    await pool.query(
      `INSERT INTO utenti (username, password, ruolo)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      [username, password_hash, 'insegnante']
    );

    res.status(201).json({ ...rows[0], password_iniziale: password });
  } catch (err) {
    console.error('Errore creazione insegnante:', err);
    res.status(500).json({ error: 'Errore nella creazione insegnante' });
  }
});

// GET tutti gli insegnanti (no auth per compatibilità: valuta se vuoi proteggerlo)
app.get('/api/insegnanti', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM insegnanti');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero insegnanti' });
  }
});

// Associazioni allievi ↔ insegnanti
app.post('/api/allievi/:id/insegnanti', async (req, res) => {
  const { id } = req.params;
  const { insegnanti } = req.body;

  if (!Array.isArray(insegnanti)) {
    return res.status(400).json({ error: 'Formato non valido' });
  }

  try {
    await pool.query('DELETE FROM allievi_insegnanti WHERE allievo_id = $1', [id]);

    const insertPromises = insegnanti.map((insegnanteId) =>
      pool.query(
        'INSERT INTO allievi_insegnanti (allievo_id, insegnante_id) VALUES ($1, $2)',
        [id, insegnanteId]
      )
    );

    await Promise.all(insertPromises);

    res.json({ message: 'Assegnazioni salvate con successo' });
  } catch (err) {
    console.error('Errore nel salvataggio assegnazioni:', err);
    res.status(500).json({ error: 'Errore nel salvataggio assegnazioni' });
  }
});

app.get('/api/allievi/:id/insegnanti', async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(`
      SELECT i.id, i.nome, i.cognome
      FROM insegnanti i
      JOIN allievi_insegnanti ai ON i.id = ai.insegnante_id
      WHERE ai.allievo_id = $1
    `, [id]);

    res.json(rows);
  } catch (err) {
    console.error('Errore nel recupero assegnazioni:', err);
    res.status(500).json({ error: 'Errore nel recupero assegnazioni' });
  }
});

// ----------------------
// PROFILO INSEGNANTE protetto (usa insegnanteId nel token)
// ----------------------
app.get('/api/insegnanti/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  // insegnante può leggere SOLO se il suo id coincide, admin può tutto
  if (String(req.user.insegnanteId || '') !== String(id) && req.user.ruolo !== 'admin') {
    return res.status(403).json({ error: 'Accesso non autorizzato' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM insegnanti WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel recupero insegnante' });
  }
});

// ----------------------
// Compatibilità tabelle auth insegnanti
// ----------------------
app.get('/api/alter-insegnanti-auth', async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE insegnanti
      ADD COLUMN IF NOT EXISTS username TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS password_hash TEXT
    `);
    res.json({ message: '✅ Colonne username e password_hash aggiunte a insegnanti' });
  } catch (err) {
    console.error('Errore nella modifica della tabella insegnanti:', err);
    res.status(500).json({ error: 'Errore nella modifica tabella insegnanti' });
  }
});

// ENDPOINT TEMPORANEO per aggiornare user e password di un insegnante
app.post('/api/setup-credentials', async (req, res) => {
  const { nome, cognome, username, password } = req.body;

  if (!nome || !cognome || !username || !password) {
    return res.status(400).json({ error: 'Nome, cognome, username e password sono obbligatori' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(`
      UPDATE insegnanti
      SET username = $1, password_hash = $2
      WHERE nome = $3 AND cognome = $4
      RETURNING *
    `, [username, hash, nome, cognome]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Insegnante non trovato' });
    }

    res.json({ message: 'Credenziali aggiornate', insegnante: result.rows[0] });
  } catch (err) {
    console.error('Errore durante aggiornamento credenziali:', err);
    res.status(500).json({ error: 'Errore durante aggiornamento credenziali' });
  }
});

// ----------------------
// ALLINEAMENTO UTENTI/INSEGNANTI (admin)
// ----------------------
app.post('/api/admin/align-insegnanti-utenti', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ error: 'Accesso negato' });
  const { normalize, apply } = req.query;
  try {
    const insRes = await pool.query('SELECT id, nome, cognome, username, password_hash FROM insegnanti');
    const utentiRes = await pool.query('SELECT id, username, ruolo FROM utenti');

    const adminUsernames = new Set(['admin', 'segreteria', 'direzione']);
    const usersByUsername = new Map(utentiRes.rows.map(u => [u.username.toLowerCase(), u]));

    const updates = [];
    for (const ins of insRes.rows) {
      let desired = ins.username || genUsernameFrom(ins.nome, ins.cognome);
      if (normalize === 'true') desired = genUsernameFrom(ins.nome, ins.cognome);
      if (adminUsernames.has(desired)) {
        // evita collisione con account admin
        desired = `${desired}.${ins.id}`;
      }

      const exists = usersByUsername.get(desired.toLowerCase());
      if (!exists && apply === 'true') {
        const pwd = ins.password_hash || await bcrypt.hash('amamusic', 10);
        await pool.query(
          `INSERT INTO utenti (username, password, ruolo)
           VALUES ($1, $2, 'insegnante')
           ON CONFLICT (username) DO NOTHING`,
          [desired, pwd]
        );
      }

      // opzionale: normalizza anche la colonna insegnanti.username
      if (normalize === 'true' && desired !== ins.username) {
        await pool.query(`UPDATE insegnanti SET username = $1 WHERE id = $2`, [desired, ins.id]);
      }

      updates.push({ insegnanteId: ins.id, username: desired, createdUser: !exists });
    }

    res.json({ ok: true, updates });
  } catch (err) {
    console.error('Errore allineamento:', err);
    res.status(500).json({ error: 'Errore allineamento' });
  }
});

// ----------------------
// CONTEGGIO LEZIONI per stato + riprogrammate (per allievo)
// ----------------------
app.get('/api/allievi/:id/conteggio-lezioni', async (req, res) => {
  const { id } = req.params;
  const { start, end } = req.query;

  const baseQuery = `
    SELECT stato, riprogrammata, COUNT(*)
    FROM lezioni
    WHERE id_allievo = $1
  `;
  const conditions = [];
  const params = [id];

  if (start) {
    conditions.push(`data >= $${params.length + 1}`);
    params.push(start);
  }
  if (end) {
    conditions.push(`data <= $${params.length + 1}`);
    params.push(end);
  }
  const whereClause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(`
      ${baseQuery} ${whereClause}
      GROUP BY stato, riprogrammata
    `, params);

    const result = { svolte: 0, annullate: 0, rimandate: 0, riprogrammate: 0 };
    for (const row of rows) {
      const stato = row.stato;
      const riprogrammata = row.riprogrammata;
      if (stato === 'svolta') result.svolte += parseInt(row.count, 10);
      else if (stato === 'annullata') result.annullate += parseInt(row.count, 10);
      else if (stato === 'rimandata') {
        if (riprogrammata) result.riprogrammate += parseInt(row.count, 10);
        else result.rimandate += parseInt(row.count, 10);
      }
    }
    res.json(result);
  } catch (err) {
    console.error('Errore nel conteggio lezioni per stato:', err);
    res.status(500).json({ error: 'Errore nel conteggio lezioni' });
  }
});

// ----------------------
// COMPENSO mensile di un insegnante
// ----------------------
app.get('/api/insegnanti/:id/compenso', async (req, res) => {
  const { id } = req.params;
  const { mese } = req.query; // YYYY-MM

  if (!mese || !/^\d{4}-\d{2}$/.test(mese)) {
    return res.status(400).json({ error: 'Parametro "mese" non valido. Usa formato YYYY-MM.' });
  }

  try {
    const startDate = new Date(`${mese}-01`);
    const result = await pool.query(`
      SELECT data, ora_inizio, ora_fine, stato, riprogrammata
      FROM lezioni
      WHERE id_insegnante = $1
        AND (
          stato IN ('svolta', 'annullata') OR
          (stato = 'rimandata' AND riprogrammata = TRUE)
        )
        AND DATE_TRUNC('month', data) = DATE_TRUNC('month', $2::DATE)
    `, [id, startDate]);

    let oreTotali = 0;
    const compensoOrario = 15;

    for (const row of result.rows) {
      const inizio = row.ora_inizio;
      const fine = row.ora_fine;
      const ore =
        (new Date(`1970-01-01T${fine}Z`) - new Date(`1970-01-01T${inizio}Z`)) / (1000 * 60 * 60);
      oreTotali += ore;
    }

    const compenso = Math.round(oreTotali * compensoOrario);

    res.json({
      mese,
      lezioniPagate: result.rowCount,
      oreTotali,
      compenso
    });
  } catch (err) {
    console.error('Errore nel calcolo compenso:', err);
    res.status(500).json({ error: 'Errore nel calcolo compenso' });
  }
});

// ----------------------
// LEZIONI (list con join info)
// ----------------------
app.get('/api/lezioni', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        l.id,
        l.data,
        l.ora_inizio,
        l.ora_fine,
        l.aula,
        l.stato,
        l.motivazione,
        l.riprogrammata,
        l.storico_programmazioni,
        l.id_insegnante,
        l.id_allievo,
        i.nome   AS nome_insegnante,
        i.cognome AS cognome_insegnante,
        a.nome   AS nome_allievo,
        a.cognome AS cognome_allievo
      FROM lezioni l
      LEFT JOIN insegnanti i ON l.id_insegnante = i.id
      LEFT JOIN allievi a     ON l.id_allievo     = a.id
    `);

    const dateOnly = (d) => {
      if (!d) return null;
      if (typeof d === 'string') return d.slice(0, 10);
      try { return new Date(d).toISOString().slice(0, 10); } catch { return String(d).slice(0, 10); }
    };
    const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

    const eventi = (rows || [])
      .filter(lezione => lezione.data && lezione.ora_inizio && lezione.ora_fine)
      .map(lezione => {
        const ymd = dateOnly(lezione.data);
        const oi  = hhmm(lezione.ora_inizio);
        const of  = hhmm(lezione.ora_fine);
        return {
          id: lezione.id,
          id_insegnante: lezione.id_insegnante,
          id_allievo: lezione.id_allievo,
          nome_insegnante: lezione.nome_insegnante,
          cognome_insegnante: lezione.cognome_insegnante,
          nome_allievo: lezione.nome_allievo,
          cognome_allievo: lezione.cognome_allievo,
          aula: lezione.aula,
          stato: lezione.stato,
          motivazione: lezione.motivazione,
          riprogrammata: lezione.riprogrammata,
          storico_programmazioni: Array.isArray(lezione.storico_programmazioni)
            ? lezione.storico_programmazioni
            : (lezione.storico_programmazioni || []),
          title: `Lezione con ${lezione.nome_allievo || 'Allievo'}${lezione.aula ? ` - Aula ${lezione.aula}` : ''}`,
          start: ymd && oi ? `${ymd}T${oi}` : null,
          end:   ymd && of ? `${ymd}T${of}` : null,
          data: ymd,
          ora_inizio: oi,
          ora_fine: of
        };
      });

    res.json(eventi);
  } catch (err) {
    console.error('Errore nel recupero lezioni:', err);
    res.status(500).json({ error: 'Errore nel recupero lezioni' });
  }
});

// CREA lezione (protetto)
app.post('/api/lezioni', authenticateToken, async (req, res) => {
  try {
    const {
      id_insegnante,
      id_allievo,
      data,
      ora_inizio,
      ora_fine,
      aula,
      stato = 'svolta',
      motivazione = null
    } = req.body;

    if (!id_insegnante || !id_allievo || !data || !ora_inizio || !ora_fine || !aula) {
      return res.status(400).json({ error: 'Dati incompleti per creare la lezione' });
    }

    // Autorizzazione: admin può tutto; insegnante solo su se stesso
    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }

    const insert = await pool.query(
      `
      INSERT INTO lezioni (
        id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato, motivazione, riprogrammata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
      RETURNING *
      `,
      [id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato, motivazione]
    );

    const row = insert.rows[0];

    const dett = await pool.query(
      `SELECT a.nome AS nome_allievo, a.cognome AS cognome_allievo
       FROM allievi a WHERE a.id = $1`, [row.id_allievo]
    );
    const allievo = dett.rows[0] || {};

    const dataSolo = String(row.data).slice(0,10);
    res.status(201).json({
      ...row,
      nome_allievo: allievo.nome_allievo,
      cognome_allievo: allievo.cognome_allievo,
      start: `${dataSolo}T${row.ora_inizio}`,
      end: `${dataSolo}T${row.ora_fine}`,
    });
  } catch (err) {
    console.error('Errore creazione lezione:', err);
    res.status(500).json({ error: 'Errore nella creazione lezione' });
  }
});

// GET una lezione
app.get('/api/lezioni/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM lezioni WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel recupero lezione' });
  }
});

// UPDATE lezione (protetto)
app.put('/api/lezioni/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const {
    id_insegnante,
    id_allievo,
    data,
    ora_inizio,
    ora_fine,
    aula,
    stato,
    motivazione = ''
  } = req.body;

  const onlyHHMM = (t) => (t ? String(t).slice(0, 5) : "");
  const onlyYMD  = (d) => (d ? String(d).slice(0, 10) : "");

  const parseHistory = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
    }
    return [];
  };

  try {
    const curRes = await pool.query('SELECT * FROM lezioni WHERE id = $1', [id]);
    if (curRes.rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    const cur = curRes.rows[0];

    // admin ok; insegnante solo su se stesso
    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(cur.id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }

    // conflitti aula/orari se completi
    if (data && ora_inizio && ora_fine && aula) {
      const conflictQuery = `
        SELECT 1 FROM lezioni
        WHERE id != $1
          AND data = $2
          AND aula = $3
          AND ($4 < ora_fine AND $5 > ora_inizio)
        LIMIT 1
      `;
      const conflictValues = [id, data, aula, ora_inizio, ora_fine];
      const conflictResult = await pool.query(conflictQuery, conflictValues);
      if (conflictResult.rows.length > 0) {
        return res.status(400).json({ error: "L'aula selezionata è già occupata nella data/ora indicata." });
      }
    }

    const dateChanged  = (data != null)      && (onlyYMD(data)      !== onlyYMD(cur.data));
    const startChanged = (ora_inizio != null) && (onlyHHMM(ora_inizio) !== onlyHHMM(cur.ora_inizio));
    const endChanged   = (ora_fine   != null) && (onlyHHMM(ora_fine)   !== onlyHHMM(cur.ora_fine));
    const roomChanged  = (aula       != null) && (String(aula).trim()  !== String(cur.aula || '').trim());
    const scheduleChanged = dateChanged || startChanged || endChanged || roomChanged;

    let newRiprogrammata = false;
    let newOld = parseHistory(cur.old_schedules);

    if ((stato ?? cur.stato) === 'rimandata') {
      if (scheduleChanged) {
        newRiprogrammata = true;
        newOld = [
          ...newOld,
          {
            data: onlyYMD(cur.data),
            ora_inizio: onlyHHMM(cur.ora_inizio),
            ora_fine: onlyHHMM(cur.ora_fine),
            aula: cur.aula,
            changed_at: new Date().toISOString()
          }
        ];
      } else {
        newRiprogrammata = false;
      }
    } else {
      newRiprogrammata = false;
    }

    const updateQuery = `
      UPDATE lezioni SET 
        id_insegnante = $1, 
        id_allievo = $2, 
        data = $3, 
        ora_inizio = $4, 
        ora_fine = $5, 
        aula = $6, 
        stato = $7,
        motivazione = $8,
        riprogrammata = $9,
        old_schedules = $10
      WHERE id = $11
      RETURNING *
    `;
    const updateValues = [
      id_insegnante ?? cur.id_insegnante,
      id_allievo ?? cur.id_allievo,
      data ?? cur.data,
      ora_inizio ?? cur.ora_inizio,
      ora_fine ?? cur.ora_fine,
      aula ?? cur.aula,
      stato ?? cur.stato,
      motivazione,
      newRiprogrammata,
      JSON.stringify(newOld),
      id,
    ];
    const { rows } = await pool.query(updateQuery, updateValues);
    res.json(rows[0]);
  } catch (err) {
    console.error("Errore nell'aggiornamento lezione:", err);
    res.status(500).json({ error: "Errore nell'aggiornamento lezione" });
  }
});

// RIMANDA lezione
app.patch('/api/lezioni/:id/rimanda', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { motivazione = '' } = req.body;

  try {
    const curRes = await pool.query('SELECT * FROM lezioni WHERE id = $1', [id]);
    if (curRes.rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    const cur = curRes.rows[0];

    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(cur.id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }

    const update = await pool.query(`
      UPDATE lezioni SET
        stato = 'rimandata',
        riprogrammata = false,
        motivazione = $1
      WHERE id = $2
      RETURNING *
    `, [motivazione, id]);

    res.json(update.rows[0]);
  } catch (err) {
    console.error('PATCH rimanda errore:', err);
    res.status(500).json({ error: 'Errore nel rimandare la lezione' });
  }
});

// ANNULLA lezione
app.patch('/api/lezioni/:id/annulla', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { motivazione = '' } = req.body;

  try {
    const curRes = await pool.query('SELECT * FROM lezioni WHERE id = $1', [id]);
    if (curRes.rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    const cur = curRes.rows[0];

    if (req.user.ruolo !== 'admin' && String(req.user.insegnanteId) !== String(cur.id_insegnante)) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }

    const update = await pool.query(`
      UPDATE lezioni SET
        stato = 'annullata',
        riprogrammata = false,
        motivazione = $1
      WHERE id = $2
      RETURNING *
    `, [motivazione, id]);

    res.json(update.rows[0]);
  } catch (err) {
    console.error('PATCH annulla errore:', err);
    res.status(500).json({ error: "Errore nell'annullare la lezione" });
  }
});

// DELETE lezione
app.delete('/api/lezioni/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM lezioni WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    res.json({ message: 'Lezione eliminata' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella cancellazione lezione' });
  }
});

// Lezioni per insegnante (protetto)
app.get('/api/insegnanti/:id/lezioni', authenticateToken, async (req, res) => {
  const { id } = req.params;

  if (String(req.user.insegnanteId || '') !== String(id) && req.user.ruolo !== 'admin') {
    return res.status(403).json({ error: 'Accesso non autorizzato' });
  }

  try {
    const { rows } = await pool.query(`
      SELECT lezioni.*, allievi.nome AS nome_allievo, allievi.cognome AS cognome_allievo
      FROM lezioni
      LEFT JOIN allievi ON lezioni.id_allievo = allievi.id
      WHERE lezioni.id_insegnante = $1
    `, [id]);

    res.json(rows);
  } catch (err) {
    console.error('Errore nel recupero lezioni insegnante:', err);
    res.status(500).json({ error: 'Errore nel recupero lezioni' });
  }
});

// Allievi di un insegnante (lista assegnati)
app.get('/api/insegnanti/:id/allievi', async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(`
      SELECT a.id, a.nome, a.cognome
      FROM allievi a
      JOIN allievi_insegnanti ai ON a.id = ai.allievo_id
      WHERE ai.insegnante_id = $1
    `, [id]);

    res.json(rows);
  } catch (err) {
    console.error('Errore nel recupero allievi assegnati:', err);
    res.status(500).json({ error: 'Errore nel recupero allievi assegnati' });
  }
});

// ----------------------
// AREA UTENTI (admin)
// ----------------------
app.get('/api/utenti', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  try {
    const result = await pool.query('SELECT id, username, ruolo FROM utenti ORDER BY username');
    res.json(result.rows);
  } catch (err) {
    console.error('Errore nel recupero utenti:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

app.post('/api/utenti', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }

  const { username, password, ruolo } = req.body;

  if (!username || !password || !['admin', 'insegnante'].includes(ruolo)) {
    return res.status(400).json({ message: 'Dati non validi' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO utenti (username, password, ruolo)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      [String(username).toLowerCase(), hashedPassword, ruolo]
    );

    res.json({ message: 'Utente creato con successo' });
  } catch (err) {
    console.error('Errore nella creazione utente:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// Setup utenti di base
app.get('/api/setup-utenti', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS utenti (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        ruolo VARCHAR(20) CHECK (ruolo IN ('admin', 'insegnante')) NOT NULL
      );
    `);

    const hashedAdminPassword = await bcrypt.hash('admin', 10);
    await pool.query(
      `INSERT INTO utenti (username, password, ruolo)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      ['admin', hashedAdminPassword, 'admin']
    );

    const hashedSegreteria = await bcrypt.hash('amamusic', 10);
    await pool.query(
      `INSERT INTO utenti (username, password, ruolo)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      ['segreteria', hashedSegreteria, 'admin']
    );

    // opzionale: crea utente per a.olivi se esiste
    const insegnanteResult = await pool.query(
      `SELECT id FROM insegnanti WHERE nome = 'Alessandro' AND cognome = 'Olivi'`
    );
    if (insegnanteResult.rows.length > 0) {
      await pool.query(
        `INSERT INTO utenti (username, password, ruolo)
         VALUES ($1, $2, $3)
         ON CONFLICT (username) DO UPDATE SET ruolo = EXCLUDED.ruolo`,
        ['a.olivi', hashedSegreteria, 'insegnante']
      );
    }

    res.json({ message: 'Setup utenti completato con admin e insegnante' });
  } catch (err) {
    console.error('Errore nel setup utenti:', err);
    res.status(500).json({ message: 'Errore nel setup utenti' });
  }
});

// ----------------------
// ALLIEVI
// ----------------------
app.get('/api/allievi', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin' && req.user.ruolo !== 'insegnante') {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM allievi ORDER BY cognome, nome');
    res.json(rows);
  } catch (err) {
    console.error('Errore nel recupero allievi:', err);
    res.status(500).json({ error: 'Errore nel recupero allievi' });
  }
});

app.get('/api/allievi/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (req.user.ruolo !== 'admin' && req.user.ruolo !== 'insegnante') {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM allievi WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel recupero allievo' });
  }
});

app.post('/api/allievi', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }

  const {
    nome,
    cognome,
    email = '',
    telefono = '',
    note = '',
    data_iscrizione = new Date().toISOString().split('T')[0],
    quota_mensile = 0
  } = req.body;

  try {
    const { rows } = await pool.query(
      `INSERT INTO allievi (
        nome, cognome, email, telefono, note, data_iscrizione, quota_mensile
      ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [nome, cognome, email, telefono, note, data_iscrizione, quota_mensile]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Errore nella creazione allievo:', err);
    res.status(500).json({ error: 'Errore nella creazione allievo' });
  }
});

app.put('/api/allievi/:id', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }

  const { id } = req.params;
  const { nome, cognome, email = '', telefono = '', note = '', quota_mensile = 0 } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE allievi SET
        nome = $1,
        cognome = $2,
        email = $3,
        telefono = $4,
        note = $5,
        quota_mensile = $6
       WHERE id = $7 RETURNING *`,
      [nome, cognome, email, telefono, note, quota_mensile, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Errore nell\'aggiornamento allievo:', err);
    res.status(500).json({ error: 'Errore nell\'aggiornamento allievo' });
  }
});

app.delete('/api/allievi/:id', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  const { id } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM allievi WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json({ message: 'Allievo eliminato' });
  } catch (err) {
    console.error('Errore nella cancellazione allievo:', err);
    res.status(500).json({ error: 'Errore nella cancellazione allievo' });
  }
});

app.patch('/api/allievi/:id/stato', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  const { id } = req.params;
  const { attivo } = req.body;
  try {
    const { rowCount } = await pool.query('UPDATE allievi SET attivo = $1 WHERE id = $2', [attivo, id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.status(204).send();
  } catch (err) {
    console.error('Errore nell\'aggiornamento stato allievo:', err);
    res.status(500).json({ error: 'Errore nell\'aggiornamento stato allievo' });
  }
});

// ----------------------
// GESTIONE PAGAMENTI
// ----------------------
app.get('/api/init-pagamenti', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamenti_mensili (
        id SERIAL PRIMARY KEY,
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        anno INTEGER NOT NULL,
        mese INTEGER NOT NULL,
        data_pagamento DATE DEFAULT CURRENT_DATE,
        UNIQUE (allievo_id, anno, mese)
      );
    `);
    res.json({ message: '✅ Tabella pagamenti_mensili creata (o già esistente).' });
  } catch (err) {
    console.error('Errore nella creazione della tabella pagamenti_mensili:', err);
    res.status(500).json({ error: 'Errore nella creazione tabella pagamenti' });
  }
});

app.get('/api/allievi/:id/pagamenti', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT anno, mese, data_pagamento
      FROM pagamenti_mensili
      WHERE allievo_id = $1
      ORDER BY anno DESC, mese DESC
    `, [id]);
    res.json(rows);
  } catch (err) {
    console.error('Errore nel recupero pagamenti:', err);
    res.status(500).json({ error: 'Errore nel recupero pagamenti' });
  }
});

app.post('/api/allievi/:id/pagamenti', async (req, res) => {
  const { id } = req.params;
  const { anno, mese } = req.body;
  try {
    const { rows } = await pool.query(`
      INSERT INTO pagamenti_mensili (allievo_id, anno, mese)
      VALUES ($1, $2, $3)
      ON CONFLICT (allievo_id, anno, mese) DO NOTHING
      RETURNING *
    `, [id, anno, mese]);
    res.status(201).json(rows[0] || { message: 'Pagamento già registrato' });
  } catch (err) {
    console.error('Errore nel salvataggio pagamento:', err);
    res.status(500).json({ error: 'Errore nel salvataggio pagamento' });
  }
});

app.delete('/api/allievi/:id/pagamenti', async (req, res) => {
  const { id } = req.params;
  const { anno, mese } = req.query;
  try {
    const result = await pool.query(`
      DELETE FROM pagamenti_mensili
      WHERE allievo_id = $1 AND anno = $2 AND mese = $3
    `, [id, anno, mese]);
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error('Errore nella cancellazione pagamento:', err);
    res.status(500).json({ error: 'Errore nella cancellazione pagamento' });
  }
});

// ----------------------
// RELAZIONI ALLIEVI-INSEGNANTI
// ----------------------
app.get('/api/init-relazioni', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS allievi_insegnanti (
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        insegnante_id INTEGER REFERENCES insegnanti(id) ON DELETE CASCADE,
        PRIMARY KEY (allievo_id, insegnante_id)
      );
    `);
    res.json({ message: '✅ Tabella allievi_insegnanti creata (o già esistente)' });
  } catch (err) {
    console.error('Errore creazione tabella allievi_insegnanti:', err);
    res.status(500).json({ error: 'Errore nella creazione tabella relazioni' });
  }
});

app.get('/api/debug-utenti', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM utenti');
    res.json(result.rows);
  } catch (err) {
    console.error('Errore nel debug utenti:', err);
    res.status(500).json({ error: 'Errore nel debug' });
  }
});

// ----------------------
// Lezioni history colonne
// ----------------------
app.get('/api/setup-lezioni-history', async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE lezioni
      ADD COLUMN IF NOT EXISTS storico_programmazioni JSONB DEFAULT '[]'::jsonb
    `);
    res.json({ message: '✅ Colonna storico_programmazioni aggiunta (o già presente).' });
  } catch (err) {
    console.error('Errore setup storico_programmazioni:', err);
    res.status(500).json({ error: 'Errore setup storico' });
  }
});

app.get('/api/init-lezioni-history1', async (_req, res) => {
  try {
    await pool.query(`ALTER TABLE lezioni ADD COLUMN IF NOT EXISTS old_schedules JSONB DEFAULT '[]'::jsonb`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'alter table failed' });
  }
});

// ------------------------------
// QUOTE ASSOCIATIVE ANNUALI
// ------------------------------
app.get('/api/init-quote-associative', async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quote_associative (
        id SERIAL PRIMARY KEY,
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        anno INTEGER NOT NULL,
        pagata BOOLEAN NOT NULL DEFAULT FALSE,
        data_pagamento DATE,
        UNIQUE (allievo_id, anno)
      );
    `);
    res.json({ message: '✅ Tabella quote_associative creata (o già esistente).' });
  } catch (err) {
    console.error('Errore creazione tabella quote_associative:', err);
    res.status(500).json({ error: 'Errore nel setup quote associative' });
  }
});

app.get('/api/allievi/:id/quote-associative', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin' && req.user.ruolo !== 'insegnante') {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT anno, pagata, data_pagamento
       FROM quote_associative
       WHERE allievo_id = $1
       ORDER BY anno DESC`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Errore recupero quote associative:', err);
    res.status(500).json({ error: 'Errore recupero quote associative' });
  }
});

app.post('/api/allievi/:id/quota-associativa', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  const { id } = req.params;
  const { anno, pagata } = req.body;

  if (!anno || !Number.isInteger(anno)) {
    return res.status(400).json({ error: 'Anno non valido' });
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO quote_associative (allievo_id, anno, pagata, data_pagamento)
      VALUES ($1, $2, $3, CASE WHEN $3 THEN CURRENT_DATE ELSE NULL END)
      ON CONFLICT (allievo_id, anno)
      DO UPDATE SET
        pagata = EXCLUDED.pagata,
        data_pagamento = CASE WHEN EXCLUDED.pagata THEN CURRENT_DATE ELSE NULL END
      RETURNING anno, pagata, data_pagamento
      `,
      [id, anno, !!pagata]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Errore upsert quota associativa:', err);
    res.status(500).json({ error: 'Errore salvataggio quota associativa' });
  }
});

app.delete('/api/allievi/:id/quota-associativa', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }
  const { id } = req.params;
  const { anno } = req.query;
  if (!anno) return res.status(400).json({ error: 'Anno mancante' });

  try {
    const result = await pool.query(
      `DELETE FROM quote_associative WHERE allievo_id = $1 AND anno = $2`,
      [id, parseInt(anno, 10)]
    );
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error('Errore delete quota associativa:', err);
    res.status(500).json({ error: 'Errore eliminazione quota associativa' });
  }
});

// ----------------------
// AULE (CRUD + setup)
// ----------------------
app.get('/api/aule', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ message: 'Accesso negato' });
  try {
    const { rows } = await pool.query('SELECT id, nome FROM aule ORDER BY nome ASC');
    res.json(rows);
  } catch (err) {
    console.error('Errore GET aule:', err);
    res.status(500).json({ error: 'Errore nel recupero aule' });
  }
});

app.post('/api/aule', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ message: 'Accesso negato' });

  const { nome } = req.body;
  if (!nome || !String(nome).trim()) {
    return res.status(400).json({ error: 'Nome aula obbligatorio' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO aule (nome) VALUES ($1) RETURNING id, nome`,
      [String(nome).trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (String(err?.message || '').includes('duplicate')) {
      return res.status(409).json({ error: 'Esiste già un’aula con questo nome' });
    }
    console.error('Errore POST aula:', err);
    res.status(500).json({ error: 'Errore creazione aula' });
  }
});

app.put('/api/aule/:id', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ message: 'Accesso negato' });

  const { id } = req.params;
  const { nome } = req.body;

  if (!nome || !String(nome).trim()) {
    return res.status(400).json({ error: 'Nome aula obbligatorio' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE aule SET nome = $1 WHERE id = $2 RETURNING id, nome`,
      [String(nome).trim(), id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Aula non trovata' });
    res.json(rows[0]);
  } catch (err) {
    if (String(err?.message || '').includes('duplicate')) {
      return res.status(409).json({ error: 'Esiste già un’aula con questo nome' });
    }
    console.error('Errore PUT aula:', err);
    res.status(500).json({ error: 'Errore aggiornamento aula' });
  }
});

app.delete('/api/aule/:id', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') return res.status(403).json({ message: 'Accesso negato' });

  const { id } = req.params;
  try {
    const { rowCount } = await pool.query(`DELETE FROM aule WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Aula non trovata' });
    res.json({ message: 'Aula eliminata' });
  } catch (err) {
    console.error('Errore DELETE aula:', err);
    res.status(500).json({ error: 'Errore cancellazione aula' });
  }
});

app.get('/api/setup-aule', async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aule (
        id SERIAL PRIMARY KEY,
        nome TEXT UNIQUE NOT NULL
      );
    `);

    await pool.query(`
      INSERT INTO aule (nome)
      SELECT DISTINCT TRIM(aula) AS nome
      FROM lezioni
      WHERE aula IS NOT NULL AND TRIM(aula) <> ''
      ON CONFLICT (nome) DO NOTHING;
    `);

    res.json({ message: '✅ Tabella aule pronta (e popolata dai valori presenti in lezioni, se ce n’erano).' });
  } catch (err) {
    console.error('Errore setup aule:', err);
    res.status(500).json({ error: 'Errore setup aule' });
  }
});

// ----------------------
// AVVIO SERVER
// ----------------------
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
