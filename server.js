require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 8080;

// ======== CORS ========
const allowedOrigins = ['https://livablom.fr', 'http://localhost:3000'];
app.use(cors({
  origin: function(origin, callback){
    if(!origin) return callback(null, true); // allow non-browser requests
    if(allowedOrigins.indexOf(origin) === -1){
      const msg = 'CORS policy : origine non autorisée';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET','POST','OPTIONS'],
  credentials: true,
}));

// ======== Middlewares ========
app.use(express.json());
app.use(express.static('public'));

// ======== Stripe ========
const isLocal = process.env.NODE_ENV !== 'production';
const stripeKey = isLocal ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripe = Stripe(stripeKey);
const webhookSecret = isLocal ? process.env.STRIPE_WEBHOOK_TEST_SECRET : process.env.STRIPE_WEBHOOK_SECRET;

console.log('🌍 Environnement :', process.env.NODE_ENV);
console.log('🔑 Clé Stripe utilisée :', stripeKey ? '✅ DEFINIE' : '❌ NON DEFINIE');

// ======== Création de session Stripe ========
app.post('/create-checkout-session', async (req, res) => {
  const { date, logement, nuits, prix, email } = req.body;
  if (!date || !logement || !nuits || !prix) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    let finalAmount = prix * 100;
    if (process.env.TEST_PAYMENT === "true") finalAmount = 100; // 1€

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
      success_url: `${req.protocol}://${req.get('host')}/confirmation.html?success=true`,
      cancel_url: `${req.protocol}://${req.get('host')}/blom/`,
      metadata: { date, logement, nuits, email }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erreur Stripe Checkout :', err.message);
    res.status(500).json({ error: 'Erreur lors de la création de la session Stripe' });
  }
});

// ======== Webhook Stripe ========
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('⚠️ Erreur webhook :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { date, logement, nuits, email } = session.metadata;

    console.log(`✅ Paiement confirmé pour ${logement} - ${nuits} nuit(s) - ${date}`);

    // --- Enregistrer réservation ---
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

    // --- Envoyer email ---
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

// ======== Lancer serveur ========
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur port ${PORT}`);
});
