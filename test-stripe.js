require('dotenv').config();
const Stripe = require('stripe');

// ⚠️ Vérifie que tu as bien mis ta clé Stripe dans le fichier .env
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

(async () => {
  try {
    const account = await stripe.accounts.retrieve();
    console.log('Connexion Stripe OK !', account.id);
  } catch (err) {
    console.error('Erreur Stripe :', err.message);
  }
})();
