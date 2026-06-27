const express = require('express');
const Stripe  = require('stripe');
const { pool } = require('../db');
const { requireRole } = require('../Middleware/auth');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const MESI_NOME = ['','Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
  'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

// Migration colonne Stripe sull'allievo
pool.query(`
  ALTER TABLE allievi
  ADD COLUMN IF NOT EXISTS stripe_customer_id    TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT
`).catch(() => {});

// ── Crea/recupera customer Stripe per l'allievo autenticato ────────────────
async function getOrCreateCustomer(allievoId) {
  const { rows } = await pool.query(
    'SELECT stripe_customer_id, nome, cognome, email FROM allievi WHERE id=$1', [allievoId]
  );
  if (!rows.length) throw new Error('Allievo non trovato');
  const a = rows[0];
  if (a.stripe_customer_id) return a.stripe_customer_id;

  const customer = await stripe.customers.create({
    name:     `${a.nome} ${a.cognome}`,
    email:    a.email || undefined,
    metadata: { allievo_id: String(allievoId) },
  });
  await pool.query(
    'UPDATE allievi SET stripe_customer_id=$1 WHERE id=$2',
    [customer.id, allievoId]
  );
  return customer.id;
}

// ── POST /api/stripe/setup-intent
// Crea un SetupIntent per salvare il metodo di pagamento (primo passo abbonamento)
router.post('/stripe/setup-intent', ...requireRole('allievo'), async (req, res) => {
  try {
    const customerId = await getOrCreateCustomer(req.user.allievoId);
    const intent = await stripe.setupIntents.create({
      customer:             customerId,
      payment_method_types: ['card'],
    });
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe/abbonamento
// Crea l'abbonamento mensile con importo personalizzato per ogni allievo
router.post('/stripe/abbonamento', ...requireRole('allievo'), async (req, res) => {
  const { paymentMethodId } = req.body;
  if (!paymentMethodId) return res.status(400).json({ error: 'Metodo di pagamento mancante' });

  try {
    const customerId = await getOrCreateCustomer(req.user.allievoId);

    // Recupera quota mensile dell'allievo
    const { rows } = await pool.query(
      'SELECT quota_mensile FROM allievi WHERE id=$1', [req.user.allievoId]
    );
    const quota = Math.round(parseFloat(rows[0]?.quota_mensile || 0) * 100); // in centesimi
    if (quota <= 0) return res.status(400).json({ error: 'Quota mensile non configurata' });

    // Recupera il product_id dal price template
    const priceTemplate = await stripe.prices.retrieve(process.env.STRIPE_PRICE_MENSILE);
    const productId = priceTemplate.product;

    // Attacca il metodo di pagamento al customer e lo imposta come default
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // Crea l'abbonamento con importo personalizzato via price_data
    const sub = await stripe.subscriptions.create({
      customer:         customerId,
      items: [{
        price_data: {
          currency:    'eur',
          product:     productId,
          unit_amount: quota,
          recurring:   { interval: 'month' },
        },
      }],
      payment_behavior: 'default_incomplete',
      expand:           ['latest_invoice.payment_intent'],
      metadata:         { allievo_id: String(req.user.allievoId) },
    });

    await pool.query(
      'UPDATE allievi SET stripe_subscription_id=$1 WHERE id=$2',
      [sub.id, req.user.allievoId]
    );

    const pi = sub.latest_invoice?.payment_intent;
    res.json({
      subscriptionId: sub.id,
      clientSecret:   pi?.client_secret || null,
      status:         sub.status,
      quota:          quota / 100,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe/payment-intent
// Pagamento singolo per arretrati mensili
router.post('/stripe/payment-intent', ...requireRole('allievo'), async (req, res) => {
  const { mesi } = req.body; // [{anno, mese, importo}]
  if (!Array.isArray(mesi) || mesi.length === 0)
    return res.status(400).json({ error: 'Nessun mese specificato' });

  try {
    const customerId = await getOrCreateCustomer(req.user.allievoId);
    const totale = mesi.reduce((s, m) => s + Math.round(parseFloat(m.importo) * 100), 0);
    const desc   = mesi.map(m => `${MESI_NOME[m.mese]} ${m.anno}`).join(', ');

    const intent = await stripe.paymentIntents.create({
      amount:               totale,
      currency:             'eur',
      customer:             customerId,
      payment_method_types: ['card'],
      description:          `Quote mensili: ${desc}`,
      metadata:             {
        allievo_id: String(req.user.allievoId),
        mesi:       JSON.stringify(mesi.map(m => ({ anno: m.anno, mese: m.mese }))),
      },
    });
    res.json({ clientSecret: intent.client_secret, totale: totale / 100 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe/webhook
// Stripe notifica il completamento del pagamento — raw body necessario
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const allievoId = parseInt(pi.metadata?.allievo_id);
      const mesi = pi.metadata?.mesi ? JSON.parse(pi.metadata.mesi) : [];

      if (allievoId && mesi.length > 0) {
        for (const { anno, mese } of mesi) {
          await pool.query(
            `INSERT INTO pagamenti_mensili (allievo_id, anno, mese, data_pagamento)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT DO NOTHING`,
            [allievoId, anno, mese]
          ).catch(() => {});
        }
        console.log(`[Stripe] Segnati come pagati ${mesi.length} mesi per allievo ${allievoId}`);
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const sub = invoice.subscription
        ? await stripe.subscriptions.retrieve(invoice.subscription)
        : null;
      const allievoId = parseInt(sub?.metadata?.allievo_id || invoice.metadata?.allievo_id);

      if (allievoId) {
        const now  = new Date();
        const anno = now.getFullYear();
        const mese = now.getMonth() + 1;
        await pool.query(
          `INSERT INTO pagamenti_mensili (allievo_id, anno, mese, data_pagamento)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT DO NOTHING`,
          [allievoId, anno, mese]
        ).catch(() => {});
        console.log(`[Stripe] Abbonamento: pagamento mensile registrato per allievo ${allievoId}`);
      }
    }
  } catch (err) {
    console.error('[Stripe webhook] Errore elaborazione:', err);
  }

  res.json({ received: true });
});

// ── GET /api/stripe/config  — publishable key per il frontend
router.get('/stripe/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

module.exports = router;
