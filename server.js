require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const { Pool } = require("pg");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 4000;

// =======================
// 📦 Middleware
// =======================
app.use(cors());
app.use(bodyParser.json());

// =======================
// 🔗 Connexion PostgreSQL Railway
// =======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// =======================
// 📧 Fonction pour envoyer l’email via Brevo
// =======================
async function envoyerEmailConfirmation(reservation) {
  try {
    const response = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: {
          name: "LIVABLŌM",
          email: "contact@livablom.fr" // ⚠️ Mets une adresse validée dans ton compte Brevo
        },
        to: [
          {
            email: reservation.email || "livablom59@gmail.com",
            name: reservation.nom_client || "Client"
          }
        ],
        subject: `Confirmation de réservation - ${reservation.logement}`,
        htmlContent: `
          <h2>Merci pour votre réservation !</h2>
          <p>Bonjour ${reservation.nom_client || "cher client"},</p>
          <p>Votre séjour pour <b>${reservation.logement}</b> du 
          <b>${reservation.date_debut.toISOString().split("T")[0]}</b> au 
          <b>${reservation.date_fin.toISOString().split("T")[0]}</b> a bien été confirmé.</p>
          <p>Nous avons hâte de vous accueillir.</p>
          <p>L’équipe LIVABLŌM</p>
        `
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("📧 Email envoyé avec succès via Brevo :", response.data);
  } catch (error) {
    console.error(
      "❌ Erreur d'envoi email Brevo :",
      error.response?.data || error.message
    );
  }
}

// =======================
// 💳 Création session Stripe Checkout
// =======================
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { logement, prix, date_debut, date_fin, nom_client, email } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `${logement} - Réservation`
            },
            unit_amount: prix * 100
          },
          quantity: 1
        }
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/success`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: {
        logement,
        date_debut,
        date_fin,
        nom_client,
        email
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session Stripe :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// 📩 Webhook Stripe
// =======================
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
      console.error("❌ Webhook Stripe signature invalide :", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const reservation = {
        logement: session.metadata.logement,
        date_debut: new Date(session.metadata.date_debut),
        date_fin: new Date(session.metadata.date_fin),
        nom_client: session.metadata.nom_client,
        email: session.metadata.email
      };

      try {
        // Enregistrement PostgreSQL
        const result = await pool.query(
          `INSERT INTO reservations (nom_client, email, logement, date_debut, date_fin, cree_le)
           VALUES ($1, $2, $3, $4, $5, NOW())
           RETURNING *`,
          [
            reservation.nom_client,
            reservation.email,
            reservation.logement,
            reservation.date_debut,
            reservation.date_fin
          ]
        );

        console.log("✅ Réservation enregistrée dans PostgreSQL :", result.rows[0]);

        // Sauvegarde JSON
        fs.appendFileSync(
          "bookings.json",
          JSON.stringify(reservation, null, 2) + ",\n"
        );
        console.log("📅 Réservation enregistrée dans bookings.json !");

        // Envoi Email
        await envoyerEmailConfirmation(reservation);
      } catch (error) {
        console.error("❌ Erreur lors de l'enregistrement :", error.message);
      }
    }

    res.json({ received: true });
  }
);

// =======================
// 🚀 Lancement serveur
// =======================
app.listen(PORT, () => {
  console.log(`🌍 NODE_ENV : ${process.env.NODE_ENV}`);
  console.log(`💳 STRIPE_MODE : test`);
  console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`);
});
