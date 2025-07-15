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
    const result = await pool.query('SELECT * FROM insegnanti WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ message: 'Credenziali non valide' });

    const insegnante = result.rows[0];
    const match = await bcrypt.compare(password, insegnante.password_hash);
    if (!match) return res.status(401).json({ message: 'Credenziali non valide' });

    const token = jwt.sign({ id: insegnante.id, ruolo: 'insegnante' }, JWT_SECRET, { expiresIn: '2h' });

    res.json({
      token,
      utente: {
        id: insegnante.id,
        nome: insegnante.nome,
        cognome: insegnante.cognome,
        username: insegnante.username,
        ruolo: 'insegnante',
        avatar_url: insegnante.avatar_url || null
      }
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

//////////////////////////
// AVVIO SERVER
//////////////////////////

app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});

