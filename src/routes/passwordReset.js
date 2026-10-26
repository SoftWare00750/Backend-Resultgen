const router = require("express").Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { sendPasswordResetCodeEmail } = require("../utils/email");
const { normalizeEmail } = require("../utils/normalizeEmail");

const RESEND_COOLDOWN_SECONDS = Number(process.env.PASSWORD_RESET_RESEND_COOLDOWN_SECONDS || 30);
const CODE_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 8;

function generateSixDigitCode() {
  // crypto.randomInt is cryptographically secure (Math.random is not).
  return crypto.randomInt(100000, 1000000).toString();
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function codesMatch(submittedCode, storedHash) {
  const a = Buffer.from(hashCode(submittedCode), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * POST /api/password-reset/request-code   { email }
 *
 * Generates a 6-digit code and emails it to the address entered. Also used
 * for "Resend code" — the server enforces a 30 second cooldown between
 * sends for the same email, so the limit can't be bypassed from the browser.
 *
 * To avoid revealing which emails have accounts, an unknown (or removed)
 * account gets the same success response as a known one; no email is sent.
 */
router.post(
  "/request-code",
  asyncHandler(async (req, res) => {
    const { email: rawEmail } = req.body;
    if (!rawEmail) return res.status(400).json({ error: "Email is required" });
    const email = normalizeEmail(rawEmail);
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }

    const genericResponse = {
      message: "If an account exists for this email, a reset code has been sent.",
      devMode: false,
      cooldownSeconds: RESEND_COOLDOWN_SECONDS,
      expiresInMinutes: CODE_EXPIRY_MINUTES,
    };

    const { rows: users } = await query(
      "SELECT id, deleted_at FROM users WHERE email = $1",
      [email]
    );
    if (!users.length || users[0].deleted_at) {
      return res.status(200).json(genericResponse);
    }

    const { rows: existing } = await query(
      "SELECT last_sent_at FROM password_reset_codes WHERE email = $1",
      [email]
    );
    if (existing[0]) {
      const secondsSinceLastSend = (Date.now() - new Date(existing[0].last_sent_at).getTime()) / 1000;
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

    await query(
      `INSERT INTO password_reset_codes (email, code_hash, attempts, last_sent_at, expires_at)
       VALUES ($1, $2, 0, $3, $4)
       ON CONFLICT (email) DO UPDATE
       SET code_hash = EXCLUDED.code_hash,
           attempts = 0,
           last_sent_at = EXCLUDED.last_sent_at,
           expires_at = EXCLUDED.expires_at`,
      [email, hashCode(code), now.toISOString(), expiresAt.toISOString()]
    );

    // Don't make the user wait on the email provider — respond right away and
    // deliver the email in the background. Failures are logged server-side.
    sendPasswordResetCodeEmail(email, code).catch((err) => {
      console.error("[password-reset] email failed:", err.message);
    });

    const devMode = !(
      (process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL) ||
      process.env.RESEND_API_KEY ||
      (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
    );

    res.status(200).json({
      ...genericResponse,
      message: devMode
        ? "Reset code generated — email is not configured on this server, check the backend logs for the code."
        : genericResponse.message,
      devMode,
    });
  })
);

/**
 * POST /api/password-reset/reset   { email, code, newPassword }
 *
 * Verifies the emailed code and, if it is correct and unexpired, sets the
 * new password in the same step. The code is single-use: the row is deleted
 * on success, and after 5 wrong guesses the user must request a new code.
 */
router.post(
  "/reset",
  asyncHandler(async (req, res) => {
    const { email: rawEmail, code, newPassword } = req.body;
    if (!rawEmail || !code || !newPassword) {
      return res.status(400).json({ error: "Email, code and new password are required" });
    }
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    const email = normalizeEmail(rawEmail);

    const { rows } = await query("SELECT * FROM password_reset_codes WHERE email = $1", [email]);
    const record = rows[0];
    if (!record) {
      return res.status(400).json({ error: "No reset code was requested for this email — request a new one" });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: "Code has expired — request a new one" });
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: "Too many attempts — request a new code" });
    }

    if (!codesMatch(code, record.code_hash)) {
      await query("UPDATE password_reset_codes SET attempts = attempts + 1 WHERE email = $1", [email]);
      return res.status(400).json({ error: "Incorrect code" });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    const { rowCount } = await query(
      "UPDATE users SET password_hash = $1, updated_at = now() WHERE email = $2 AND deleted_at IS NULL",
      [hash, email]
    );
    await query("DELETE FROM password_reset_codes WHERE email = $1", [email]);

    if (!rowCount) {
      return res.status(404).json({ error: "No active account found for this email" });
    }

    res.json({ message: "Password updated. You can now sign in." });
  })
);

module.exports = router;