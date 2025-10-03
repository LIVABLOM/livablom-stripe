// === Charger .env ===
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");
const stripeLib = require("stripe");
const fetch = require("node-fetch");
const ical = require("ical");

// --- Variables ---
const NODE_ENV = process.env.NODE_ENV || "development";
const isTest = process.env.STRIPE_MODE === "test" || NODE_ENV === "development";
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest
  ? process.env.STRIPE_WEBHOOK_TEST_SECRET
  : process.env.STRIPE_WEBHOOK_SECRET;
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:4000";
const port = process.env.PORT || 3000;

const stripe = stripeLib(stripeKey);

console.log(`🚀 Node env: ${NODE_ENV}`);
console.log(`🚀 Stripe mode: ${isTest ? "TEST" : "PROD"}`);
console.log(`🚀 Clé Stripe utilisée: ${stripeKey.substring(0, 10)}...`);
console.log(`🔹 DATABASE_URL utilisée : ${process.env.DATABASE_URL}`);

// --- PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log("✅ Connecté à PostgreSQL"))
  .catch(err => console.error("❌ Erreur connexion BDD:", err));

// --- URLs iCal ---
const calendars = {
  LIVA: [
    "https://calendar.google.com/calendar/ical/25b3ab9fef930d1760a10e762624b8f604389bdbf69d0ad23c98759fee1b1c89%40group.calendar.google.com/private-13c805a19f362002359c4036bf5234d6/basic.ics",
    "https://www.airbnb.fr/calendar/ical/41095534.ics?s=723d983690200ff422703dc7306303de",
    "https://ical.booking.com/v1/export?t=30a4b8a1-39a3-4dae-9021-0115bdd5e49d"
  ],
  BLOM: [
    "https://calendar.google.com/calendar/ical/c686866e780e72a89dd094dedc492475386f2e6ee8e22b5a63efe7669d52621b%40group.calendar.google.com/private-a78ad751bafd3b6f19cf5874453e6640/basic.ics",
    "https://www.airbnb.fr/calendar/ical/985569147645507170.ics?s=b9199a1a132a6156fcce597fe4786c1e",
    "https://ical.booking.com/v1/export?t=8b652fed-8787-4a0c-974c-eb139f83b20f"
  ]
};

// --- Fonction fetch iCal avec logs détaillés ---
async function fetchICal(url, logement) {
  console.log(`🔹 Tentative fetch iCal pour ${logement}: ${url}`);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
        "Accept": "text/calendar, text/plain, */*"
      }
    });

    console.log(`➡ HTTP ${res.status} pour ${url}`);

    if (!res.ok) {
      console.error(`❌ Erreur fetch iCal ${url}: HTTP ${res.status}`);
      return [];
    }

    const data = await res.text();
    const parsed = ical.parseICS(data);
    const events = Object.values(parsed)
      .filter(ev => ev.start && ev.end)
      .map(ev => ({
        title: ev.summary || "Réservé (iCal)",
        start: ev.start,
        end: ev.end,
        logement,
        display: "background",
        color: "#ff0000"
      }));

    console.log(`✅ ${events.length} événements récupérés depuis ${url}`);
    return events;
  } catch (err) {
    console.error(`❌ Erreur iCal pour ${logement} depuis ${url}:`, err);
    return [];
  }
}

// --- Express ---
const app = express();

// ⚠️ Webhook Stripe (avant bodyParser.json)
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
        console.log(`📝 Réservation ajoutée : ${session.metadata.logement} (${session.metadata.date_debut} → ${session.metadata.date_fin})`);
      } catch (dbErr) {
        console.error("❌ Erreur insertion BDD:", dbErr);
      }
    }

    res.json({ received: true });
  }
);

// --- Middlewares ---
app.use(cors());
app.use(bodyParser.json());

// --- Endpoint BDD + iCal pour un logement ---
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
      display: "background",
      color: "#ff0000",
      title: "Réservé (BDD)"
    }));

    // iCal
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
      // BDD
      const result = await pool.query(
        "SELECT date_debut, date_fin FROM reservations WHERE logement = $1",
        [logement]
      );
      const bddEvents = result.rows.map(r => ({
        start: r.date_debut,
        end: r.date_fin,
        display: "background",
        color: "#ff0000",
        title: "Réservé (BDD)"
      }));
      events = events.concat(bddEvents);

      // iCal
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
            unit_amount: montantFinal * 100
          },
          quantity: 1
        }
      ],
      mode: "payment",
      success_url: `${frontendUrl}/blom/merci`,
      cancel_url: `${frontendUrl}/blom/annule`,
      metadata: { logement, date_debut: startDate, date_fin: endDate }
    });

    console.log(`📅 Création session: ${logement} du ${startDate} au ${endDate} pour ${montantFinal} €`);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// --- Route test ---
app.get("/", (req, res) => res.send("🚀 API LIVABLŌM opérationnelle !"));

// --- Démarrage serveur ---
app.listen(port, () => {
  console.log(`✅ Serveur lancé sur port ${port} en ${NODE_ENV} | Stripe: ${isTest ? "TEST" : "PROD"}`);
});
