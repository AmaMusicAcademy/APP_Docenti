
// init-db.js
const { pool } = require('./db');

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS studenti (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS insegnanti (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS aule (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS appuntamenti (
        id SERIAL PRIMARY KEY,
        studente_id INTEGER REFERENCES studenti(id),
        insegnante_id INTEGER REFERENCES insegnanti(id),
        aula_id INTEGER REFERENCES aule(id),
        inizio TIMESTAMP NOT NULL,
        fine TIMESTAMP NOT NULL,
        ripetizione BOOLEAN DEFAULT FALSE,
        data_fine_ripetizione TIMESTAMP
      );
    `);

    console.log('Tabelle create o già presenti.');
    return 'Tabelle create o già presenti.';
  } catch (error) {
    console.error('Errore nella creazione delle tabelle:', error);
    throw error;
  }
}

module.exports = initializeDatabase;

}

createTables();
