// server.js
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");
const stripeLib = require("stripe");
const ical = require("ical");
const fetch = require("node-fetch");

// --- Brevo (Sendinblue) ---
const SibApiV3Sdk = require('sib-api-v3-sdk');

// --- Variables ---
const NODE_ENV = process.env.NODE_ENV || "development";
const isTest = process.env.STRIPE_MODE === "test" || NODE_ENV === "development";

// Stripe keys (test / prod)
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest
  ? process.env.STRIPE_WEBHOOK_TEST_SECRET
  : process.env.STRIPE_WEBHOOK_SECRET;

// Frontend URL (fallbacks)
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

// --- Google Calendar seulement ---
const calendars = {
  LIVA: [
    "https://calendar.google.com/calendar/ical/25b3ab9fef930d1760a10e762624b8f604389bdbf69d0ad23c98759fee1b1c89%40group.calendar.google.com/private-13c805a19f362002359c4036bf5234d6/basic.ics",
  ],
  BLOM: [
    "https://calendar.google.com/calendar/ical/c686866e780e72a89dd094dedc492475386f2e6ee8e22b5a63efe7669d52621b%40group.calendar.google.com/private-a78ad751bafd3b6f19cf5874453e6640/basic.ics",
  ]
};

// --- Fonction fetch iCal Google ---
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

// --- Brevo init ---
// Support multiple env var names to be robust
const brevoApiKey = process.env.BREVO_API_KEY || process.env.CLE_API_BREVO || process.env['CLÉ_API_BREVO'] || process.env.CLÉ_API_BREVO || process.env.CLÉ_API_BREVO;
const brevoSender = process.env.BREVO_SENDER || process.env.BREVO_FROM || process.env.BREVO_FROM_EMAIL || "contact@livablom.fr";
const brevoSenderName = process.env.BREVO_SENDER_NAME || process.env.BREVO_SENDER || "LIVABLOM";
const brevoAdminTo = process.env.BREVO_TO || process.env.ADMIN_EMAIL || process.env.BREVO_ADMIN || "";

if (!brevoApiKey) {
  console.warn("⚠️ Clé Brevo introuvable dans les variables d'environnement. Les emails ne seront pas envoyés.");
} else {
  const client = SibApiV3Sdk.ApiClient.instance;
  const apiKeyAuth = client.authentications['api-key'];
  apiKeyAuth.apiKey = brevoApiKey;
}

// Fonction d'envoi d'emails via Brevo
async function sendConfirmationEmail({ name, email, logement, startDate, endDate, personnes }) {
  if (!brevoApiKey) {
    console.warn("Brevo API key non configurée — email non envoyé.");
    return;
  }

  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

  // Email au client
  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email: email, name: name || "" }],
      subject: `Confirmation de réservation ${logement} - LIVABLŌM`,
      htmlContent: `
        <div style="font-family:Arial, sans-serif; color:#222;">
          <h3>Bonjour ${name || ""},</h3>
          <p>Merci pour votre réservation sur <strong>LIVABLŌM</strong>.</p>
          <p><strong>Logement :</strong> ${logement}</p>
          <p><strong>Dates :</strong> ${startDate} au ${endDate}</p>
          <p><strong>Nombre de personnes :</strong> ${personnes || ""}</p>
          <p>Nous avons hâte de vous accueillir.</p>
          <p>Cordialement,<br/>L’équipe LIVABLŌM</p>
        </div>
      `
    });
    console.log("✉️ Email de confirmation envoyé au client :", email);
  } catch (err) {
    console.error("❌ Erreur envoi email client via Brevo :", err);
  }

  // Email admin (copie)
  if (brevoAdminTo) {
    try {
      await tranEmailApi.sendTransacEmail({
        sender: { name: brevoSenderName, email: brevoSender },
        to: [{ email: brevoAdminTo, name: 'LIVABLŌM Admin' }],
        subject: `Nouvelle réservation confirmée - ${logement}`,
        htmlContent: `
          <div style="font-family:Arial, sans-serif; color:#222;">
            <h3>Nouvelle réservation confirmée</h3>
            <p><strong>Nom :</strong> ${name || ""}</p>
            <p><strong>Email client :</strong> ${email || ""}</p>
            <p><strong>Logement :</strong> ${logement}</p>
            <p><strong>Dates :</strong> ${startDate} au ${endDate}</p>
            <p><strong>Nombre de personnes :</strong> ${personnes || ""}</p>
          </div>
        `
      });
      console.log("✉️ Email admin envoyé à :", brevoAdminTo);
    } catch (err) {
      console.error("❌ Erreur envoi email admin via Brevo :", err);
    }
  } else {
    console.warn("⚠️ BREVO_TO (admin) non configuré — pas d'email admin envoyé.");
  }
}

// --- Express ---
const app = express();

// Webhook Stripe (doit rester bodyParser.raw pour vérifier la signature)
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Traitement des événements
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      try {
        // Insertion BDD (dates telles que stockées en metadata)
        await pool.query(
          "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
          [session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin]
        );

        // Envoi emails (utilise metadata si dispo, sinon fallback)
        const clientEmail = session.metadata.email || (session.customer_details && session.customer_details.email) || null;
        const clientName = session.metadata.name || (session.customer_details && session.customer_details.name) || null;

        await sendConfirmationEmail({
          name: clientName,
          email: clientEmail,
          logement: session.metadata.logement,
          startDate: session.metadata.date_debut,
          endDate: session.metadata.date_fin,
          personnes: session.metadata.personnes
        });
      } catch (dbErr) {
        console.error("❌ Erreur insertion BDD ou envoi email dans webhook:", dbErr);
      }
    }

    // Toujours répondre 200 à Stripe (on a traité l'événement)
    res.json({ received: true });
  }
);

app.use(cors());
app.use(bodyParser.json());

// --- Endpoint réservation par logement (BDD + Google) ---
app.get("/api/reservations/:logement", async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  if (!calendars[logement]) return res.status(404).json({ error: "Logement inconnu" });

  try {
    let events = [];

    // BDD
    const result = await pool.query(
      "SELECT date_debut, date_fin FROM reservations WHERE logement = $1",
      [logement]
    );
    events = result.rows.map(r => ({
      start: r.date_debut,
      end: r.date_fin,
      display: "background",
      color: "#ff0000",
      title: "Réservé (BDD)"
    }));

    // Google Calendar
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
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `Réservation ${logement}` },
            unit_amount: Math.round(montantFinal * 100)
          },
          quantity: 1
        }
      ],
      mode: "payment",
      success_url: `${frontendUrl}/${(logement || "blom").toLowerCase()}/merci`,
      cancel_url: `${frontendUrl}/${(logement || "blom").toLowerCase()}/annule`,
      metadata: {
        logement,
        date_debut: startDate,
        date_fin: endDate,
        personnes,
        name,
        email,
        phone
      }
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
