// server.js
import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import { Pool } from "pg";
import SibApiV3Sdk from "sib-api-v3-sdk";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

// Stripe
const stripeSecret =
  process.env.STRIPE_MODE === "live"
    ? process.env.STRIPE_SECRET_KEY_LIVE
    : process.env.STRIPE_SECRET_KEY_TEST;

const stripe = new Stripe(stripeSecret);

// PostgreSQL (Railway)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- API ROUTES --- //

// 1. Créer une session de paiement
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { nights, total, date } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `BLŌM - ${nights} nuit(s)`,
            },
            unit_amount: Math.round(total * 100),
          },
          quantity: 1,
        },
      ],
      success_url: "https://livablom.fr/success.html",
      cancel_url: "https://livablom.fr/cancel.html",
      metadata: {
        logement: "BLŌM",
        nights,
        date,
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur création session Stripe:", err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Webhook Stripe
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
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
      console.error("Erreur Webhook:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const logement = session.metadata.logement || "BLŌM";
      const nights = session.metadata.nights || 1;
      const dateDebut = session.metadata.date;

      try {
        // Enregistrer en BDD
        const query =
          "INSERT INTO reservations (logement, date_debut, nuits, stripe_session_id) VALUES ($1, $2, $3, $4) RETURNING *";
        const values = [logement, dateDebut, nights, session.id];
        const result = await pool.query(query, values);
        console.log("✅ Réservation enregistrée:", result.rows[0]);

        // Sauvegarde JSON locale
        const booking = {
          logement,
          dateDebut,
          nights,
          stripeId: session.id,
        };
        fs.appendFileSync("bookings.json", JSON.stringify(booking) + "\n");

        // Envoi d’email avec Brevo
        let brevoClient = SibApiV3Sdk.ApiClient.instance;
        brevoClient.authentications["api-key"].apiKey =
          process.env.BREVO_API_KEY;

        let apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
        let sendSmtpEmail = {
          sender: { name: "LIVABLŌM", email: "livablom59@gmail.com" }, // ✅ obligatoire
          to: [{ email: "livablom59@gmail.com" }],
          subject: `Nouvelle réservation ${logement}`,
          htmlContent: `<p>Nouvelle réservation confirmée :</p>
                        <ul>
                          <li>Logement : ${logement}</li>
                          <li>Date d'arrivée : ${dateDebut}</li>
                          <li>Nuits : ${nights}</li>
                        </ul>`,
        };

        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log("📧 Email envoyé avec succès !");
      } catch (err) {
        console.error("❌ Erreur traitement réservation:", err);
      }
    }

    res.json({ received: true });
  }
);

// --- START SERVER ---
app.listen(port, () => {
  console.log(`🚀 Serveur lancé sur http://localhost:${port}`);
  console.log(`💳 Stripe mode: ${process.env.STRIPE_MODE}`);
  console.log(`🔑 Clé Stripe chargée: ${stripeSecret ? "OK" : "❌ Manquante"}`);
});
