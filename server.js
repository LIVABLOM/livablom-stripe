require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");

// --- Mode Stripe ---
const isTest = true; // force mode test
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest ? process.env.STRIPE_WEBHOOK_TEST_SECRET : process.env.STRIPE_WEBHOOK_SECRET;

const stripe = require("stripe")(stripeKey);
console.log(`🚀 Stripe mode: ${isTest ? "TEST (clé test)" : "PROD (clé live)"} `);
console.log(`🚀 Clé Stripe utilisée: ${stripeKey.substring(0, 10)}...`);

// --- Express ---
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(bodyParser.json());

// --- PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Endpoint pour créer session Stripe ---
app.post("/api/checkout", async (req, res) => {
  try {
    const { logement, startDate, endDate, amount } = req.body;

    console.log(`📅 Nouvelle réservation ${logement} du ${startDate} au ${endDate} pour ${amount} €`);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `Réservation ${logement}` },
            unit_amount: amount * 100,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/blom/merci`,
      cancel_url: `${process.env.FRONTEND_URL}/blom/annule`,
      metadata: { logement, date_debut: startDate, date_fin: endDate },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// --- Démarrage serveur ---
app.listen(port, () => {
  console.log(`🚀 Serveur lancé sur port ${port} en mode ${isTest ? "TEST" : "PROD"}`);
});
