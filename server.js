// server.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const ical = require("node-ical");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- PostgreSQL ---// server.js (CommonJS)

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

// --- Config BDD Postgres ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Middleware CORS ---
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// --- Middleware normal pour JSON ---
app.use(bodyParser.json());

// --- Middleware spécial pour Stripe Webhook (raw body obligatoire) ---
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body, // Buffer brut
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("⚠️ Erreur webhook signature:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // --- Événement checkout.session.completed ---
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
  }
);

// --- Endpoint pour récupérer les réservations d’un logement ---
app.get("/api/reservations/:logement", async (req, res) => {
  const { logement } = req.params;

  try {
    const result = await pool.query(
      "SELECT date_debut, date_fin FROM reservations WHERE logement = $1",
      [logement]
    );

    // Transformer en format utilisable par FullCalendar
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

// --- Démarrage ---
app.listen(port, () => {
  console.log(`🚀 Serveur lancé sur port ${port}`);
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Stripe Checkout ---
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
      m
