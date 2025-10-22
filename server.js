// ========================================================
// 🌸 LIVABLŌM - Server.js (version finale corrigée 2025)
// ========================================================

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
// ⚙️ CONFIGURATION GLOBALE
// ========================================================
const NODE_ENV = process.env.NODE_ENV || "development";
const isTestMode =
  (process.env.STRIPE_MODE || "").toLowerCase() === "test" ||
  NODE_ENV === "development";

const isPaymentTest = (() => {
  const val =
    process.env.TEST_PAIEMENT ||
    process.env.TEST_PAYMENT ||
    process.env.PAIEMENT_TEST ||
    "";
  const normalized = val.trim().toLowerCase();
  return ["true", "1", "yes", "vrai", "on"].includes(normalized);
})();

const stripeKey = isTestMode
  ? process.env.STRIPE_TEST_KEY
  : process.env.STRIPE_SECRET_KEY;

const stripeWebhookSecret = isTestMode
  ? process.env.STRIPE_WEBHOOK_TEST_SECRET
  : process.env.STRIPE_WEBHOOK_SECRET;

const frontendUrl =
  NODE_ENV === "production"
    ? process.env.FRONTEND_URL || "https://livablom.fr"
    : process.env.FRONTEND_URL || "http://localhost:4001";

const port = process.env.PORT || 3000;
const stripe = stripeLib(stripeKey);

// ========================================================
// 🗄️ PostgreSQL
// ========================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

pool
  .connect()
  .then(() => console.log("✅ Connecté à PostgreSQL"))
  .catch((err) => console.error("❌ Erreur connexion BDD:", err));

// ========================================================
// 📅 iCal Google
// ========================================================
const calendars = {
  LIVA: ["https://calendar.google.com/calendar/ical/.../basic.ics"],
  BLOM: ["https://calendar.google.com/calendar/ical/.../basic.ics"],
};

async function fetchICal(url, logement) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const data = await res.text();
    const parsed = ical.parseICS(data);
    return Object.values(parsed)
      .filter((ev) => ev.start && ev.end)
      .map((ev) => ({
        title: ev.summary || "Réservé (Google)",
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

// ========================================================
// ✉️ Brevo (Sendinblue)
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
  return String(str || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function slugify(str) {
  return (
    String(str || "blom")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9-_]/g, "")
      .toLowerCase() || "blom"
  );
}

// 📅 Formatage des dates FR
function formatDateFr(dateStr) {
  try {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    if (isNaN(date)) return dateStr;
    return date.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch (err) {
    console.error("Erreur formatDateFr:", err);
    return dateStr;
  }
}

// ========================================================
// 📩 Envoi des emails (client + admin)
// ========================================================
async function sendConfirmationEmail({
  name,
  email,
  logement,
  startDate,
  endDate,
  personnes,
  phone,
  amount,
}) {
  if (!brevoApiKey) return;
  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

  const logementNormalized = normalizeLogement(logement);
  const isBlom = logementNormalized === "BLOM";

  const logementClean = isBlom
    ? "BLŌM – Spa & Détente"
    : "LIVA – Confort & Sérénité";

  const colorTheme = isBlom ? "#c59c5d" : "#5da0c5";
  const accentText = isBlom
    ? "un moment de détente et de bien-être unique 💆‍♀️"
    : "un séjour confortable et apaisant 🏡";

  const arrivalHour = "16h00";
  const departureHour = "11h00";

  // --- Email client ---
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; background:#f9f9f9; padding:30px;">
      <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;padding:25px;box-shadow:0 3px 8px rgba(0,0,0,0.1);">
        <div style="text-align:center;margin-bottom:25px;">
          <img src="https://livablom.fr/assets/images/logolivablom.png" alt="LIVABLŌM" style="width:120px;margin-bottom:10px;">
          <h2 style="color:#333;margin:0;">Confirmation de votre réservation</h2>
        </div>

        <p>Bonjour <strong>${name || "cher client"}</strong>,</p>
        <p>Nous vous confirmons votre réservation chez <strong>${logementClean}</strong> 🎉</p>

        <div style="background:#f3f3f3;padding:15px;border-radius:8px;margin:20px 0;">
          <p><strong>Logement :</strong> ${logementClean}</p>
          <p><strong>Date d'arrivée :</strong> ${formatDateFr(startDate)} à partir de <b>${arrivalHour}</b></p>
          <p><strong>Date de départ :</strong> ${formatDateFr(endDate)} avant <b>${departureHour}</b></p>
          ${personnes ? `<p><strong>Nombre de personnes :</strong> ${personnes}</p>` : ""}
          ${phone ? `<p><strong>Téléphone :</strong> ${phone}</p>` : ""}
        </div>

        <p>Nous avons hâte de vous accueillir pour ${accentText}</p>

        ${
          isBlom
            ? `<p>💧 Profitez de votre espace privatif avec spa, lit king size et petit déjeuner offert.</p>`
            : `<p>🍃 Votre logement tout équipé est prêt à vous accueillir pour un séjour familial ou professionnel.</p>`
        }

        <p>Pour toute question :</p>
        <ul>
          <li><a href="https://livablom.fr/contact" style="color:${colorTheme};font-weight:bold;text-decoration:none;">Formulaire de contact</a></li>
          <li>Ou appelez-nous au <a href="tel:+33649831838" style="color:${colorTheme};text-decoration:none;">06 49 83 18 38</a></li>
        </ul>

        <p style="font-size:13px;color:#777;margin-top:30px;">
          Merci de votre confiance 💛<br>L’équipe LIVABLŌM
        </p>
      </div>
    </div>
  `;

  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email, name }],
      subject: `🌸 Confirmation de votre réservation - ${logementClean}`,
      htmlContent: emailHtml,
    });
    console.log("✉️ Email client envoyé :", email);
  } catch (err) {
    console.error("❌ Erreur envoi email client:", err);
  }

  // --- Copie admin ---
  if (brevoAdminTo) {
    try {
      await tranEmailApi.sendTransacEmail({
        sender: { name: brevoSenderName, email: brevoSender },
        to: [{ email: brevoAdminTo }],
        subject: `🧾 Nouvelle réservation ${logementClean}`,
        htmlContent: `
          <div style="font-family:Arial,sans-serif;background:#fafafa;padding:20px;">
            <h2 style="color:${colorTheme};margin-bottom:10px;">
              Nouvelle réservation sur ${logementClean}
            </h2>
            <p><strong>Nom :</strong> ${name}</p>
            <p><strong>Email :</strong> ${email}</p>
            <p><strong>Téléphone :</strong> ${phone}</p>
            <p><strong>Logement :</strong> ${logementClean}</p>
            <p><strong>Dates :</strong> du <b>${formatDateFr(startDate)}</b> à 16h00<br>
               au <b>${formatDateFr(endDate)}</b> (départ max 11h00)</p>
            <p><strong>Nombre de personnes :</strong> ${personnes || "Non précisé"}</p>
            <p><strong>Montant total :</strong> ${amount || "N/A"} €</p>
            <hr style="margin-top:20px;">
            <p style="font-size:13px;color:#666;">
              Réservation effectuée via <a href="https://livablom.fr" style="color:${colorTheme};text-decoration:none;">livablom.fr</a>
            </p>
          </div>
        `,
      });
      console.log("✉️ Copie admin envoyée à :", brevoAdminTo);
    } catch (err) {
      console.error("❌ Erreur email admin:", err);
    }
  }
}

// ========================================================
// 🚦 Serveur Express
// ========================================================
const app = express();
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => { /* ... identique ... */ });
app.use(cors());
app.use(bodyParser.json());
// (le reste de tes routes inchangé)
