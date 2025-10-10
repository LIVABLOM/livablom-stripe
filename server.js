// server.js – version complète corrigée et finalisée

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");
const stripeLib = require("stripe");
const ical = require("ical");
const fetch = require("node-fetch");
const SibApiV3Sdk = require('sib-api-v3-sdk');

// --- Variables ---
const NODE_ENV = process.env.NODE_ENV || "development";
const isTest = process.env.STRIPE_MODE === "test" || NODE_ENV === "development";
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest ? process.env.STRIPE_WEBHOOK_TEST_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
const frontendUrl = process.env.FRONTEND_URL || process.env.URL_FRONTEND || "http://localhost:4000";
const port = process.env.PORT || 3000;

const stripe = stripeLib(stripeKey);

// --- Postgres ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.URL_BASE_DE_DONNÉES,
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
const brevoApiKey = process.env.CLÉ_API_BREVO || process.env.BREVO_API_KEY;
const brevoSender = process.env.BREVO_SENDER || "contact@livablom.fr";
const brevoSenderName = process.env.BREVO_SENDER_NAME || "LIVABLŌM";
const brevoAdminTo = process.env.BREVO_TO || "livablom59@gmail.com";

if (!brevoApiKey) {
  console.warn("⚠️ Clé Brevo introuvable, emails non envoyés.");
} else {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications['api-key'].apiKey = brevoApiKey;
}

async function sendConfirmationEmail({ name, email, logement, startDate, endDate, personnes }) {
  if (!brevoApiKey) return;

  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

  // --- Email client ---
  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email: email, name: name || "" }],
      subject: `Confirmation de réservation - LIVABLŌM`,
      htmlContent: `
        <div style="font-family: 'Arial', sans-serif; color: #333; background-color: #f9f9f9; padding: 20px;">
          <div style="max-width: 600px; margin: auto; background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.05);">
            <h2 style="color: #2E86C1;">Bonjour ${name || ""},</h2>
            <p>Merci pour votre réservation sur <strong>LIVABLŌM</strong>.</p>

            <table style="width:100%; border-collapse: collapse; margin: 20px 0;">
              <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Logement :</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${logement}</td>
              </tr>
              <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Date d'arrivée :</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${startDate}</td>
              </tr>
              <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Date de départ :</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${endDate} (départ avant 11h)</td>
              </tr>
              <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Nombre de personnes :</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${personnes || ""}</td>
              </tr>
            </table>

            <p style="margin-top: 20px;">Nous vous remercions de votre confiance et vous souhaitons un excellent séjour !</p>

            <p style="margin-top: 30px; font-size: 0.9em; color: #666;">
              Cordialement,<br/>
              L’équipe <strong>LIVABLŌM</strong>
            </p>
          </div>
        </div>
      `
    });
    console.log("✉️ Email client envoyé :", email);
  } catch (err) {
    console.error("❌ Erreur email client :", err);
  }

  // --- Email admin ---
  if (brevoAdminTo) {
    try {
      await tranEmailApi.sendTransacEmail({
        sender: { name: brevoSenderName, email: brevoSender },
        to: [{ email: brevoAdminTo, name: "LIVABLŌM Admin" }],
        subject: `Nouvelle réservation - ${logement}`,
        htmlContent: `
          <div style="font-family:Arial, sans-serif; color:#222;">
            <h3>Nouvelle réservation</h3>
            <p><strong>Nom :</strong> ${name || ""}</p>
            <p><strong>Email :</strong> ${email || ""}</p>
            <p><strong>Logement réservé :</strong> ${logement}</p>
            <p><strong>Dates :</strong> ${startDate} au ${endDate} (départ avant 11h)</p>
            <p><strong>Nombre de personnes :</strong> ${personnes || ""}</p>
          </div>
        `
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
      // BDD
      await pool.query(
        "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
        [session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin]
      );

      // Envoi emails
      const clientEmail = session.metadata.email;
      const clientName = session.metadata.name;

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
      customer_email: email, // pré-remplit automatiquement le mail sur Stripe
      success_url: `${frontendUrl}/${(logement || "blom").toLowerCase()}/merci`,
      cancel_url: `${frontendUrl}/${(logement || "blom").toLowerCase()}/annule`,
      metadata: { logement, date_debut: startDate, date_fin: endDate, personnes, name, email, phone }
    });

    res.json({ url: session.url });
    console.log("✅ Session Stripe créée :", session.id);
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
