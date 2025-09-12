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

// === Détection Test / Prod ===
const isLocal = process.env.NODE_ENV !== 'production';
const stripe = Stripe(
  isLocal ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY
);
const endpointSecret = isLocal
  ? process.env.STRIPE_WEBHOOK_TEST_SECRET
  : process.env.STRIPE_WEBHOOK_SECRET;

// === URL de base ===
const BASE_URL = isLocal ? `http://localhost:${PORT}` : 'https://livablom.fr';

// === Middlewares ===
app.use(cors());
app.use(express.json({ verify: (req, res, buf) => (req.rawBody = buf) }));
app.use(express.static('public'));

// === iCal ===
const calendars = {
  LIVA: [],
  BLOM: []
};

async function fetchICal(url, logement) {
  try {
    const res = await fetch(url);
    const data = await res.text();
    const parsed = ical.parseICS(data);
    return Object.values(parsed)
      .filter(ev => ev.start && ev.end)
      .map(ev => ({
        summary: ev.summary || 'Réservé',
        start: ev.start,
        end: ev.end,
        logement
      }));
  } catch (err) {
    console.error('Erreur iCal pour', url, err);
    return [];
  }
}

app.get('/api/reservations/:logement', async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  if (!calendars[logement]) return res.status(404).json({ error: 'Logement inconnu' });

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
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// === Stripe Checkout ===
app.post('/create-checkout-session', async (req, res) => {
  const { date, logement, nuits, prix, email } = req.body;

  console.log('Création session checkout avec :', req.body);

  if (!date || !logement || !nuits || !prix) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    let finalAmount = prix * 100;
    if (isLocal && process.env.TEST_PAYMENT === 'true') finalAmount = 100;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: { name: `${logement} - ${nuits} nuit(s)` },
            unit_amount: finalAmount
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      success_url: `${BASE_URL}/confirmation.html?success=true`,
      cancel_url: `${BASE_URL}/blom/`,
      metadata: { date, logement, nuits, email }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erreur Stripe Checkout :', err.message);
    res.status(500).json({ error: 'Erreur lors de la création de la session Stripe' });
  }
});

// === Gestion des clés Stripe selon l'environnement ===
const isLocal = process.env.NODE_ENV !== 'production';
const stripeKey = isLocal ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY;

console.log("🔑 Stripe KEY utilisée :", stripeKey ? stripeKey.slice(0, 8) + "..." : "❌ NON DEFINIE");

const stripe = Stripe(stripeKey);


// === Stripe Webhook ===
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
  } catch (err) {
    console.error('⚠️ Erreur webhook :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { date, logement, nuits, email } = session.metadata;

    console.log(`✅ Paiement confirmé pour ${logement} - ${nuits} nuit(s) - ${date}`);

    // === Mise à jour calendrier local ===
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
    console.log('📅 Réservation enregistrée !');

    // === Email ===
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    transporter.sendMail(
      {
        from: `"LIVABLŌM" <${process.env.EMAIL_USER}>`,
        to: process.env.EMAIL_USER,
        subject: `Nouvelle réservation : ${logement}`,
        text: `Réservation confirmée pour ${logement}\nDate : ${date}\nNombre de nuits : ${nuits}\nEmail client : ${email}`
      },
      (error, info) => {
        if (error) console.error('❌ Erreur envoi email :', error);
        else console.log('📧 Email envoyé :', info.response);
      }
    );
  }

  res.json({ received: true });
});

// === Serveur ===
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur ${BASE_URL}`);
});
