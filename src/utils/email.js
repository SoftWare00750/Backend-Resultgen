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

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn(
      "[email] GMAIL_USER / GMAIL_APP_PASSWORD not set — auth code emails will be logged to the console instead of sent."
    );
    return null;
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
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
    return { devMode: true };
  }

  return tx.sendMail({
    from: `"Result Generation System" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject,
    text,
    html,
  });
}

module.exports = { sendAdminAuthCodeEmail };
