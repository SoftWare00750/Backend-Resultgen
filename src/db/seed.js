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
    // 1. Central Admin — platform-wide account, NOT tied to any single school.
    // Manages every school, their admins/teachers/students, DB storage
    // consumption, and can remove data platform-wide (see centralAdmin.js).
    const centralEmail = process.env.CENTRAL_ADMIN_EMAIL || "admin@school.edu.ng";
    const { rows: existingCentral } = await query("SELECT id FROM users WHERE email = $1", [centralEmail]);
    if (existingCentral.length === 0) {
      const hash = await bcrypt.hash(process.env.CENTRAL_ADMIN_PASSWORD || "Admin@123", 10);
      await query(
        `INSERT INTO users (name, email, password_hash, role, school_id)
         VALUES ($1, $2, $3, 'central_admin', NULL)`,
        [process.env.CENTRAL_ADMIN_NAME || "Central Administrator", centralEmail, hash]
      );
      console.log(`✅ Seeded Central Admin: ${centralEmail}`);
    } else {
      console.log("ℹ️  Central Admin already exists, skipping.");
    }

    // 1b. Legacy per-school admin (only if explicitly configured and different
    // from the Central Admin above — most deployments won't set this; a
    // school's admin is normally created by the Central Admin or via
    // /api/auth/register instead).
    if (process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_EMAIL !== centralEmail) {
      const email = process.env.SEED_ADMIN_EMAIL;
      const { rows: existing } = await query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.length === 0) {
        const hash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || "Admin@123", 10);
        const { rows: schoolRows } = await query(
          `INSERT INTO schools (name) VALUES ($1) RETURNING id`,
          [process.env.SEED_SCHOOL_NAME || "Default School"]
        );
        await query(
          `INSERT INTO users (name, email, password_hash, role, school_id)
           VALUES ($1, $2, $3, 'admin', $4)`,
          [process.env.SEED_ADMIN_NAME || "School Administrator", email, hash, schoolRows[0].id]
        );
        console.log(`✅ Seeded school admin: ${email}`);

        // Only meaningful in the context of the legacy school just created above.
        await query(
          `INSERT INTO sessions (year, is_active, school_id) VALUES ($1, TRUE, $2)
           ON CONFLICT (school_id, year) DO NOTHING`,
          ["2024/2025", schoolRows[0].id]
        );
        for (const c of DEFAULT_CLASSES) {
          await query(
            `INSERT INTO classes (name, category, subjects, school_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (school_id, name) DO NOTHING`,
            [c.name, c.category, JSON.stringify(getSubjectsByCategory(c.name)), schoolRows[0].id]
          );
        }
        console.log("✅ Seeded default session and classes for the legacy school");
      } else {
        console.log("ℹ️  School admin already exists, skipping.");
      }
    } else {
      console.log("ℹ️  No SEED_ADMIN_EMAIL configured — skipping legacy school/session/class seeding. " +
        "Onboard real schools via POST /api/central/schools as the Central Admin.");
    }

    console.log("🎉 Seed complete.");
  } catch (err) {
    console.error("❌ Seed failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();