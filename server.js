// === Charger .env en priorité ===
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");
const stripeLib = require("stripe");
const fetch = require("node-fetch");
const ical = require("ical");

// --- Forcer le mode test local ---
const NODE_ENV = process.env.NODE_ENV || "development";
let STRIPE_MODE = process.env.STRIPE_MODE || "test";
if (NODE_ENV === "development") STRIPE_MODE = "test";

const isTest = STRIPE_MODE === "test";
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest
  ? process.env.STRIPE_WEBHOOK_TEST_SECRET
  : process.env.STRIPE_WEBHOOK_SECRET;

const stripe = stripeLib(stripeKey);

console.log(`🚀 Node env: ${NODE_ENV}`);
console.log(`🚀 Stripe mode: ${isTest ? "TEST" : "PROD"}`);
console.log(`🚀 Clé Stripe utilisée: ${stripeKey.substring(0, 10)}...`);
console.log(`🔹 DATABASE_URL utilisée : ${process.env.DATABASE_URL}`);

// --- Express ---
const app = express();
const port = process.env.PORT || 3000;

// --- PostgreSQL local sans SSL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, // <--- IMPORTANT pour local
});

// Test connexion
pool.connect()
  .then(client => {
    console.log("✅ Connexion PostgreSQL OK !");
    return client.query("SELECT current_database(), current_schema()")
      .then(res => {
        console.log("📊 Base et schéma courant :", res.rows);
        client.release();
      });
  })
  .catch(err => console.error("❌ Erreur connexion PostgreSQL :", err));

// --- iCal URLs ---
const calendars = {
  LIVA: [ /* ... tes URLs ... */ ],
  BLOM: [ /* ... tes URLs ... */ ]
};

// --- Fonction fetch iCal ---
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
        logement,
      }));
  } catch (err) {
    console.error("Erreur iCal pour", url, err);
    return [];
  }
}

// --- Webhook Stripe doit être avant bodyParser.json() ---
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
});

// --- Middleware global après webhook ---
app.use(cors());
app.use(bodyParser.json());

// --- Endpoint BDD + iCal pour un logement ---
app.get("/api/reservations/:logement", async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  if (!calendars[logement]) return res.status(404).json({ error: "Logement inconnu" });

  try {
    const result = await pool.query(
      "SELECT date_debut, date_fin FROM reservations WHERE logement = $1",
      [logement]
    );
    let events = result.rows.map(r => ({
      start: r.date_debut,
      end: r.date_fin,
      display: "background",
      color: "#ff0000",
      title: "Réservé (BDD)",
    }));

    for (const url of calendars[logement]) {
      const icalEvents = await fetchICal(url, logement);
      events = events.concat(icalEvents);
    }

    res.json(events);
  } catch (err) {
    console.error("❌ Erreur récupération fusionnée:", err);
    res.status(500).json({ error: "Impossible de charger les réservations" });
  }
});

// --- Endpoint global fusionné ---
app.get("/api/reservations", async (req, res) => {
  try {
    let events = [];
    for (const logement of Object.keys(calendars)) {
      const result = await pool.query(
        "SELECT date_debut, date_fin FROM reservations WHERE logement = $1",
        [logement]
      );
      const bddEvents = result.rows.map(r => ({
        start: r.date_debut,
        end: r.date_fin,
        display: "background",
        color: "#ff0000",
        title: "Réservé (BDD)",
      }));
      events = events.concat(bddEvents);

      for (const url of calendars[logement]) {
        const icalEvents = await fetchICal(url, logement);
        events = events.concat(icalEvents);
      }
    }
    res.json(events);
  } catch (err) {
    console.error("❌ Erreur récupération fusionnée:", err);
    res.status(500).json({ error: "Impossible de charger les réservations" });
  }
});

// --- Endpoint Stripe Checkout ---
app.post("/api/checkout", async (req, res) => {
  try {
    const { logement, startDate, endDate, amount } = req.body;
    const montantFinal = process.env.TEST_PAYMENT === "true" ? 1 : amount;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `Réservation ${logement}` },
            unit_amount: montantFinal * 100,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/blom/merci`,
      cancel_url: `${process.env.FRONTEND_URL}/blom/annule`,
      metadata: { logement, date_debut: startDate, date_fin: endDate },
    });

    console.log(`📅 Création session: ${logement} du ${startDate} au ${endDate} pour ${montantFinal} €`);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// --- Démarrage serveur ---
app.listen(port, () => {
  console.log(`🚀 Serveur lancé sur port ${port} en ${NODE_ENV} | Stripe: ${isTest ? "TEST" : "PROD"} | TEST_PAYMENT=${process.env.TEST_PAYMENT}`);
}); test  
