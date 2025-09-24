// server.js (CommonJS)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// ----- Config / URLs -----
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://livablom.fr';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const CALENDAR_URL = process.env.CALENDAR_URL || ''; // si tu veux prioriser le proxy-calendar

// ----- Stripe keys (test/live) -----
const STRIPE_MODE = process.env.STRIPE_MODE || 'test';
const STRIPE_KEY = STRIPE_MODE === 'live' ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_KEY;
const STRIPE_WEBHOOK_SECRET = STRIPE_MODE === 'live' ? process.env.STRIPE_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_TEST_SECRET;

const stripe = Stripe(STRIPE_KEY || ''); // si vide, Stripe throwera plus tard

// ----- Brevo -----
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER = process.env.BREVO_SENDER || ''; // ex: contact@livablom.fr (doit être validée dans Brevo)
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'LIVABLŌM';
const BREVO_TO = process.env.BREVO_TO || ''; // ex: livablom59@gmail.com

// ----- Postgres (Railway) -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || '',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Vérifie la connexion DB (optionnel)
pool.connect().then(client => {
  client.release();
  console.log('✅ PostgreSQL connecté.');
}).catch(err => {
  console.warn('⚠️ Impossible de se connecter à PostgreSQL:', err.message || err);
});

// Logging config
console.log('DATABASE_URL :', process.env.DATABASE_URL ? 'OK' : 'MISSING');
console.log('🌍 NODE_ENV :', process.env.NODE_ENV || 'development');
console.log('💳 STRIPE_MODE :', STRIPE_MODE);
console.log('🔑 STRIPE_KEY :', STRIPE_KEY ? 'OK' : 'MISSING');
console.log('🔒 STRIPE_WEBHOOK_SECRET :', STRIPE_WEBHOOK_SECRET ? 'OK' : 'MISSING');
console.log('📧 BREVO configured :', BREVO_API_KEY ? 'OK' : 'NO API KEY', ' sender:', BREVO_SENDER || 'MISSING');
console.log('📆 CALENDAR_URL :', CALENDAR_URL ? CALENDAR_URL : 'PAS DEFINI (fallback local/Postgres)');

// ----- Helpers -----
async function insertReservation(logement, email, dateDebutISO, dateFinISO, montantCents = null) {
  try {
    const result = await pool.query(
      `INSERT INTO reservations (logement, email, date_debut, date_fin, montant, cree_le)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING *`,
      [logement, email, dateDebutISO, dateFinISO, montantCents]
    );
    console.log('✅ Réservation enregistrée dans PostgreSQL :', result.rows[0]);
    return result.rows[0];
  } catch (err) {
    console.error('❌ Erreur PostgreSQL :', err.message || err);
    throw err;
  }
}

function writeBookingJson(logement, startISO, endISO, email) {
  try {
    const filePath = path.join(__dirname, 'bookings.json');
    let bookings = {};
    if (fs.existsSync(filePath)) {
      bookings = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
    }
    if (!bookings[logement]) bookings[logement] = [];
    bookings[logement].push({
      title: `Réservé (${email || 'client'})`,
      start: startISO.split('T')[0],
      end: endISO.split('T')[0]
    });
    fs.writeFileSync(filePath, JSON.stringify(bookings, null, 2));
    console.log('📅 Réservation enregistrée dans bookings.json');
  } catch (err) {
    console.error('❌ Erreur écriture bookings.json :', err.message || err);
  }
}

function formatDateForICS(date) {
  // renvoie YYYYMMDD (valeur date-only)
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = date.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

// ----- Middlewares -----
app.use(cors());
app.use(express.static('public')); // si tu as des fichiers statiques

// IMPORTANT: webhook Stripe must be before express.json
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Erreur webhook signature :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Gère checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const date = metadata.date || new Date().toISOString();
    const logement = (metadata.logement || 'BLŌM').toString();
    const nuits = parseInt(metadata.nuits || 1, 10);
    const email = metadata.email || session.customer_details?.email || null;
    const montant = session.amount_total || null;

    console.log(`✅ Webhook: paiement confirmé pour ${logement} - ${nuits} nuit(s) - ${date}`);

    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + nuits);

    // 1) Insert en PostgreSQL
    try {
      await insertReservation(logement, email, startDate.toISOString(), endDate.toISOString(), montant);
    } catch (err) {
      console.error('Erreur insertReservation (webhook):', err.message || err);
    }

    // 2) Backup local bookings.json
    try {
      writeBookingJson(logement, startDate.toISOString(), endDate.toISOString(), email);
    } catch (err) {
      console.error('Erreur backup bookings.json:', err.message || err);
    }

    // 3) Envoi email via Brevo (si configuré)
    if (BREVO_API_KEY && BREVO_SENDER && BREVO_TO) {
      try {
        const payload = {
          sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER },
          to: [{ email: BREVO_TO }],
          subject: `Nouvelle réservation : ${logement}`,
          textContent: `Réservation confirmée pour ${logement}\nDate : ${startDate.toISOString().split('T')[0]}\nNuits : ${nuits}\nEmail client : ${email || 'non fourni'}`,
          htmlContent: `<p>Réservation confirmée pour <strong>${logement}</strong></p>
                        <p>Date : ${startDate.toISOString().split('T')[0]}</p>
                        <p>Nuits : ${nuits}</p>
                        <p>Email client : ${email || 'non fourni'}</p>`
        };
        const r = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
          headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' }
        });
        console.log('📧 Email Brevo envoyé:', r.data || r.status);
      } catch (err) {
        console.error('❌ Erreur envoi email Brevo :', err.response ? err.response.data : err.message);
      }
    } else {
      console.warn('⚠️ Brevo non configuré (API_KEY / SENDER / TO manquant)');
    }
  }

  // Toujours répondre rapidement à Stripe
  res.json({ received: true });
});

// Après le webhook raw, on active express.json pour les autres routes
app.use(express.json());

// ----- Route : récupérer réservations (frontend) -----
app.get('/api/reservations/:logement', async (req, res) => {
  const logement = (req.params.logement || '').toUpperCase();
  if (!logement) return res.status(400).json({ error: 'Logement requis' });

  // Priorité : CALENDAR_URL (proxy-calendar)
  if (CALENDAR_URL) {
    try {
      const url = `${CALENDAR_URL}/api/reservations/${encodeURIComponent(logement)}`;
      const r = await axios.get(url);
      return res.json(r.data);
    } catch (err) {
      console.error('Erreur proxy vers CALENDAR_URL :', err.message || err);
      // fallback below
    }
  }

  // Sinon : lire PostgreSQL + bookings.json local
  try {
    const result = await pool.query(
      `SELECT date_debut, date_fin, email FROM reservations WHERE UPPER(logement) = $1 ORDER BY date_debut`,
      [logement]
    );
    let events = result.rows.map(r => ({
      title: `Réservé (${r.email || 'client'})`,
      start: (r.date_debut instanceof Date ? r.date_debut : new Date(r.date_debut)).toISOString().split('T')[0],
      end: (r.date_fin instanceof Date ? r.date_fin : new Date(r.date_fin)).toISOString().split('T')[0]
    }));

    // Ajouter bookings.json si présent
    const filePath = path.join(__dirname, 'bookings.json');
    if (fs.existsSync(filePath)) {
      const local = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
      if (local[logement]) events = events.concat(local[logement]);
    }

    return res.json(events);
  } catch (err) {
    console.error('Erreur récupération réservations:', err.message || err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ----- Route iCal dynamique pour Booking / Airbnb -----
app.get('/ical/:logement.ics', async (req, res) => {
  const logement = (req.params.logement || '').toUpperCase();
  if (!logement) return res.status(400).send('Logement requis');

  try {
    const result = await pool.query(
      `SELECT date_debut, date_fin, email, montant FROM reservations WHERE UPPER(logement) = $1 ORDER BY date_debut`,
      [logement]
    );

    // Construire ICS
    let ics = '';
    ics += 'BEGIN:VCALENDAR\r\n';
    ics += 'VERSION:2.0\r\n';
    ics += 'PRODID:-//LIVABLŌM//Reservation Calendar//FR\r\n';
    ics += `NAME:Calendrier ${logement} - LIVABLŌM\r\n`;
    ics += `X-WR-CALNAME:Calendrier ${logement} - LIVABLŌM\r\n`;
    ics += 'CALSCALE:GREGORIAN\r\n';
    ics += 'METHOD:PUBLISH\r\n';

    result.rows.forEach((r, idx) => {
      const start = new Date(r.date_debut);
      const end = new Date(r.date_fin); // end est exclusive pour all-day event
      const dtstart = formatDateForICS(start);
      const dtend = formatDateForICS(end);
      const uid = `livablom-${logement}-${idx}-${Date.now()}@livablom.fr`;
      const summary = `Réservé - ${logement}`;
      const description = `Réservation (montant: ${r.montant ? (r.montant/100)+'€' : 'N/A'}) - email: ${r.email || 'N/A'}`;

      ics += 'BEGIN:VEVENT\r\n';
      ics += `UID:${uid}\r\n`;
      ics += `DTSTAMP:${formatDateForICS(new Date())}T000000Z\r\n`;
      ics += `DTSTART;VALUE=DATE:${dtstart}\r\n`;
      ics += `DTEND;VALUE=DATE:${dtend}\r\n`;
      ics += `SUMMARY:${summary}\r\n`;
      ics += `DESCRIPTION:${description}\r\n`;
      ics += 'TRANSP:OPAQUE\r\n';
      ics += 'END:VEVENT\r\n';
    });

    ics += 'END:VCALENDAR\r\n';

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${logement}.ics"`);
    return res.send(ics);
  } catch (err) {
    console.error('Erreur génération iCal :', err.message || err);
    return res.status(500).send('Erreur iCal');
  }
});

// ----- Create Checkout Session (frontend calls this) -----
app.post('/create-checkout-session', async (req, res) => {
  try {
    const body = req.body || {};
    const date = body.date || body.arrivalDate || body.date_debut || new Date().toISOString();
    const logement = (body.logement || 'BLŌM').toString();
    const nuits = parseInt(body.nuits || 1, 10);

    // calcul du montant total (en cents)
    let totalCents = 0;
    if (body.total) totalCents = Math.round(parseFloat(body.total) * 100);
    else if (body.prix) totalCents = Math.round(parseFloat(body.prix) * 100 * nuits);
    else if (body.pricePerNight) totalCents = Math.round(parseFloat(body.pricePerNight) * 100 * nuits);
    else return res.status(400).json({ error: 'prix ou total manquant dans la requête' });

    // option test: forcer 1€
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

    return res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erreur Stripe Checkout :', err.response?.data || err.message || err);
    return res.status(500).json({ error: 'Erreur lors de la création de la session de paiement.' });
  }
});

// ----- Start server -----
app.listen(PORT, () => {
  console.log(`🚀 livablom-stripe démarré. BACKEND_URL=${BACKEND_URL} FRONTEND_URL=${FRONTEND_URL}`);
  console.log(`   → iCal (ex): ${BACKEND_URL}/ical/BLŌM.ics`);
});
