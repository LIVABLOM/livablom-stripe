require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");

// --- Choix automatique des clés Stripe selon le mode ---
const isTest = process.env.STRIPE_MODE === "test";
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest ? process.env.STRIPE_WEBHOOK_TEST_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
const stripe = require("stripe")(stripeKey);

const app = express();
const port = process.env.PORT || 3000;

// --- PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Middleware ---
app.use(cors({ origin: process.env.FRONTEND_URL, methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(bodyParser.json());

// --- Webhook Stripe ---
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
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
    const logement = session.metadata.logement;
    const date_debut = session.metadata.date_debut;
    const date_fin = session.metadata.date_fin;

    try {
      await pool.query(
        "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
        [logement, date_debut, date_fin]
      );
      console.log("✅ Réservation ajoutée en BDD:", logement, date_debut, date_fin);
    } catch (dbErr) {
      console.error("❌ Erreur insertion BDD:", dbErr);
    }
  }

  res.json({ received: true });
});

// --- Endpoint récupérer réservations ---
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

// --- Endpoint Checkout Stripe ---
app.post("/api/checkout", async (req, res) => {
  try {
    let { logement, startDate, endDate, amount } = req.body;

    // Mode test : override montant avec 1 € si TEST_PAYMENT=true
    if (isTest && process.env.TEST_PAYMENT === "true") amount = 1;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `Réservation ${logement}` },
            unit_amount: amount * 100, // centimes
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/blom/?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/blom/?canceled=true`,
      metadata: {
        logement,
        date_debut: startDate,
        date_fin: endDate,
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// --- Démarrage serveur ---
app.listen(port, () => {
  console.log(`🚀 Serveur lancé sur port ${port} en mode ${isTest ? "TEST" : "PRODUCTION"}`);
});
