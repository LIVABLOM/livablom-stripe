// email.js
const SibApiV3Sdk = require("sib-api-v3-sdk");

const brevoApiKey = process.env.BREVO_API_KEY;
const brevoSender = process.env.BREVO_SENDER || "contact@livablom.fr";
const brevoSenderName = process.env.BREVO_SENDER_NAME || "LIVABLŌM";
const brevoAdminTo = process.env.BREVO_TO || "livablom59@gmail.com";

let tranEmailApi = null;

if (brevoApiKey) {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications["api-key"].apiKey = brevoApiKey;
  tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();
} else {
  console.warn("⚠️ Clé Brevo introuvable, emails non envoyés.");
}

async function sendConfirmationEmail({ name, email, logement, startDate, endDate, personnes }) {
  if (!tranEmailApi) return;

  // --- Email client ---
  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email, name: name || "" }],
      subject: `Confirmation de réservation ${logement} - LIVABLŌM`,
      htmlContent: `
        <div style="font-family:Arial, sans-serif; color:#222;">
          <h3>Bonjour ${name || ""},</h3>
          <p>Merci pour votre réservation sur <strong>LIVABLŌM</strong>.</p>
          <p><strong>Logement :</strong> ${logement}</p>
          <p><strong>Arrivée :</strong> ${startDate}</p>
          <p><strong>Départ :</strong> ${endDate} (au plus tard 11h)</p>
          <p><strong>Nombre de personnes :</strong> ${personnes || ""}</p>
          <p>Cordialement,<br/>L’équipe LIVABLŌM</p>
        </div>
      `,
    });
    console.log("✉️ Email client envoyé :", email);
  } catch (err) {
    console.error("❌ Erreur email client :", err);
  }

  // --- Email admin ---
  if (brevoAdminTo) {
    try {
      await tranEmailApi.sendTransacEmail({
        sender: { name: brevoSenderName, email: brevoSender },
        to: [{ email: brevoAdminTo, name: "LIVABLŌM Admin" }],
        subject: `Nouvelle réservation - ${logement}`,
        htmlContent: `
          <div style="font-family:Arial, sans-serif; color:#222;">
            <h3>Nouvelle réservation</h3>
            <p><strong>Nom :</strong> ${name || ""}</p>
            <p><strong>Email :</strong> ${email || ""}</p>
            <p><strong>Logement :</strong> ${logement}</p>
            <p><strong>Arrivée :</strong> ${startDate}</p>
            <p><strong>Départ :</strong> ${endDate} (au plus tard 11h)</p>
            <p><strong>Nombre de personnes :</strong> ${personnes || ""}</p>
          </div>
        `,
      });
      console.log("✉️ Email admin envoyé à :", brevoAdminTo);
    } catch (err) {
      console.error("❌ Erreur email admin :", err);
    }
  }
}

module.exports = { sendConfirmationEmail };
