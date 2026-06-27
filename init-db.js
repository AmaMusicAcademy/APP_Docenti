const { pool } = require('./db');

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS insegnanti (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        cognome VARCHAR(100) NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS allievi (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        cognome VARCHAR(100) NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lezioni (
        id SERIAL PRIMARY KEY,
        id_insegnante INTEGER REFERENCES insegnanti(id) ON DELETE CASCADE,
        id_allievo INTEGER,
        id_aula INTEGER,
        data DATE NOT NULL,
        ora_inizio TIME NOT NULL,
        ora_fine TIME NOT NULL,
        stato VARCHAR(20) CHECK (stato IN ('svolta', 'rimandata', 'annullata', 'futura')) NOT NULL DEFAULT 'futura'
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamenti (
        id SERIAL PRIMARY KEY,
        allievo_id INTEGER REFERENCES allievi(id),
        importo NUMERIC(10, 2),
        data_pagamento DATE
      );
    `);

    console.log("Tabelle create o già presenti.");
  } catch (error) {
    console.error("Errore nella creazione delle tabelle:", error);
  }
}

module.exports = { initializeDatabase };

