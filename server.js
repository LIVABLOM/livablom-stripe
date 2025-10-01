require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");

// --- Mode Stripe (test ou prod) ---
const isTest = process.env.STRIPE_MODE === "test";
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest
  ? process.env.STRIPE_WEBHOOK_TEST_SECRET
  : process.env.STRIPE_WEBHOOK_SECRET;

const stripe = require("stripe")(stripeKey);

console.log(`🚀 Stripe mode: ${isTest ? "TEST (clé test)" : "PROD (clé live)"}`);
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

// --- Endpoint Checkout ---
app.post("/api/checkout", async (req, res) => {
  try {
    const { logement, startDate, endDate, amount } = req.body;

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

    console.log(`📅 Création session: ${logement} du ${startDate} au ${endDate} pour ${amount} €`);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// --- Endpoint Webhook Stripe ---
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      console.error("⚠️ Erreur webhook signature:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      try {
        await pool.query(
          "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
          [session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin]
        );
        console.log(`✅ Réservation ajoutée en BDD: ${session.metadata.logement} du ${session.metadata.date_debut} au ${session.metadata.date_fin}`);
      } catch (dbErr) {
        console.error("❌ Erreur insertion BDD:", dbErr);
      }
    }

    res.json({ received: true });
  }
);

// --- Endpoint pour récupérer les réservations ---
app.get("/api/reservations/:logement", async (req, res) => {
  const { logement } = req.params;
  try {
    const result = await pool.query(
      "SELECT date_debut, date_fin FROM reservations WHERE logement = $1",
      [logement]
    );
    const events = result.rows.map((r) => ({
      start: r.date_debut,
      end: r.date_fin,
      display: "background",
      color: "#ff0000",
      title: "Réservé",
    }));
    res.json(events);
  } catch (err) {
    console.error("❌ Erreur récupération réservations:", err);
    res.status(500).json({ error: "Impossible de charger les réservations" });
  }
});

// --- Démarrage serveur ---
app.listen(port, () => {
  console.log(`🚀 Serveur lancé sur port ${port} en mode ${isTest ? "TEST" : "PROD"}`);
});
