const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
require('dotenv').config();

const initializeDatabase = require('./init-db');
const { pool } = require('./db');

app.use(express.json());

app.get('/api/test', (req, res) => {
  res.json({ message: 'API funzionante!' });
});

app.get('/api/dbtest', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ dbTime: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Endpoint per inizializzare il DB
app.get('/api/init-db', async (req, res) => {
  try {
    const message = await initializeDatabase();
    res.json({ message });
  } catch (error) {
    res.status(500).json({ error: 'Errore durante inizializzazione DB' });
  }
});

app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
