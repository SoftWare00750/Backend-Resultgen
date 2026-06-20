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
