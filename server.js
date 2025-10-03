// === Dépendances ===
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const stripeLib = require("stripe");
const fetch = require("node-fetch");
const ical = require("ical");

// Charger .env
dotenv.config();

// === Variables ===
const port = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "production";
const STRIPE_MODE = process.env.STRIPE_MODE || "live";

const stripeKey =
  STRIPE_MODE === "test" ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret =
  STRIPE_MODE === "test"
    ? process.env.STRIPE_WEBHOOK_TEST_SECRET
    : process.env.STRIPE_WEBHOOK_SECRET;

const frontendUrl = process.env.FRONTEND_URL || "http://localhost:4000";
const stripe = stripeLib(stripeKey);

// Logs au démarrage
console.log("🚀 Node env:", NODE_ENV);
console.log("🚀 Stripe mode:", STRIPE_MODE.toUpperCase());
console.log("🚀 Clé Stripe utilisée:", stripeKey ? stripeKey.substring(0, 10) + "..." : "⚠️ Aucune");

// === PostgreSQL (Railway : SSL obligatoire) ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log("✅ Connecté à PostgreSQL"))
  .catch(err => console.error("❌ Erreur connexion BDD:", err));

// === Express ===
const app = express();

// ⚠️ Webhook Stripe : doit être AVANT le middleware JSON
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
      console.log(`✅ Webhook reçu : ${event.type}`);
    } catch (err) {
      console.error("❌ Erreur signature webhook:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      try {
        await pool.query(
          "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
          [session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin]
        );
        console.log(
          `📝 Réservation ajoutée : ${session.metadata.logement} (${session.metadata.date_debut} → ${session.metadata.date_fin})`
        );
      } catch (dbErr) {
        console.error("❌ Erreur insertion BDD:", dbErr);
      }
    }

    res.json({ received: true });
  }
);

// === Middlewares globaux (après webhook) ===
app.use(cors());
app.use(bodyParser.json());

// === iCal (Airbnb / Booking) ===
const calendars = {
  LIVA: [
    // "https://airbnb.com/calendar.ics?...",
    // "https://booking.com/calendar.ics?..."
  ],
  BLOM: [
    // idem pour Blom
  ]
};

async function fetchICal(url, logement) {
  try {
    const res = await fetch(url);
    const data = await res.text();
    const parsed = ical.parseICS(data);

    return Object.values(parsed)
      .filter(ev => ev.start && ev.end)
      .map(ev => ({
        title: ev.summary || "Réservé (iCal)",
        start: ev.start,
        end: ev.end,
        logement,
        display: "background",
        color: "#ff0000",
      }));
  } catch (err) {
    console.error("❌ Erreur iCal pour", logement, url, err);
    return [];
  }
}

// === Endpoints réservation ===

// Reservations d’un logement
app.get("/api/reservations/:logement", async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  if (!calendars[logement]) return res.status(404).json({ error: "Logement inconnu" });

  try {
    // BDD
    const result = await pool.query(
      "SELECT date_debut, date_fin FROM reservations WHERE logement = $1",
      [logement]
    );
    let events = result.rows.map(r => ({
      start: r.date_debut,
      end: r.date_fin,
      title: "Réservé (BDD)",
      display: "background",
      color: "#ff0000",
    }));

    // iCal
    for (const url of calendars[logement]) {
      const icalEvents = await fetchICal(url, logement);
      events = events.concat(icalEvents);
    }

    res.json(events);
  } catch (err) {
    console.error("❌ Erreur récupération réservations:", err);
    res.status(500).json({ error: "Impossible de charger les réservations" });
  }
});

// Toutes réservations fusionnées
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
        title: "Réservé (BDD)",
        display: "background",
        color: "#ff0000",
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

// === Stripe Checkout ===
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
      success_url: `${frontendUrl}/merci`,
      cancel_url: `${frontendUrl}/annule`,
      metadata: { logement, date_debut: startDate, date_fin: endDate },
    });

    console.log(`📅 Session Stripe: ${logement} ${startDate}→${endDate} (${montantFinal}€)`);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// === Route test ===
app.get("/", (req, res) => {
  res.send("🚀 API LIVABLŌM opérationnelle !");
});

// === Démarrage serveur ===
app.listen(port, () => {
  console.log(`✅ Serveur lancé sur port ${port} | ENV=${NODE_ENV} | Stripe=${STRIPE_MODE}`);
});
