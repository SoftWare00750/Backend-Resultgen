const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate } = require("../middleware/auth");
const { isValidPlan, getTrialLimit } = require("../utils/pricing");
const { normalizeEmail } = require("../utils/normalizeEmail");

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email, name: user.name, schoolId: user.school_id || null },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

function sanitize(user) {
  const { password_hash, ...rest } = user;
  return rest;
}

// POST /api/auth/register
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const {
      name, email: rawEmail, password, role, authCode, phone,
      schoolName, schoolLogo, schoolAddress, schoolMotto, signatureDataUrl,
      // Admin/School Owner/School Proprietor-only fields:
      plan, paymentReference, studentCount,
    } = req.body;

    if (!name || !rawEmail || !password || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!["admin", "teacher", "parent"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    // Normalize once so lookups, the signup-code match, and the stored row
    // are all consistent regardless of how the person typed their email.
    const email = normalizeEmail(rawEmail);

    const { rows: existingUsers } = await query("SELECT id FROM users WHERE email = $1", [email]);
    if (existingUsers.length) return res.status(409).json({ error: "An account with this email already exists" });

    // ── Admin/School Owner/School Proprietor: email-verified signup code,
    // plan selection, and a captured payment method — no pre-issued auth
    // code, since admins are the ones who *hand out* auth codes to
    // teachers/parents, not the other way around.
    let authCodeRow = null;
    let paymentRow = null;
    let newSchoolId = null;

    if (role === "admin") {
      const { rows: signupCodes } = await query(
        "SELECT * FROM admin_signup_codes WHERE email = $1 AND is_verified = TRUE",
        [email]
      );
      if (!signupCodes.length) {
        return res.status(400).json({ error: "Please verify the code sent to your email before continuing" });
      }

      if (!plan || !isValidPlan(plan)) {
        return res.status(400).json({ error: "A valid plan (starter, standard, or premium) is required" });
      }

      if (!paymentReference) {
        return res.status(400).json({ error: "Payment details are required to register as Admin/School Owner/School Proprietor" });
      }
      const { rows: payments } = await query(
        "SELECT * FROM payments WHERE reference = $1 AND status = 'success'",
        [paymentReference]
      );
      if (!payments.length) {
        return res.status(400).json({ error: "We couldn't confirm your payment details — please try again" });
      }
      paymentRow = payments[0];

      // Every paying Admin/School Owner onboards their OWN school — this is a
      // multi-tenant platform, so this creates a new row in `schools` rather
      // than overwriting whatever the last admin registered.
      if (!schoolName) return res.status(400).json({ error: "School name is required for admin registration" });
      const { rows: schoolRows } = await query(
        `INSERT INTO schools (name, address, motto, logo_url) VALUES ($1,$2,$3,$4) RETURNING id`,
        [schoolName, schoolAddress || null, schoolMotto || null, schoolLogo || null]
      );
      newSchoolId = schoolRows[0].id;
      await query(
        `INSERT INTO school_info (name, address, motto, logo_url, school_id) VALUES ($1,$2,$3,$4,$5)`,
        [schoolName, schoolAddress || null, schoolMotto || null, schoolLogo || null, newSchoolId]
      );
    } else {
      // Teacher / Parent: still go through the Admin-issued auth_codes flow.
      if (!authCode) return res.status(400).json({ error: "Missing required fields" });
      const { rows: codes } = await query(
        "SELECT * FROM auth_codes WHERE code = $1 AND role = $2 AND is_used = FALSE",
        [authCode, role]
      );
      authCodeRow = codes[0];
      if (!authCodeRow) return res.status(400).json({ error: "Invalid or already used authorization code for this role" });
      if (new Date(authCodeRow.expires_at) < new Date()) {
        return res.status(400).json({ error: "Authorization code has expired" });
      }

      if (authCodeRow.school_id) {
        // Preferred path: the code itself carries the issuing school.
        newSchoolId = authCodeRow.school_id;
      } else if (role === "teacher") {
        // Legacy fallback for codes issued before school scoping existed.
        if (!schoolName) return res.status(400).json({ error: "School name is required for teacher registration" });
        const { rows: schools } = await query("SELECT id, name FROM school_info LIMIT 1");
        if (schools.length && schools[0].name.toLowerCase() !== schoolName.trim().toLowerCase()) {
          return res.status(400).json({ error: `School name does not match "${schools[0].name}"` });
        }
        newSchoolId = schools[0]?.id || null;
      }
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows: inserted } = await query(
      `INSERT INTO users (name, email, password_hash, role, phone, signature_url, school_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, email, hash, role, phone || null, signatureDataUrl || null, newSchoolId]
    );
    const user = inserted[0];

    if (role === "admin") {
      // `paystack_raw` is a JSONB column — node-postgres already parses it
      // into a plain object when it comes back from a SELECT/UPDATE...RETURNING,
      // so re-parsing it with JSON.parse() here would throw
      // ("Unexpected token o in JSON") and break registration right after a
      // successful charge. Use it directly.
      const raw = paymentRow.paystack_raw || {};
      const authorizationCode = raw.authorization?.authorization_code || null;
      const trialLimit = getTrialLimit(plan);
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 30);

      const { rows: subRows } = await query(
        `INSERT INTO subscriptions
           (user_id, plan, status, student_limit, trial_student_limit, trial_ends_at,
            paystack_authorization_code, paystack_email, last_charged_amount_kobo)
         VALUES ($1,$2,'trialing',$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          user.id, plan, trialLimit, trialLimit, trialEndsAt.toISOString(),
          authorizationCode, email, paymentRow.amount_kobo,
        ]
      );
      await query("UPDATE payments SET user_id = $1, subscription_id = $2 WHERE id = $3", [
        user.id, subRows[0].id, paymentRow.id,
      ]);
    } else {
      await query("UPDATE auth_codes SET is_used = TRUE, used_by = $1 WHERE id = $2", [email, authCodeRow.id]);
    }

    const token = signToken(user);
    res.status(201).json({ token, user: sanitize(user) });
  })
);

// POST /api/auth/login
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email: rawEmail, password } = req.body;
    if (!rawEmail || !password) return res.status(400).json({ error: "Email and password are required" });
    const email = normalizeEmail(rawEmail);

    const { rows } = await query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "No account found with this email address" });
    if (user.deleted_at) return res.status(403).json({ error: "This account has been removed. Contact your administrator." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Incorrect password" });

    if (user.school_id && user.role !== "central_admin") {
      const { rows: schoolRows } = await query("SELECT status, deleted_at FROM schools WHERE id = $1", [user.school_id]);
      const school = schoolRows[0];
      if (school && (school.deleted_at || school.status === "suspended")) {
        return res.status(403).json({ error: "Your school's account has been suspended. Contact the platform administrator." });
      }
    }

    const token = signToken(user);
    res.json({ token, user: sanitize(user) });
  })
);

// GET /api/auth/me
router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json({ user: sanitize(rows[0]) });
  })
);

module.exports = router;