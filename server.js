// ========================================================
// 🌸 LIVABLŌM - Server.js (version finale 2025 corrigée)
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
const crypto = require("crypto");

console.log("🌐 CALENDAR_PROXY_URL =", process.env.CALENDAR_PROXY_URL);


// ========================================================
// ⚙️ CONFIGURATION GLOBALE
// ========================================================
const NODE_ENV = process.env.NODE_ENV || "development";
const isTestMode =
  (process.env.STRIPE_MODE || "").toLowerCase() === "test" ||
  NODE_ENV === "development";

// ✅ Meilleure logique pour TEST_PAIEMENT
const isPaymentTest = (() => {
  const val =
    process.env.TEST_PAIEMENT ||
    process.env.TEST_PAYMENT ||
    process.env.PAIEMENT_TEST ||
    "";
  const normalized = val.trim().toLowerCase();
  return ["true", "1", "yes", "vrai", "on"].includes(normalized);
})();

console.log("🔍 ENVIRONMENT CHECK -----------------------");
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("STRIPE_MODE:", process.env.STRIPE_MODE);
console.log("MODE_STRIPE:", process.env.MODE_STRIPE);
console.log("TEST_PAIEMENT:", process.env.TEST_PAIEMENT);
console.log("TEST_PAYMENT:", process.env.TEST_PAYMENT);
console.log("PAIEMENT_TEST:", process.env.PAIEMENT_TEST);
console.log("STRIPE_SECRET_KEY (tronc):", (process.env.STRIPE_SECRET_KEY || "").slice(0, 10));
console.log("STRIPE_TEST_KEY (tronc):", (process.env.STRIPE_TEST_KEY || "").slice(0, 10));
console.log("------------------------------------------");
console.log("🧩 Valeur brute TEST_PAIEMENT :", process.env.TEST_PAIEMENT);
console.log("🧠 Interprétation Node (isPaymentTest) :", isPaymentTest);
console.log("🛠️ isPaymentTest final :", isPaymentTest);

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
// 🎁 CARTES CADEAUX BLŌM
// ========================================================

const GIFT_CARD_PAYMENT_LINKS = {
  plink_1Sms3CIWRH02GJbeWO0NlSFE: 5000,
  plink_1Sms7BIWRH02GJbe39aDJE5e: 10000,
  plink_1Sms8ZIWRH02GJbe7pTb0fGd: 15000,
};

function isGiftCardPayment(session) {
  return Boolean(
    session.payment_link &&
    GIFT_CARD_PAYMENT_LINKS[session.payment_link]
  );
}

function generateGiftCardCode() {
  return `BLOM-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function giftCardExpiryDate() {
  const expiration = new Date();
  expiration.setFullYear(expiration.getFullYear() + 1);
  return expiration.toISOString().slice(0, 10);
}

async function initGiftCardsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gift_cards (
      id SERIAL PRIMARY KEY,
      code VARCHAR(30) UNIQUE NOT NULL,
      stripe_session_id VARCHAR(255) UNIQUE NOT NULL,
      payment_link_id VARCHAR(255) NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency VARCHAR(10) NOT NULL DEFAULT 'eur',

      buyer_name TEXT,
      buyer_email TEXT NOT NULL,

      recipient_name TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      personal_message TEXT,

      purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at DATE NOT NULL,

      email_sent BOOLEAN NOT NULL DEFAULT FALSE,
email_sent_at TIMESTAMPTZ,

      used BOOLEAN NOT NULL DEFAULT FALSE,
      used_at TIMESTAMPTZ,
      reservation_reference TEXT
    )
  `);

  console.log("🎁 Table gift_cards prête");
}

initGiftCardsTable().catch((err) =>
  console.error("❌ Erreur initialisation gift_cards :", err)
);

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

function todayParisISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isSameDayBlomBooking(logement, startDate) {
  return normalizeLogement(logement) === "BLOM" && startDate === todayParisISO();
}
// ========================================================
// 📩 Envoi des emails (version différenciée LIVA / BLŌM)
// ========================================================
async function sendConfirmationEmail({ name, email, logement, startDate, endDate, personnes, phone }) {
  if (!brevoApiKey) return;
  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  };

  const logementNormalized = normalizeLogement(logement);
  const isBlom = logementNormalized === "BLOM";
  const logementClean = isBlom ? "BLŌM – Spa & Détente" : "LIVA – Confort & Sérénité";
  const colorTheme = isBlom ? "#c59c5d" : "#5da0c5";
  const accentText = isBlom
    ? "un moment de détente et de bien-être unique 💆‍♀️"
    : "un séjour confortable et apaisant 🏡";

  // ✅ Heure d'arrivée selon le logement
  const arrivalHour = isBlom ? "19h00" : "16h00";
  const departureHour = "11h00"; // départ commun

  // --- HTML mail client ---
  const emailHtml = `
<div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 30px;">
  <div style="max-width: 600px; margin: auto; background: #fff; border-radius: 10px; padding: 25px; box-shadow: 0 3px 8px rgba(0,0,0,0.1);">
    <div style="text-align: center; margin-bottom: 25px;">
      <img src="https://livablom.fr/assets/images/logolivablom.png" alt="LIVABLŌM" style="width: 120px; margin-bottom: 10px;">
      <h2 style="color: #333; margin: 0;">Confirmation de votre réservation</h2>
    </div>

    <p>Bonjour <strong>${name || "cher client"}</strong>,</p>
    <p>Nous vous confirmons votre réservation chez <strong>${logementClean}</strong> 🎉</p>

    <div style="background: #f3f3f3; padding: 15px; border-radius: 8px; margin: 20px 0;">
      <p style="margin:5px 0;"><strong>Logement :</strong> ${logementClean}</p>
      <p style="margin:5px 0;"><strong>Date d'arrivée :</strong> ${formatDate(startDate)} à partir de <strong>${arrivalHour}</strong></p>
      <p style="margin:5px 0;"><strong>Date de départ :</strong> ${formatDate(endDate)} avant <strong>${departureHour}</strong></p>
      ${personnes ? `<p style="margin:5px 0;"><strong>Nombre de personnes :</strong> ${personnes}</p>` : ""}
      ${phone ? `<p style="margin:5px 0;"><strong>Téléphone :</strong> ${phone}</p>` : ""}
    </div>

    <p>Nous avons hâte de vous accueillir et de vous offrir ${accentText}</p>

    ${isBlom
      ? `<p style="margin-top:10px;">💧 Profitez de votre espace privatif avec spa, lit king size et petit déjeuner offert.</p>`
      : `<p style="margin-top:10px;">🍃 Votre logement tout équipé est prêt à vous accueillir pour un séjour familial ou professionnel.</p>`}

    <p>Pour toute question ou modification :</p>
    <ul>
      <li><a href="https://livablom.fr/contact" style="color:${colorTheme}; font-weight:bold; text-decoration:none;">Formulaire de contact</a></li>
      <li><a href="tel:+33649831838" style="color:${colorTheme}; font-weight:bold; text-decoration:none;">06 49 83 18 38</a></li>
    </ul>

    <p style="margin-top: 30px; font-size: 13px; color: #777;">
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
        subject: `Nouvelle réservation - ${logementClean}`,
        htmlContent: `
<h3>Nouvelle réservation ${isBlom ? "BLŌM" : "LIVA"}</h3>
<p><b>Nom :</b> ${name}</p>
<p><b>Email :</b> ${email}</p>
<p><b>Téléphone :</b> ${phone}</p>
<p><b>Logement :</b> ${logementClean}</p>
<p><b>Dates :</b> ${formatDate(startDate)} → ${formatDate(endDate)}</p>
${personnes ? `<p><b>Nombre de personnes :</b> ${personnes}</p>` : ""}
`,
      });
      console.log("✉️ Copie admin envoyée à :", brevoAdminTo);
    } catch (err) {
      console.error("❌ Erreur email admin:", err);
    }
  }
}

// ========================================================
// 🎁 Traitement des cartes cadeaux
// ========================================================

function getStripeCustomField(session, key) {
  const field = (session.custom_fields || []).find((f) => f.key === key);

  if (!field) return "";

  if (field.type === "text") return field.text?.value || "";
  if (field.type === "numeric") return String(field.numeric?.value || "");
  if (field.type === "dropdown") return field.dropdown?.value || "";

  return "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendGiftCardEmail({
  buyerName,
  buyerEmail,
  recipientName,
  senderName,
  personalMessage,
  amountCents,
  code,
  expiresAt,
}) {
  if (!brevoApiKey) {
    console.warn("⚠️ Brevo désactivé : carte cadeau non envoyée.");
    return;
  }

  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

  const amount = (amountCents / 100).toFixed(0);

  const expirationFormatted = new Date(
    `${expiresAt}T12:00:00`
  ).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const messageHtml = personalMessage
    ? `
      <div style="margin:25px 0;padding:18px;background:#faf7f2;border-radius:8px;">
        <em>« ${escapeHtml(personalMessage)} »</em>
      </div>
    `
    : "";

  const htmlContent = `
    <div style="font-family:Arial,sans-serif;background:#f5f3ef;padding:30px;">
      <div style="max-width:600px;margin:auto;background:#ffffff;padding:35px;border-radius:12px;text-align:center;">

        <img
          src="https://livablom.fr/assets/images/logolivablom.png"
          alt="BLŌM"
          style="width:130px;margin-bottom:20px;"
        >

        <p style="font-size:14px;letter-spacing:3px;color:#777;">
          CARTE CADEAU
        </p>

        <h1 style="font-size:42px;margin:15px 0;color:#c59c5d;">
          ${amount} €
        </h1>

        <p style="font-size:18px;">
          Une parenthèse de détente à vivre chez <strong>BLŌM</strong>
        </p>

        <div style="margin:30px 0;font-size:17px;line-height:1.8;">
          <div><strong>Pour :</strong> ${escapeHtml(recipientName)}</div>
          <div><strong>De la part de :</strong> ${escapeHtml(senderName)}</div>
        </div>

        ${messageHtml}

        <div style="margin:30px 0;padding:20px;border:1px solid #c59c5d;border-radius:8px;">
          <div style="font-size:13px;color:#777;">CODE CADEAU</div>
          <div style="font-size:25px;font-weight:bold;letter-spacing:2px;margin-top:8px;">
            ${escapeHtml(code)}
          </div>
        </div>

        <p>
          Valable jusqu'au <strong>${expirationFormatted}</strong>
        </p>

        <p style="font-size:14px;color:#666;line-height:1.6;">
          Pour réserver votre séjour, contactez BLŌM en indiquant votre code cadeau.
          Si le montant de la réservation est supérieur à la valeur de la carte,
          seule la différence restera à régler.
        </p>

        <p style="margin-top:30px;">
          <a href="https://livablom.fr/contact"
             style="color:#c59c5d;font-weight:bold;">
            Contacter BLŌM
          </a>
        </p>

        <p style="font-size:12px;color:#999;margin-top:30px;">
          Carte cadeau valable 12 mois à compter de son achat.
          Non échangeable contre de l'argent.
        </p>
      </div>
    </div>
  `;

  await tranEmailApi.sendTransacEmail({
    sender: { name: brevoSenderName, email: brevoSender },
    to: [{ email: buyerEmail, name: buyerName || senderName }],
    subject: `🎁 Votre carte cadeau BLŌM de ${amount} €`,
    htmlContent,
  });

  console.log("🎁 Carte cadeau envoyée à :", buyerEmail);

  if (brevoAdminTo) {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email: brevoAdminTo }],
      subject: `Nouvelle carte cadeau BLŌM - ${amount} €`,
      htmlContent: `
        <h3>Nouvelle carte cadeau BLŌM</h3>
        <p><strong>Montant :</strong> ${amount} €</p>
        <p><strong>Acheteur :</strong> ${escapeHtml(buyerName)}</p>
        <p><strong>Email :</strong> ${escapeHtml(buyerEmail)}</p>
        <p><strong>Pour :</strong> ${escapeHtml(recipientName)}</p>
        <p><strong>De la part de :</strong> ${escapeHtml(senderName)}</p>
        <p><strong>Code :</strong> ${escapeHtml(code)}</p>
        <p><strong>Expiration :</strong> ${expirationFormatted}</p>
      `,
    });
  }
}

async function processGiftCard(session) {
  const amountCents = GIFT_CARD_PAYMENT_LINKS[session.payment_link];

  if (!amountCents) {
    throw new Error("Lien carte cadeau inconnu");
  }

  if (session.payment_status !== "paid") {
    throw new Error("Carte cadeau non payée");
  }

  if (session.amount_total !== amountCents) {
    throw new Error(
      `Montant carte cadeau incorrect : ${session.amount_total}`
    );
  }

  const buyerEmail =
    session.customer_details?.email ||
    session.customer_email;

  const buyerName =
    session.customer_details?.name ||
    session.customer_details?.individual_name ||
    "";

  const recipientName = getStripeCustomField(
    session,
    "prnomdubnficiaire"
  );

  const senderName = getStripeCustomField(
    session,
    "delapartde"
  );

  const personalMessage = getStripeCustomField(
    session,
    "messageinscriresurlacartecadeau"
  );

  if (!buyerEmail || !recipientName || !senderName) {
    throw new Error("Informations carte cadeau incomplètes");
  }

  const code = generateGiftCardCode();
  const expiresAt = giftCardExpiryDate();

  const result = await pool.query(
    `
      INSERT INTO gift_cards (
        code,
        stripe_session_id,
        payment_link_id,
        amount_cents,
        currency,
        buyer_name,
        buyer_email,
        recipient_name,
        sender_name,
        personal_message,
        expires_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (stripe_session_id) DO UPDATE
SET stripe_session_id = EXCLUDED.stripe_session_id
RETURNING *
    `,
    [
      code,
      session.id,
      session.payment_link,
      amountCents,
      session.currency || "eur",
      buyerName,
      buyerEmail,
      recipientName,
      senderName,
      personalMessage,
      expiresAt,
    ]
  );

  // Stripe peut renvoyer le même webhook plusieurs fois.
  // Si la session existe déjà, on ne recrée pas une deuxième carte.
  const giftCard = result.rows[0];

if (giftCard.email_sent) {
  console.log(
    "ℹ️ Carte cadeau déjà créée et envoyée :",
    session.id
  );
  return;
}

  await sendGiftCardEmail({
  buyerName,
  buyerEmail,
  recipientName,
  senderName,
  personalMessage,
  amountCents,
  code: giftCard.code,
  expiresAt: String(giftCard.expires_at).slice(0, 10),
});

await pool.query(
  `
    UPDATE gift_cards
    SET email_sent = TRUE,
        email_sent_at = NOW()
    WHERE id = $1
  `,
  [giftCard.id]
);

  console.log(
    `✅ Carte cadeau créée : ${code} - ${amountCents / 100} €`
  );
}

// ========================================================
// 🚦 Serveur Express
// ========================================================
const app = express();

// ⚡ WEBHOOK STRIPE (doit être tout en haut)
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

      // 🎁 Carte cadeau : traitement séparé des réservations
     if (isGiftCardPayment(session)) {
  console.log("🎁 Paiement carte cadeau détecté :", session.payment_link);

  try {
    await processGiftCard(session);
    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Erreur traitement carte cadeau :", err);
    return res.status(500).json({
      error: "gift_card_processing_failed",
    });
  }
}

      if (session.metadata?.logement && session.metadata?.date_debut && session.metadata?.date_fin) {
        await pool.query(
          "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
          [session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin]
        );
        console.log("✅ Réservation enregistrée :", session.metadata.logement);
      }
      // 🔁 Envoi de la réservation au calendar-proxy
try {
  const proxyUrl = process.env.CALENDAR_PROXY_URL || "https://calendar-proxy.up.railway.app/api/add-reservation";
  await fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      logement: session.metadata.logement,
      date_debut: session.metadata.date_debut,
      date_fin: session.metadata.date_fin,
      title: `Réservation ${session.metadata.logement}`,
    }),
  });
  console.log("📤 Réservation envoyée à calendar-proxy");
} catch (err) {
  console.error("❌ Erreur envoi vers calendar-proxy :", err);
}


      await sendConfirmationEmail({
        name: session.metadata?.name,
        email: session.metadata?.email,
        logement: session.metadata?.logement,
        startDate: session.metadata?.date_debut,
        endDate: session.metadata?.date_fin,
        personnes: session.metadata?.personnes,
        phone: session.metadata?.phone,
      });
    } catch (err) {
      console.error("❌ Erreur traitement webhook :", err);
    }
  }

  res.json({ received: true });
});

// ✅ Middlewares
app.use(cors());
app.use(bodyParser.json());

// ========================================================
// 💳 API Checkout Stripe
// ========================================================
app.post("/api/checkout", async (req, res) => {
  try {
    const { logement, startDate, endDate, amount, personnes, name, email, phone } = req.body;

    if (!logement || !startDate || !endDate || !amount || !email) {
      return res.status(400).json({ error: "Champs manquants" });
    }

    // 🚫 Sécurité : pas de réservation automatique le jour même pour BLŌM
    if (isSameDayBlomBooking(logement, startDate)) {
      return res.status(409).json({
        error: "same_day_not_allowed",
        message:
          "Pour une arrivée aujourd’hui à BLŌM, merci de nous contacter directement afin de vérifier si la réservation est possible.",
      });
    }

    const montantFinal = isPaymentTest ? 1 : amount;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      payment_method_options: { card: { request_three_d_secure: "any" } },
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `Réservation ${logement}` },
            unit_amount: Math.round(montantFinal * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      customer_email: email,
      success_url: `${frontendUrl}/${slugify(logement)}?payment=success`,
      cancel_url: `${frontendUrl}/${slugify(logement)}?payment=cancel`,
      
      metadata: { logement, date_debut: startDate, date_fin: endDate, personnes, name, email, phone },
    });

    console.log(`✅ Session Stripe ${isTestMode ? "TEST" : "LIVE"} créée : ${session.id}`);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// ========================================================
// 📅 API Réservations
// ========================================================
app.get("/api/reservations/:logement", async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  if (!calendars[logement]) return res.status(404).json({ error: "Logement inconnu" });

  try {
    let events = [];
    const result = await pool.query("SELECT date_debut, date_fin FROM reservations WHERE logement = $1", [logement]);
    events = result.rows.map((r) => ({
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
    console.error("❌ Erreur récupération réservations:", err);
    res.status(500).json({ error: "Impossible de charger les réservations" });
  }
});

// ========================================================
// 🧭 Nouvelle route /api/config
// ========================================================
app.get("/api/config", (req, res) => {
  res.json({
    mode: isTestMode ? "test" : "live",
    testPayment: isPaymentTest,
  });
});

// ========================================================
// 🌐 Test route
// ========================================================
app.get("/", (req, res) =>
  res.send(
    `🚀 API LIVABLŌM opérationnelle ! Mode: ${isTestMode ? "TEST" : "LIVE"} | Paiement: ${isPaymentTest ? "1€" : "réel"}`
  )
);

// ========================================================
// 🚀 Lancement serveur
// ========================================================
app.listen(port, () => {
  console.log(
    `✅ Serveur lancé sur port ${port} (${NODE_ENV}) | Mode: ${isTestMode ? "TEST" : "LIVE"} | Paiement: ${isPaymentTest ? "1€" : "réel"}`
  );
});
