// server.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const ical = require("node-ical");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Stripe Checkout ---
app.post("/api/checkout", async (req, res) => {
  try {
    const { logement, startDate, endDate, amount } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `Réservation ${logement}` },
            unit_amount: amount * 100,
          },
          quantity: 1,
        },
      ],
      m
