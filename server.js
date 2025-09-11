require("dotenv").config();
const express = require("express");
const app = express();
const stripe = require("stripe")(
  process.env.NODE_ENV === "production"
    ? process.env.STRIPE_SECRET_KEY
    : process.env.STRIPE_TEST_SECRET_KEY
);
const bodyParser = require("body-parser");
const path = require("path");

// Middleware pour le JSON standard
app.use(express.json());

// Middleware spécial pour les webhooks Stripe (raw body)
app.use(
  "/webhook",
  bodyParser.raw({ type: "application/json" })
);

// ✅ Route pour créer une session de paiement (FR)
app.post("/créer-une-session-de-paiement", async (req, res) => {
  try {
    const { date, logement, nuits, prix, email } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `Réservation ${logement} (${nuits} nuit(s))`,
              description: `Date : ${date}`,
            },
            unit_amount: prix * 100, // en centimes
          },
          quantity: 1,
        },
      ],
      customer_email: email,
      success_url: `${process.env.BASE_URL}/confirmation.html`,
      cancel_url: `${process.env.BASE_URL}/erreur.html`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Erreur création session :", error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Webhook Stripe
app.post("/webhook", (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret =
    process.env.NODE_ENV === "production"
      ? process.env.STRIPE_WEBHOOK_SECRET
      : process.env.STRIPE_WEBHOOK_TEST_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("⚠️ Erreur webhook :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Traitement de l'événement
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("💰 Paiement réussi pour :", session.customer_email);

    // Ici : envoyer l’email, bloquer la date, etc.
  }

  res.json({ received: true });
});

// ✅ Fichiers statiques (HTML/CSS/JS)
app.use(express.static(path.join(__dirname, "public")));

// ✅ Lancement serveur
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur en cours sur http://localhost:${PORT}`);
});
