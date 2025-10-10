// server.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// --- Transport mail (Brevo / SMTP) ---
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  auth: {
    user: process.env.BREVO_USER,
    pass: process.env.BREVO_PASS,
  },
});

// --- Fonction d’envoi d’email de confirmation ---
async function sendConfirmationEmail(formData, checkoutSession) {
  const {
    email,
    nom,
    prenom,
    logement,
    dateArrivee,
    dateDepart,
    message,
  } = formData;

  // déterminer le type de logement
  const isBlom = logement && logement.toLowerCase().includes("blom");
  const logementNom = isBlom ? "BLŌM – Espace bien-être" : "LIVA – Logement tout équipé";

  const htmlContent = `
  <div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 30px; color: #333;">
    <div style="max-width: 600px; margin: auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
      <div style="background: #000; color: #fff; text-align: center; padding: 25px;">
        <h1 style="margin: 0; font-size: 26px; letter-spacing: 2px;">LIVABLŌM</h1>
        <p style="margin: 5px 0 0; font-size: 14px;">Votre réservation est confirmée ✨</p>
      </div>
      <div style="padding: 25px; line-height: 1.6;">
        <h2 style="font-size: 20px; margin-bottom: 15px;">Bonjour ${prenom} ${nom},</h2>
        <p>Nous avons le plaisir de confirmer votre réservation pour <strong>${logementNom}</strong>.</p>
        <table style="width: 100%; margin: 20px 0; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0;"><strong>Arrivée :</strong></td>
            <td>${dateArrivee}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0;"><strong>Départ :</strong></td>
            <td>${dateDepart} <em>(départ au plus tard à 11h)</em></td>
          </tr>
        </table>
        ${
          message
            ? `<p><strong>Message laissé :</strong><br>${message}</p>`
            : ""
        }
        <p>Un reçu Stripe a été envoyé à <strong>${email}</strong> pour le paiement effectué.</p>
        <p style="margin-top: 20px;">Nous vous remercions pour votre confiance et avons hâte de vous accueillir !</p>
        <p style="margin-top: 30px;">Bien à vous,<br><strong>L’équipe LIVABLŌM</strong></p>
      </div>
      <div style="background: #f1f1f1; text-align: center; padding: 15px; font-size: 12px; color: #555;">
        <p style="margin: 0;">© 2025 LIVABLŌM – Séjours bien-être & confort</p>
        <p style="margin: 4px 0 0;">Contact : livablom59@gmail.com</p>
      </div>
    </div>
  </div>`;

  await transporter.sendMail({
    from: '"LIVABLŌM" <livablom59@gmail.com>',
    to: email,
    bcc: "livablom59@gmail.com",
    subject: "Confirmation de votre réservation – LIVABLŌM",
    html: htmlContent,
  });

  console.log(`📧 Email de confirmation envoyé à ${email}`);
}

// --- Route : création de session Stripe ---
app.post("/create-checkout-session", async (req, res) => {
  try {
    const formData = req.body;
    const { logement, email } = formData;

    if (!email || !logement) {
      return res.status(400).json({ error: "Email ou logement manquant" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: logement },
            unit_amount: formData.montant * 100,
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONT_URL}/success.html`,
      cancel_url: `${process.env.FRONT_URL}/cancel.html`,
      metadata: {
        logement,
        email,
        nom: formData.nom,
        prenom: formData.prenom,
        dateArrivee: formData.dateArrivee,
        dateDepart: formData.dateDepart,
        message: formData.message || "",
      },
    });

    console.log("✅ Session Stripe créée :", session.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création session :", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Webhook Stripe ---
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("❌ Erreur signature Webhook :", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const meta = session.metadata;

      try {
        await sendConfirmationEmail(meta, session);
      } catch (err) {
        console.error("Erreur envoi email confirmation :", err);
      }
    }

    res.json({ received: true });
  }
);

// --- Lancer le serveur ---
app.listen(port, () => {
  console.log(`🚀 Serveur Stripe + Mail en ligne sur le port ${port}`);
});
