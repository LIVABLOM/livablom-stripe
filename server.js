// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Stripe = require("stripe");
const dotenv = require("dotenv");
const { Pool } = require("pg");

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
        // Récupérer les metadata
        const logement = session.metadata.logement;
        const date_debut = session.metadata.date;
        const nuits = parseInt(session.metadata.nuits, 10);
        const dateFin = new Date(date_debut);
        dateFin.setDate(dateFin.getDate() + nuits);

        // Sauvegarde en BDD
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

// ✅ API pour récupérer les réservations depuis PostgreSQL
app.get("/api/reservations/:logement", async (req, res) => {
  try {
    const logement = req.params.logement.toUpperCase();
    const result = await pool.query(
      "SELECT date_debut, date_fin FROM reservations WHERE logement = $1",
      [logement]
    );
    res.json(result.rows);
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
