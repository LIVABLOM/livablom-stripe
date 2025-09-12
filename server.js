import express from "express";
import Stripe from "stripe";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

// === Variables d'environnement & logs ===
const isLocal = process.env.NODE_ENV !== "production";
const stripeKey = isLocal
  ? process.env.STRIPE_TEST_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY;

console.log("🌍 Environnement :", process.env.NODE_ENV);
console.log(
  "🔑 Clé Stripe utilisée :",
  stripeKey ? stripeKey.slice(0, 10) + "..." : "❌ NON DEFINIE"
);

const stripe = Stripe(stripeKey);

// === Config chemins ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware classique pour tout sauf /webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    next(); // on laisse express.raw() gérer ça plus bas
  } else {
    bodyParser.json()(req, res, next);
  }
});

// === Route pour créer une session de paiement ===
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("📩 Requête reçue sur /create-checkout-session :", req.body);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: "Réservation LIVABLŌM" },
            unit_amount: 5000, // 50,00 €
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "https://livablom.fr/confirmation.html?success=true",
      cancel_url: "https://livablom.fr/confirmation.html?canceled=true",
    });

    console.log("✅ Session Stripe créée :", session.id);
    res.json({ id: session.id });
  } catch (err) {
    console.error("❌ Erreur création session Stripe :", err);
    res.status(500).json({ error: err.message });
  }
});

// === Webhook Stripe (nécessite express.raw) ===
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = isLocal
      ? process.env.STRIPE_WEBHOOK_TEST_SECRET
      : process.env.STRIPE_WEBHOOK_SECRET;

    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        webhookSecret
      );
      console.log("📦 Webhook reçu :", event.type);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        console.log("💰 Paiement confirmé pour la session :", session.id);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("❌ Erreur Webhook :", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// === Servir les fichiers statiques (confirmation.html inclus) ===
app.use(express.static(path.join(__dirname, "public")));

// === Lancer le serveur ===
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 Serveur lancé sur port ${PORT}`));
