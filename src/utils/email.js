const nodemailer = require("nodemailer");

let transporter = null;

/**
 * Lazily builds a Gmail SMTP transporter from env vars. Requires a Gmail
 * *App Password* (not the regular account password) — generate one at
 * https://myaccount.google.com/apppasswords once 2-Step Verification is on.
 *
 * Required env vars:
 *   GMAIL_USER  — the sending Gmail address, e.g. results@yourschoolgroup.com
 *   GMAIL_APP_PASSWORD — the 16-character app password
 */
function getTransporter() {
  if (transporter) return transporter;

  const user = process.env.GMAIL_USER?.trim();
  // Google's UI displays App Passwords as "abcd efgh ijkl mnop" with spaces
  // for readability — copy-pasting them verbatim (spaces included) is the
  // single most common cause of "email isn't sending" in the wild, so we
  // strip whitespace defensively rather than fail on it.
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");

  if (!user || !pass) {
    console.warn(
      "[email] GMAIL_USER / GMAIL_APP_PASSWORD not set — auth code emails will be logged to the console instead of sent. " +
      "Set both in your .env (see env.example) to actually send mail."
    );
    return null;
  }

  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, // SSL — more reliable across hosts/containers than the 'service: gmail' shorthand + STARTTLS on 587
    auth: { user, pass },
  });
  return transporter;
}

/**
 * Sends (or, if SMTP isn't configured, logs) the 6-digit verification code
 * an Admin/School Owner/School Proprietor needs to complete registration.
 */
async function sendAdminAuthCodeEmail(toEmail, code) {
  const subject = "Your Result Generation System verification code";
  const text =
    `Your Admin/School Owner/School Proprietor verification code is: ${code}\n\n` +
    `This code expires in 10 minutes. If you didn't request this, you can ignore this email.\n\n` +
    `You can request a new code after 30 seconds if this one doesn't arrive.`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
      <h2 style="color:#111827;">Verify your email</h2>
      <p style="color:#4B5563;font-size:14px;">
        Use the code below to finish registering as an
        <strong>Admin / School Owner / School Proprietor</strong> on the
        Result Generation System.
      </p>
      <div style="font-size:32px;font-weight:800;letter-spacing:6px;background:#EEF4FF;
                  color:#0c0c0c;padding:16px 24px;border-radius:10px;text-align:center;margin:20px 0;">
        ${code}
      </div>
      <p style="color:#6B7280;font-size:12px;">
        This code expires in 10 minutes. Didn't request this? You can safely ignore this email.
      </p>
    </div>`;

  const tx = getTransporter();
  if (!tx) {
    console.log(`[email:dev-mode] Auth code for ${toEmail}: ${code}`);
    return { devMode: true, sent: false };
  }

  try {
    const info = await tx.sendMail({
      from: `"Result Generation System" <${process.env.GMAIL_USER.trim()}>`,
      to: toEmail,
      subject,
      text,
      html,
    });
    console.log(`[email] Sent auth code to ${toEmail} (messageId: ${info.messageId})`);
    return { devMode: false, sent: true, messageId: info.messageId };
  } catch (err) {
    // Common causes: (1) GMAIL_APP_PASSWORD is your normal password instead
    // of an App Password, (2) 2-Step Verification isn't enabled on the
    // account (required before Google will issue App Passwords), or
    // (3) the account has "Less secure app access" / App Passwords
    // disabled by an org admin. Surface all of that instead of a bare
    // "Invalid login" so it's actually actionable from the server logs.
    console.error(`[email] Failed to send to ${toEmail}:`, err.message);
    console.error(`[email] For reference, the code that failed to send was: ${code}`);
    const hint =
      err.responseCode === 535 || /invalid login|username and password/i.test(err.message || "")
        ? " (Gmail rejected the credentials — confirm GMAIL_APP_PASSWORD is a 16-character App Password from " +
          "https://myaccount.google.com/apppasswords, generated with 2-Step Verification turned on, not your regular account password.)"
        : "";
    const wrapped = new Error(`Could not send verification email: ${err.message}${hint}`);
    wrapped.status = 502;
    throw wrapped;
  }
}

module.exports = { sendAdminAuthCodeEmail };
