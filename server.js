require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fetch = require('node-fetch');
const ical = require('ical');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Détecter si on est en local ou prod
const isLocal = process.env.NODE_ENV !== 'production';
const BASE_URL = isLocal ? `http://localhost:${PORT}` : 'https://livablom-stripe-production.up.railway.app';

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ======== iCal (optionnel, futur) ========
const calendars = {
  LIVA: [],
  BLOM: []
};

async function fetchICal(url, logement) {
  try {
    const res = await fetch(url);
    const data = await res.text();
    const parsed = ical.parseICS(data);
    return Object.values(parsed)
      .filter(ev => ev.start && ev.end)
      .map(ev => ({
        summary: ev.summary || "Réservé",
        start: ev.start,
        end: ev.end,
        logement
      }));
  } catch (err) {
    console.error("Erreur iCal pour", url, err);
    return [];
  }
}

// ======== Endpoint réservations JSON ========
app.get("/api/reservations/:logement", (req, res) => {
  const logement = req.params.logement.toUpperCase();
  const reservationsData = require("./reservations.json"); // ton fichier à la racine
  const reservations = reservationsData[logement] || [];
  res.json(reservations);
});

// ======== Stripe Checkout ========
app.post('/create-checkout-session', async (req, res) => {
  const { date, logement, nuits, prix, email } = req.body;

  if (!date || !logement || !nuits || !prix) {
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

// ======== Serveur ========
app.listen(PORT, () => {
  console.log(`Serveur lancé sur ${BASE_URL}`);
});
