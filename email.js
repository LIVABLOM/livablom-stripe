const SibApiV3Sdk = require('sib-api-v3-sdk');

let brevoApiKey = process.env.CLÉ_API_BREVO || process.env.BREVO_API_KEY;
let brevoSender = process.env.BREVO_SENDER || "contact@livablom.fr";
let brevoSenderName = process.env.BREVO_SENDER_NAME || "LIVABLOM";
let brevoAdminTo = process.env.BREVO_TO || "livablom59@gmail.com";

if (brevoApiKey) {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications['api-key'].apiKey = brevoApiKey;
}

async function sendConfirmationEmail({ name, email, logement, startDate, endDate, personnes }) {
  if (!brevoApiKey) return;

  const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

  // Mail client
  try {
    await tranEmailApi.sendTransacEmail({
      sender: { name: brevoSenderName, email: brevoSender },
      to: [{ email, name: name || "" }],
      subject: `Confirmation réservation ${logement} - LIVABLŌM`,
      htmlContent: `
        <div style="font-family:Arial,sans-serif;color:#222;">
          <h3>Bonjour ${name || ""},</h3>
          <p>Merci pour votre réservation sur <strong>LIVABLŌM</strong>.</p>
          <p><strong>Logement :</strong> ${logement}</p>
          <p><strong>Dates :</strong> ${startDate} au ${endDate} (départ avant 11H)</p>
          <p><strong>Nombre de personnes :</strong> ${personnes || ""}</p>
          <p>Cordialement,<br>L’équipe LIVABLŌM</p>
        </div>
      `
    });
    console.log("✉️ Email client envoyé :", email);
  } catch (err) {
    console.error("❌ Erreur email client :", err);
  }

  // Mail admin
  if (brevoAdminTo) {
    try {
      await tranEmailApi.sendTransacEmail({
        sender: { name: brevoSenderName, email: brevoSender },
        to: [{ email: brevoAdminTo, name: "LIVABLŌM Admin" }],
        subject: `Nouvelle réservation - ${logement}`,
        htmlContent: `
          <div style="font-family:Arial,sans-serif;color:#222;">
            <h3>Nouvelle réservation</h3>
            <p><strong>Nom :</strong> ${name || ""}</p>
            <p><strong>Email :</strong> ${email || ""}</p>
            <p><strong>Logement :</strong> ${logement}</p>
            <p><strong>Dates :</strong> ${startDate} au ${endDate}</p>
            <p><strong>Nombre de personnes :</strong> ${personnes || ""}</p>
          </div>
        `
      });
      console.log("✉️ Email admin envoyé à :", brevoAdminTo);
    } catch (err) {
      console.error("❌ Erreur email admin :", err);
    }
  }
}

module.exports = { sendConfirmationEmail };
