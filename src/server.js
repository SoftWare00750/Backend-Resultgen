require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { runMigrations } = require("./db/migrate");
const { seedCentralAdmins } = require("./db/seed");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const authCodeRoutes = require("./routes/authCodes");
const classRoutes = require("./routes/classes");
const studentRoutes = require("./routes/students");
const resultRoutes = require("./routes/results");
const sessionRoutes = require("./routes/sessions");
const schoolRoutes = require("./routes/school");
const adminSignupRoutes = require("./routes/adminSignup");
const paymentRoutes = require("./routes/payments");
const centralAdminRoutes = require("./routes/centralAdmin");

const app = express();

// Allow multiple origins: the env var + common Vercel preview patterns
const allowedOrigins = new Set(
  (process.env.CLIENT_ORIGIN || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean)
);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, Postman, server-to-server)
      if (!origin) return callback(null, true);
      const normalised = origin.replace(/\/$/, "");
      if (
        allowedOrigins.has(normalised) ||
        // Allow any *.vercel.app subdomain for preview deployments
        /^https:\/\/[a-z0-9-]+(\.vercel\.app)$/.test(normalised)
      ) {
        return callback(null, true);
      }
      console.warn(`CORS blocked: ${origin}`);
      return callback(new Error(`CORS policy: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

// `verify` stashes the raw request bytes on req.rawBody so the Paystack
// webhook handler can compute an HMAC signature over the exact payload sent
// (JSON.stringify(req.body) is not guaranteed to match byte-for-byte).
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// Root route — confirms the API is live
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "RGS API is running",
    version: "1.0.0",
    endpoints:
      "/health, /api/auth, /api/users, /api/classes, /api/students, /api/results, /api/sessions, /api/school, /api/admin-signup, /api/payments, /api/central",
  });
});

app.get("/health", (req, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/auth-codes", authCodeRoutes);
app.use("/api/classes", classRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/results", resultRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/school", schoolRoutes);
app.use("/api/admin-signup", adminSignupRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/central", centralAdminRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Centralised error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 4000;

function logIntegrationStatus() {
  const gmailReady = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  const paystackReady = !!(process.env.PAYSTACK_SECRET_KEY && process.env.PAYSTACK_PUBLIC_KEY);
  const sheetsOverflowReady = require("./utils/dbOverflow").isConfigured();
  console.log(
    `📧 Gmail (admin auth-code emails): ${gmailReady ? "configured" : "NOT configured — codes will only be logged to this console"}`
  );
  console.log(
    `💳 Paystack (payments): ${paystackReady ? "configured" : "NOT configured — /api/payments/initialize will return an error until PAYSTACK_SECRET_KEY / PAYSTACK_PUBLIC_KEY are set"}`
  );
  console.log(
    `📊 Google Sheets overflow store: ${sheetsOverflowReady ? "configured — results/students will fail over to Sheets if Postgres runs out of storage" : "NOT configured — writes will simply error if Postgres runs out of storage"}`
  );
}

// Always serve plain HTTP. TLS termination is handled upstream (Render,
// Vercel, nginx, etc. in production; the Next.js dev proxy locally).
//
// A previous version of this file conditionally started an HTTPS server
// using local, self-signed certificates (localhost-key.pem / localhost.pem)
// if it found them on disk. Self-signed certs are not trusted by Node's
// default CA store, so any Node-side fetch (Next.js server-side rewrites,
// SSR, etc.) to that endpoint failed with:
//   "self-signed certificate; if the root CA is installed locally, try
//    running Node.js with --use-system-ca"
// which is exactly the error blocking login/register for every portal.
// Removing the self-signed HTTPS branch removes the failure mode entirely.
// Apply schema.sql on every boot before accepting traffic. schema.sql is
// fully idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS everywhere), so
// this is safe to run against a database that's already up to date, and it
// guarantees the running code and the live schema can never drift apart —
// which is what caused `relation "schools" does not exist`: schema.sql had
// been updated to add multi-tenancy (the `schools` table) but that change
// was never applied to the deployed database because `npm run migrate` is a
// separate manual step that's easy to forget after a deploy.
async function start() {
  try {
    console.log("Running database migrations...");
    await runMigrations();
    console.log("✅ Database schema is up to date.");
  } catch (err) {
    console.error("❌ Database migration failed on boot:", err.message);
    process.exit(1);
  }

  try {
    // Guarantees admin@school.edu.ng and admin1@school.edu.ng (or whatever
    // CENTRAL_ADMIN*_EMAIL is set to) always exist, on every boot, without a
    // manual `npm run seed` step. Idempotent — skips accounts that already
    // exist, so it's safe to run on every deploy/restart.
    console.log("Ensuring default Central Admin accounts exist...");
    await seedCentralAdmins();
    console.log("✅ Central Admin accounts ready.");
  } catch (err) {
    // Don't crash the whole server over this — migrations already succeeded
    // and most of the app works without it. Log loudly so it's not missed.
    console.error("⚠️  Central Admin auto-seed failed:", err.message);
  }

  app.listen(PORT, () => {
    console.log(`🚀 RGS backend listening on http://localhost:${PORT}`);
    logIntegrationStatus();
  });
}

start();