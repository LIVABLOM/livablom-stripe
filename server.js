const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const stripeLib = require("stripe");

const app = express();

// Middleware
app.use(cors());
app.use(express.static("public"));
app.use(bodyParser.json());

// === Gestion des clés Stripe selon l'environnement ===
const isLocal = process.env.NODE_ENV !== "production";
const stripeKey = isLocal
  ? process.env.STRIPE_TEST_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY;

console.log("🌍 Environnement :", process.env.NODE_ENV);
console.log(
  "🔑 Clé Stripe utilisée :",
  stripeKey ? stripeKey.slice(0, 10) + "..." : "❌ NON DEFINIE"
);

const stripe = stripeLib(stripeKey);

// === Route pour créer une session Checkout ===
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: "Réservation LIVABLŌM" },
            unit_amount: 5000, // prix en centimes (50€)
          },
          quantity: 1,
        },
      ],
      success_url: `${req.protocol}://${req.get("host")}/confirmation.html?success=true`,
      cancel_url: `${req.protocol}://${req.get("host")}/confirmation.html?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur Stripe Checkout :", err);
    res.status(500).json({ error: err.message });
  }
});

// === Webhook Stripe ===
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = isLocal
    ? process.env.STRIPE_WEBHOOK_TEST_SECRET
    : process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("⚠️ Erreur webhook :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("✅ Événement Stripe reçu :", event.type);
  res.json({ received: true });
});

// Lancer serveur
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur port ${PORT}`);
});
