// node reset_for_beta.js
require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('./db');

(async () => {
  try {
    // 1) genera hash (scegli le password finali qui!)
    const passSegreteria = 'password-segreteria-NUOVA';
    const passDirezione  = 'password-direzione-NUOVA';
    const h1 = await bcrypt.hash(passSegreteria, 10);
    const h2 = await bcrypt.hash(passDirezione, 10);

    // 2) pulizia tabelle operative
    await pool.query('BEGIN');

    await pool.query(`TRUNCATE TABLE lezioni RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE TABLE pagamenti_mensili RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE TABLE allievi_insegnanti RESTART IDENTITY CASCADE`);

    // aule se esiste
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='aule') THEN
          EXECUTE 'TRUNCATE TABLE aule RESTART IDENTITY CASCADE';
        END IF;
      END $$;
    `);

    // 3) anagrafiche (opzionale, se vuoi ripulire tutto)
    await pool.query(`TRUNCATE TABLE allievi RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE TABLE insegnanti RESTART IDENTITY CASCADE`);

    // 4) utenti -> lascia solo i due admin
    await pool.query(`TRUNCATE TABLE utenti RESTART IDENTITY CASCADE`);
    await pool.query(
      `INSERT INTO utenti (username, password, ruolo) VALUES
       ($1, $2, 'admin'), ($3, $4, 'admin')`,
      ['segreteria', h1, 'direzione', h2]
    );

    await pool.query('COMMIT');
    console.log('✅ Reset completato. Admin attivi: segreteria / direzione.');
  } catch (e) {
    await pool.query('ROLLBACK').catch(()=>{});
    console.error('❌ Errore reset:', e);
  } finally {
    pool.end();
  }
})();