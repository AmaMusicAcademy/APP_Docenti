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

//app.use(cors());
app.use(cors({
  origin: ["https://accademia-frontend.vercel.app"], // oppure "*" in sviluppo
  credentials: true,
}));

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `avatar_${Date.now()}${ext}`;
    cb(null, filename);
  }
});
const upload = multer({ storage });


// Middleware per autenticazione
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

//CARICARE AVATAR
app.post('/api/avatar', upload.single('avatar'), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || !req.file) return res.status(400).json({ message: 'Token o file mancante' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const id = decoded.id;

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

app.post('/api/setup-avatar-column', async (req, res) => {
  try {
    await pool.query(`ALTER TABLE insegnanti ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
    res.json({ message: 'Colonna avatar_url aggiunta con successo' });
  } catch (err) {
    console.error('Errore creazione colonna avatar_url:', err);
    res.status(500).json({ message: 'Errore nel setup' });
  }
});


//////////////////////////
// LOGIN
//////////////////////////

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // 🔍 Cerca prima negli utenti (admin o insegnanti con login)
    const result = await pool.query('SELECT * FROM utenti WHERE username = $1', [username]);

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenziali non valide' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);

    if (!match) return res.status(401).json({ message: 'Credenziali non valide' });

    const token = jwt.sign({ id: user.id, username: user.username, ruolo: user.ruolo }, JWT_SECRET, { expiresIn: '12h' });

    res.json({
      message: 'Login riuscito',
      token,
      ruolo: user.ruolo,
      username: user.username
    });
  } catch (err) {
    console.error('Errore login:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});


//////////////////////////
// CAMBIO password
//////////////////////////

app.post('/api/cambia-password', async (req, res) => {
  const { id, nuovaPassword } = req.body;

  if (!id || !nuovaPassword) {
    return res.status(400).json({ message: 'Dati mancanti' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(nuovaPassword, salt);

    await pool.query(
      'UPDATE insegnanti SET password_hash = $1 WHERE id = $2',
      [hash, id]
    );

    res.json({ message: 'Password aggiornata con successo' });
  } catch (err) {
    console.error('Errore durante il cambio password:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});


//////////////////////////
// CREAZIONE INSEGNANTE con username/password
//////////////////////////

app.post('/api/insegnanti', async (req, res) => {
  const { nome, cognome } = req.body;
  try {
    const username = `${nome[0].toLowerCase()}.${cognome.toLowerCase()}`;
    const password = 'amamusic';
    const password_hash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      'INSERT INTO insegnanti (nome, cognome, username, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
      [nome, cognome, username, password_hash]
    );

    res.status(201).json({ ...rows[0], password_iniziale: password });
  } catch (err) {
    console.error('Errore creazione insegnante:', err);
    res.status(500).json({ error: 'Errore nella creazione insegnante' });
  }
});

// GET tutti gli insegnanti
app.get('/api/insegnanti', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM insegnanti');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero insegnanti' });
  }
});

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

    res.json(rows); // restituisce un array di insegnanti già assegnati
  } catch (err) {
    console.error('Errore nel recupero assegnazioni:', err);
    res.status(500).json({ error: 'Errore nel recupero assegnazioni' });
  }
});



//////////////////////////
// PROTEZIONE PROFILO INSEGNANTE
//////////////////////////

app.get('/api/insegnanti/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  if (req.user.id != id && req.user.ruolo !== 'admin') {
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

//////////////////////////
// AGGIUNTA COLONNE auth (per compatibilità con vecchie tabelle)
//////////////////////////

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

// ⚠️ ENDPOINT TEMPORANEO per aggiornare user e password di un insegnante
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

// GET conteggio lezioni per stato + riprogrammate
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

    const result = {
      svolte: 0,
      annullate: 0,
      rimandate: 0,
      riprogrammate: 0
    };

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

// GET compenso mensile di un insegnante
app.get('/api/insegnanti/:id/compenso', async (req, res) => {
  const { id } = req.params;
  const { mese } = req.query; // formato atteso: '2025-06'

  if (!mese || !/^\d{4}-\d{2}$/.test(mese)) {
    return res.status(400).json({ error: 'Parametro "mese" non valido. Usa formato YYYY-MM.' });
  }

  try {
    const startDate = new Date(`${mese}-01`);
    const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0); // ultimo giorno del mese

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
      // Calcolo ore: fine - inizio
      const inizio = row.ora_inizio;
      const fine = row.ora_fine;

      const ore =
        (new Date(`1970-01-01T${fine}Z`) - new Date(`1970-01-01T${inizio}Z`)) /
        (1000 * 60 * 60);

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

app.get('/api/insegnanti/:id/lezioni', authenticateToken, async (req, res) => {
  const { id } = req.params;

  if (req.user.id != id && req.user.ruolo !== 'admin') {
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

//////////////////////////
// AREA UTENTI
//////////////////////////

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
      [username, hashedPassword, ruolo]
    );

    res.json({ message: 'Utente creato con successo' });
  } catch (err) {
    console.error('Errore nella creazione utente:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});



app.get('/api/setup-utenti', async (req, res) => {
  try {
    // Crea tabella utenti se non esiste
    await pool.query(`
      CREATE TABLE IF NOT EXISTS utenti (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        ruolo VARCHAR(20) CHECK (ruolo IN ('admin', 'insegnante')) NOT NULL
      );
    `);

    // Inserisci admin "admin"
    const hashedAdminPassword = await bcrypt.hash('admin', 10);
    await pool.query(
      `INSERT INTO utenti (username, password, ruolo)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      ['admin', hashedAdminPassword, 'admin']
    );

    // Inserisci admin "segreteria"
    const hashedSegreteria = await bcrypt.hash('amamusic', 10);
    await pool.query(
      `INSERT INTO utenti (username, password, ruolo)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      ['segreteria', hashedSegreteria, 'admin']
    );

    // Assegna ruolo "insegnante" a "a.olivi" se esiste tra gli insegnanti
    const insegnanteResult = await pool.query(
      `SELECT id FROM insegnanti WHERE nome = 'Alessandro' AND cognome = 'Olivi'`
    );

    if (insegnanteResult.rows.length > 0) {
      await pool.query(
        `INSERT INTO utenti (username, password, ruolo)
         VALUES ($1, $2, $3)
         ON CONFLICT (username) DO UPDATE SET ruolo = EXCLUDED.ruolo`,
        ['a.olivi', hashedSegreteria, 'insegnante'] // usa 'amamusic' anche per lui
      );
    }

    res.json({ message: 'Setup utenti completato con admin e insegnante' });
  } catch (err) {
    console.error('Errore nel setup utenti:', err);
    res.status(500).json({ message: 'Errore nel setup utenti' });
  }
});


app.get('/api/forza-admin', async (req, res) => {
  try {
    const hashed = await bcrypt.hash('amamusic', 10);

    await pool.query(
      `INSERT INTO utenti (username, password, ruolo)
       VALUES ('segreteria', $1, 'admin')
       ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, ruolo = EXCLUDED.ruolo`,
      [hashed]
    );

    res.json({ message: 'Utente "segreteria" aggiornato con successo' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Errore nel reinserimento admin' });
  }
});

//////////////////////////
// ALLIEVI
//////////////////////////

// GET tutti gli allievi
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


// GET un allievo per ID
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


// POST nuovo allievo
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


// PUT modifica allievo
app.put('/api/allievi/:id', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }

  const { id } = req.params;
  const {
    nome,
    cognome,
    email = '',
    telefono = '',
    note = '',
    quota_mensile = 0
  } = req.body;

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


// DELETE allievo
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


// PATCH stato attivo/inattivo
app.patch('/api/allievi/:id/stato', authenticateToken, async (req, res) => {
  if (req.user.ruolo !== 'admin') {
    return res.status(403).json({ message: 'Accesso negato' });
  }

  const { id } = req.params;
  const { attivo } = req.body;

  try {
    const { rowCount } = await pool.query(
      'UPDATE allievi SET attivo = $1 WHERE id = $2',
      [attivo, id]
    );

    if (rowCount === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.status(204).send();
  } catch (err) {
    console.error('Errore nell\'aggiornamento stato allievo:', err);
    res.status(500).json({ error: 'Errore nell\'aggiornamento stato allievo' });
  }
});

////////////////////////
// GESTIONE PAGAMENTI
////////////////////////

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



//////////////////////////
// AVVIO SERVER
//////////////////////////

app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});

