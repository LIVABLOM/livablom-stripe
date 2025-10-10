// server.js — CommonJS, stable + templates pro
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

if (!stripeKey) console.warn("⚠️ STRIPE KEY non configurée (STRIPE_TEST_KEY / STRIPE_SECRET_KEY).");
const stripe = stripeLib(stripeKey);

// --- Postgres ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.URL_BASE_DE_DONNÉES,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log("✅ Connecté à PostgreSQL"))
  .catch(err => console.error("❌ Erreur connexion BDD:", err && err.message));

// --- Google Calendar (exemples) ---
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
    console.error("❌ Erreur iCal pour", logement, url, err && err.message);
    return [];
  }
}

// --- Brevo (Sendinblue) init ---
const brevoApiKey = process.env.CLÉ_API_BREVO || process.env.BREVO_API_KEY || process.env.SENDINBLUE_API_KEY;
const brevoSender = process.env.BREVO_SENDER || process.env.ADMIN_EMAIL || "contact@livablom.fr";
const brevoSenderName = process.env.BREVO_SENDER_NAME || "LIVABLŌM";
const brevoAdminTo = process.env.BREVO_TO || process.env.ADMIN_EMAIL || "livablom59@gmail.com";

if (!brevoApiKey) {
  console.warn("⚠️ Clé Brevo/Sendinblue non configurée — les emails ne seront pas envoyés.");
} else {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications["api-key"].apiKey = brevoApiKey;
}

// helper: send mail with SibApiV3Sdk
async function sendMail({ toEmail, toName, subject, html }) {
  if (!brevoApiKey) {
    console.warn("sendMail: clé Brevo manquante, skip.");
    return;
  }
  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();
  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email: toEmail, name: toName || "" }],
      subject,
      htmlContent: html
    });
    return true;
  } catch (err) {
    console.error("❌ Erreur sendTransacEmail:", err && err.body ? (err.body || err.message) : (err && err.message));
    return false;
  }
}

// Templates HTML
function clientTemplate({ name, logement, startDate, endDate, amount, logoUrl }) {
  // small safe defaults
  name = name || "Client";
  logement = logement || "Logement";
  startDate = startDate || "-";
  endDate = endDate || "-";
  amount = amount != null ? amount : "-";
  logoUrl = logoUrl || (process.env.LOGO_URL || "");

  return `
  <html>
  <body style="font-family: Arial, sans-serif; background:#f7f7f7; padding:20px; margin:0;">
    <div style="max-width:600px;margin:auto;background:#fff;border-radius:8px;overflow:hidden;">
      <div style="background:#000;color:#fff;padding:18px;text-align:center;">
        ${logoUrl ? `<img src="${logoUrl}" alt="LIVABLŌM" style="height:56px;margin-bottom:8px;">` : ''}
        <h2 style="margin:0;font-weight:600">Confirmation de réservation</h2>
      </div>
      <div style="padding:24px;color:#222;line-height:1.5;">
        <p>Bonjour <strong>${name}</strong>,</p>
        <p>Merci pour votre réservation chez <strong>LIVABLŌM</strong> — votre paiement a bien été reçu.</p>
        <table style="width:100%;margin-top:12px;border-collapse:collapse;">
          <tr><td style="padding:6px 0;"><strong>Logement :</strong></td><td style="padding:6px 0;">${logement}</td></tr>
          <tr><td style="padding:6px 0;"><strong>Arrivée :</strong></td><td style="padding:6px 0;">${startDate}</td></tr>
          <tr><td style="padding:6px 0;"><strong>Départ :</strong></td><td style="padding:6px 0;">${endDate}</td></tr>
          <tr><td style="padding:6px 0;"><strong>Montant :</strong></td><td style="padding:6px 0;">${amount} €</td></tr>
        </table>
        <p style="margin-top:18px;">Nous vous enverrons un message avant votre arrivée avec les instructions.</p>
        <p>Cordialement,<br><strong>L’équipe LIVABLŌM</strong></p>
      </div>
      <div style="background:#f0f0f0;padding:12px;text-align:center;font-size:12px;color:#666;">
        © LIVABLŌM — <a href="https://livablom.fr" style="color:#333;text-decoration:none;">livablom.fr</a>
      </div>
    </div>
  </body>
  </html>`;
}

function adminTemplate({ name, email, logement, startDate, endDate, amount }) {
  return `
  <html>
  <body style="font-family: Arial, sans-serif; background:#f9f9f9; padding:20px;">
    <div style="max-width:600px;margin:auto;background:#fff;border-radius:8px;padding:18px;">
      <h3 style="margin-top:0;">📬 Nouvelle réservation - LIVABLŌM</h3>
      <ul>
        <li><strong>Client :</strong> ${name || "-"}</li>
        <li><strong>Email :</strong> ${email || "-"}</li>
        <li><strong>Logement :</strong> ${logement || "-"}</li>
        <li><strong>Dates :</strong> ${startDate || "-"} → ${endDate || "-"}</li>
        <li><strong>Montant :</strong> ${amount != null ? amount + " €" : "-"}</li>
      </ul>
      <p>Consulter Stripe / la BDD pour plus de détails.</p>
    </div>
  </body>
  </html>`;
}

// --- Express ---
const app = express();

// --- Webhook Stripe (corps brut requis) ---
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    console.error("❌ Webhook: header stripe-signature absent");
    return res.status(400).send("Missing stripe-signature header");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature error:", err && err.message);
    return res.status(400).send(`Webhook Error: ${err && err.message}`);
  }

  console.log("📦 Webhook Stripe reçu :", event.type);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object || {};
      const metadata = session.metadata || {};

      // safe extraction (fall back to customer_details if metadata not present)
      const logement = metadata.logement || (metadata.logement) || (session?.metadata && session.metadata.logement) || "LIVA/BLŌM";
      const startDate = metadata.date_debut || metadata.startDate || null;
      const endDate = metadata.date_fin || metadata.endDate || null;
      const personnes = metadata.personnes || null;
      const clientEmail = metadata.email || (session.customer_details && session.customer_details.email);
      const clientName = metadata.name || (session.customer_details && session.customer_details.name) || clientEmail || "Client";

      // optional: insert into DB if dates present
      if (startDate && endDate && logement) {
        try {
          await pool.query(
            "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
            [logement, startDate, endDate]
          );
        } catch (dbErr) {
          console.error("❌ Erreur insertion BDD (webhook):", dbErr && dbErr.message);
        }
      }

      // amount: try session.amount_total else undefined
      let amount = session.amount_total != null ? (session.amount_total / 100).toFixed(2) : null;

      // Send client email (if we have an email)
      if (clientEmail) {
        const htmlClient = clientTemplate({
          name: clientName,
          logement,
          startDate,
          endDate,
          amount,
          logoUrl: process.env.LOGO_URL || ""
        });
        const okClient = await sendMail({
          toEmail: clientEmail,
          toName: clientName,
          subject: `✅ Confirmation de votre réservation - ${logement}`,
          html: htmlClient
        });
        if (okClient) console.log(`✉️ Email client envoyé : ${clientEmail}`);
      } else {
        console.warn("⚠️ Webhook: email client introuvable, email non envoyé.");
      }

      // Send admin email
      const htmlAdmin = adminTemplate({
        name: clientName,
        email: clientEmail,
        logement,
        startDate,
        endDate,
        amount
      });
      const okAdmin = await sendMail({
        toEmail: brevoAdminTo,
        toName: "LIVABLŌM Admin",
        subject: `📬 Nouvelle réservation - ${logement}`,
        html: htmlAdmin
      });
      if (okAdmin) console.log(`✉️ Email admin envoyé à : ${brevoAdminTo}`);
    }
  } catch (err) {
    console.error("❌ Erreur traitement webhook:", err && err.message);
  }

  res.json({ received: true });
});

// --- Body parser JSON pour le reste des routes ---
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
    console.error("❌ Erreur récupération:", err && err.message);
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
      customer_email: email,
      metadata: { logement, date_debut: startDate, date_fin: endDate, personnes, name, email, phone }
    });

    console.log("💳 Session Stripe créée :", session.id);
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error("❌ Erreur création session Stripe :", err && (err.message || err));
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// --- Route test email (utile pour debug) ---
app.get("/test-email", async (req, res) => {
  if (!brevoApiKey) return res.status(500).send("Brevo key missing");
  try {
    const html = clientTemplate({
      name: "Test",
      logement: "LIVA",
      startDate: "2025-10-10",
      endDate: "2025-10-12",
      amount: "1.00",
      logoUrl: process.env.LOGO_URL || ""
    });
    const ok = await sendMail({ toEmail: brevoAdminTo, toName: "Admin", subject: "Test email LIVABLŌM", html });
    if (ok) return res.send("✅ Test email envoyé (vérifie la boîte).");
    return res.status(500).send("Erreur envoi test email");
  } catch (err) {
    console.error("❌ test-email error:", err && err.message);
    res.status(500).send("Erreur interne");
  }
});

// --- Route root ---
app.get("/", (req, res) => res.send("🚀 API LIVABLŌM opérationnelle !"));

// --- Start ---
app.listen(port, () => {
  console.log(`✅ Serveur lancé sur port ${port} (${NODE_ENV}) | Stripe: ${isTest ? "TEST" : "PROD"}`);
});
