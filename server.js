// server.js – CommonJS, webhook + arrivée BLŌM 19h / LIVA 16h

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

// --- Calendriers (Google iCal) ---
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

// --- Brevo (Sib) init ---
const brevoApiKey = process.env.CLÉ_API_BREVO || process.env.BREVO_API_KEY || process.env.CLE_API_BREVO;
const brevoSender = process.env.BREVO_SENDER || "contact@livablom.fr";
const brevoSenderName = process.env.BREVO_SENDER_NAME || "LIVABLŌM";
const brevoAdminTo = process.env.BREVO_TO || process.env.ADMIN_EMAIL || "livablom59@gmail.com";

if (!brevoApiKey) {
  console.warn("⚠️ Clé Brevo introuvable — emails non envoyés.");
} else {
  try {
    const client = SibApiV3Sdk.ApiClient.instance;
    client.authentications['api-key'].apiKey = brevoApiKey;
  } catch (e) {
    console.warn("⚠️ Impossible d'initialiser SibApiV3Sdk:", e.message);
  }
}

// --- Helpers (normalisation + slug) ---
function normalizeLogement(str) {
  if (!str) return "";
  // remove diacritics, uppercase
  return String(str).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function slugify(str) {
  const s = String(str || "blom")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")      // remove diacritics
    .replace(/[^a-zA-Z0-9-_]/g, "")       // keep safe chars
    .toLowerCase();
  return s || "blom";
}

// --- Envoi email via Brevo (client + admin) ---
async function sendConfirmationEmail({ name, email, logement, startDate, endDate, personnes, phone }) {
  if (!brevoApiKey) {
    console.warn("Brevo non configuré — skip email.");
    return;
  }

  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

  const norm = normalizeLogement(logement);
  const heureArrivee = norm === "BLOM" ? "19h" : "16h";

  // email client (bouton contact, pas d'affichage d'adresse mail brute)
  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email: email, name: name || "" }],
      subject: `Confirmation de réservation - LIVABLŌM`,
      htmlContent: `
        <div style="font-family: Arial, sans-serif; color:#333; background:#f9f9f9; padding:20px;">
          <div style="max-width:600px;margin:auto;background:#fff;padding:30px;border-radius:8px;">
            <h2 style="color:#2E86C1">Bonjour ${name || ""},</h2>
            <p>Merci pour votre réservation sur <strong>LIVABLŌM</strong>.</p>
            <table style="width:100%;border-collapse:collapse;margin:20px 0;">
              <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Logement :</strong></td><td style="padding:8px;border:1px solid #ddd;">${logement}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Date d'arrivée :</strong></td><td style="padding:8px;border:1px solid #ddd;">${startDate} à partir de ${heureArrivee}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Date de départ :</strong></td><td style="padding:8px;border:1px solid #ddd;">${endDate} (départ avant 11h)</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Nombre de personnes :</strong></td><td style="padding:8px;border:1px solid #ddd;">${personnes || ""}</td></tr>
            </table>
            <p>Nous vous remercions de votre confiance et vous souhaitons un excellent séjour !</p>
            <div style="text-align:center;margin-top:30px;">
              <a href="https://livablom.fr/contact" style="background:#2E86C1;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Nous contacter</a>
            </div>
            <p style="margin-top:30px;color:#666;font-size:0.9em;">Cordialement,<br/>L’équipe <strong>LIVABLŌM</strong></p>
          </div>
        </div>
      `
    });
    console.log("✉️ Email client envoyé :", email);
  } catch (err) {
    console.error("❌ Erreur envoi email client via Brevo :", err);
  }

  // email admin (inclut téléphone si renseigné)
  if (brevoAdminTo) {
    try {
      await tranEmailApi.sendTransacEmail({
        sender: { name: brevoSenderName, email: brevoSender },
        to: [{ email: brevoAdminTo, name: "LIVABLŌM Admin" }],
        subject: `Nouvelle réservation - ${logement}`,
        htmlContent: `
          <div style="font-family: Arial, sans-serif; color:#222;">
            <h3>Nouvelle réservation</h3>
            <p><strong>Nom :</strong> ${name || ""}</p>
            <p><strong>Email client :</strong> ${email || ""}</p>
            <p><strong>Téléphone :</strong> ${phone || "Non renseigné"}</p>
            <p><strong>Logement réservé :</strong> ${logement}</p>
            <p><strong>Dates :</strong> ${startDate} à partir de ${heureArrivee} → ${endDate} (départ avant 11h)</p>
            <p><strong>Nombre de personnes :</strong> ${personnes || ""}</p>
          </div>
        `
      });
      console.log("✉️ Email admin envoyé à :", brevoAdminTo);
    } catch (err) {
      console.error("❌ Erreur envoi email admin via Brevo :", err);
    }
  } else {
    console.warn("⚠️ brevoAdminTo non configuré — pas d'email admin envoyé.");
  }
}

// --- Express app ---
const app = express();

// --- Stripe Webhook (doit rester avant bodyParser.json()) ---
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Traiter l'événement
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log("💳 checkout.session.completed reçu — metadata:", session.metadata);

      try {
        // Insert en BDD (si metadata contient date_debut/date_fin)
        if (session.metadata && session.metadata.logement && session.metadata.date_debut && session.metadata.date_fin) {
          try {
            await pool.query(
              "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
              [session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin]
            );
            console.log("✅ Réservation insérée en BDD:", session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin);
          } catch (dbErr) {
            console.error("❌ Erreur insertion BDD depuis webhook:", dbErr);
          }
        }

        // Récupérer infos client (metadata ou customer_details)
        const clientEmail = (session.metadata && session.metadata.email) || (session.customer_details && session.customer_details.email) || null;
        const clientName = (session.metadata && session.metadata.name) || (session.customer_details && session.customer_details.name) || null;
        const clientPhone = (session.metadata && session.metadata.phone) || null;
        const logement = (session.metadata && session.metadata.logement) || "LIVA";
        const startDate = (session.metadata && session.metadata.date_debut) || "";
        const endDate = (session.metadata && session.metadata.date_fin) || "";
        const personnes = (session.metadata && session.metadata.personnes) || "";

        // Envoi des emails après paiement réussi
        await sendConfirmationEmail({
          name: clientName,
          email: clientEmail,
          logement,
          startDate,
          endDate,
          personnes,
          phone: clientPhone
        });

        console.log("✉️ Emails envoyés suite au webhook pour", clientEmail);
      } catch (err) {
        console.error("❌ Erreur lors du traitement du webhook:", err);
      }
    }

    // Répondre à Stripe
    res.json({ received: true });
  }
);

// --- Middleware (après webhook) ---
app.use(cors());
app.use(bodyParser.json());

// --- Endpoint réservations (BDD + Google) ---
app.get("/api/reservations/:logement", async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  if (!calendars[logement]) return res.status(404).json({ error: "Logement inconnu" });

  try {
    let events = [];

    // BDD
    const result = await pool.query("SELECT date_debut, date_fin FROM reservations WHERE logement = $1", [logement]);
    events = result.rows.map(r => ({
      start: r.date_debut,
      end: r.date_fin,
      display: "background",
      color: "#ff0000",
      title: "Réservé (BDD)"
    }));

    // iCal Google
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

// --- Stripe Checkout (création session, pas d'email ici) ---
app.post("/api/checkout", async (req, res) => {
  try {
    const { logement, startDate, endDate, amount, personnes, name, email, phone } = req.body;

    // validation de base
    if (!logement || !startDate || !endDate || !amount || !email) {
      console.error("❌ Données manquantes pour /api/checkout :", { logement, startDate, endDate, amount, email });
      return res.status(400).json({ error: "Champs manquants pour créer la session Stripe" });
    }

    const montantFinal = process.env.TEST_PAYMENT === "true" ? 1 : amount;

    // créer un slug ASCII-safe pour les URLs de réussite/annulation
    const slug = slugify(logement);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      payment_method_options: {
        card: {
          request_three_d_secure: "any" // ✅ Forcer 3D Secure si la banque l'exige
        }
      },
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: `Réservation ${logement}` },
          unit_amount: Math.round(montantFinal * 100)
        },
        quantity: 1
      }],
      mode: "payment",
      customer_email: email, // pré-remplit le email sur Stripe
      success_url: `${frontendUrl}/merci/`,
      cancel_url: `${frontendUrl}/contact/`,
      metadata: { logement, date_debut: startDate, date_fin: endDate, personnes, name, email, phone }
    });

    console.log("✅ Session Stripe créée :", session.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    if (err && err.raw && err.raw.message) console.error("🧩 Stripe detail:", err.raw.message);
    res.status(500).json({ error: "Impossible de créer la session Stripe", message: err.message });
  }
});


// --- Route test ---
app.get("/", (req, res) => res.send("🚀 API LIVABLŌM opérationnelle !"));

// --- Lancement serveur ---
app.listen(port, () => {
  console.log(`✅ Serveur lancé sur port ${port} (${NODE_ENV}) | Stripe: ${isTest ? "TEST" : "PROD"}`);
});
