const { Pool } = require('pg');

const pool = new Pool({
  host: 'dpg-d12n0s49c44c738g0drg-a',
  port: 5432,
  user: 'accademia_db_user',
  password: 't4VtyqmwjujGaAhiyy0nn3GB5g6ipVKf',
  database: 'accademia_db',
  ssl: {
    rejectUnauthorized: false,
  }
});

module.exports = pool;
