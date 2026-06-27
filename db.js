const { Pool, types } = require('pg');
require('dotenv').config();

// Restituisce DATE come stringa "YYYY-MM-DD" invece di oggetto Date JS (evita sfasamento timezone)
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: { rejectUnauthorized: false }
});

module.exports = { pool };
