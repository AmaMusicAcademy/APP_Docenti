const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersegreto';

app.use(cors());
app.use(express.json());

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
        ruolo: 'insegnante'
      }
    });
  } catch (err) {
    console.error('Errore login:', err);
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

//////////////////////////
// AVVIO SERVER
//////////////////////////

app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});

