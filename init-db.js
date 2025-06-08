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
        allievo_id INTEGER REFERENCES allievi(id),
        insegnante_id INTEGER REFERENCES insegnanti(id),
        aula VARCHAR(50),
        data TIMESTAMP NOT NULL,
        stato VARCHAR(50) DEFAULT 'prevista'
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

