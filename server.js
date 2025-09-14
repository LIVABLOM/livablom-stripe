require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fetch = require('node-fetch');
const ical = require('ical');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// ======== PostgreSQL ========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Railway donne cette variable
  ssl: { rejectUnauthorized: false },
});

// Vérification + création de la table
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        logement TEXT NOT NULL,
        email TEXT NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("📦 Table reservations prête !");
  } catch (err) {
    console.error("❌ Erreur init DB :", err);
  }
}
initDB();

// ======== Choix de la clé Stripe ========
const stripeMode = process.env.STRIPE_MODE || "test"; // "test" ou "live"
const stripeSecretKey =
  stripeMode === "live" ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_KEY;

const stripeWebhookSecret =
  stripeMode === "live"
    ? process.env.STRIPE_WEBHOOK_SECRET
    : process.env.STRIPE_WEBHOOK_TEST_SECRET;

const stripe = Stripe(stripeSecretKey);

console.log(`🌍 NODE_ENV : ${process.env.NODE_ENV}`);
console.log(`💳 STRIPE_MODE : ${stripeMode}`);
console.log(`💳 TEST_PAYMENT : ${process.env.TEST_PAYMENT}`);
console.log(`🔑 Clé Stripe utilisée : ${stripeSecretKey ? "✅ OK" : "❌ NON DEFINIE"}`);

// ======== Middlewares ========
app.use(cors());
app.use(express.static('public'));

// ⚠️ Pas de express.json ici → casse le webhook Stripe

// ======== Webhook Stripe ========
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error("⚠️ Erreur webhook :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { date, logement, nuits, email } = session.metadata;

    console.log(`✅ Paiement confirmé pour ${logement} - ${nuits} nuit(s) - ${date}`);

    // Dates de réservation
    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + parseInt(nuits));

    // 🔹 Insertion en base
    try {
      await pool.query(
        `INSERT INTO reservations (logement, email, start_date, end_date)
         VALUES ($1, $2, $3, $4)`,
        [logement, email, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]]
      );
      console.log("📅 Réservation enregistrée en base !");
    } catch (err) {
      console.error("❌ Erreur insertion réservation :", err);
    }

    // 🔹 Envoi email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    const mailOptions = {
      from: `"LIVABLŌM" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      subject: `Nouvelle réservation : ${logement}`,
      text: `Réservation confirmée pour ${logement}\nDate : ${date}\nNombre de nuits : ${nuits}\nEmail client : ${email}`
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) console.error("❌ Erreur envoi email :", error);
      else console.log("📧 Email envoyé :", info.response);
    });
  }

  res.json({ received: true });
});

// ======== JSON après webhook ========
app.use(express.json());

// ======== iCal ========
const calendars = { LIVA: [], BLOM: [] };

async function fetchICal(url, logement) {
  try {
    const res = await fetch(url);
    const data = await res.text();
    const parsed = ical.parseICS(data);

    return Object.values(parsed)
      .filter(ev => ev.start && ev.end)
      .map(ev => ({
        summary: ev.summary || "Réservé",
        start: ev.start,
        end: ev.end,
        logement
      }));
  } catch (err) {
    console.error("Erreur iCal pour", url, err);
    return [];
  }
}

app.get("/api/reservations/:logement", async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  if (!calendars[logement]) return res.status(404).json({ error: "Logement inconnu" });

  try {
    let events = [];

    // 🔹 iCal externes
    for (const url of calendars[logement]) {
      const e = await fetchICal(url, logement);
      events = events.concat(e);
    }

    // 🔹 Réservations DB
    const { rows } = await pool.query(
      `SELECT logement, email, start_date, end_date FROM reservations WHERE logement = $1`,
      [logement]
    );

    rows.forEach(r => {
      events.push({
        title: `Réservé (${r.email})`,
        start: r.start_date,
        end: r.end_date,
        logement: r.logement
      });
    });

    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ======== Stripe Checkout ========
const BASE_URL = stripeMode === "live" ? 'https://livablom.fr' : `http://localhost:${PORT}`;

app.post('/create-checkout-session', async (req, res) => {
  const { date, logement, nuits, prix, email } = req.body;

  if (!date || !logement || !nuits || !prix) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    let finalAmount = prix * 100;
    if (process.env.TEST_PAYMENT === "true") {
      finalAmount = 100; // 1 € test
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `${logement} - ${nuits} nuit(s)` },
          unit_amount: finalAmount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${BASE_URL}/confirmation.html?success=true`,
      cancel_url: `${BASE_URL}/blom/`,
      metadata: { date, logement, nuits, email }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur Stripe Checkout :", err);
    res.status(500).json({ error: 'Erreur lors de la réservation.' });
  }
});

// ======== Serveur ========
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur ${BASE_URL}`);
});
