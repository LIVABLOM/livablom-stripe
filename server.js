// server.js (CommonJS)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const Stripe = require('stripe');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// ----- Config (env) -----
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://livablom.fr';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const CALENDAR_URL = process.env.CALENDAR_URL || ''; // si tu as encore un proxy calendar

const STRIPE_MODE = process.env.STRIPE_MODE || 'test';
const STRIPE_KEY = STRIPE_MODE === 'live' ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_KEY;
const STRIPE_WEBHOOK_SECRET = STRIPE_MODE === 'live' ? process.env.STRIPE_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_TEST_SECRET;

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER = process.env.BREVO_SENDER; // ex: contact@livablom.fr (doit être vérifié dans Brevo)
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'LIVABLŌM';
const BREVO_TO = process.env.BREVO_TO; // ex: livablom59@gmail.com

// ----- Logging config -----
console.log('DATABASE_URL :', process.env.DATABASE_URL ? 'OK' : 'MISSING');
console.log('🌍 NODE_ENV :', process.env.NODE_ENV);
console.log('💳 STRIPE_MODE :', STRIPE_MODE);
console.log('🔑 STRIPE_KEY :', STRIPE_KEY ? 'OK' : 'MISSING');
console.log('🔒 STRIPE_WEBHOOK_SECRET :', STRIPE_WEBHOOK_SECRET ? 'OK' : 'MISSING');
console.log('📧 BREVO configured :', BREVO_API_KEY ? 'OK' : 'NO API KEY', ' sender:', BREVO_SENDER || 'MISSING');
console.log('📆 CALENDAR_URL :', CALENDAR_URL || 'NONE');

// ----- Stripe init -----
if (!STRIPE_KEY) console.warn('⚠️ Stripe key manquante. Vérifie STRIPE_TEST_KEY / STRIPE_SECRET_KEY.');
const stripe = Stripe(STRIPE_KEY);

// ----- Postgres (Railway) -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ----- Helpers -----
async function insertReservation(logement, email, dateDebut, dateFin, montant = null) {
  try {
    const result = await pool.query(
      `INSERT INTO reservations (logement, email, date_debut, date_fin, montant, cree_le)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING *`,
      [logement, email, dateDebut, dateFin, montant]
    );
    console.log('✅ Réservation enregistrée dans PostgreSQL :', result.rows[0]);
    return result.rows[0];
  } catch (err) {
    console.error('❌ Erreur PostgreSQL :', err.message || err);
    throw err;
  }
}

// ----- Middlewares -----
// Static files (si besoin)
app.use(cors());
app.use(express.static('public'));

// IMPORTANT: webhook doit être défini AVANT express.json (Stripe exige la raw body)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn('⚠️ STRIPE_WEBHOOK_SECRET manquant — webhook non vérifiable.');
  }

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    // console.log('Stripe event:', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      // Robustness: read metadata with fallback names
      const date = session.metadata?.date || session.metadata?.date_debut || null;
      const logement = (session.metadata?.logement || session.metadata?.property || 'BLŌM').toString();
      const nuits = parseInt(session.metadata?.nuits || session.metadata?.nights || 1, 10);
      const email = session.metadata?.email || session.customer_details?.email || null;
      const montant = session.amount_total ? session.amount_total / 100 : null;

      console.log(`✅ Webhook: paiement confirmé pour ${logement} - ${nuits} nuit(s) - ${date || 'date non fournie'}`);

      // compute dates
      const startDate = date ? new Date(date) : new Date();
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + (isNaN(nuits) ? 1 : nuits));

      // Insert en base
      try {
        await insertReservation(logement.toUpperCase(), email, startDate.toISOString(), endDate.toISOString(), montant);
      } catch (err) {
        console.error('Erreur insertReservation (webhook):', err.message || err);
      }

      // Envoi email via Brevo (si configuré)
      if (BREVO_API_KEY && BREVO_SENDER && BREVO_TO) {
        try {
          const payload = {
            sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER },
            to: [{ email: BREVO_TO }, { email: email || BREVO_TO }],
            subject: `Nouvelle réservation : ${logement}`,
            textContent:
              `Réservation confirmée pour ${logement}\nDate d'arrivée : ${startDate.toISOString().split('T')[0]}\nNuits : ${nuits}\nMontant payé : ${montant !== null ? montant + ' €' : 'non précisé'}\nEmail client : ${email || 'non fourni'}`,
            htmlContent:
              `<p>Réservation confirmée pour <strong>${logement}</strong></p>
               <ul>
                 <li>Date d'arrivée : ${startDate.toISOString().split('T')[0]}</li>
                 <li>Nuits : ${nuits}</li>
                 <li>Montant payé : ${montant !== null ? montant + ' €' : 'non précisé'}</li>
                 <li>Email client : ${email || 'non fourni'}</li>
               </ul>`
          };
          const brevoRes = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
            headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' }
          });
          console.log('📧 Email Brevo envoyé:', brevoRes.data);
        } catch (err) {
          console.error('❌ Erreur envoi email Brevo :', err.response ? err.response.data : err.message);
        }
      } else {
        console.warn('⚠️ Brevo non configuré (BREVO_API_KEY / BREVO_SENDER / BREVO_TO manquant)');
      }
    }

    // Return 200 quickly
    res.json({ received: true });
  } catch (err) {
    console.error('⚠️ Erreur webhook signature:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Après le webhook raw : json pour les autres routes
app.use(express.json());

// ----- Create Checkout Session -----
app.post('/create-checkout-session', async (req, res) => {
  try {
    const body = req.body || {};

    // Accept multiple field names to maximize compatibility with frontend
    const date = body.date || body.arrivalDate || body.date_debut || body.arrival || null;
    const logement = (body.logement || body.property || 'BLŌM').toString();
    const nuits = parseInt(body.nuits || body.nights || 1, 10);

    // prix ou total (front peut envoyer `total`, `prix`, `pricePerNight`, etc)
    let totalCents = 0;
    if (body.total) totalCents = Math.round(parseFloat(body.total) * 100);
    else if (body.prix) totalCents = Math.round(parseFloat(body.prix) * 100 * nuits);
    else if (body.pricePerNight) totalCents = Math.round(parseFloat(body.pricePerNight) * 100 * nuits);
    else if (body.price) totalCents = Math.round(parseFloat(body.price) * 100);
    else return res.status(400).json({ error: 'prix ou total manquant dans la requête' });

    // Forcer paiement 1€ en test (optionnel)
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
      success_url: `${FRONTEND_URL}/confirmation/?success=true&logement=${encodeURIComponent(logement)}&date=${encodeURIComponent(date || '')}&nuits=${encodeURIComponent(nuits)}&montant=${encodeURIComponent((totalCents/100).toString())}`,
      cancel_url: `${FRONTEND_URL}/${encodeURIComponent(logement.toLowerCase())}/`,
      metadata: { date: date || new Date().toISOString(), logement, nuits, email: body.email || null }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erreur Stripe Checkout :', err.response?.data || err.message || err);
    res.status(500).json({ error: 'Erreur lors de la création de la session de paiement.' });
  }
});

// ----- iCal dynamique (depuis PostgreSQL) -----
// Accessible sous /ical/BLOM.ics ou /ical/blom.ics
app.get(['/ical/:logement', '/ical/:logement.ics'], async (req, res) => {
  try {
    const raw = req.params.logement || req.params[0];
    const logementParam = raw.replace('.ics', '').toUpperCase();

    // Récupère réservations futures et présentes (filtre sur date_fin >= aujourd'hui - safe)
    const now = new Date().toISOString();
    const q = `
      SELECT date_debut, date_fin, email
      FROM reservations
      WHERE logement = $1 AND date_fin >= $2
      ORDER BY date_debut ASC
    `;
    const result = await pool.query(q, [logementParam, now]);

    // Génère ICS à la main (format simple, compatible Airbnb/Booking)
    let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//LIVABLŌM//FR\r\n';
    for (const r of result.rows) {
      // date_debut / date_fin sont des timestamps -> on prend la partie date
      const start = (new Date(r.date_debut)).toISOString().split('T')[0].replace(/-/g, '');
      const end = (new Date(r.date_fin)).toISOString().split('T')[0].replace(/-/g, '');
      const summary = `Réservé (${r.email || 'client'})`;

      ics += 'BEGIN:VEVENT\r\n';
      ics += `DTSTART;VALUE=DATE:${start}\r\n`;
      ics += `DTEND;VALUE=DATE:${end}\r\n`;
      ics += `SUMMARY:${summary}\r\n`;
      ics += 'END:VEVENT\r\n';
    }
    ics += 'END:VCALENDAR\r\n';

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // Fournir un nom de fichier compatible (BLOM.ics)
    res.setHeader('Content-Disposition', `attachment; filename="${logementParam}.ics"`);
    res.send(ics);
  } catch (err) {
    console.error('❌ Erreur génération ICS :', err.message || err);
    res.status(500).send('Erreur ICS');
  }
});

// ----- API réservation fusionnée (Postgres + (optionnel) proxy iCal) -----
// Retourne JSON utilisable par le front FullCalendar
app.get('/api/reservations/:logement', async (req, res) => {
  try {
    const logement = req.params.logement.toUpperCase();

    // 1) depuis Postgres
    const now = new Date().toISOString();
    const r = await pool.query(
      `SELECT date_debut, date_fin, email FROM reservations WHERE logement = $1 AND date_fin >= $2 ORDER BY date_debut`,
      [logement, now]
    );
    const eventsFromDb = r.rows.map(row => ({
      title: `Réservé (${row.email || 'client'})`,
      start: (new Date(row.date_debut)).toISOString().split('T')[0],
      end: (new Date(row.date_fin)).toISOString().split('T')[0]
    }));

    // 2) Optionnel: fusionner avec iCal externe (proxy calendar) si défini
    let eventsFromIcal = [];
    if (CALENDAR_URL) {
      try {
        const url = `${CALENDAR_URL}/${logement}.ics`;
        const txt = (await axios.get(url)).data;
        // minimal parse: chercher DTSTART/DTEND/SUMMARY occurrences
        const vevents = txt.split('BEGIN:VEVENT').slice(1);
        eventsFromIcal = vevents.map(block => {
          const get = (key) => {
            const re = new RegExp(`${key}[^\\n\\r]*[:](\\d{8})`, 'i');
            const m = block.match(re);
            return m ? `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}` : null;
          };
          const summaryMatch = block.match(/SUMMARY:(.*)/i);
          return {
            title: summaryMatch ? summaryMatch[1].trim() : 'Réservé',
            start: get('DTSTART'),
            end: get('DTEND')
          };
        }).filter(e => e.start && e.end);
      } catch (err) {
        console.warn('⚠️ Impossible de récupérer iCal externe:', err.message);
      }
    }

    // Merge (BDD first, then external)
    const merged = [...eventsFromDb, ...eventsFromIcal];
    res.json(merged);
  } catch (err) {
    console.error('❌ Erreur /api/reservations:', err.message || err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ----- Start server -----
app.listen(PORT, () => {
  console.log(`🚀 livablom-stripe démarré. BACKEND_URL=${BACKEND_URL} FRONTEND_URL=${FRONTEND_URL}`);
});
