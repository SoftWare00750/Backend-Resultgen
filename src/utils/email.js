const nodemailer = require("nodemailer");

// Cache whichever transporter config actually works so we don't re-probe
// on every request once we know which one gets through.
let workingTransportConfig = null;

// Errors that mean "we couldn't even open a TCP connection" as opposed to
// "we connected fine but auth/sending failed". Only these should trigger a
// fallback to a different port/protocol — an auth failure on port 465 will
// also fail on 587, so retrying would just waste time and muddy the error.
const CONNECTION_LEVEL_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKET",
  "ECONNECTION",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

function isConnectionLevelError(err) {
  if (!err) return false;
  if (CONNECTION_LEVEL_ERROR_CODES.has(err.code)) return true;
  // Nodemailer throws a plain "Connection timeout" message (no useful
  // .code) when the initial TCP connect or greeting doesn't complete in
  // time — catch that by message too.
  return /connection timeout|greeting never received/i.test(err.message || "");
}

/**
 * Two ways to reach Gmail's SMTP, tried in order. 465/SSL is tried first
 * (fewer round trips), falling back to 587/STARTTLS if the connection
 * itself fails — some networks/hosts allow one port but not the other.
 *
 * `family: 4` forces IPv4. This matters a lot in containers/cloud VMs
 * where Node resolves smtp.gmail.com to an IPv6 address first and that
 * route is silently dead — that alone produces the exact "Connection
 * timeout" symptom even though the account/credentials are fine.
 *
 * The three *Timeout options bound how long we wait before giving up, so a
 * genuinely blocked port fails in ~10s instead of hanging for nodemailer's
 * default ~2 minutes before the user sees any error.
 */
function buildTransportConfigs(user, pass) {
  const shared = {
    family: 4,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    auth: { user, pass },
  };
  return [
    { ...shared, host: "smtp.gmail.com", port: 465, secure: true },
    { ...shared, host: "smtp.gmail.com", port: 587, secure: false, requireTLS: true },
  ];
}

/**
 * Reads and validates the Gmail credentials from env vars. Requires a
 * Gmail *App Password* (not the regular account password) — generate one
 * at https://myaccount.google.com/apppasswords once 2-Step Verification
 * is on.
 *
 * Required env vars:
 *   GMAIL_USER  — the sending Gmail address, e.g. results@yourschoolgroup.com
 *   GMAIL_APP_PASSWORD — the 16-character app password
 */
function getCredentials() {
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
  return { user, pass };
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

  const creds = getCredentials();
  if (!creds) {
    console.log(`[email:dev-mode] Auth code for ${toEmail}: ${code}`);
    return { devMode: true, sent: false };
  }

  const mail = {
    from: `"Result Generation System" <${creds.user}>`,
    to: toEmail,
    subject,
    text,
    html,
  };

  // If a previous send already told us which config works, use it directly
  // instead of re-probing both ports every time.
  const configs = workingTransportConfig
    ? [workingTransportConfig]
    : buildTransportConfigs(creds.user, creds.pass);

  let lastErr = null;
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const tx = nodemailer.createTransport(config);
    try {
      const info = await tx.sendMail(mail);
      workingTransportConfig = config; // remember what worked for next time
      console.log(
        `[email] Sent auth code to ${toEmail} via port ${config.port} (messageId: ${info.messageId})`
      );
      return { devMode: false, sent: true, messageId: info.messageId };
    } catch (err) {
      lastErr = err;
      const isLastConfig = i === configs.length - 1;
      const willRetry = isConnectionLevelError(err) && !isLastConfig;
      console.error(
        `[email] Send via port ${config.port} failed: ${err.message}` +
          (willRetry ? " — retrying on fallback port…" : "")
      );
      if (!isConnectionLevelError(err)) break; // auth/other errors won't be fixed by switching ports
    }
  }

  // Common causes: (1) GMAIL_APP_PASSWORD is your normal password instead
  // of an App Password, (2) 2-Step Verification isn't enabled on the
  // account (required before Google will issue App Passwords), (3) the
  // account has App Passwords disabled by an org admin, or (4) the host
  // this backend runs on blocks outbound SMTP (465 *and* 587) entirely —
  // common on some serverless/free-tier platforms — in which case no
  // credential is ever checked and every attempt times out identically.
  console.error(`[email] Failed to send to ${toEmail}:`, lastErr.message);
  console.error(`[email] For reference, the code that failed to send was: ${code}`);

  let hint = "";
  if (lastErr.responseCode === 535 || /invalid login|username and password/i.test(lastErr.message || "")) {
    hint =
      " (Gmail rejected the credentials — confirm GMAIL_APP_PASSWORD is a 16-character App Password from " +
      "https://myaccount.google.com/apppasswords, generated with 2-Step Verification turned on, not your regular account password.)";
  } else if (isConnectionLevelError(lastErr)) {
    hint =
      " (Could not even open a connection to Gmail on port 465 or 587 — this looks like outbound SMTP is blocked by " +
      "your hosting provider's network/firewall rather than a credentials problem. Test with " +
      "`nc -zv smtp.gmail.com 465` and `nc -zv smtp.gmail.com 587` from the server itself; if both hang, move this " +
      "backend to a host that allows outbound SMTP, or switch to an HTTP-based email API such as Resend/SendGrid/Brevo.)";
  }

  const wrapped = new Error(`Could not send verification email: ${lastErr.message}${hint}`);
  wrapped.status = 502;
  throw wrapped;
}

module.exports = { sendAdminAuthCodeEmail };