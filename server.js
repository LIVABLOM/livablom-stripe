// server.js (CommonJS)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { Pool } = require('pg');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;

// ----- URLs / Config -----
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://livablom.fr';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

const STRIPE_MODE = process.env.STRIPE_MODE || 'test';
const STRIPE_KEY = STRIPE_MODE === 'live' ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_KEY;
const STRIPE_WEBHOOK_SECRET = STRIPE_MODE === 'live' ? process.env.STRIPE_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_TEST_SECRET;

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER = process.env.BREVO_SENDER;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'LIVABLŌM';
const BREVO_TO = process.env.BREVO_TO;

// ----- Stripe init -----
const stripe = Stripe(STRIPE_KEY);

// ----- PostgreSQL -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function insertReservation(logement, email, dateDebut, dateFin, montant) {
  try {
    const result = await pool.query(
      `INSERT INTO reservations (logement, email, date_debut, date_fin, montant, cree_le)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING *`,
      [logement, email, dateDebut, dateFin, montant]
    );
    console.log('✅ Réservation enregistrée dans PostgreSQL :', result.rows[0]);
    return result.rows[0];
  } catch (err) {
    console.error('❌ Erreur PostgreSQL :', err.message || err);
    throw err;
  }
}

// ----- Middlewares -----
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ----- Webhook Stripe -----
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Erreur webhook signature:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const date = session.metadata.date || new Date().toISOString();
    const logement = session.metadata.logement || 'BLŌM';
    const nuits = parseInt(session.metadata.nuits || 1, 10);
    const email = session.metadata.email || session.customer_details?.email || null;
    const montant = session.amount_total ? session.amount_total / 100 : 0;

    console.log(`✅ Webhook: paiement confirmé pour ${logement} - ${nuits} nuit(s) - ${date}`);

    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + nuits);

    try { await insertReservation(logement, email, startDate.toISOString(), endDate.toISOString(), montant); }
    catch (err) { console.error('Erreur insertReservation (webhook):', err.message); }

    // Email via Brevo
    if (BREVO_API_KEY && BREVO_SENDER && BREVO_TO) {
      try {
        const axios = require('axios');
        const payload = {
          sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER },
          to: [{ email: BREVO_TO }, { email: email || BREVO_TO }],
          subject: `Nouvelle réservation : ${logement}`,
          textContent: `Réservation confirmée pour ${logement}\nDate : ${startDate.toISOString().split('T')[0]}\nNuits : ${nuits}\nMontant payé : ${montant}€\nEmail client : ${email || 'non fourni'}`,
          htmlContent: `<p>Réservation confirmée pour <strong>${logement}</strong></p>
                        <p>Date : ${startDate.toISOString().split('T')[0]}</p>
                        <p>Nuits : ${nuits}</p>
                        <p>Montant payé : ${montant} €</p>
                        <p>Email client : ${email || 'non fourni'}</p>`
        };
        const resBrevo = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
          headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' }
        });
        console.log('📧 Email Brevo envoyé:', resBrevo.data);
      } catch (err) { console.error('❌ Erreur envoi email Brevo :', err.message); }
    }
  }
  res.json({ received: true });
});

// ----- Create Checkout Session -----
app.post('/create-checkout-session', async (req, res) => {
  try {
    const body = req.body || {};
    const date = body.date || new Date().toISOString();
    const logement = (body.logement || 'BLŌM').toString();
    const nuits = parseInt(body.nuits || 1, 10);

    let totalCents = 0;
    if (body.total) totalCents = Math.round(parseFloat(body.total) * 100);
    else if (body.prix) totalCents = Math.round(parseFloat(body.prix) * 100);
    else return res.status(400).json({ error: 'prix ou total manquant dans la requête' });

    // option test
    if (process.env.TEST_PAYMENT === 'true') totalCents = 100;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `${logement} - ${nuits} nuit(s)` },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${FRONTEND_URL}/confirmation/?success=true&logement=${encodeURIComponent(logement)}&date=${encodeURIComponent(date)}&nuits=${encodeURIComponent(nuits)}&montant=${encodeURIComponent(totalCents/100)}`,
      cancel_url: `${FRONTEND_URL}/${encodeURIComponent(logement.toLowerCase())}/`,
      metadata: { date, logement, nuits, email: body.email || null }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erreur Stripe Checkout :', err.message || err);
    res.status(500).json({ error: 'Erreur lors de la création de la session de paiement.' });
  }
});

// ----- iCal dynamique -----
app.get('/ical/:logement', async (req, res) => {
  try {
    const logement = req.params.logement.toUpperCase();
    const result = await pool.query(
      `SELECT date_debut, date_fin, email FROM reservations WHERE logement=$1`,
      [logement]
    );

    let icsContent = 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//LIVABLŌM//FR\n';
    result.rows.forEach(r => {
      const start = new Date(r.date_debut);
      const end = new Date(r.date_fin);
      const startStr = start.toISOString().split('T')[0].replace(/-/g, '');
      const endStr = end.toISOString().split('T')[0].replace(/-/g, '');
      icsContent += 'BEGIN:VEVENT\n';
      icsContent += `DTSTART;VALUE=DATE:${startStr}\n`;
      icsContent += `DTEND;VALUE=DATE:${endStr}\n`;
      icsContent += `SUMMARY:Réservé (${r.email || 'client'})\n`;
      icsContent += 'END:VEVENT\n';
    });
    icsContent += 'END:VCALENDAR';

    res.setHeader('Content-Type', 'text/calendar');
    res.send(icsContent);

  } catch (err) {
    console.error('❌ Erreur ICS :', err.message);
    res.status(500).send('Erreur ICS');
  }
});

// ----- Start server -----
app.listen(PORT, () => {
  console.log(`🚀 livablom-stripe démarré. BACKEND_URL=${BACKEND_URL} FRONTEND_URL=${FRONTEND_URL}`);
});
