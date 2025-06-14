const express = require('express');
const cors = require('cors'); // 👈 Importa il pacchetto
const { pool } = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // 👈 Abilita CORS per tutte le origini

app.use(express.json());

/*app.get('/api/drop-lezioni', async (req, res) => {
  try {
    await pool.query('DROP TABLE IF EXISTS lezioni');
    res.json({ message: 'Tabella lezioni eliminata' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nell\'eliminazione della tabella lezioni' });
  }
});*/

// ✅ Crea tabella lezioni
app.get('/api/init-lezioni', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE lezioni (
  id SERIAL PRIMARY KEY,
  id_insegnante INTEGER REFERENCES insegnanti(id),
  id_allievo INTEGER,
  data DATE,
  ora_inizio TIME,
  ora_fine TIME,
  aula VARCHAR(50),
  stato VARCHAR(20)
);
    `);
    res.json({ message: 'Tabella lezioni creata o già esistente.' });
  } catch (err) {
    console.error('Errore creazione tabella lezioni:', err);
    res.status(500).json({ error: 'Errore nella creazione tabella lezioni' });
  }
});


////////////////////////
// ENDPOINT DI TEST
////////////////////////
app.get('/api/test', (req, res) => {
  res.json({ message: 'API funzionante!' });
});

////////////////////////
// INSEGNANTI
////////////////////////

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

// GET un insegnante
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

// POST nuovo insegnante
app.post('/api/insegnanti', async (req, res) => {
  const { nome, cognome } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO insegnanti (nome, cognome) VALUES ($1, $2) RETURNING *',
      [nome, cognome]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella creazione insegnante' });
  }
});

// PUT modifica insegnante
app.put('/api/insegnanti/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, cognome } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE insegnanti SET nome = $1, cognome = $2 WHERE id = $3 RETURNING *',
      [nome, cognome, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Insegnante non trovato' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nell\'aggiornamento insegnante' });
  }
});

// DELETE insegnante
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

////////////////////////
// LEZIONI
////////////////////////

// GET tutte le lezioni
app.get('/api/lezioni', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        lezioni.id,
        lezioni.data,
        lezioni.ora_inizio,
        lezioni.ora_fine,
        lezioni.aula,
        lezioni.stato,
        lezioni.id_insegnante,
        lezioni.id_allievo,
        i.nome AS nome_insegnante,
        i.cognome AS cognome_insegnante
      FROM lezioni
      LEFT JOIN insegnanti i ON lezioni.id_insegnante = i.id
    `);

    // Converte in eventi
    const eventi = rows.map(lezione => {
      const dataSolo = lezione.data.toISOString().split('T')[0]; // se PostgreSQL restituisce come Date
      const start = `${dataSolo}T${lezione.ora_inizio}`;
      const end = `${dataSolo}T${lezione.ora_fine}`;

      return {
        id: lezione.id,
        id_insegnante: lezione.id_insegnante,
        title: `Lezione con ${lezione.nome_insegnante} ${lezione.cognome_insegnante} - Aula ${lezione.aula}`,
        start,
        end,
      };
    });

    res.json(eventi);
  } catch (err) {
    console.error('Errore nel recupero lezioni:', err);
    res.status(500).json({ error: 'Errore nel recupero lezioni' });
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

// POST nuova lezione
app.post('/api/lezioni', async (req, res) => {
  const { id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO lezioni 
        (id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato) 
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella creazione lezione' });
  }
});

// PUT modifica lezione
app.put('/api/lezioni/:id', async (req, res) => {
  const { id } = req.params;
  const { id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE lezioni SET 
        id_insegnante = $1, 
        id_allievo = $2, 
        data = $3, 
        ora_inizio = $4, 
        ora_fine = $5, 
        aula = $6, 
        stato = $7
       WHERE id = $8 RETURNING *`,
      [id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nell\'aggiornamento lezione' });
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

// ✅ GET lezioni di un insegnante specifico
app.get('/api/insegnanti/:id/lezioni', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM lezioni WHERE id_insegnante = $1',
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nel recupero delle lezioni per l\'insegnante' });
  }
});

////////////////////////
// ALLIEVI
////////////////////////

app.get('/api/init-allievi', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS allievi (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        cognome VARCHAR(100) NOT NULL,
        email VARCHAR(150),
        telefono VARCHAR(30),
        note TEXT,
        attivo BOOLEAN DEFAULT TRUE,
        data_iscrizione DATE DEFAULT CURRENT_DATE,
        lezioni_effettuate INTEGER DEFAULT 0,
        lezioni_da_pagare INTEGER DEFAULT 0,
        totale_pagamenti NUMERIC(10,2) DEFAULT 0,
        ultimo_pagamento DATE
      );
    `);
    res.json({ message: 'Tabella allievi creata o già esistente.' });
  } catch (err) {
    console.error('Errore nella creazione della tabella allievi:', err);
    res.status(500).json({ error: 'Errore nella creazione della tabella allievi' });
  }
});






////////////////////////
// AVVIO SERVER
////////////////////////
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});

