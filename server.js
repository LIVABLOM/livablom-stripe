require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 4000;

// ======= Gestion des clés selon NODE_ENV =======
const isLocal = process.env.NODE_ENV !== 'production';
const stripeSecret = isLocal ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const endpointSecret = isLocal ? process.env.STRIPE_WEBHOOK_TEST_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
const stripe = Stripe(stripeSecret);

console.log(`🌍 Environnement : ${process.env.NODE_ENV}`);
console.log(`🔑 Clé Stripe utilisée : ${stripeSecret ? '✅ OK' : '❌ NON DEFINIE'}`);

// ======= Middleware =======
app.use(cors());

// Middleware JSON pour toutes les routes sauf /webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  express.json()(req, res, next);
});

// ======= Webhook Stripe =======
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

    // Enregistrer la réservation
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
      if (error) return console.error("❌ Erreur envoi email :", error);
      console.log("📧 Email envoyé :", info.response);
    });
  }

  res.json({ received: true });
});

// ======= Création session Stripe =======
app.post('/create-checkout-session', async (req, res) => {
  const { date, logement, nuits, prix, email } = req.body;
  if (!date || !logement || !nuits || !prix) return res.status(400).json({ error: 'Paramètres manquants' });

  try {
    let finalAmount = prix * 100;
    if (process.env.TEST_PAYMENT === "true") finalAmount = 100; // 1 €

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
      success_url: `${isLocal ? 'http://localhost:' + PORT : 'https://livablom.fr'}/confirmation.html?success=true`,
      cancel_url: `${isLocal ? 'http://localhost:' + PORT : 'https://livablom.fr'}/blom/`,
      metadata: { date, logement, nuits, email }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur Stripe Checkout :", err);
    res.status(500).json({ error: 'Erreur lors de la création de la session Stripe' });
  }
});

// ======= Serveur =======
app.listen(PORT, () => console.log(`🚀 Serveur lancé sur port ${PORT}`));
