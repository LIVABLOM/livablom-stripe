require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fs = require('fs');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 4000;

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Détecter si on est en local ou prod
const isLocal = process.env.NODE_ENV !== 'production';
const BASE_URL = isLocal ? `http://localhost:${PORT}` : 'https://livablom.fr';

// Switch de test
const TEST_PAYMENT = process.env.TEST_PAYMENT === 'true'; // true = paiement 1€

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(bodyParser.json());

// Fichier des réservations
const RESERVATIONS_FILE = 'reservations.json';
let reservations = {};
if (fs.existsSync(RESERVATIONS_FILE)) {
  reservations = JSON.parse(fs.readFileSync(RESERVATIONS_FILE, 'utf-8'));
}

// Endpoint pour récupérer les réservations
app.get('/api/reservations/:logement', (req, res) => {
  const logement = req.params.logement.toUpperCase();
  if (!reservations[logement]) return res.status(404).json({ error: 'Logement inconnu' });
  res.json(reservations[logement]);
});

// Fonction pour sauvegarder les réservations
function saveReservations() {
  fs.writeFileSync(RESERVATIONS_FILE, JSON.stringify(reservations, null, 2));
}

// Fonction pour envoyer email
async function sendEmail(to, sujet, texte) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject: sujet,
    text: texte
  });
}

// Tarif par défaut
const tarifs = {
  BLOM: { 'default': 150, vendredi: 169, samedi: 169, dimanche: 190 },
  LIVA: { 'default': 120, vendredi: 140, samedi: 140, dimanche: 160 }
};

// Fonction pour calculer prix
function getPrix(logement, date) {
  if (TEST_PAYMENT) return 1;
  const day = new Date(date).getDay(); // 0 = dimanche, 5 = vendredi, 6 = samedi
  if (day === 0) return tarifs[logement].dimanche || tarifs[logement].default;
  if (day === 5) return tarifs[logement].vendredi || tarifs[logement].default;
  if (day === 6) return tarifs[logement].samedi || tarifs[logement].default;
  return tarifs[logement].default;
}

// ======== Stripe Checkout ========
app.post('/create-checkout-session', async (req, res) => {
  const { date, logement, nuits, email } = req.body;
  if (!date || !logement || !nuits) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  const prix = getPrix(logement, date) * nuits;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `${logement} - ${nuits} nuit(s)` },
          unit_amount: prix * 100
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${BASE_URL}/confirmation.html?success=true`,
      cancel_url: `${BASE_URL}/${logement.toLowerCase()}/`,
      metadata: { date, logement, nuits, email }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Échec de la création de la session Stripe' });
  }
});

// Webhook Stripe pour confirmer le paiement et bloquer la date
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
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

    // Bloquer la date
    if (!reservations[logement]) reservations[logement] = [];
    reservations[logement].push({
      title: 'Réservé',
      start: date,
      end: new Date(new Date(date).getTime() + nuits*24*60*60*1000).toISOString().split('T')[0]
    });
    saveReservations();

    // Envoyer email
    sendEmail(email, `Confirmation réservation ${logement}`, `Merci pour votre réservation du ${date} pour ${nuits} nuit(s) à ${logement}.`);
  }

  res.json({ received: true });
});

// ======== Serveur ========
app.listen(PORT, () => {
  console.log(`Serveur lancé sur ${BASE_URL}`);
});
