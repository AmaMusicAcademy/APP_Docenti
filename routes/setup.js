/**
 * Setup/migrazione DB — endpoint idempotenti, da chiamare una volta sola
 * per aggiornare lo schema al nuovo modello (allievo role, notifiche, ecc.)
 */
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/setup/migrate
// Esegue tutte le migrazioni necessarie in ordine sicuro (IF NOT EXISTS / IF NOT EXISTS)
router.get('/setup/migrate', async (_req, res) => {
  const steps = [];
  try {
    // 1. Aggiungi colonna allievo_id a utenti
    await pool.query(`ALTER TABLE utenti ADD COLUMN IF NOT EXISTS allievo_id INTEGER`);
    steps.push('utenti.allievo_id aggiunta');

    // 2. Aggiorna il CHECK constraint di utenti.ruolo per includere 'allievo'
    //    (drop + re-create, sicuro su Postgres)
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.check_constraints
          WHERE constraint_name LIKE 'utenti_ruolo%'
        ) THEN
          ALTER TABLE utenti DROP CONSTRAINT IF EXISTS utenti_ruolo_check;
        END IF;
        ALTER TABLE utenti ADD CONSTRAINT utenti_ruolo_check
          CHECK (ruolo IN ('admin', 'insegnante', 'allievo'));
      END
      $$;
    `);
    steps.push('utenti.ruolo CHECK aggiornato con allievo');

    // 3. Aggiungi colonne a allievi
    await pool.query(`ALTER TABLE allievi ADD COLUMN IF NOT EXISTS strumento TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE allievi ADD COLUMN IF NOT EXISTS data_nascita DATE`);
    await pool.query(`ALTER TABLE allievi ADD COLUMN IF NOT EXISTS stato_iscrizione TEXT DEFAULT 'confermata'`);
    steps.push('allievi: strumento, data_nascita, stato_iscrizione aggiunti');

    // 4. Crea tabella notifiche
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifiche (
        id SERIAL PRIMARY KEY,
        dest_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        messaggio TEXT NOT NULL,
        letto BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifiche_dest_id ON notifiche(dest_id)`);
    steps.push('tabella notifiche creata');

    // 5. Colonne lezioni legacy (idempotenti)
    await pool.query(`ALTER TABLE lezioni ADD COLUMN IF NOT EXISTS storico_programmazioni JSONB DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE lezioni ADD COLUMN IF NOT EXISTS old_schedules JSONB DEFAULT '[]'::jsonb`);
    steps.push('lezioni: storico_programmazioni e old_schedules presenti');

    // 7. Anno accademico — colonna su tutte le tabelle rilevanti
    await pool.query(`ALTER TABLE lezioni ADD COLUMN IF NOT EXISTS anno_accademico TEXT`);
    await pool.query(`ALTER TABLE pagamenti_mensili ADD COLUMN IF NOT EXISTS anno_accademico TEXT`);
    await pool.query(`ALTER TABLE quote_associative ADD COLUMN IF NOT EXISTS anno_accademico TEXT`);
    await pool.query(`ALTER TABLE gruppi ADD COLUMN IF NOT EXISTS anno_accademico TEXT`);
    await pool.query(`ALTER TABLE iscrizioni ADD COLUMN IF NOT EXISTS anno_accademico TEXT`);
    steps.push('anno_accademico aggiunto a lezioni, pagamenti_mensili, quote_associative, gruppi, iscrizioni');

    // 6. Tabelle legacy (safe)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamenti_mensili (
        id SERIAL PRIMARY KEY,
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        anno INTEGER NOT NULL,
        mese INTEGER NOT NULL,
        data_pagamento DATE DEFAULT CURRENT_DATE,
        UNIQUE (allievo_id, anno, mese)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quote_associative (
        id SERIAL PRIMARY KEY,
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        anno INTEGER NOT NULL,
        pagata BOOLEAN NOT NULL DEFAULT FALSE,
        data_pagamento DATE,
        UNIQUE (allievo_id, anno)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS allievi_insegnanti (
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        insegnante_id INTEGER REFERENCES insegnanti(id) ON DELETE CASCADE,
        PRIMARY KEY (allievo_id, insegnante_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aule (
        id SERIAL PRIMARY KEY,
        nome TEXT UNIQUE NOT NULL
      )
    `);
    steps.push('tabelle legacy verificate');

    res.json({ ok: true, steps });
  } catch (err) {
    console.error('Errore migrazione:', err);
    res.status(500).json({ ok: false, error: err.message, steps });
  }
});

// Alias legacy
router.get('/init-pagamenti', async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamenti_mensili (
        id SERIAL PRIMARY KEY,
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        anno INTEGER NOT NULL,
        mese INTEGER NOT NULL,
        data_pagamento DATE DEFAULT CURRENT_DATE,
        UNIQUE (allievo_id, anno, mese)
      )
    `);
    res.json({ message: 'Tabella pagamenti_mensili ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore' });
  }
});

router.get('/init-relazioni', async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS allievi_insegnanti (
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        insegnante_id INTEGER REFERENCES insegnanti(id) ON DELETE CASCADE,
        PRIMARY KEY (allievo_id, insegnante_id)
      )
    `);
    res.json({ message: 'Tabella allievi_insegnanti ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore' });
  }
});

router.get('/init-quote-associative', async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quote_associative (
        id SERIAL PRIMARY KEY,
        allievo_id INTEGER REFERENCES allievi(id) ON DELETE CASCADE,
        anno INTEGER NOT NULL,
        pagata BOOLEAN NOT NULL DEFAULT FALSE,
        data_pagamento DATE,
        UNIQUE (allievo_id, anno)
      )
    `);
    res.json({ message: 'Tabella quote_associative ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore' });
  }
});

router.get('/setup-lezioni-history', async (_req, res) => {
  try {
    await pool.query(`ALTER TABLE lezioni ADD COLUMN IF NOT EXISTS storico_programmazioni JSONB DEFAULT '[]'::jsonb`);
    res.json({ message: 'storico_programmazioni ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore' });
  }
});

router.get('/init-lezioni-history1', async (_req, res) => {
  try {
    await pool.query(`ALTER TABLE lezioni ADD COLUMN IF NOT EXISTS old_schedules JSONB DEFAULT '[]'::jsonb`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
