const express = require('express');
const pool = require('./db');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/api/dbtest', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ dbTime: result.rows[0] });
  } catch (error) {
    console.error('Errore nella connessione al DB:', error);
    res.status(500).json({ error: 'Errore nella connessione al database' });
  }
});

app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});


