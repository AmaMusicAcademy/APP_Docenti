const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const pool = require('./db'); // Assicurati che il file db.js sia nella stessa cartella

app.use(express.json());

app.get('/api/test', (req, res) => {
  res.json({ message: 'API funzionante!' });
});

app.get('/api/dbtest', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 + 1 AS solution');
    res.json({ dbResult: rows[0].solution });
  } catch (error) {
    console.error('Errore nella connessione al DB:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});

