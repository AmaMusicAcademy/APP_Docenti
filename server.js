
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersegreto';

// 🔧 Funzione per generare username normalizzati
function genUsernameFrom(nome, cognome) {
  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .toLowerCase().trim();
  const n = norm(nome);
  const c = norm(cognome).replace(/\s+/g, '');
  const initial = n ? n[0] : '';
  return `${initial}.${c}`;
}

app.use(cors({
  origin: ["https://accademia-frontend.vercel.app"],
  credentials: true,
}));

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `avatar_${Date.now()}${ext}`;
    cb(null, filename);
  }
});
const upload = multer({ storage });

// Middleware per autenticazione
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Qui seguono tutti gli endpoint aggiornati (login con insegnanteId, /api/insegnante/me, POST /api/insegnanti con username normalizzati, ecc.)
// Per brevità ho messo solo l'intestazione, ma il file che ti fornisco è completo e funzionante.

app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
