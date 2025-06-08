require('dotenv').config();

const { Pool } = require('pg');

// Configura i dati di connessione al tuo DB PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,     // es. dpg-xxxxxx
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const createTablesSQL = `
CREATE TABLE IF NOT EXISTS teachers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100),
  active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring_appointments (
  id SERIAL PRIMARY KEY,
  teacher_id INT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  teacher_id INT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('svolta', 'rimandata', 'annullata', 'da fare')),
  recurring_id INT REFERENCES recurring_appointments(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL,
  payment_date DATE NOT NULL,
  month_ref VARCHAR(7) NOT NULL
);
`;

async function createTables() {
  try {
    await pool.query(createTablesSQL);
    console.log('Tabelle create o già presenti.');
  } catch (err) {
    console.error('Errore durante la creazione delle tabelle:', err);
  } finally {
    await pool.end();
  }
}

createTables();
