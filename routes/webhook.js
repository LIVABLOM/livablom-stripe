const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const stripe = Stripe(process.env.NODE_ENV !== 'production' ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.NODE_ENV !== 'production' ? process.env.STRIPE_WEBHOOK_TEST_SECRET : process.env.STRIPE_WEBHOOK_SECRET;

// Webhook reçoit body brut
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
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
    const description = session.display_items?.[0]?.custom?.name || 'Réservation';
    const date = description.split(' - ')[1] || 'date inconnue';
    const email = session.customer_email;

    console.log(`✅ Paiement réussi pour ${email}, date: ${date}`);

    // 🔒 Bloquer la date dans calendrier (JSON)
    const filePath = path.join(__dirname, '../calendar.json');
    let calendar = {};
    if (fs.existsSync(filePath)) {
      calendar = JSON.parse(fs.readFileSync(filePath));
    }
    calendar[date] = 'réservé';
    fs.writeFileSync(filePath, JSON.stringify(calendar, null, 2));

    // 📧 Envoyer mail confirmation
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Confirmation de réservation BLOM',
      text: `Bonjour,\n\nVotre réservation pour le ${date} a bien été enregistrée.\n\nMerci !`,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) console.error("Erreur envoi mail :", error);
      else console.log("Mail envoyé :", info.response);
    });
  }

  res.json({ received: true });
});

module.exports = router;
