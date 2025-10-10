// server.js — LIVABLŌM (paiement Stripe + email + réservation)

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

// --- Variables d'environnement ---
const NODE_ENV = process.env.NODE_ENV || "development";
const isTest = process.env.STRIPE_MODE === "test" || NODE_ENV === "development";
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest ? process.env.STRIPE_WEBHOOK_TEST_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:4000";
const port = process.env.PORT || 3000;

const stripe = stripeLib(stripeKey);

// --- Base de données PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log("✅ Connecté à PostgreSQL"))
  .catch(err => console.error("❌ Erreur connexion BDD:", err));

// --- Calendriers Google (exemples) ---
const calendars = {
  LIVA: ["https://calendar.google.com/calendar/ical/.../basic.ics"],
  BLOM: ["https://calendar.google.com/calendar/ical/.../basic.ics"],
};

// --- Lecture iCal ---
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
        color: "#ff0000",
      }));
  } catch (err) {
    console.error("❌ Erreur iCal:", err);
    return [];
  }
}

// --- Configuration Brevo ---
const brevoApiKey = process.env.CLÉ_API_BREVO || process.env.BREVO_API_KEY;
const brevoSender = process.env.BREVO_SENDER || "contact@livablom.fr";
const brevoSenderName = process.env.BREVO_SENDER_NAME || "LIVABLŌM";
const brevoAdminTo = process.env.BREVO_TO || "livablom59@gmail.com";

if (brevoApiKey) {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications["api-key"].apiKey = brevoApiKey;
} else {
  console.warn("⚠️ Clé Brevo absente — les e-mails ne seront pas envoyés.");
}

// --- Fonction d'envoi d'email (client + admin) ---
async function sendConfirmationEmail({ name, email, logement, startDate, endDate, personnes }) {
  if (!brevoApiKey) return;
  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

  // --- Email client (visuel spa / beige / logo lotus) ---
  const htmlClient = `
  <div style="font-family: 'Helvetica Neue', Arial, sans-serif; background-color:#faf8f5; color:#333; padding:25px;">
    <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 10px rgba(0,0,0,0.05);">
      <div style="background-color:#f1e9df;padding:20px;text-align:center;">
        <img src="https://livablom.fr/assets/img/lotus.jpg" alt="LIVABLŌM" style="height:60px;margin-bottom:10px;">
        <h1 style="color:#7b5e3b;letter-spacing:2px;margin:0;">LIVABLŌM</h1>
        <p style="color:#a78c6f;margin:0;">Spa · Détente · Petit-déjeuner offert</p>
      </div>
      <div style="padding:30px;">
        <h2 style="color:#7b5e3b;">Bonjour ${name || ""},</h2>
        <p>Nous vous remercions chaleureusement pour votre réservation chez <strong>LIVABLŌM</strong> 🌸</p>
        <p>Voici les détails de votre séjour :</p>

        <div style="background-color:#f9f6f2;border-left:4px solid #c5a47e;padding:15px 20px;margin:20px 0;border-radius:6px;">
          <p><strong>🏡 Logement :</strong> ${logement}</p>
          <p><strong>📅 Dates :</strong> du ${startDate} au ${endDate}</p>
          <p><strong>👥 Nombre de personnes :</strong> ${personnes || "non précisé"}</p>
        </div>

        <p>Nous vous accueillerons avec plaisir dans une ambiance apaisante et raffinée.</p>
        <p>En attendant votre arrivée, n’hésitez pas à consulter nos prestations bien-être sur le site.</p>

        <div style="text-align:center;margin-top:25px;">
          <a href="https://livablom.fr" style="background-color:#7b5e3b;color:#fff;padding:12px 25px;border-radius:30px;text-decoration:none;font-weight:bold;">Découvrir LIVABLŌM</a>
        </div>

        <p style="margin-top:35px;color:#555;">À très bientôt 🌿<br><strong>L’équipe LIVABLŌM</strong></p>
      </div>
      <div style="background-color:#f1e9df;color:#7b5e3b;text-align:center;padding:12px;font-size:12px;">
        © 2025 LIVABLŌM · Guesnain, Hauts-de-France
      </div>
    </div>
  </div>`;

  // --- Email admin ---
  const htmlAdmin = `
  <div style="font-family: Arial, sans-serif; color: #333; background-color: #fafafa; padding: 20px;">
    <div style="max-width: 600px; margin: auto; background: #fff; border-radius: 8px; padding: 25px; box-shadow: 0 2px 6px rgba(0,0,0,0.1);">
      <h2>Nouvelle réservation – ${logement}</h2>
      <p><strong>Nom :</strong> ${name || ""}</p>
      <p><strong>Email :</strong> ${email || ""}</p>
      <p><strong>Logement :</strong> ${logement}</p>
      <p><strong>Dates :</strong> ${startDate} au ${endDate}</p>
      <p><strong>Personnes :</strong> ${personnes || ""}</p>
      <hr>
      <p style="font-size: 12px; color: #777;">Email automatique envoyé par le serveur LIVABLŌM</p>
    </div>
  </div>`;

  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email: email }],
      subject: `Votre réservation ${logement} est confirmée ✨`,
      htmlContent: htmlClient,
    });
    console.log("✉️ Email client envoyé :", email);
  } catch (err) {
    console.error("❌ Erreur email client :", err);
  }

  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email: brevoAdminTo }],
      subject: `Nouvelle réservation – ${logement}`,
      htmlContent: htmlAdmin,
    });
    console.log("✉️ Email admin envoyé à :", brevoAdminTo);
  } catch (err) {
    console.error("❌ Erreur email admin :", err);
  }
}

// --- Initialisation Express ---
const app = express();

// Webhook Stripe
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      await pool.query(
        "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
        [session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin]
      );

      await sendConfirmationEmail({
        name: session.metadata.name,
        email: session.metadata.email,
        logement: session.metadata.logement,
        startDate: session.metadata.date_debut,
        endDate: session.metadata.date_fin,
        personnes: session.metadata.personnes,
      });
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Erreur webhook Stripe:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.use(cors());
app.use(bodyParser.json());

// --- Récupération des réservations (BDD + Google) ---
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
      title: "Réservé (BDD)",
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

// --- Paiement Stripe Checkout ---
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
          unit_amount: Math.round(montantFinal * 100),
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: `${frontendUrl}/${(logement || "blom").toLowerCase()}/merci`,
      cancel_url: `${frontendUrl}/${(logement || "blom").toLowerCase()}/annule`,
      metadata: { logement, date_debut: startDate, date_fin: endDate, personnes, name, email, phone },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// --- Test route ---
app.get("/", (req, res) => res.send("🚀 API LIVABLŌM opérationnelle (emails version Spa) !"));

app.listen(port, () => {
  console.log(`✅ Serveur lancé sur port ${port} (${NODE_ENV}) | Mode: ${isTest ? "TEST" : "PROD"}`);
});
