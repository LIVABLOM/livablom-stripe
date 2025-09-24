// ----- Dépendances -----
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const stripeLib = require('stripe');
const { Pool } = require('pg');
const fs = require('fs');
const ics = require('ics');
const path = require('path');
const fetch = require('node-fetch');

// ----- Variables d'env -----
const PORT = process.env.PORT || 3000;
const STRIPE_MODE = process.env.STRIPE_MODE || 'test';
const STRIPE_KEY = STRIPE_MODE === 'live' ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_KEY;
const stripe = stripeLib(STRIPE_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4000';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ----- App Express -----
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ----- Table reservations -----
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      logement TEXT NOT NULL,
      date DATE NOT NULL,
      nuits INTEGER DEFAULT 1,
      montant INTEGER DEFAULT 0,
      email TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
initDB().catch(err => console.error('Erreur initDB:', err));

// ----- Insert réservation -----
async function insertReservation({ logement, date, nuits, montant, email }) {
  try {
    await pool.query(
      `INSERT INTO reservations (logement, date, nuits, montant, email) VALUES ($1, $2, $3, $4, $5)`,
      [logement, date, nuits, montant, email]
    );
  } catch (err) {
    console.error("❌ Erreur PostgreSQL :", err.message || err);
    // fallback JSON local
    const file = path.join(__dirname, 'bookings.json');
    let data = [];
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.push({ logement, date, nuits, montant, email, created_at: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    console.log("📅 Réservation enregistrée dans bookings.json");
  }
}

// ----- Email confirmation (Brevo) -----
async function sendConfirmationEmail({ to, logement, date, nuits, montant }) {
  if (!process.env.BREVO_API_KEY || !to) return;

  const body = {
    sender: { email: 'contact@livablom.fr', name: 'LIVABLŌM' },
    to: [{ email: to }],
    subject: "Confirmation de votre réservation",
    htmlContent: `
      <h2>Merci pour votre réservation !</h2>
      <p><b>Logement :</b> ${logement}</p>
      <p><b>Date d’arrivée :</b> ${date}</p>
      <p><b>Nombre de nuits :</b> ${nuits}</p>
      <p><b>Montant payé :</b> ${montant} €</p>
    `
  };

  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": process.env.BREVO_API_KEY
      },
      body: JSON.stringify(body)
    });
    const result = await resp.json();
    console.log("📧 Email Brevo envoyé:", result);
  } catch (err) {
    console.error("❌ Erreur envoi Brevo:", err.message || err);
  }
}

// ----- Création session Stripe -----
app.post('/create-checkout-session', async (req, res) => {
  try {
    const body = req.body || {};
    const date = body.date || new Date().toISOString().split('T')[0];
    const logement = (body.logement || 'BLŌM').toString();
    const nuits = parseInt(body.nuits || 1, 10);

    let totalCents = 0;
    if (body.total) totalCents = Math.round(parseFloat(body.total) * 100);
    else if (body.prix) totalCents = Math.round(parseFloat(body.prix) * 100 * nuits);
    else return res.status(400).json({ error: 'prix ou total manquant dans la requête' });

    // En mode test → paiement forcé à 1€
    if (STRIPE_MODE !== 'live') totalCents = 100;

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

// ----- Webhook Stripe -----
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Erreur Webhook Stripe :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const logement = session.metadata?.logement || 'BLŌM';
    const date = session.metadata?.date || new Date().toISOString().split('T')[0];
    const nuits = parseInt(session.metadata?.nuits || 1, 10);
    const montant = session.amount_total ? session.amount_total / 100 : 0;

    // Si mode test → ajoute (TEST) au logement
    const isTest = STRIPE_MODE !== 'live';
    const logementFinal = isTest ? `${logement} (TEST)` : logement;

    try {
      await insertReservation({
        logement: logementFinal,
        date,
        nuits,
        montant,
        email: session.metadata?.email || null
      });

      console.log(`✅ Réservation enregistrée pour ${logementFinal} - ${nuits} nuit(s) - ${date}`);

      await sendConfirmationEmail({
        to: session.metadata?.email,
        logement: logementFinal,
        date,
        nuits,
        montant
      });
    } catch (err) {
      console.error('❌ Erreur insertReservation (webhook):', err.message || err);
    }
  }

  res.json({ received: true });
});

// ----- Génération dynamique .ics -----
app.get('/ical/:logement.ics', async (req, res) => {
  try {
    const logement = decodeURIComponent(req.params.logement);
    const result = await pool.query(
      `SELECT date, nuits FROM reservations WHERE logement ILIKE $1 ORDER BY date ASC`,
      [`${logement}%`] // accepte BLOM et BLOM (TEST)
    );

    const events = result.rows.map(r => {
      const startDate = new Date(r.date);
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + r.nuits);

      return {
        title: `Réservé - ${logement}`,
        start: [startDate.getFullYear(), startDate.getMonth() + 1, startDate.getDate()],
        end: [endDate.getFullYear(), endDate.getMonth() + 1, endDate.getDate()],
      };
    });

    ics.createEvents(events, (error, value) => {
      if (error) {
        console.error("❌ Erreur ICS:", error);
        return res.status(500).send("Erreur ICS");
      }
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=${logement}.ics`);
      res.send(value);
    });
  } catch (err) {
    console.error("❌ Erreur génération ICS:", err.message || err);
    res.status(500).send("Erreur génération ICS");
  }
});

// ----- Lancement -----
app.listen(PORT, () => {
  console.log(`🚀 livablom-stripe démarré. BACKEND_URL=${BACKEND_URL} FRONTEND_URL=${FRONTEND_URL}`);
});
