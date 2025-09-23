// server.js (CommonJS)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const Stripe = require('stripe');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// ----- URLs / Config -----
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://livablom.fr';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const CALENDAR_URL = process.env.CALENDAR_URL || '';

const STRIPE_MODE = process.env.STRIPE_MODE || 'test';
const STRIPE_KEY = STRIPE_MODE === 'live' ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_KEY;
const STRIPE_WEBHOOK_SECRET =
  STRIPE_MODE === 'live' ? process.env.STRIPE_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_TEST_SECRET;

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER = process.env.BREVO_SENDER; // ex: contact@livablom.fr
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'LIVABLŌM';
const BREVO_TO = process.env.BREVO_TO; // ex: livablom59@gmail.com

console.log('DATABASE_URL :', process.env.DATABASE_URL);
console.log('🌍 NODE_ENV :', process.env.NODE_ENV);
console.log('💳 STRIPE_MODE :', STRIPE_MODE);
console.log('🔑 STRIPE_KEY :', STRIPE_KEY ? 'OK' : 'MISSING');
console.log('🔒 STRIPE_WEBHOOK_SECRET :', STRIPE_WEBHOOK_SECRET ? 'OK' : 'MISSING');
console.log('📧 BREVO configured :', BREVO_API_KEY ? 'OK' : 'NO API KEY', ' sender:', BREVO_SENDER || 'MISSING');

// ----- Stripe init -----
if (!STRIPE_KEY) {
  console.warn('⚠️ STRIPE_KEY manquante — le serveur démarre mais Stripe échouera.');
}
const stripe = Stripe(STRIPE_KEY);

// ----- PostgreSQL -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function insertReservation(logement, email, dateDebut, dateFin) {
  try {
    const result = await pool.query(
      `INSERT INTO reservations (logement, email, date_debut, date_fin, cree_le)
       VALUES ($1, $2, $3, $4, now())
       RETURNING *`,
      [logement, email, dateDebut, dateFin]
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
app.use(express.static('public'));

// ----- Stripe Webhook (⚠️ express.raw obligatoire ici) -----
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

    const date = session.metadata.date || session.metadata.date_debut || null;
    const logement = session.metadata.logement || 'UNKNOWN';
    const nuits = session.metadata.nuits || '1';
    const email = session.metadata.email || session.customer_details?.email || null;

    console.log(`✅ Webhook: paiement confirmé pour ${logement} - ${nuits} nuit(s) - ${date}`);

    // Calcul des dates
    const startDate = date ? new Date(date) : new Date();
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + parseInt(nuits, 10));

    // Insert en BDD
    try {
      await insertReservation(logement, email, startDate.toISOString(), endDate.toISOString());
    } catch (err) {
      console.error('Erreur insertReservation (webhook):', err.message);
    }

    // Backup local JSON
    try {
      const filePath = './bookings.json';
      let bookings = {};
      if (fs.existsSync(filePath)) {
        bookings = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
      }
      if (!bookings[logement]) bookings[logement] = [];
      bookings[logement].push({
        title: `Réservé (${email || 'client'})`,
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      });
      fs.writeFileSync(filePath, JSON.stringify(bookings, null, 2));
      console.log('📅 Réservation enregistrée dans bookings.json');
    } catch (err) {
      console.error('Erreur sauvegarde bookings.json :', err.message);
    }

    // Email Brevo
    if (BREVO_API_KEY && BREVO_SENDER && BREVO_TO) {
      try {
        const payload = {
          sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER },
          to: [{ email: BREVO_TO }],
          subject: `Nouvelle réservation : ${logement}`,
          textContent: `Réservation confirmée pour ${logement}
Date : ${startDate.toISOString().split('T')[0]}
Nuits : ${nuits}
Email client : ${email || 'non fourni'}`,
          htmlContent: `<p><strong>Nouvelle réservation</strong></p>
                        <p>Logement : ${logement}</p>
                        <p>Date : ${startDate.toISOString().split('T')[0]}</p>
                        <p>Nuits : ${nuits}</p>
                        <p>Email client : ${email || 'non fourni'}</p>`
        };
        await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
          headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' }
        });
        console.log('📧 Email Brevo envoyé avec succès');
      } catch (err) {
        console.error('❌ Erreur envoi email Brevo :', err.response?.data || err.message);
      }
    } else {
      console.warn('⚠️ Brevo non configuré');
    }
  }

  res.json({ received: true });
});

// ----- express.json après webhook -----
app.use(express.json());

// ----- API pour récupérer réservations -----
app.get('/api/reservations/:logement', async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  try {
    const filePath = './bookings.json';
    if (!fs.existsSync(filePath)) return res.json([]);
    const local = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
    return res.json(local[logement] || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ----- Create Checkout Session -----
app.post('/create-checkout-session', async (req, res) => {
  try {
    const body = req.body || {};
    const date = body.date || null;
    const logement = (body.logement || 'BLŌM').toString();
    const nuits = parseInt(body.nuits || 1, 10);

    let totalCents = 0;
    if (body.total) {
      totalCents = Math.round(parseFloat(body.total) * 100);
    } else if (body.prix) {
      totalCents = Math.round(parseFloat(body.prix) * 100 * nuits);
    } else {
      return res.status(400).json({ error: 'Prix ou total manquant' });
    }

    if (process.env.TEST_PAYMENT === 'true') {
      totalCents = 100; // Forcer 1€ en test
    }

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
      success_url: `${FRONTEND_URL}/confirmation/?success=true&logement=${encodeURIComponent(logement)}`,
      cancel_url: `${FRONTEND_URL}/${encodeURIComponent(logement.toLowerCase())}/`,
      metadata: {
        date: date || new Date().toISOString(),
        logement,
        nuits,
        email: body.email || null
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erreur Stripe Checkout :', err.response?.data || err.message || err);
    res.status(500).json({ error: 'Erreur création session paiement' });
  }
});

// ----- Start server -----
app.listen(PORT, () => {
  console.log(`🚀 livablom-stripe démarré. BACKEND_URL=${BACKEND_URL} FRONTEND_URL=${FRONTEND_URL}`);
});
