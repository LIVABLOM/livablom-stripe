require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fs = require('fs');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Détecter si on est en local ou prod
const isLocal = process.env.NODE_ENV !== 'production';
const BASE_URL = isLocal ? `http://localhost:${PORT}` : 'https://livablom.fr';

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ======== Body parser pour Stripe Webhook ========
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));

// ======== Stripe Checkout ========
app.post('/create-checkout-session', async (req, res) => {
  const { date, logement, nuits, prix, email } = req.body;

  if (!date || !logement || !nuits || !prix || !email) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `${logement} - ${nuits} nuit(s)` },
          unit_amount: prix * 100,
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

// ======== Webhook Stripe ========
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { date, logement, nuits, email } = session.metadata;

    // 1️⃣ Envoyer un mail
    const transporter = nodemailer.createTransport({
      service: 'gmail', // ou autre selon ton email
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Réservation confirmée pour ${logement}`,
      text: `Merci pour votre réservation de ${nuits} nuit(s) le ${date} pour ${logement}.`
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) console.error('Erreur mail:', err);
      else console.log('Mail envoyé:', info.response);
    });

    // 2️⃣ Bloquer la date localement
    const reservationsFile = path.join(__dirname, 'reservations.json');
    let reservations = {};
    if (fs.existsSync(reservationsFile)) {
      reservations = JSON.parse(fs.readFileSync(reservationsFile, 'utf-8'));
    }

    if (!reservations[logement]) reservations[logement] = [];
    reservations[logement].push({ date, nuits: Number(nuits), email });

    fs.writeFileSync(reservationsFile, JSON.stringify(reservations, null, 2));
    console.log(`Date ${date} ajoutée pour ${logement}`);
  }

  res.status(200).send('Received');
});

// ======== Serveur ========
app.listen(PORT, () => {
  console.log(`Serveur lancé sur ${BASE_URL}`);
});
