const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const stripeLib = require("stripe");

const { pool } = require("./db");
const { sendConfirmationEmail } = require("./email");
const { fetchICal } = require("./calendar");

// --- Variables ---
const NODE_ENV = process.env.NODE_ENV || "development";
const isTest = process.env.STRIPE_MODE === "test" || NODE_ENV === "development";
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest ? process.env.STRIPE_WEBHOOK_TEST_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
const frontendUrl = process.env.FRONTEND_URL || process.env.URL_FRONTEND || "http://localhost:4000";
const port = process.env.PORT || 3000;

const stripe = stripeLib(stripeKey);

// --- Google Calendar ---
const calendars = {
  LIVA: ["https://calendar.google.com/calendar/ical/.../basic.ics"],
  BLOM: ["https://calendar.google.com/calendar/ical/.../basic.ics"]
};

// --- Express ---
const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- Stripe Checkout ---
app.post("/api/checkout", async (req, res) => {
  try {
    const { logement, startDate, endDate, amount, personnes, name, email, phone } = req.body;
    const montantFinal = process.env.TEST_PAYMENT === "true" ? 1 : amount;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: `Réservation ${logement}` },
          unit_amount: Math.round(montantFinal * 100)
        },
        quantity: 1
      }],
      mode: "payment",
      success_url: `${frontendUrl}/${(logement || "blom").toLowerCase()}/merci`,
      cancel_url: `${frontendUrl}/${(logement || "blom").toLowerCase()}/annule`,
      metadata: { logement, date_debut: startDate, date_fin: endDate, personnes, name, email, phone }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// --- Webhook Stripe ---
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    try {
      await pool.query(
        "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
        [session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin]
      );

      const clientEmail = session.metadata.email || (session.customer_details && session.customer_details.email);
      const clientName = session.metadata.name || (session.customer_details && session.customer_details.name);

      await sendConfirmationEmail({
        name: clientName,
        email: clientEmail,
        logement: session.metadata.logement,
        startDate: session.metadata.date_debut,
        endDate: session.metadata.date_fin,
        personnes: session.metadata.personnes
      });
    } catch (err) {
      console.error("❌ Erreur webhook :", err);
    }
  }

  res.json({ received: true });
});

// --- Endpoint réservations ---
app.get("/api/reservations/:logement", async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  if (!calendars[logement]) return res.status(404).json({ error: "Logement inconnu" });

  try {
    let events = [];
    const result = await pool.query("SELECT date_debut, date_fin FROM reservations WHERE logement = $1", [logement]);
    events = result.rows.map(r => ({
      start: r.date_debut,
      end: r.date_fin,
      display: "background",
      color: "#ff0000",
      title: "Réservé (BDD)"
    }));

    for (const url of calendars[logement]) {
      const gEvents = await fetchICal(url, logement);
      events = events.concat(gEvents);
    }

    res.json(events);
  } catch (err) {
    console.error("❌ Erreur récupération:", err);
    res.status(500).json({ error: "Impossible de charger les réservations" });
  }
});

// --- Route test ---
app.get("/", (req, res) => res.send("🚀 API LIVABLŌM opérationnelle !"));

app.listen(port, () => {
  console.log(`✅ Serveur lancé sur port ${port} (${NODE_ENV}) | Stripe: ${isTest ? "TEST" : "PROD"}`);
});
