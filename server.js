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

// ----- URLs / Config -----
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://livablom.fr';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const CALENDAR_URL = process.env.CALENDAR_URL || '';

const STRIPE_MODE = process.env.STRIPE_MODE || 'test';
const STRIPE_KEY = STRIPE_MODE === 'live' ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_KEY;
const STRIPE_WEBHOOK_SECRET = STRIPE_MODE === 'live' ? process.env.STRIPE_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_TEST_SECRET;

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER = process.env.BREVO_SENDER;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'LIVABLŌM';
const BREVO_TO = process.env.BREVO_TO;

console.log('DATABASE_URL :', process.env.DATABASE_URL ? 'OK' : 'MISSING');
console.log('🌍 NODE_ENV :', process.env.NODE_ENV);
console.log('💳 STRIPE_MODE :', STRIPE_MODE);
console.log('🔑 STRIPE_KEY :', STRIPE_KEY ? 'OK' : 'MISSING');
console.log('🔒 STRIPE_WEBHOOK_SECRET :', STRIPE_WEBHOOK_SECRET ? 'OK' : 'MISSING');
console.log('📧 BREVO configured :', BREVO_API_KEY ? 'OK' : 'NO API KEY', ' sender:', BREVO_SENDER || 'MISSING');
console.log('📆 CALENDAR_URL :', CALENDAR_URL || 'MISSING');

// ----- Stripe init -----
const stripe = Stripe(STRIPE_KEY);

// ----- PostgreSQL -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function insertReservation(logement, email, dateDebut, dateFin, montant) {
  try {
    const result = await pool.query(
      `INSERT INTO reservations (logement, email, date_debut, date_fin, montant, cree_le)
       VALUES ($1,$2,$3,$4,$5,now())
       RETURNING *`,
      [logement, email, dateDebut, dateFin, montant || 0]
    );
    console.log('✅ Réservation enregistrée dans PostgreSQL :', result.rows[0]);
    return result.rows[0];
  } catch (err) {
    console.error('❌ Erreur PostgreSQL :', err.message || err);
    throw err;
  }
}

// ----- Middlewares -----
app.use(cors());
app.use(express.static('public'));

// ----- Webhook Stripe -----
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET); }
  catch (err) { console.error('⚠️ Erreur webhook signature:', err.message); return res.status(400).send(`Webhook Error: ${err.message}`); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const date = session.metadata.date || new Date().toISOString();
    const logement = session.metadata.logement || 'BLŌM';
    const nuits = parseInt(session.metadata.nuits || 1, 10);
    const email = session.metadata.email || session.customer_details?.email || null;
    const montant = session.amount_total ? session.amount_total / 100 : 0;

    console.log(`✅ Webhook: paiement confirmé pour ${logement} - ${nuits} nuit(s) - ${date}`);

    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + nuits);

    // BDD
    try { await insertReservation(logement, email, startDate.toISOString(), endDate.toISOString(), montant); }
    catch (err) { console.error('Erreur insertReservation:', err.message); }

    // Backup bookings.json
    try {
      const filePath = './bookings.json';
      let bookings = {};
      if (fs.existsSync(filePath)) bookings = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
      if (!bookings[logement]) bookings[logement] = [];
      bookings[logement].push({
        title: `Réservé (${email || 'client'})`,
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      });
      fs.writeFileSync(filePath, JSON.stringify(bookings, null, 2));
      console.log('📅 Réservation enregistrée dans bookings.json');
    } catch (err) { console.error('Erreur sauvegarde bookings.json :', err.message); }

    // Email via Brevo
    if (BREVO_API_KEY && BREVO_SENDER && BREVO_TO) {
      try {
        const payload = {
          sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER },
          to: [{ email: BREVO_TO }, { email: email || BREVO_TO }],
          subject: `Nouvelle réservation : ${logement}`,
          textContent: `Réservation confirmée pour ${logement}\nDate : ${startDate.toISOString().split('T')[0]}\nNuits : ${nuits}\nMontant : ${montant} €\nEmail client : ${email || 'non fourni'}`,
          htmlContent: `<p>Réservation confirmée pour <strong>${logement}</strong></p>
                        <p>Date : ${startDate.toISOString().split('T')[0]}</p>
                        <p>Nuits : ${nuits}</p>
                        <p>Montant : ${montant} €</p>
                        <p>Email client : ${email || 'non fourni'}</p>`
        };
        const resBrevo = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
          headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' }
        });
        console.log('📧 Email Brevo envoyé:', resBrevo.data);
      } catch (err) { console.error('❌ Erreur envoi email Brevo :', err.response ? err.response.data : err.message); }
    } else { console.warn('⚠️ Brevo non configuré (API_KEY / SENDER / TO manquant)'); }
  }

  res.json({ received: true });
});

// ----- Express.json pour les autres routes -----
app.use(express.json());

// ----- iCal / Calendrier .ics -----
app.get('/ical/:logement', async (req, res) => {
  const logement = req.params.logement.toUpperCase().replace('Ō','O');
  let reservations = [];

  try {
    const filePath = './bookings.json';
    if (fs.existsSync(filePath)) {
      const local = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
      reservations = local[logement] || [];
    }
  } catch (err) { console.error('Erreur lecture bookings.json:', err.message); return res.status(500).send('Erreur serveur'); }

  let icsContent = 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//LIVABLŌM//Booking Calendar//FR\n';
  reservations.forEach((r,index) => {
    const uid = `${index}-${logement}-${r.start}`;
    icsContent += 'BEGIN:VEVENT\n';
    icsContent += `UID:${uid}\n`;
    icsContent += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').split('.')[0]}Z\n`;
    icsContent += `DTSTART;VALUE=DATE:${r.start.replace(/-/g,'')}\n`;
    icsContent += `DTEND;VALUE=DATE:${r.end.replace(/-/g,'')}\n`;
    icsContent += `SUMMARY:Réservé\n`;
    icsContent += 'END:VEVENT\n';
  });
  icsContent += 'END:VCALENDAR';

  res.setHeader('Content-Type','text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition',`inline; filename=${logement}.ics`);
  res.send(icsContent);
});

// ----- API récupération réservation pour frontend -----
app.get('/api/reservations/:logement', async (req, res) => {
  const logement = req.params.logement.toUpperCase();
  try {
    const filePath = './bookings.json';
    if (!fs.existsSync(filePath)) return res.json([]);
    const local = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
    return res.json(local[logement] || []);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ----- Create Checkout Session -----
app.post('/create-checkout-session', async (req,res) => {
  try {
    const body = req.body || {};
    const date = body.date || body.arrivalDate || body.date_debut || new Date().toISOString();
    const logement = (body.logement || 'BLŌM').toString();
    const nuits = parseInt(body.nuits || 1,10);

    let totalCents = 0;
    if(body.total) totalCents = Math.round(parseFloat(body.total)*100);
    else if(body.prix) totalCents = Math.round(parseFloat(body.prix)*100*nuits);
    else if(body.pricePerNight) totalCents = Math.round(parseFloat(body.pricePerNight)*100*nuits);
    else return res.status(400).json({ error: 'prix ou total manquant dans la requête' });

    if(process.env.TEST_PAYMENT === 'true') totalCents = 100;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items:[{
        price_data: {
          currency:'eur',
          product_data: { name:`${logement} - ${nuits} nuit(s)` },
          unit_amount: totalCents,
        },
        quantity: 1
      }],
      mode:'payment',
      success_url: `${FRONTEND_URL}/confirmation/?success=true&logement=${encodeURIComponent(logement)}&date=${encodeURIComponent(date)}&nuits=${encodeURIComponent(nuits)}&montant=${encodeURIComponent(totalCents/100)}`,
      cancel_url: `${FRONTEND_URL}/${encodeURIComponent(logement.toLowerCase())}/`,
      metadata: { date, logement, nuits, email: body.email || null }
    });

    res.json({ url: session.url });
  } catch(err) { console.error('❌ Erreur Stripe Checkout :', err.response?.data || err.message || err); res.status(500).json({ error: 'Erreur lors de la création de la session de paiement.' }); }
});

// ----- Start server -----
app.listen(PORT, () => {
  console.log(`🚀 livablom-stripe démarré. BACKEND_URL=${BACKEND_URL} FRONTEND_URL=${FRONTEND_URL}`);
});
