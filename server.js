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

// Détection du mode
const isProduction = process.env.NODE_ENV === 'production';

// Stripe : choisir clé test ou production
const stripe = Stripe(
  isProduction ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_SECRET_KEY
);

// Webhook : clé correspondante
const endpointSecret = isProduction
  ? process.env.STRIPE_WEBHOOK_SECRET
  : process.env.STRIPE_WEBHOOK_TEST_SECRET;

// URL de base
const BASE_URL = isProduction ? 'https://livablom.fr' : `http://localhost:${PORT}`;

// Middlewares
app.use(cors());
// Important : express.json() pour tout sauf webhook
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));
app.use(express.static('public'));

// ======== iCal ========
const calendars = {
  LIVA: [/* URLs iCal de LIVA */],
  BLOM: [/* URLs iCal de BLOM */]
};

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
      events = events.concat(await fetchICal(url, logement));
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
app.post('/create-checkout-session', async (req, res) => {
  const { date, logement, nuits, prix, email } = req.body;
  if (!date || !logement || !nuits || !prix) return res.status(400).json({ error: 'Paramètres manquants' });

  try {
    let finalAmount = prix * 100;
    if (!isProduction) finalAmount = 100; // 1€ en test

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
    console.error(err);
    res.status(500).json({ error: 'Échec de la création de la session Stripe' });
  }
});

// ======== Stripe Webhook ========
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("⚠️ Erreur webhook :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { date, logement, nuits, email } = session.metadata;

    console.log(`✅ Paiement confirmé pour ${logement} - ${nuits} nuit(s) - ${date}`);

    // Blocage date local
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
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
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
  console.log(`🚀 Serveur lancé sur ${BASE_URL} (${isProduction ? 'PROD' : 'TEST'})`);
});
