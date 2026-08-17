const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { pool } = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'supersegreto';

pool.query(`ALTER TABLE utenti ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE`).catch(() => {});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `avatar_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

// POST /api/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const uname = String(username || '').trim().toLowerCase();
    if (!uname || !password) return res.status(400).json({ message: 'Dati mancanti' });

    const result = await pool.query('SELECT * FROM utenti WHERE LOWER(username) = $1', [uname]);
    if (result.rows.length === 0) return res.status(401).json({ message: 'Credenziali non valide' });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Credenziali non valide' });

    let insegnanteId = null;
    if (user.ruolo === 'insegnante') {
      const r2 = await pool.query('SELECT id FROM insegnanti WHERE LOWER(username) = $1', [uname]);
      if (r2.rows.length) insegnanteId = r2.rows[0].id;
    }

    // Blocca allievi disattivati (failsafe: l'account viene già eliminato a fine anno)
    if (user.ruolo === 'allievo' && user.allievo_id) {
      const ar = await pool.query('SELECT attivo FROM allievi WHERE id=$1', [user.allievo_id]);
      if (ar.rows.length && ar.rows[0].attivo === false) {
        return res.status(403).json({ message: 'Account sospeso. Contatta la segreteria per rinnovare l\'iscrizione.' });
      }
    }

    let allievoId = user.allievo_id || null;

    const mustChangePassword = !!user.must_change_password;

    const token = jwt.sign(
      { userId: user.id, username: user.username, ruolo: user.ruolo, insegnanteId, allievoId, mustChangePassword },
      JWT_SECRET
    );

    res.json({
      message: 'Login riuscito',
      token,
      ruolo: user.ruolo,
      username: user.username,
      insegnanteId,
      allievoId,
      mustChangePassword,
    });
  } catch (err) {
    console.error('Errore login:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// POST /api/cambia-password — cambio password obbligatorio al primo accesso
router.post('/cambia-password', async (req, res) => {
  const { nuovaPassword } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || !nuovaPassword) return res.status(400).json({ message: 'Dati mancanti' });
  if (nuovaPassword.length < 6) return res.status(400).json({ message: 'Password troppo corta (min 6 caratteri)' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const hash = await bcrypt.hash(nuovaPassword, 10);
    await pool.query(
      `UPDATE utenti SET password=$1, must_change_password=FALSE WHERE id=$2`,
      [hash, decoded.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// POST /api/avatar
router.post('/avatar', upload.single('avatar'), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || !req.file) return res.status(400).json({ message: 'Token o file mancante' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const id = decoded.insegnanteId;
    if (!id) return res.status(400).json({ message: 'Nessun insegnante collegato' });
    const avatarUrl = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE insegnanti SET avatar_url = $1 WHERE id = $2', [avatarUrl, id]);
    res.json({ message: 'Avatar aggiornato', avatarUrl });
  } catch (err) {
    console.error('Errore upload avatar:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// POST /api/setup-avatar-column (legacy/idempotente)
router.post('/setup-avatar-column', async (_req, res) => {
  try {
    await pool.query(`ALTER TABLE insegnanti ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
    res.json({ message: 'Colonna avatar_url aggiunta' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Errore setup' });
  }
});

module.exports = router;
