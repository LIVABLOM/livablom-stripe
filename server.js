require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fetch = require('node-fetch');
const ical = require('ical');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// ======== Stripe ========
const stripeMode = process.env.STRIPE_MODE || "test";
const stripeSecretKey =
  stripeMode === "live" ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_KEY;
const stripeWebhookSecret =
  stripeMode === "live" ? process.env.STRIPE_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_TEST_SECRET;

const stripe = Stripe(stripeSecretKey);
console.log(`🌍 NODE_ENV : ${process.env.NODE_ENV}`);
console.log(`💳 STRIPE_MODE : ${stripeMode}`);
console.log(`🔑 Clé Stripe utilisée : ${stripeSecretKey ? "✅ OK" : "❌ NON DEFINIE"}`);

// ======== PostgreSQL ========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function insertReservation(logement, email, dateDebut, dateFin) {
  try {
    const result = await pool.query(
      `INSERT INTO reservations (logement, email, date_debut, date_de_fin)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [logement, email, dateDebut, dateFin]
    );
    console.log("✅ Réservation enregistrée dans PostgreSQL :", result.rows[0]);
  } catch (err) {
    console.error("❌ Erreur PostgreSQL :", err.message);
  }
}

// ======== Middleware ========
app.use(cors());
app.use(express.static('public'));

// ⚠️ Express.json après le webhook pour Stripe
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

    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + parseInt(nuits));

    // PostgreSQL
    await insertReservation(logement, email, startDate.toISOString(), endDate.toISOString());

    // Backup JSON local
    const filePath = './bookings.json';
    let bookings = {};
    if (fs.existsSync(filePath)) bookings = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!bookings[logement]) bookings[logement] = [];
    bookings[logement].push({
      title: `Réservé (${email})`,
      start: startDate.toISOString().split('T')[0],
      end: endDate.toISOString().split('T')[0]
    });
    fs.writeFileSync(filePath, JSON.stringify(bookings, null, 2));
    console.log("📅 Réservation enregistrée dans bookings.json !");

    // Email
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
    for (const url of calendars[logement]) {
      const e = await fetchICal(url, logement);
      events = events.concat(e);
    }

    // Ajout des réservations locales
    const filePath = './bookings.json';
    if (fs.existsSync(filePath)) {
      const localReservations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (localReservations[logement]) events = events.concat(localReservations[logement]);
    }

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
    if (process.env.TEST_PAYMENT === "true") finalAmount = 100; // 1 € pour test

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
