const express = require('express');
const { initializeDatabase } = require('./init-db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Endpoint di test
app.get('/api/test', (req, res) => {
  res.json({ message: 'API funzionante!' });
});

// Endpoint per inizializzare il database
app.get('/api/init-db', async (req, res) => {
  try {
    await initializeDatabase();
    res.json({ message: 'Tabelle create o già presenti.' });
  } catch (error) {
    console.error('Errore nella creazione delle tabelle:', error);
    res.status(500).json({ error: 'Errore nella creazione delle tabelle' });
  }
});

// Avvio server
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
