const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { sendAdminAuthCodeEmail } = require("../utils/email");

const RESEND_COOLDOWN_SECONDS = Number(process.env.ADMIN_CODE_RESEND_COOLDOWN_SECONDS || 30);
const CODE_EXPIRY_MINUTES = 10;

function generateSixDigitCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * POST /api/admin-signup/request-code   { email }
 * Generates (or regenerates, subject to the 30s cooldown) a 6-digit code and
 * emails it to the prospective Admin/School Owner/School Proprietor. Used
 * both for the initial send and for "Resend code".
 */
router.post(
  "/request-code",
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const { rows: existingUsers } = await query("SELECT id FROM users WHERE email = $1", [email]);
    if (existingUsers.length) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const { rows: existing } = await query("SELECT * FROM admin_signup_codes WHERE email = $1", [email]);
    const record = existing[0];

    if (record) {
      const secondsSinceLastSend = (Date.now() - new Date(record.last_sent_at).getTime()) / 1000;
      if (secondsSinceLastSend < RESEND_COOLDOWN_SECONDS) {
        const secondsRemaining = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLastSend);
        return res.status(429).json({
          error: `Please wait ${secondsRemaining}s before requesting another code`,
          secondsRemaining,
        });
      }
    }

    const code = generateSixDigitCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CODE_EXPIRY_MINUTES * 60 * 1000);

    if (record) {
      await query(
        `UPDATE admin_signup_codes
         SET code = $1, is_verified = FALSE, attempts = 0, last_sent_at = $2, expires_at = $3
         WHERE email = $4`,
        [code, now.toISOString(), expiresAt.toISOString(), email]
      );
    } else {
      await query(
        `INSERT INTO admin_signup_codes (email, code, last_sent_at, expires_at)
         VALUES ($1,$2,$3,$4)`,
        [email, code, now.toISOString(), expiresAt.toISOString()]
      );
    }

    const emailResult = await sendAdminAuthCodeEmail(email, code);

    res.status(200).json({
      message: emailResult.devMode
        ? "Verification code generated — email is not configured on this server, check the backend logs for the code."
        : "Verification code sent",
      devMode: emailResult.devMode,
      cooldownSeconds: RESEND_COOLDOWN_SECONDS,
      expiresInMinutes: CODE_EXPIRY_MINUTES,
    });
  })
);

/**
 * POST /api/admin-signup/verify-code   { email, code }
 * Marks the code as verified so /api/auth/register can accept it. Does NOT
 * create the account — registration still happens as a separate step so the
 * admin can fill in school info, plan, and payment details first.
 */
router.post(
  "/verify-code",
  asyncHandler(async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: "Email and code are required" });

    const { rows } = await query("SELECT * FROM admin_signup_codes WHERE email = $1", [email]);
    const record = rows[0];
    if (!record) return res.status(400).json({ error: "No verification code was requested for this email" });

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: "Code has expired — request a new one" });
    }

    if (record.attempts >= 5) {
      return res.status(429).json({ error: "Too many attempts — request a new code" });
    }

    if (record.code !== code) {
      await query("UPDATE admin_signup_codes SET attempts = attempts + 1 WHERE email = $1", [email]);
      return res.status(400).json({ error: "Incorrect code" });
    }

    await query("UPDATE admin_signup_codes SET is_verified = TRUE WHERE email = $1", [email]);
    res.json({ verified: true });
  })
);

module.exports = router;
