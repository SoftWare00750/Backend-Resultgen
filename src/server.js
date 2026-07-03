require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const authCodeRoutes = require("./routes/authCodes");
const classRoutes = require("./routes/classes");
const studentRoutes = require("./routes/students");
const resultRoutes = require("./routes/results");
const sessionRoutes = require("./routes/sessions");
const schoolRoutes = require("./routes/school");

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

app.use(express.json({ limit: "10mb" }));

// Root route — confirms the API is live
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "RGS API is running",
    version: "1.0.0",
    endpoints:
      "/health, /api/auth, /api/users, /api/classes, /api/students, /api/results, /api/sessions, /api/school",
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

// 404 handler
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Centralised error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 4000;

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
app.listen(PORT, () => {
  console.log(`🚀 RGS backend listening on http://localhost:${PORT}`);
});