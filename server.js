require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ----- ENV -----
const PORT = process.env.PORT || 4242;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4000';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

// ----- PostgreSQL -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ----- Réservations JSON (backup local) -----
const BOOKINGS_FILE = './bookings.json';
function loadBookings() {
  if (fs.existsSync(BOOKINGS_FILE)) {
    return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
  }
  return { BLOM: [], LIVA: [] };
}
function saveBooking(logement, start, end) {
  const data = loadBookings();
  if (!data[logement]) data[logement] = [];
  data[logement].push({ start, end });
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(data, null, 2));
}

// ----- Email (Brevo) -----
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  auth: {
    user: process.env.BREVO_LOGIN,
    pass: process.env.BREVO_KEY,
  },
});

// ----- Stripe Checkout -----
app.post('/create-checkout-session', async (req, res) => {
  try {
    const body = req.body || {};
    const date = body.date || new Date().toISOString().split('T')[0];
    const logement = (body.logement || 'BLOM').toUpperCase();
    const nuits = parseInt(body.nuits || 1, 10);

    let totalCents = 0;
    if (body.total) totalCents = Math.round(parseFloat(body.total) * 100);
    else if (body.prix) totalCents = Math.round(parseFloat(body.prix) * 100 * nuits);
    else return res.status(400).json({ error: 'Prix manquant' });

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
      metadata: { date, logement, nuits, montant: totalCents/100, email: body.email || null }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erreur Stripe Checkout :', err.message);
    res.status(500).json({ error: 'Erreur création session paiement' });
  }
});

// ----- Stripe Webhook -----
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook invalide :', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { logement, date, nuits, montant, email } = session.metadata;

    const start = new Date(date);
    const end = new Date(start);
    end.setDate(start.getDate() + parseInt(nuits, 10));

    try {
      await pool.query(
        'INSERT INTO reservations (logement, date_debut, date_fin, nuits, montant, email) VALUES ($1,$2,$3,$4,$5,$6)',
        [logement, start, end, nuits, montant, email]
      );
      console.log(`✅ Réservation enregistrée en DB: ${logement} du ${date} (${nuits} nuits)`);

      saveBooking(logement, start.toISOString().split('T')[0], end.toISOString().split('T')[0]);

      if (email) {
        await transporter.sendMail({
          from: `"LIVABLŌM" <contact@livablom.fr>`,
          to: email,
          subject: "Confirmation de réservation LIVABLŌM",
          text: `Votre réservation pour ${logement} est confirmée du ${date} pour ${nuits} nuit(s). Montant payé: ${montant} €`,
        });
        console.log("📧 Email envoyé:", email);
      }
    } catch (err) {
      console.error("❌ Erreur DB:", err.message);
    }
  }

  res.send();
});

// ----- iCal dynamique -----
app.get('/ical/:logement.ics', async (req, res) => {
  const logement = req.params.logement.toUpperCase();

  try {
    // DB
    const pgRes = await pool.query(
      'SELECT date_debut, date_fin FROM reservations WHERE logement=$1 AND date_fin >= now()',
      [logement]
    );
    const pgBookings = pgRes.rows.map(r => ({
      start: r.date_debut.toISOString().split('T')[0],
      end: r.date_fin.toISOString().split('T')[0]
    }));

    // Local JSON
    let localBookings = [];
    if (fs.existsSync(BOOKINGS_FILE)) {
      const local = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8') || '{}');
      localBookings = (local[logement] || []).filter(b => new Date(b.end) >= new Date());
    }

    const allBookings = [...pgBookings, ...localBookings];

    // Génération iCal
    let icalContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//LIVABLŌM//Calendrier ${logement}//FR
CALSCALE:GREGORIAN
METHOD:PUBLISH
`;
    allBookings.forEach(b => {
      icalContent += `BEGIN:VEVENT
SUMMARY:Réservé
DTSTART;VALUE=DATE:${b.start.replace(/-/g, '')}
DTEND;VALUE=DATE:${b.end.replace(/-/g, '')}
STATUS:CONFIRMED
DESCRIPTION:Réservation ${logement}
END:VEVENT
`;
    });
    icalContent += 'END:VCALENDAR';

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.send(icalContent);
  } catch (err) {
    console.error('❌ Erreur génération iCal:', err.message);
    res.status(500).send('Erreur serveur');
  }
});

// ----- Start -----
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur ${PORT}`);
  console.log(`   → iCal BLOM : ${BACKEND_URL}/ical/BLOM.ics`);
  console.log(`   → iCal LIVA : ${BACKEND_URL}/ical/LIVA.ics`);
});
