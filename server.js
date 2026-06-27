const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      'https://accademia-frontend.vercel.app',
      'http://localhost:3001',
      'http://localhost:3000',
    ];
    // Accetta tutti i deploy Vercel del progetto (preview branch inclusi)
    if (!origin || allowed.includes(origin) || /^https:\/\/accademia-frontend(-[a-z0-9-]+)?\.vercel\.app$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
// Webhook Stripe DEVE stare prima di express.json() per ricevere il raw body
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ----------------------
// Routes
// ----------------------
app.use('/api', require('./routes/stripe'));
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/insegnanti'));
app.use('/api', require('./routes/allievi'));
app.use('/api', require('./routes/lezioni'));
app.use('/api', require('./routes/aule'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/allievo'));
app.use('/api', require('./routes/setup'));
app.use('/api', require('./routes/giorni-chiusura'));

// ----------------------
// Health + debug routes
// ----------------------
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/api/_routes', (_req, res) => {
  const routes = [];
  app._router.stack.forEach((layer) => {
    if (layer.name === 'router' && layer.handle.stack) {
      layer.handle.stack.forEach((r) => {
        if (r.route) {
          const methods = Object.keys(r.route.methods).join(',').toUpperCase();
          routes.push(`${methods} ${r.route.path}`);
        }
      });
    }
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
      routes.push(`${methods} ${layer.route.path}`);
    }
  });
  res.json(routes.sort());
});

// ----------------------
// Avvio
// ----------------------
const { pool } = require('./db');
const { avviaCron } = require('./cron/notifiche-pagamento');

pool.query(`
  CREATE TABLE IF NOT EXISTS cron_log (
    job TEXT PRIMARY KEY,
    eseguito_il TIMESTAMPTZ,
    notifiche_inviate INTEGER DEFAULT 0
  )
`).catch(() => {});

app.listen(PORT, () => {
  console.log(`Server AMA in ascolto sulla porta ${PORT}`);
  avviaCron();
});
