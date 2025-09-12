import express from "express";
import Stripe from "stripe";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// === Détection de l'environnement ===
const isProduction = process.env.NODE_ENV === "production";
console.log("🌍 Environnement :", isProduction ? "production" : "développement");

// === Initialisation de Stripe avec la bonne clé ===
const stripeSecretKey = isProduction
  ? process.env.STRIPE_SECRET_KEY        // clé live
  : process.env.STRIPE_TEST_KEY;         // clé test

if (!stripeSecretKey) {
  console.error("❌ ERREUR : aucune clé Stripe trouvée !");
} else {
  console.log("🔑 Clé Stripe utilisée :", stripeSecretKey.startsWith("sk_live_") ? "LIVE ✅" : "TEST 🧪");
}

const stripe = new Stripe(stripeSecretKey);

// === Middleware ===
app.use(bodyParser.json());
app.use(express.static("public"));

// === Route création session de paiement ===
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: "Réservation LIVABLŌM" },
            unit_amount: 15000, // 150 €
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "https://livablom.fr/confirmation.html?success=true",
      cancel_url: "https://livablom.fr/confirmation.html?canceled=true",
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error("❌ Erreur Stripe :", err.message);
    res.status(500).json({ error: "Erreur lors de la création de la session" });
  }
});

// === Route webhook Stripe ===
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    const webhookSecret = isProduction
      ? process.env.STRIPE_WEBHOOK_SECRET
      : process.env.STRIPE_WEBHOOK_TEST_SECRET;

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error("❌ Erreur Webhook :", err.message);
      return res.sendStatus(400);
    }

    console.log("✅ Événement Stripe reçu :", event.type);
    res.json({ received: true });
  }
);

// === Lancement serveur ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur port ${PORT}`);
});
