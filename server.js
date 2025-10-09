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

// --- Config Brevo ---
const brevoClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = brevoClient.authentications["api-key"];
apiKey.apiKey = process.env.BREVO_API_KEY;
const brevo = new SibApiV3Sdk.TransactionalEmailsApi();

// --- Variables générales ---
const NODE_ENV = process.env.NODE_ENV || "development";
const isTest = process.env.STRIPE_MODE === "test" || NODE_ENV === "development";
const stripeKey = isTest ? process.env.STRIPE_TEST_KEY : process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = isTest
  ? process.env.STRIPE_WEBHOOK_TEST_SECRET
  : process.env.STRIPE_WEBHOOK_SECRET;
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:4000";
const port = process.env.PORT || 3000;

const stripe = stripeLib(stripeKey);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Connexion DB ---
pool.connect()
  .then(() => console.log("✅ Connecté à PostgreSQL"))
  .catch(err => console.error("❌ Erreur connexion BDD:", err));

// --- Google Calendar ---
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

// --- Express ---
const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- Webhook Stripe ---
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      try {
        // 1️⃣ Sauvegarde BDD
        await pool.query(
          "INSERT INTO reservations (logement, date_debut, date_fin) VALUES ($1, $2, $3)",
          [session.metadata.logement, session.metadata.date_debut, session.metadata.date_fin]
        );

        // 2️⃣ Prépare les infos email
        const logement = session.metadata.logement;
        const startDate = session.metadata.date_debut;
        const endDate = session.metadata.date_fin;
        const amount = (session.amount_total / 100).toFixed(2);
        const customerEmail = session.customer_details?.email || "Client inconnu";
        const customerName = session.customer_details?.name || "Client LIVABLŌM";

        // 3️⃣ Contenu HTML de l'email client
        const clientEmail = {
          sender: { email: process.env.BREVO_SENDER, name: process.env.BREVO_SENDER_NAME },
          to: [{ email: customerEmail, name: customerName }],
          subject: `Confirmation de votre réservation - ${logement}`,
          htmlContent: `
            <div style="font-family:Arial,sans-serif;background:#f7f7f7;padding:30px;">
              <div style="max-width:600px;margin:auto;background:white;border-radius:10px;padding:20px;">
                <h2 style="text-align:center;color:#222;">Merci pour votre réservation !</h2>
                <p>Bonjour <strong>${customerName}</strong>,</p>
                <p>Nous confirmons votre réservation pour <b>${logement}</b>.</p>
                <ul>
                  <li>📅 <b>Du :</b> ${startDate}</li>
                  <li>📅 <b>Au :</b> ${endDate}</li>
                  <li>💶 <b>Montant payé :</b> ${amount} €</li>
                </ul>
                <p>Nous avons hâte de vous accueillir chez <b>LIVABLŌM</b> 🌸</p>
                <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
                <p style="font-size:12px;text-align:center;color:#666;">
                  Cet email est automatique. Pour toute question, contactez-nous à <a href="mailto:${process.env.BREVO_SENDER}">${process.env.BREVO_SENDER}</a>
                </p>
              </div>
            </div>`
        };

        // 4️⃣ Email admin
        const adminEmail = {
          sender: { email: process.env.BREVO_SENDER, name: process.env.BREVO_SENDER_NAME },
          to: [{ email: process.env.BREVO_TO }],
          subject: `Nouvelle réservation - ${logement}`,
          htmlContent: `
            <h2>Nouvelle réservation confirmée 🎉</h2>
            <p><b>Client :</b> ${customerName}</p>
            <p><b>Email :</b> ${customerEmail}</p>
            <p><b>Logement :</b> ${logement}</p>
            <p><b>Dates :</b> ${startDate} → ${endDate}</p>
            <p><b>Montant :</b> ${amount} €</p>`
        };

        // 5️⃣ Envoi des mails via Brevo
        await brevo.sendTransacEmail(clientEmail);
        console.log(`✉️ Email client envoyé à : ${customerEmail}`);
        await brevo.sendTransacEmail(adminEmail);
        console.log(`✉️ Email admin envoyé à : ${process.env.BREVO_TO}`);

      } catch (err) {
        console.error("❌ Erreur traitement webhook:", err);
      }
    }

    res.json({ received: true });
  }
);

// --- Endpoint réservations ---
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
    const { logement, startDate, endDate, amount } = req.body;
    const montantFinal = process.env.TEST_PAYMENT === "true" ? 1 : amount;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `Réservation ${logement}` },
            unit_amount: montantFinal * 100
          },
          quantity: 1
        }
      ],
      mode: "payment",
      success_url: `${frontendUrl}/blom/merci`,
      cancel_url: `${frontendUrl}/blom/annule`,
      metadata: { logement, date_debut: startDate, date_fin: endDate }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe:", err);
    res.status(500).json({ error: "Impossible de créer la session Stripe" });
  }
});

// --- Route test ----
app.get("/", (req, res) => res.send("🚀 API LIVABLŌM opérationnelle avec emails Brevo !"));

app.listen(port, () => {
  console.log(`✅ Serveur lancé sur port ${port} (${NODE_ENV}) | Stripe: ${isTest ? "TEST" : "PROD"}`);
});
