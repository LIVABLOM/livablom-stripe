// server.js – version corrigée (test/live + paiement symbolique + 3D Secure)

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

// ========================================================
// 🔧 CONFIGURATION GLOBALE
// ========================================================
const NODE_ENV = process.env.NODE_ENV || "development";

// Basculer automatiquement entre TEST et LIVE selon ta variable MODE_RAYURE
const isTestMode =
  (process.env.MODE_RAYURE || "").toUpperCase() === "TEST" ||
  process.env.STRIPE_MODE === "test" ||
  NODE_ENV === "development";

// Paiement symbolique à 1 € si TRUE
const isPaymentTest = (process.env.TEST_PAIEMENT || "").toUpperCase() === "TRUE";

// Clés Stripe selon le mode
const stripeKey = isTestMode
  ? process.env.CLÉ_TEST_STRAPPE || process.env.STRIPE_TEST_KEY
  : process.env.STRIPE_SECRET_KEY;

const stripeWebhookSecret = isTestMode
  ? process.env.STRIPE_WEBHOOK_TEST_SECRET
  : process.env.STRIPE_WEBHOOK_SECRET;

// URLs et port
const frontendUrl = process.env.URL_FRONTEND || process.env.FRONTEND_URL || "http://localhost:4000";
const port = process.env.PORT || 3000;

const stripe = stripeLib(stripeKey);

// ========================================================
// 🗄️ Connexion PostgreSQL
// ========================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.URL_BASE_DE_DONNÉES,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log("✅ Connecté à PostgreSQL"))
  .catch(err => console.error("❌ Erreur connexion BDD:", err));

// ========================================================
// 🗓️ Chargement des calendriers iCal Google
// ========================================================
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

// ========================================================
// 📧 Brevo (Sendinblue)
// ========================================================
const brevoApiKey = process.env.CLÉ_API_BREVO || process.env.BREVO_API_KEY;
const brevoSender = process.env.BREVO_SENDER || "contact@livablom.fr";
const brevoSenderName = process.env.BREVO_SENDER_NAME || "LIVABLŌM";
const brevoAdminTo = process.env.BREVO_TO || "livablom59@gmail.com";

if (brevoApiKey) {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications["api-key"].apiKey = brevoApiKey;
} else {
  console.warn("⚠️ Clé Brevo manquante — emails désactivés.");
}

// ========================================================
// 🧩 Fonctions utilitaires
// ========================================================
function normalizeLogement(str) {
  return String(str || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function slugify(str) {
  return String(str || "blom")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_]/g, "")
    .toLowerCase() || "blom";
}

// ========================================================
// ✉️ Envoi des emails de confirmation
// ========================================================
async function sendConfirmationEmail({ name, email, logement, startDate, endDate, personnes, phone }) {
  if (!brevoApiKey) return;
  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();
  const heureArrivee = normalizeLogement(logement) === "BLOM" ? "19h" : "16h";

  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email, name }],
      subject: `Confirmation de réservation - LIVABLŌM`,
      htmlContent: `
        <h2>Bonjour ${name || ""},</h2>
        <p>Merci pour votre réservation <b>${logement}</b>.</p>
        <p><b>Arrivée :</b> ${startDate} à partir de ${heureArrivee}</p>
        <p><b>Départ :</b> ${endDate} avant 11h</p>
        <a href="https://livablom.fr/contact">Nous contacter</a>
      `
    });
    console.log("✉️ Email client envoyé :", email);
  } catch (err) {
    console.error("❌ Erreur envoi email client:", err);
  }

  if (brevoAdminTo) {
    try {
      await tranEmailApi.sendTransacEmail({
        sender: { name: brevoSenderName, email: brevoSender },
        to: [{ email: brevoAdminTo }],
        subject: `Nouvelle réservation - ${logement}`,
        htmlContent: `
          <h3>Nouvelle réservation</h3>
          <p><b>Nom :</b> ${name}</p>
          <p><b>Email :</b> ${email}</p>
          <p><b>Téléphone :</b> ${phone}</p>
          <p><b>Dates :</b> ${startDate} → ${endDate}</p>
        `
      });
      console.log("✉️ Email admin envoyé à :", brevoAdminTo);
    } catch (err) {
      console.error("❌ Erreur email admin:", err);
    }
  }
}

// ========================================================
// 🚦 Initialisation Express
// ========================================================
const app = express();

// ========================================================
// ⚡ WEBHOOK STRIPE (doit être AVANT bodyParser.json())
// ========================================================
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    console.log(`✅ Webhook Stripe vérifié : ${event.type}`);
  } catch (err) {
    console.error("❌ Webhook de signature invalide :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("💰 Paiement confirmé par Stripe :", session.id);

    try {
      if (session.metadata?.logement && session.metadata?.date_debut && session.metadata?.date_fin) {
        await pool.query(
          "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
          [session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin]
        );
        console.log("✅ Réservation enregistrée :", session.metadata.logement, session.metadata.date_debut);
      }

      await sendConfirmationEmail({
        name: session.metadata?.name,
        email: session.metadata?.email,
        logement: session.metadata?.logement,
        startDate: session.metadata?.date_debut,
        endDate: session.metadata?.date_fin,
        personnes: session.metadata?.personnes,
        phone: session.metadata?.phone
      });

      console.log("✉️ Emails envoyés avec succès à :", session.metadata?.email);
    } catch (err) {
      console.error("❌ Erreur traitement webhook :", err);
    }
  }

  res.json({ received: true });
});

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// ========================================================
// 🧭 API Réservations (BDD + Google)
// ========================================================
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
    console.error("❌ Erreur récupération réservations:", err);
    res.status(500).json({ error: "Impossible de charger les réservations" });
  }
});

// ========================================================
// 💳 API Stripe Checkout
// ========================================================
app.post("/api/checkout", async (req, res) => {
  try {
    const { logement, startDate, endDate, amount, personnes, name, email, phone } = req.body;
    if (!logement || !startDate || !endDate || !amount || !email)
      return res.status(400).json({ error: "Champs manquants" });

    const montantFinal = isPaymentTest ? 1 : amount;
    const slug = slugify(logement);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      payment_method_options: { card: { request_three_d_secure: "any" } },
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: `Réservation ${logement}` },
          unit_amount: Math.round(montantFinal * 100)
        },
        quantity: 1
      }],
      mode: "payment",
      customer_email: email,
      success_url: `${frontendUrl}/${slug}/merci/`,
      cancel_url: `${frontendUrl}/${slug}/contact/`,
      metadata: { logement, date_debut: startDate, date_fin: endDate, personnes, name, email, phone }
    });

    console.log(`✅ Session Stripe ${isTestMode ? "TEST" : "LIVE"} créée :`, session.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe", message: err.message });
  }
});

// ========================================================
// 🌐 Route de test
// ========================================================
app.get("/", (req, res) =>
  res.send(`🚀 API LIVABLŌM opérationnelle ! Mode: ${isTestMode ? "TEST" : "LIVE"} | Paiement: ${isPaymentTest ? "1€" : "réel"}`)
);

// ========================================================
// 🚀 Lancement serveur
// ========================================================
app.listen(port, () => {
  console.log(`✅ Serveur lancé sur port ${port} (${NODE_ENV}) | Mode: ${isTestMode ? "TEST" : "LIVE"} | Paiement: ${isPaymentTest ? "1€" : "réel"}`);
});
