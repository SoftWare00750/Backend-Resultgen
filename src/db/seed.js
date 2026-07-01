require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, query } = require("./pool");
const { getSubjectsByCategory } = require("../utils/subjects");

const DEFAULT_CLASSES = [
  { name: "Nursery 1", category: "Nursery" },
  { name: "Kindergarten 1", category: "Kindergarten" },
  { name: "Primary 1", category: "Primary" },
  { name: "Primary 2", category: "Primary" },
  { name: "JSS 1", category: "JSS" },
  { name: "JSS 2", category: "JSS" },
  { name: "JSS 3", category: "JSS" },
  { name: "SS 1", category: "SSS" },
  { name: "SS 2", category: "SSS" },
  { name: "SS 3", category: "SSS" },
];

async function seed() {
  try {
    // 1. Admin user
    const email = process.env.SEED_ADMIN_EMAIL || "admin@school.edu.ng";
    const { rows: existing } = await query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.length === 0) {
      const hash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || "Admin@123", 10);
      await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'admin')`,
        [process.env.SEED_ADMIN_NAME || "System Administrator", email, hash]
      );
      console.log(`✅ Seeded default admin: ${email}`);
    } else {
      console.log("ℹ️  Admin user already exists, skipping.");
    }

    // 2. Active session
    const { rows: sessions } = await query("SELECT id FROM sessions WHERE is_active = TRUE");
    if (sessions.length === 0) {
      await query(
        `INSERT INTO sessions (year, is_active) VALUES ($1, TRUE)
         ON CONFLICT (year) DO NOTHING`,
        ["2024/2025"]
      );
      console.log("✅ Seeded active session 2024/2025");
    }

    // 3. Default classes
    for (const c of DEFAULT_CLASSES) {
      await query(
        `INSERT INTO classes (name, category, subjects)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO NOTHING`,
        [c.name, c.category, JSON.stringify(getSubjectsByCategory(c.name))]
      );
    }
    console.log("✅ Seeded default classes");

    console.log("🎉 Seed complete.");
  } catch (err) {
    console.error("❌ Seed failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();
=== authCodes.js ===
const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

router.use(authenticate, requireRole("admin"));

function generateSixDigitCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// GET /api/auth-codes
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT * FROM auth_codes ORDER BY created_at DESC");
    res.json(rows);
  })
);

// POST /api/auth-codes  { role }
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { role } = req.body;
    if (!["admin", "teacher", "parent"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    const code = generateSixDigitCode();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const { rows } = await query(
      `INSERT INTO auth_codes (code, role, expires_at, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [code, role, expiresAt.toISOString(), req.user.id]
    );
    res.status(201).json(rows[0]);
  })
);

// DELETE /api/auth-codes/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await query("DELETE FROM auth_codes WHERE id = $1", [req.params.id]);
    res.status(204).send();
  })
);

module.exports = router;
