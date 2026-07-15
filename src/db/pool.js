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

/**
 * Strips any ssl*-related query params (sslmode, sslcert, sslkey, sslrootcert)
 * from a Postgres connection string.
 *
 * Why this matters: pg's ConnectionParameters constructor does
 *   config = Object.assign({}, config, parse(config.connectionString))
 * i.e. whatever pg-connection-string derives FROM the connection string is
 * applied *after*, and therefore OVERWRITES, any `ssl` option we pass
 * explicitly alongside `connectionString`. Since a bare `sslmode=require`
 * (without `uselibpqcompat=true`) is now parsed as an *empty* ssl object
 * (strict/verify-full validation - see the pg-connection-string deprecation
 * warning about 'prefer'/'require'/'verify-ca' being aliases for
 * 'verify-full'), our explicit `ssl: { rejectUnauthorized: false }` below
 * was being silently discarded, causing:
 *   "self-signed certificate; if the root CA is installed locally, try
 *    running Node.js with --use-system-ca" (DEPTH_ZERO_SELF_SIGNED_CERT)
 * on every query against Render's self-signed Postgres cert.
 * Stripping these params means pg-connection-string returns no `ssl` key at
 * all, so Object.assign leaves our explicit override untouched.
 */
function stripSslParams(raw) {
  const [base, query] = raw.split("?");
  if (!query) return raw;
  const kept = query
    .split("&")
    .filter((pair) => !/^ssl(mode|cert|key|rootcert)=/i.test(pair));
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

function createPool() {
  if (process.env.DATABASE_URL) {
    const fixed = stripSslParams(sanitizeDatabaseUrl(process.env.DATABASE_URL.trim()));

    return new Pool({
      connectionString: fixed,
      // Always disable certificate verification for Render/cloud-hosted Postgres.
      // Render uses self-signed certs; rejectUnauthorized: false is the standard fix.
      // NOTE: this option only takes effect because stripSslParams() above
      // removes sslmode from the connection string first - see its comment.
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