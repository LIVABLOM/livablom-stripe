// ----- Dépendances -----
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const { Pool } = require('pg');
const ics = require('ics');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ----- Config -----
const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:4000";
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(bodyParser.json());

// ----- PostgreSQL -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ----- Stripe Checkout -----
app.post('/create-checkout-session', async (req, res) => {
  try {
    const body = req.body || {};
    const date = body.date || body.arrivalDate || body.date_debut || new Date().toISOString();
    const logement = (body.logement || 'BLOM').toString().toUpperCase();
    const nuits = parseInt(body.nuits || 1, 10);

    // prix ou total
    let totalCents = 0;
    if (body.total) totalCents = Math.round(parseFloat(body.total) * 100);
    else if (body.prix) totalCents = Math.round(parseFloat(body.prix) * 100 * nuits);
    else if (body.pricePerNight) totalCents = Math.round(parseFloat(body.pricePerNight) * 100 * nuits);
    else return res.status(400).json({ error: 'prix ou total manquant dans la requête' });

    if (process.env.TEST_PAYMENT === 'true') totalCents = 100;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `${logement} - ${nuits} nuit(s)` },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${FRONTEND_URL}/confirmation/?success=true&logement=${encodeURIComponent(logement)}&date=${encodeURIComponent(date)}&nuits=${encodeURIComponent(nuits)}&montant=${encodeURIComponent(totalCents/100)}`,
      cancel_url: `${FRONTEND_URL}/${encodeURIComponent(logement.toLowerCase())}/`,
      metadata: { date, logement, nuits, email: body.email || null }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erreur Stripe Checkout :', err.message || err);
    res.status(500).json({ error: 'Erreur lors de la création de la session de paiement.' });
  }
});

// ----- Génération du fichier ICS -----
async function getBookings(logement) {
  try {
    const result = await pool.query('SELECT * FROM bookings WHERE logement = $1', [logement]);
    return result.rows;
  } catch (err) {
    console.error('⚠️ Erreur DB, fallback JSON', err.message);
    try {
      const raw = fs.readFileSync('bookings.json', 'utf8');
      const all = JSON.parse(raw);
      return all.filter(b => b.logement === logement);
    } catch {
      return [];
    }
  }
}

app.get('/ical/:logement.ics', async (req, res) => {
  const logementParam = req.params.logement.toLowerCase();

  // normalisation : BLOM ou LIVA
  const logement = logementParam === 'blom' ? 'BLOM' : 'LIVA';

  const bookings = await getBookings(logement);

  const events = bookings.map(b => {
    const startDate = new Date(b.date);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + (b.nuits || 1));

    return {
      title: `${logement} réservé`,
      start: [
        startDate.getFullYear(),
        startDate.getMonth() + 1,
        startDate.getDate()
      ],
      end: [
        endDate.getFullYear(),
        endDate.getMonth() + 1,
        endDate.getDate()
      ],
    };
  });

  ics.createEvents(events, (err, value) => {
    if (err) {
      console.error('❌ Erreur génération ICS :', err);
      return res.status(500).send('Erreur ICS');
    }
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${logement.toLowerCase()}.ics`);
    res.send(value);
  });
});

// ----- Lancement -----
app.listen(PORT, () => {
  console.log(`🚀 livablom-stripe démarré. BACKEND_URL=${BACKEND_URL} FRONTEND_URL=${FRONTEND_URL}`);
});
