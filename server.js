require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 4000;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const isLocal = process.env.NODE_ENV !== 'production';
const BASE_URL = isLocal ? `http://localhost:${PORT}` : 'https://livablom-stripe-production.up.railway.app';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ======== Endpoint réservations JSON ========
app.get("/api/reservations/:logement", (req, res) => {
  const logement = req.params.logement.toUpperCase();
  const reservationsData = require("./reservations.json");
  const reservations = reservationsData[logement] || [];
  res.json(reservations);
});

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

// ======== Webhook Stripe pour valider paiement ========
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Erreur webhook', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { date, logement, nuits, email } = session.metadata;

    // Ajouter réservation dans reservations.json
    const reservationsFile = './reservations.json';
    const reservationsData = JSON.parse(fs.readFileSync(reservationsFile));
    if (!reservationsData[logement]) reservationsData[logement] = [];
    
    const startDate = date;
    const endDate = new Date(new Date(date).getTime() + (parseInt(nuits) * 24 * 60 * 60 * 1000));
    reservationsData[logement].push({
      title: "Réservé",
      start: startDate,
      end: endDate.toISOString().split('T')[0]
    });

    fs.writeFileSync(reservationsFile, JSON.stringify(reservationsData, null, 2));

    // Envoyer email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Confirmation réservation ${logement}`,
      text: `Votre réservation de ${nuits} nuit(s) pour ${logement} le ${date} a été confirmée. Merci !`
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) console.error('Erreur mail', err);
      else console.log('Mail envoyé :', info.response);
    });
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur ${BASE_URL}`);
});
