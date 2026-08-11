require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, query } = require("./pool");
const { getSubjectsByCategory } = require("../utils/subjects");
const { normalizeEmail } = require("../utils/normalizeEmail");

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

/**
 * Central Admin accounts — platform-wide, NOT tied to any single school.
 * These must exist out of the box on every environment (fresh local DB,
 * fresh Render deploy, etc.) without anyone having to remember to run a
 * separate `npm run seed` step by hand, which was the actual cause of
 * "No account found with this email address" on login: migrations ran
 * automatically on boot (see server.js) but seeding did not, so on a brand
 * new database neither admin row ever got created.
 *
 * Two accounts ship by default. Override any of these via env vars; leave
 * them unset to use the defaults below. Change the default passwords after
 * first login in a real deployment.
 */
function getCentralAdminAccounts() {
  return [
    {
      name: process.env.CENTRAL_ADMIN_NAME || "Central Administrator",
      email: process.env.CENTRAL_ADMIN_EMAIL || "admin@school.edu.ng",
      password: process.env.CENTRAL_ADMIN_PASSWORD || "Admin@123",
    },
    {
      name: process.env.CENTRAL_ADMIN2_NAME || "Central Administrator 2",
      email: process.env.CENTRAL_ADMIN2_EMAIL || "admin1@school.edu.ng",
      password: process.env.CENTRAL_ADMIN2_PASSWORD || "Admin@123",
    },
  ];
}

/**
 * Idempotent — safe to call on every server boot (see server.js) as well as
 * from the CLI (`npm run seed`). Only inserts a row when that email doesn't
 * already exist, so it never overwrites a password someone has since changed.
 */
async function seedCentralAdmins() {
  const accounts = getCentralAdminAccounts();
  for (const acct of accounts) {
    const email = normalizeEmail(acct.email);
    const { rows: existing } = await query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.length === 0) {
      const hash = await bcrypt.hash(acct.password, 10);
      await query(
        `INSERT INTO users (name, email, password_hash, role, school_id)
         VALUES ($1, $2, $3, 'central_admin', NULL)`,
        [acct.name, email, hash]
      );
      console.log(`✅ Seeded Central Admin: ${email}`);
    } else {
      console.log(`ℹ️  Central Admin already exists, skipping: ${email}`);
    }
  }
  return accounts.map((a) => normalizeEmail(a.email));
}

/**
 * Legacy per-school admin (only if explicitly configured via SEED_ADMIN_EMAIL
 * and different from either Central Admin above — most deployments won't set
 * this; a school's admin is normally created by the Central Admin or via
 * /api/auth/register instead). CLI-only; not run on server boot, since it
 * also provisions a whole default school/session/classes and shouldn't fire
 * silently on every deploy.
 */
async function seedLegacySchoolAdmin(centralEmails) {
  const seedAdminEmail = normalizeEmail(process.env.SEED_ADMIN_EMAIL);
  if (seedAdminEmail && !centralEmails.includes(seedAdminEmail)) {
    const email = seedAdminEmail;
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
    console.log("ℹ️  No SEED_ADMIN_EMAIL configured (or it matches a Central Admin) — skipping legacy " +
      "school/session/class seeding. Onboard real schools via POST /api/central/schools as the Central Admin.");
  }
}

async function seedAll() {
  const centralEmails = await seedCentralAdmins();
  await seedLegacySchoolAdmin(centralEmails);
  console.log("🎉 Seed complete.");
}

module.exports = { seedCentralAdmins, seedLegacySchoolAdmin, seedAll };

// Only run standalone when invoked as `node src/db/seed.js` / `npm run seed`.
// When required as a module (server.js imports seedCentralAdmins on boot),
// this block must NOT run — calling pool.end() there would kill the pool the
// running server needs for every subsequent request.
if (require.main === module) {
  seedAll()
    .catch((err) => {
      console.error("❌ Seed failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}