const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// ⚠️ Webhook avant tout middleware
const webhookRouter = require('./routes/webhook');
app.use('/webhook', webhookRouter);

// Middleware global
app.use(cors());
app.use(express.json());

// Stripe selon environnement
const Stripe = require('stripe');
const stripe = Stripe(process.env.NODE_ENV !== 'production' ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY);

// Endpoint pour créer session de paiement
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { amount, email, date } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: { name: `Réservation BLOM - ${date}` },
            unit_amount: amount * 100,
          },
          quantity: 1,
        },
      ],
      success_url: 'https://livablom.fr/confirmation.html?success=true',
      cancel_url: 'https://livablom.fr/confirmation.html?canceled=true',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur Stripe Checkout :", err);
    res.status(500).json({ error: 'Erreur lors de la réservation.' });
  }
});

// Servir fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
console.log(`🌍 Environnement : ${process.env.NODE_ENV}`);
console.log(`🚀 Serveur lancé sur port ${PORT}`);
app.listen(PORT);
