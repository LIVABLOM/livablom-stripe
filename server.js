// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Stripe = require("stripe");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const ical = require("node-ical"); // <--- ajout

dotenv.config();

const app = express();

// ⚡ Config
const PORT = process.env.PORT || 4242;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://livablom.fr";
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Connexion PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ URLs iCal (remplacer par tes vrais liens Airbnb/Booking)
const ICAL_URLS = {
  BLOM: [
    "https://www.airbnb.com/calendar/ical/xxxxx.ics",
    "https://www.booking.com/calendar/ical/yyyyy.ics",
  ],
  LIVA: [
    "https://www.airbnb.com/calendar/ical/zzzzz.ics",
  ],
};

// ✅ CORS autorisé uniquement depuis ton frontend
app.use(
  cors({
    origin: FRONTEND_URL,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// ✅ Stripe Webhook → doit lire le raw body
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("⚠️ Erreur webhook signature:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      try {
        const logement = session.metadata.logement;
        const date_debut = session.metadata.date;
        const nuits = parseInt(session.metadata.nuits, 10);
        const dateFin = new Date(date_debut);
        dateFin.setDate(dateFin.getDate() + nuits);

        await pool.query(
          `INSERT INTO reservations (logement, date_debut, date_fin, montant) 
           VALUES ($1, $2, $3, $4)`,
          [logement, date_debut, dateFin, session.amount_total / 100]
        );

        console.log("✅ Réservation enregistrée :", logement, date_debut);
      } catch (err) {
        console.error("❌ Erreur lors de l'enregistrement :", err);
      }
    }

    res.json({ received: true });
  }
);

// ✅ Parser JSON (après /webhook)
app.use(bodyParser.json());

// ✅ Créer une session Stripe Checkout
app.post("/create-checkout-session", async (req, res) => {
  const { date, logement, nuits, prix } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `${logement} - Réservation` },
            unit_amount: prix * 100,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${FRONTEND_URL}/success`,
      cancel_url: `${FRONTEND_URL}/cancel`,
      metadata: { date, logement, nuits },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur Stripe:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ API pour récupérer les réservations locales + externes
app.get("/api/reservations/:logement", async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  try {
    // --- 1. Récupérer réservations locales (Postgres)
    const result = await pool.query(
      "SELECT date_debut, date_fin FROM reservations WHERE logement = $1",
      [logement]
    );
    const localRes = result.rows.map(r => ({
      start: new Date(r.date_debut).toISOString().split("T")[0],
      end: new Date(r.date_fin).toISOString().split("T")[0],
      source: "Stripe",
    }));

    // --- 2. Récupérer réservations externes (iCal)
    const urls = ICAL_URLS[logement] || [];
    let externalRes = [];

    for (const url of urls) {
      try {
        const data = await ical.async.fromURL(url);
        for (const k in data) {
          const ev = data[k];
          if (ev.type === "VEVENT") {
            externalRes.push({
              start: ev.start.toISOString().split("T")[0],
              end: ev.end.toISOString().split("T")[0],
              source: "iCal",
            });
          }
        }
      } catch (err) {
        console.error(`❌ Erreur iCal (${url}):`, err.message);
      }
    }

    // --- 3. Fusionner et renvoyer
    const allRes = [...localRes, ...externalRes];
    res.json(allRes);
  } catch (err) {
    console.error("❌ Erreur récupération réservations :", err);
    res.status(500).json({ error: "Impossible de récupérer les réservations" });
  }
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(
    `🚀 livablom-stripe démarré. BACKEND_URL=${BACKEND_URL} FRONTEND_URL=${FRONTEND_URL}`
  );
});
