// server.js — Version stable avec emails professionnels

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");
const stripeLib = require("stripe");
const ical = require("ical");
const fetch = require("node-fetch");
const SibApiV3Sdk = require("sib-api-v3-sdk");

// --- Variables ---
const NODE_ENV = process.env.NODE_ENV || "development";
const isTest = process.env.STRIPE_MODE === "test" || NODE_ENV === "development";
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest ? process.env.STRIPE_WEBHOOK_TEST_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:4000";
const port = process.env.PORT || 3000;

const stripe = stripeLib(stripeKey);

// --- PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log("✅ Connecté à PostgreSQL"))
  .catch(err => console.error("❌ Erreur connexion BDD:", err));

// --- Google Calendar ---
const calendars = {
  LIVA: ["https://calendar.google.com/calendar/ical/.../basic.ics"],
  BLOM: ["https://calendar.google.com/calendar/ical/.../basic.ics"]
};

async function fetchICal(url, logement) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const data = await res.text();
    const parsed = ical.parseICS(data);
    return Object.values(parsed)
      .filter(ev => ev.start && ev.end)
      .map(ev => ({
        title: ev.summary || "Réservé (Google)",
        start: ev.start,
        end: ev.end,
        logement,
        display: "background",
        color: "#ff0000"
      }));
  } catch (err) {
    console.error("❌ Erreur iCal pour", logement, url, err);
    return [];
  }
}

// --- Brevo ---
const brevoApiKey = process.env.BREVO_API_KEY;
const brevoSender = process.env.BREVO_SENDER || "contact@livablom.fr";
const brevoSenderName = process.env.BREVO_SENDER_NAME || "LIVABLŌM";
const brevoAdminTo = process.env.BREVO_TO || "livablom59@gmail.com";

if (brevoApiKey) {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications["api-key"].apiKey = brevoApiKey;
} else {
  console.warn("⚠️ Clé Brevo introuvable, emails non envoyés.");
}

// --- Envoi des emails (amélioré et visuel) ---
async function sendConfirmationEmail({ name, email, logement, startDate, endDate, personnes }) {
  if (!brevoApiKey) return;

  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

  const logementDisplay = logement === "BLOM" ? "BLŌM – Espace bien-être & spa" : "LIVA – Logement tout équipé";
  const formattedStart = new Date(startDate).toLocaleDateString("fr-FR");
  const formattedEnd = new Date(endDate).toLocaleDateString("fr-FR");

  const htmlTemplateClient = `
  <div style="font-family:Arial,sans-serif;color:#222;max-width:600px;margin:auto;background:#fff;padding:20px;border-radius:12px;box-shadow:0 0 10px rgba(0,0,0,0.1)">
    <div style="text-align:center;padding-bottom:10px;border-bottom:1px solid #eee;">
      <h2 style="color:#000;font-weight:700;margin:0;">Confirmation de votre réservation</h2>
      <p style="font-size:15px;color:#777;margin-top:4px;">Merci d’avoir choisi <strong>LIVABLŌM</strong></p>
    </div>
    <div style="padding:20px 10px;">
      <p>Bonjour ${name || ""},</p>
      <p>Nous vous confirmons votre réservation pour :</p>
      <ul style="line-height:1.6;">
        <li><strong>Logement :</strong> ${logementDisplay}</li>
        <li><strong>Date d’arrivée :</strong> ${formattedStart}</li>
        <li><strong>Date de départ :</strong> ${formattedEnd} (départ avant <strong>11h</strong>)</li>
        <li><strong>Nombre de personnes :</strong> ${personnes || "Non précisé"}</li>
      </ul>
      <p>Nous restons à votre disposition pour toute demande ou précision avant votre arrivée.</p>
      <p style="margin-top:20px;">À très bientôt,<br/><strong>L’équipe LIVABLŌM</strong></p>
    </div>
    <div style="text-align:center;border-top:1px solid #eee;padding-top:10px;font-size:12px;color:#777;">
      <p>LIVABLŌM – Hébergements & bien-être</p>
      <p><a href="https://livablom.fr" style="color:#000;text-decoration:none;">www.livablom.fr</a></p>
    </div>
  </div>
  `;

  const htmlTemplateAdmin = `
  <div style="font-family:Arial,sans-serif;color:#222;max-width:600px;margin:auto;background:#fff;padding:20px;border-radius:12px;box-shadow:0 0 10px rgba(0,0,0,0.1)">
    <h3 style="margin-top:0;">📩 Nouvelle réservation reçue</h3>
    <ul style="line-height:1.6;">
      <li><strong>Nom :</strong> ${name || ""}</li>
      <li><strong>Email :</strong> ${email}</li>
      <li><strong>Logement :</strong> ${logementDisplay}</li>
      <li><strong>Arrivée :</strong> ${formattedStart}</li>
      <li><strong>Départ :</strong> ${formattedEnd} (départ avant 11h)</li>
      <li><strong>Personnes :</strong> ${personnes || "Non précisé"}</li>
    </ul>
  </div>
  `;

  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email }],
      subject: `Confirmation de réservation - ${logementDisplay}`,
      htmlContent: htmlTemplateClient
    });
    console.log("✉️ Email client envoyé :", email);
  } catch (err) {
    console.error("❌ Erreur email client :", err);
  }

  if (brevoAdminTo) {
    try {
      await tranEmailApi.sendTransacEmail({
        sender: { name: brevoSenderName, email: brevoSender },
        to: [{ email: brevoAdminTo, name: "LIVABLŌM Admin" }],
        subject: `Nouvelle réservation - ${logementDisplay}`,
        htmlContent: htmlTemplateAdmin
      });
      console.log("✉️ Email admin envoyé à :", brevoAdminTo);
    } catch (err) {
      console.error("❌ Erreur email admin :", err);
    }
  }
}

// --- Express ---
const app = express();

// Webhook Stripe
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

app.use(cors());
app.use(bodyParser.json());

// --- Endpoint réservations (BDD + Google) ---
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

// --- Route test ---
app.get("/", (req, res) => res.send("🚀 API LIVABLŌM opérationnelle !"));

app.listen(port, () => {
  console.log(`✅ Serveur lancé sur port ${port} (${NODE_ENV}) | Stripe: ${isTest ? "TEST" : "PROD"}`);
});
