require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY); // clé Stripe dans .env
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Endpoint pour créer une session Checkout
app.post('/create-checkout-session', async (req, res) => {
  const { date, logement, nuits, prix } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `${logement} - ${nuits} nuit(s)`,
          },
          unit_amount: prix * 100, // Stripe en centimes
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin}/confirmation.html?success=true`,
      cancel_url: `${req.headers.origin}/blom.md`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur création session Stripe' });
  }
});

app.listen(PORT, () => console.log(`Stripe server running on port ${PORT}`));
