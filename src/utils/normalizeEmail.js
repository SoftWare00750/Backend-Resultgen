/**
 * Normalizes an email address for storage and lookup: trims whitespace and
 * lowercases it.
 *
 * Why this exists: `users.email` has a case-SENSITIVE `UNIQUE` constraint,
 * and every query in this codebase did a raw `WHERE email = $1` /
 * `INSERT ... (email) VALUES ($1)` with whatever casing the caller happened
 * to send. In practice that meant:
 *   - Logging in with different casing than you registered with (e.g. a
 *     phone keyboard capitalizing the first letter, or copy-pasting an email
 *     from a signature) fails with "No account found with this email
 *     address", even though the account exists.
 *   - Two accounts could be created for the same real-world mailbox that
 *     only differ by case (e.g. "Admin@school.edu.ng" vs
 *     "admin@school.edu.ng"), since the UNIQUE constraint is case-sensitive.
 *
 * Every route that reads or writes `users.email` (and the related
 * `admin_signup_codes.email`) should normalize through this function first,
 * so lookups and inserts are consistent regardless of how the email was
 * typed. See also the `idx_users_email_lower` unique index in schema.sql,
 * which is a defense-in-depth backstop in case any code path misses this.
 */
function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : email;
}

module.exports = { normalizeEmail };
