require("dotenv").config();
const { Pool } = require("pg");

/**
 * Repairs malformed DATABASE_URLs where the query string got concatenated
 * onto the path without a "?" separator, e.g.
 *   postgres://user:pass@host:5432/rgs_db_xzpwsslmode=require
 * -> postgres://user:pass@host:5432/rgs_db_xzpw?sslmode=require
 */
function sanitizeDatabaseUrl(raw) {
  return raw.replace(/([^?&])(sslmode=)/, "$1?$2");
}

function createPool() {
  if (process.env.DATABASE_URL) {
    const fixed = sanitizeDatabaseUrl(process.env.DATABASE_URL.trim());

    return new Pool({
      connectionString: fixed,
      // Always disable certificate verification for Render/cloud-hosted Postgres.
      // Render uses self-signed certs; rejectUnauthorized: false is the standard fix.
      ssl: {
        rejectUnauthorized: false,
      },
    });
  }

  // Fallback: individual env vars (local development)
  const config = {
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432", 10),
    database: process.env.PGDATABASE || "rgs_db",
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  };

  // Only add SSL locally if explicitly requested
  if (process.env.PGSSL === "true") {
    config.ssl = { rejectUnauthorized: false };
  }

  return new Pool(config);
}

const pool = createPool();

pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error:", err.message);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};