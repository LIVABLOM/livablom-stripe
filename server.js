require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const stripe = require("stripe");

const app = express();

// ----------------------
// 1. Configuration
// ----------------------
const isDev = process.env.NODE_ENV === "development" || process.env.TEST_PAYMENT === "true";
const stripeSecretKey = isDev ? process.env.STRIPE_SECRET_KEY_TEST : process.env.STRIPE_SECRET_KEY_LIVE;
const stripeClient = stripe(stripeSecretKey);

// Port Railway ou local
const PORT = process.env.PORT || 3000;

// ----------------------
// 2. Middleware
// ----------------------

// 👉 IMPORTANT : le webhook a besoin du "raw body"
// donc on configure express différemment pour /webhook
app.use(
  (req, res, next) => {
    if (req.originalUrl === "/webhook") {
      next();
    } else {
      bodyParser.json()(req, res, next);
    }
  }
);

app.use(cors());

// ----------------------
// 3. Routes
// ----------------------

// ✅ Création d’une session de paiement
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: "Réservation LIVABLŌM" },
            unit_amount: 15000, // montant en centimes (150€)
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${req.headers.origin}/success`,
      cancel_url: `${req.headers.origin}/cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur création session :", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Webhook Stripe
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    try {
      const event = stripeClient.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      // Exemple : gestion paiement réussi
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        console.log("💰 Paiement réussi :", session.id);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("⚠️ Erreur webhook :", err.message);
      res.status(400).send(`Webhook error: ${err.message}`);
    }
  }
);

// ----------------------
// 4. Lancement serveur
// ----------------------
app.listen(PORT, () => {
  console.log(`🌍 Environnement : ${isDev ? "development (TEST)" : "production (LIVE)"}`);
  console.log(`🔑 Clé Stripe utilisée : ${isDev ? "TEST ✅" : "LIVE ✅"}`);
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});
