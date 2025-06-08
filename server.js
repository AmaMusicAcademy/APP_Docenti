const express = require('express');
const { pool } = require('./db');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Endpoint di test
app.get('/api/test', (req, res) => {
  res.json({ message: 'API funzionante!' });
});

// ✅ GET all insegnanti
app.get('/api/insegnanti', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM insegnanti');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero insegnanti' });
  }
});

// ✅ GET one insegnante
app.get('/api/insegnanti/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM insegnanti WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel recupero insegnante' });
  }
});

// ✅ POST crea insegnante
app.post('/api/insegnanti', async (req, res) => {
  const { id, nome, cognome } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO insegnanti (id, nome, cognome) VALUES ($1, $2, $3) RETURNING *',
      [id, nome, cognome]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nella creazione insegnante' });
  }
});

// ✅ PUT modifica insegnante
app.put('/api/insegnanti/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, cognome, email, telefono } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE insegnanti SET nome = $1, cognome = $2, email = $3, telefono = $4 WHERE id = $5 RETURNING *',
      [nome, cognome, email, telefono, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nell\'aggiornamento insegnante' });
  }
});

// ✅ DELETE insegnante
app.delete('/api/insegnanti/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM insegnanti WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json({ message: 'Insegnante eliminato' });
  } catch (err) {
    res.status(500).json({ error: 'Errore nella cancellazione insegnante' });
  }
});

// Avvio server
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
