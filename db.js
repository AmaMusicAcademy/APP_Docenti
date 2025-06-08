const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: sql.amamusicacademy.it,       // es. 'localhost' o indirizzo DB Tophost
  user: amamusic47740,        // utente DB
  password: amam45804,  // password DB
  database: amamusic47740,    // nome DB
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;
