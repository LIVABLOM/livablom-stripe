require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fetch = require('node-fetch');
const ical = require('ical');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 4000;

// ======== Gestion des clés Stripe selon les variables d'environnement ========
const isProduction = process.env.NODE_ENV === 'production';
const isStripeLive = process.env.STRIPE_MODE === 'live';

const stripeSecretKey = isStripeLive
  ? process.env.STRIPE_SECRET_KEY      // clé live
  : process.env.STRIPE_TEST_KEY;       // clé test

const stripeWebhookSecret = isStripeLive
  ? process.env.STRIPE_WEBHOOK_SECRET  // webhook live
  : process.env.STRIPE_WEBHOOK_TEST_SECRET; // webhook test

const stripe = Stripe(stripeSecretKey);

console.log(`🌍 NODE_ENV : ${process.env.NODE_ENV}`);
console.log(`💳 STRIPE_MODE : ${process.env.STRIPE_MODE}`);
console.log(`💳 Mode TEST_PAYMENT : ${process.env.TEST_PAYMENT}`);
console.log(`🔑 Clé Stripe utilisée : ${stripeSecretKey ? '✅ OK' : '❌ NON DEFINIE'}`);

// ======== Middlewares ========
app.use(cors());
app.use(express.static('public'));

// ⚠️ Attention : express.json() doit être après le webhook pour ne pas casser le raw body
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

    const filePath = './reservations.json';
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
const BASE_URL = isProduction ? 'https://livablom.fr' : `http://localhost:${PORT}`;

app.post('/create-checkout-session', async (req, res) => {
  const { date, logement, nuits, prix, email } = req.body;

  if (!date || !logement || !nuits || !prix) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    let finalAmount = prix * 100;

    // Test payment à 1€ si demandé et que Stripe n'est pas en live
    if (process.env.TEST_PAYMENT === "true" && !isStripeLive) {
      finalAmount = 100; // 1€
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

// ======== Stripe Webhook ========
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
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

    // Enregistrement réservation
    const filePath = './reservations.json';
    let reservations = {};
    if (fs.existsSync(filePath)) reservations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!reservations[logement]) reservations[logement] = [];

    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + parseInt(nuits));

    reservations[logement].push({
      title: `Réservé (${email})`,
      start: startDate.toISOString().split('T')[0],
      end: endDate.toISOString().split('T')[0]
    });

    fs.writeFileSync(filePath, JSON.stringify(reservations, null, 2));
    console.log("📅 Réservation enregistrée !");

    // Envoi email
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

// ======== Serveur ========
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur ${BASE_URL}`);
});
