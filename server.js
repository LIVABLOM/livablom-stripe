require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const fs = require('fs');
const { Pool } = require('pg');
const fetch = require('node-fetch');

const app = express();

// ---------------- CONFIG ----------------
const STRIPE_KEY = process.env.STRIPE_TEST_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_TEST_SECRET;
const stripe = Stripe(STRIPE_KEY);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Brevo
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER = process.env.BREVO_SENDER || 'contact@livablom.fr';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'LIVABLŌM';

console.log('🌍 NODE_ENV :', process.env.NODE_ENV);
console.log('💳 STRIPE_KEY :', STRIPE_KEY ? 'OK' : 'MISSING');
console.log('📧 BREVO configured :', BREVO_API_KEY ? 'OK' : 'MISSING');

// ---------------- MIDDLEWARE ----------------
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ---------------- ROUTES ----------------
app.get('/', (req, res) => {
  res.send('✅ LIVABLŌM Stripe backend is running');
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { logement, dateDebut, dateFin, prix, email } = req.body;

    if (!logement || !dateDebut || !dateFin || !prix) {
      return res.status(400).json({ error: 'Champs manquants' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `${logement} - Séjour` },
          unit_amount: prix * 100,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${FRONTEND_URL}/success.html`,
      cancel_url: `${FRONTEND_URL}/cancel.html`,
      metadata: { logement, dateDebut, dateFin, email }
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Erreur création session :', err);
    res.status(500).json({ error: 'Erreur création session' });
  }
});

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Erreur webhook :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const logement = session.metadata.logement;
    const dateDebut = session.metadata.dateDebut;
    const dateFin = session.metadata.dateFin;
    const customerEmail = session.metadata.email || session.customer_details?.email || 'inconnu';

    console.log(`✅ Paiement confirmé pour ${logement} - ${dateDebut}`);

    // Enregistrer en BDD PostgreSQL
    try {
      const client = await pool.connect();
      const result = await client.query(
        `INSERT INTO bookings (logement, date_debut, date_fin, email)
         VALUES ($1, $2, $3, $4)
         RETURNING id, logement, date_debut, date_fin, email, cree_le`,
        [logement, dateDebut, dateFin, customerEmail]
      );
      client.release();
      console.log('✅ Réservation enregistrée dans PostgreSQL :', result.rows[0]);

      // Backup local bookings.json
      const bookingsFile = './bookings.json';
      let bookings = [];
      if (fs.existsSync(bookingsFile)) bookings = JSON.parse(fs.readFileSync(bookingsFile));
      bookings.push(result.rows[0]);
      fs.writeFileSync(bookingsFile, JSON.stringify(bookings, null, 2));
      console.log('📅 Réservation enregistrée dans bookings.json');
    } catch (err) {
      console.error('❌ Erreur PostgreSQL :', err);
    }

    // Envoi email via Brevo
    if (BREVO_API_KEY) {
      try {
        const payload = {
          sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER },
          to: [
            { email: 'contact@livablom.fr' },
            { email: 'livablom59@gmail.com' }
          ],
          subject: `Nouvelle réservation : ${logement}`,
          textContent: `Nouvelle réservation confirmée :\nLogement : ${logement}\nDates : ${dateDebut} → ${dateFin}\nClient : ${customerEmail}`
        };

        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ Erreur Brevo :', errorText);
        } else {
          console.log('📧 Email envoyé via Brevo à contact@livablom.fr + livablom59@gmail.com');
        }
      } catch (err) {
        console.error('❌ Erreur d\'envoi email Brevo :', err);
      }
    } else {
      console.log('⚠️ Brevo non configuré (BREVO_API_KEY manquant)');
    }
  }

  res.json({ received: true });
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 livablom-stripe démarré sur http://localhost:${PORT}`);
});
