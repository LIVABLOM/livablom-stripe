const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.URL_BASE_DE_DONNÉES,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log("✅ Connecté à PostgreSQL"))
  .catch(err => console.error("❌ Erreur connexion BDD:", err));

module.exports = { pool };
