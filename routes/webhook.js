const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const stripe = Stripe(process.env.NODE_ENV !== 'production' ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.NODE_ENV !== 'production' ? process.env.STRIPE_WEBHOOK_TEST_SECRET : process.env.STRIPE_WEBHOOK_SECRET;

// ⚠️ express.raw() pour recevoir le body brut
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("⚠️ Erreur webhook :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Quand paiement réussi
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    console.log("✅ Paiement réussi pour :", session.customer_email);

    // TODO : Bloquer la date dans ton calendrier
    // Exemple : await blockDate(session.line_items[0].description);

    // TODO : Envoyer mail confirmation
    // Exemple nodemailer :
    // const transporter = nodemailer.createTransport({ ... });
    // await transporter.sendMail({ to: session.customer_email, subject: 'Confirmation', text: '...' });
  }

  res.json({ received: true });
});

module.exports = router;
