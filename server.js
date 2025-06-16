const express = require('express');
const cors = require('cors'); // 👈 Importa il pacchetto
const { pool } = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // 👈 Abilita CORS per tutte le origini

app.use(express.json());

app.get('/api/alter-lezioni', async (req, res) => {
  try {
    await pool.query(`ALTER TABLE lezioni ADD COLUMN IF NOT EXISTS motivazione TEXT`);
    res.json({ message: '✅ Colonna motivazione aggiunta alla tabella lezioni.' });
  } catch (err) {
    console.error('Errore nella modifica della tabella lezioni:', err);
    res.status(500).json({ error: 'Errore nella modifica tabella lezioni' });
  }
});


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

// Lezioni rimandate per un insegnante
app.get('/api/insegnanti/:id/lezioni-rimandate', async (req, res) => {
  const { id } = req.params;
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
        l.id_allievo,
        a.nome AS nome_allievo,
        a.cognome AS cognome_allievo
      FROM lezioni l
      LEFT JOIN allievi a ON l.id_allievo = a.id
      WHERE l.id_insegnante = $1 AND l.stato = 'rimandata'
      ORDER BY l.data
    `, [id]);
    res.json(rows);
  } catch (err) {
    console.error('Errore nel recupero lezioni rimandate:', err);
    res.status(500).json({ error: 'Errore nel recupero lezioni rimandate' });
  }
});

// GET aule occupate in una data e fascia oraria
app.get('/api/lezioni/occupazione-aule', async (req, res) => {
  const { data, ora_inizio, ora_fine } = req.query;

  if (!data || !ora_inizio || !ora_fine) {
    return res.status(400).json({ error: 'Parametri mancanti: data, ora_inizio e ora_fine sono obbligatori' });
  }

  try {
    const query = `
      SELECT DISTINCT aula
      FROM lezioni
      WHERE data = $1
        AND (
          ($2 < ora_fine AND $3 > ora_inizio) -- sovrapposizione oraria
        )
    `;
    const values = [data, ora_inizio, ora_fine];

    const { rows } = await pool.query(query, values);
    const auleOccupate = rows.map(r => r.aula);

    res.json(auleOccupate);
  } catch (err) {
    console.error('Errore nel recupero aule occupate:', err);
    res.status(500).json({ error: 'Errore nel recupero aule occupate' });
  }
});


// ✅ GET tutte le lezioni con info insegnante e allievo
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
        lezioni.motivazione,
        lezioni.id_insegnante,
        lezioni.id_allievo,
        i.nome AS nome_insegnante,
        i.cognome AS cognome_insegnante,
        a.nome AS nome_allievo,
        a.cognome AS cognome_allievo
      FROM lezioni
      LEFT JOIN insegnanti i ON lezioni.id_insegnante = i.id
      LEFT JOIN allievi a ON lezioni.id_allievo = a.id
    `);

    // Filtra solo lezioni con data e orari validi
    const eventi = rows
      .filter(lezione => lezione.data && lezione.ora_inizio && lezione.ora_fine)
      .map(lezione => {
        const dataSolo = new Date(lezione.data).toISOString().split('T')[0];
        const start = `${dataSolo}T${lezione.ora_inizio}`;
        const end = `${dataSolo}T${lezione.ora_fine}`;

        return {
          id: lezione.id,
          id_insegnante: lezione.id_insegnante,
          id_allievo: lezione.id_allievo,
          nome_allievo: lezione.nome_allievo,
          cognome_allievo: lezione.cognome_allievo,
          aula: lezione.aula,
          stato: lezione.stato,
          motivazione: lezione.motivazione,
          title: `Lezione con ${lezione.nome_allievo || 'Allievo'} - Aula ${lezione.aula}`,
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
    const { rows } = await pool.query(
      'SELECT * FROM lezioni WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Lezione non trovata' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel recupero lezione' });
  }
});

//POST lezioni
app.post('/api/lezioni', async (req, res) => {
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

  try {
    const { rows } = await pool.query(
      `INSERT INTO lezioni 
        (id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato, motivazione) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
        RETURNING *`,
      [id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato, motivazione]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore nella creazione lezione' });
  }
});

//PUT lezioni
app.put('/api/lezioni/:id', async (req, res) => {
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

  try {
    const { rows } = await pool.query(
      `UPDATE lezioni SET 
        id_insegnante = $1, 
        id_allievo = $2, 
        data = $3, 
        ora_inizio = $4, 
        ora_fine = $5, 
        aula = $6, 
        stato = $7,
        motivazione = $8
       WHERE id = $9 RETURNING *`,
      [id_insegnante, id_allievo, data, ora_inizio, ora_fine, aula, stato, motivazione, id]
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
app.get('/api/drop-allievi', async (req, res) => {
  try {
    await pool.query('DROP TABLE IF EXISTS allievi CASCADE');
    res.json({ message: 'Tabella allievi eliminata' });
  } catch (err) {
    console.error('Errore nell\'eliminazione della tabella allievi:', err);
    res.status(500).json({ error: 'Errore nell\'eliminazione della tabella allievi' });
  }
});


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
    res.json({ message: '✅ Tabella allievi creata o già esistente.' });
  } catch (err) {
    console.error('Errore nella creazione della tabella allievi:', err);
    res.status(500).json({ error: 'Errore nella creazione della tabella allievi' });
  }
});

app.get('/api/alter-allievi', async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE allievi
      DROP COLUMN IF EXISTS lezioni_effettuate,
      DROP COLUMN IF EXISTS lezioni_da_pagare,
      DROP COLUMN IF EXISTS totale_pagamenti,
      DROP COLUMN IF EXISTS ultimo_pagamento;
    `);
    res.json({ message: '✅ Colonne obsolete rimosse dalla tabella allievi.' });
  } catch (err) {
    console.error('Errore nella modifica tabella allievi:', err);
    res.status(500).json({ error: 'Errore nella modifica tabella allievi' });
  }
});



////////////////////////
// ALLIEVI
////////////////////////

// GET conteggio lezioni per stato (svolte, annullate, rimandate) in un intervallo
app.get('/api/allievi/:id/conteggio-lezioni', async (req, res) => {
  const { id } = req.params;
  const { start, end } = req.query;

  const baseQuery = `
    SELECT stato, COUNT(*) 
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
    const { rows } = await pool.query(`${baseQuery} ${whereClause} GROUP BY stato`, params);

    const result = {
      svolte: 0,
      annullate: 0,
      rimandate: 0
    };

    for (const row of rows) {
      if (row.stato === 'svolta') result.svolte = parseInt(row.count, 10);
      else if (row.stato === 'annullata') result.annullate = parseInt(row.count, 10);
      else if (row.stato === 'rimandata') result.rimandate = parseInt(row.count, 10);
    }

    res.json(result);
  } catch (err) {
    console.error('Errore nel conteggio lezioni per stato:', err);
    res.status(500).json({ error: 'Errore nel conteggio lezioni' });
  }
});


// GET tutti gli allievi
app.get('/api/allievi', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM allievi ORDER BY cognome, nome');
    res.json(rows);
  } catch (err) {
    console.error('Errore nel recupero allievi:', err);
    res.status(500).json({ error: 'Errore nel recupero allievi' });
  }
});

// GET un allievo per ID
app.get('/api/allievi/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM allievi WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel recupero allievo' });
  }
});

// POST nuovo allievo
app.post('/api/allievi', async (req, res) => {
  const {
    nome,
    cognome,
    email = '',
    telefono = '',
    note = '',
    data_iscrizione = new Date().toISOString().split('T')[0] // formato YYYY-MM-DD
  } = req.body;

  try {
    const { rows } = await pool.query(
      `INSERT INTO allievi (
        nome, cognome, email, telefono, note, data_iscrizione
      ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nome, cognome, email, telefono, note, data_iscrizione]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Errore nella creazione allievo:', err);
    res.status(500).json({ error: 'Errore nella creazione allievo' });
  }
});

// PUT modifica allievo
app.put('/api/allievi/:id', async (req, res) => {
  const { id } = req.params;
  const {
    nome,
    cognome,
    email = '',
    telefono = '',
    note = '',
    data_iscrizione
  } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE allievi SET
        nome = $1,
        cognome = $2,
        email = $3,
        telefono = $4,
        note = $5,
        data_iscrizione = $6
       WHERE id = $7 RETURNING *`,
      [nome, cognome, email, telefono, note, data_iscrizione, id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Allievo non trovato' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Errore nell\'aggiornamento allievo:', err);
    res.status(500).json({ error: 'Errore nell\'aggiornamento allievo' });
  }
});

// DELETE allievo
app.delete('/api/allievi/:id', async (req, res) => {
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

// PATCH stato attivo/inattivo allievo
app.patch('/api/allievi/:id/stato', async (req, res) => {
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

// GET lezioni future di un allievo
app.get('/api/allievi/:id/lezioni-future', async (req, res) => {
  const { id } = req.params;

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
        i.nome AS nome_insegnante,
        i.cognome AS cognome_insegnante
      FROM lezioni l
      LEFT JOIN insegnanti i ON l.id_insegnante = i.id
      WHERE l.id_allievo = $1
        AND (
          (l.stato = 'svolta' AND l.data >= CURRENT_DATE)
          OR (l.stato = 'rimandata')
        )
      ORDER BY l.data NULLS LAST, l.ora_inizio
    `, [id]);

    res.json(rows);
  } catch (err) {
    console.error('Errore nel recupero lezioni future per allievo:', err);
    res.status(500).json({ error: 'Errore nel recupero lezioni future' });
  }
});



//COUNT LEZIONI EFFETTUATE ALLIEVO
app.get('/api/allievi/:id/lezioni-effettuate', async (req, res) => {
  const { id } = req.params;
  const { start, end } = req.query;

  let query = `SELECT COUNT(*) FROM lezioni WHERE id_allievo = $1 AND stato = 'svolta'`;
  const params = [id];

  if (start) {
    params.push(start);
    query += ` AND data >= $${params.length}`;
  }
  if (end) {
    params.push(end);
    query += ` AND data <= $${params.length}`;
  }

  try {
    const { rows } = await pool.query(query, params);
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (err) {
    console.error('Errore nel conteggio lezioni effettuate:', err);
    res.status(500).json({ error: 'Errore nel conteggio lezioni' });
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


////////////////////////
// AVVIO SERVER
////////////////////////
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});

