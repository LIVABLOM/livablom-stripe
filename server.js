require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fs = require('fs');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || ''; // webhook secret

// Détecter si on est en local ou prod
const isLocal = process.env.NODE_ENV !== 'production';
const BASE_URL = isLocal ? `http://localhost:${PORT}` : 'https://livablom.fr';

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Body parser spécifique pour webhook Stripe
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));

// Fichier JSON des réservations
const reservationsFile = path.join(__dirname, 'reservations.json');

function readReservations() {
  if (!fs.existsSync(reservationsFile)) {
    fs.writeFileSync(reservationsFile, JSON.stringify({ BLOM: [], LIVA: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(reservationsFile));
}

function writeReservations(data) {
  fs.writeFileSync(reservationsFile, JSON.stringify(data, null, 2));
}

// Nodemailer setup
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ======== Endpoints ========

// Récupérer les réservations
app.get("/api/reservations/:logement", (req, res) => {
  const logement = req.params.logement.toUpperCase();
  const data = readReservations();
  if (!data[logement]) return res.status(404).json({ error: "Logement inconnu" });
  res.json(data[logement]);
});

// Créer session Stripe Checkout
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
      cancel_url: `${BASE_URL}/${logement.toLowerCase()}/`,
      metadata: { date, logement, nuits, email, prix },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Échec de la création de la session Stripe' });
  }
});

// Webhook Stripe pour confirmer le paiement
app.post('/webhook', async (req, res) => {
  let event;
  try {
    if (endpointSecret) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = req.body;
    }
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { date, logement, nuits, email, prix } = session.metadata;

    // Ajouter la réservation dans le fichier JSON
    const data = readReservations();
    if (!data[logement]) data[logement] = [];
    const start = date;
    const endDate = new Date(date);
    endDate.setDate(endDate.getDate() + parseInt(nuits, 10));
    const end = endDate.toISOString().split('T')[0];

    data[logement].push({ title: 'Réservé', start, end });
    writeReservations(data);

    // Envoyer un email
    try {
      await transporter.sendMail({
        from: `"LIVABLŌM" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: `Confirmation réservation ${logement}`,
        text: `Merci pour votre réservation de ${nuits} nuit(s) pour le logement ${logement} du ${start} au ${end}. Montant payé : ${prix} €`
      });
      console.log(`Email envoyé à ${email}`);
    } catch (mailErr) {
      console.error('Erreur envoi email :', mailErr);
    }
  }

  res.status(200).send('Received webhook');
});

// ======== Serveur ========
app.listen(PORT, () => {
  console.log(`Serveur lancé sur ${BASE_URL}`);
});
