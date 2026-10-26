const dns = require("dns");
const { promisify } = require("util");
const nodemailer = require("nodemailer");

const dnsResolve4 = promisify(dns.resolve4);
const dnsLookup = promisify(dns.lookup);

// ───────────────────────────────────────────────────────────────────────
// WHY THIS FILE LOOKS THE WAY IT DOES
//
// The original ENETUNREACH error (connecting to an IPv6 address like
// 2607:f8b0:4004:c07::6d on port 465/587) kept happening *even with*
// `family: 4` set on the nodemailer transport. That's because nodemailer
// 9.x's own DNS layer (lib/shared/index.js -> resolveHostname) resolves
// BOTH the A (IPv4) and AAAA (IPv6) records for smtp.gmail.com and then
// picks a RANDOM address from the combined list to actually connect to —
// it does not read/respect the `family` option at all. On a host whose
// container has no real outbound IPv6 route (common on Render and many
// other PaaS providers), every time it randomly picks one of Gmail's
// IPv6 addresses, the connection fails immediately with ENETUNREACH,
// which is exactly the symptom reported.
//
// Two independent fixes are applied below:
//
// 1. PREFERRED: an HTTP-based email API (Resend). This sends mail over a
//    normal HTTPS POST on port 443 — no SMTP, no IPv4/IPv6 lottery, no
//    port 465/587 to be blocked. This is the most reliable option on
//    hosts like Render and is what the previous error message itself
//    recommended. Enabled by setting RESEND_API_KEY.
//
// 2. FALLBACK: Gmail SMTP, kept working for anyone who wants to keep
//    using it, but fixed to bypass nodemailer's buggy dual-stack
//    resolution entirely — we resolve the A (IPv4-only) record ourselves
//    with Node's `dns` module and hand nodemailer the literal IPv4
//    address as `host`, with `servername` set explicitly so TLS
//    certificate validation still checks against "smtp.gmail.com" (the
//    name the certificate is actually issued for) instead of the IP.
// ───────────────────────────────────────────────────────────────────────

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

// ───────────────────────────── Resend (HTTP API) ─────────────────────────

function getResendConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  const from =
    process.env.RESEND_FROM_EMAIL?.trim() ||
    // Resend's shared sandbox sender — works out of the box with no domain
    // verification, but only delivers to the email address you signed up
    // to Resend with. Verify your own domain in Resend and set
    // RESEND_FROM_EMAIL once you're ready for production sending.
    "onboarding@resend.dev";
  return { apiKey, from };
}

async function sendViaResend({ apiKey, from }, mail) {
  if (typeof fetch !== "function") {
    // Only relevant on Node < 18 without a fetch polyfill installed.
    const err = new Error(
      "global fetch is not available in this Node runtime — upgrade to Node 18+ (Render's default images already do)."
    );
    throw err;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10000), // never hang longer than 10s
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Result Generation System <${from}>`,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(
      `Resend API error (${res.status}): ${data?.message || res.statusText}`
    );
    err.status = res.status;
    err.resendError = data;
    throw err;
  }

  return { messageId: data.id };
}

// ───────────────────────────── Brevo (HTTP API) ──────────────────────────
// Sends over HTTPS (port 443) like Resend, but does NOT require owning a
// domain: you only verify a single sender address (e.g. a Gmail address) in
// Brevo, and it can then deliver to ANY recipient. Free tier: 300 emails/day.

function getBrevoConfig() {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const fromEmail = process.env.BREVO_FROM_EMAIL?.trim();
  if (!apiKey || !fromEmail) return null;
  const fromName = process.env.BREVO_FROM_NAME?.trim() || "Result Generation System";
  return { apiKey, fromEmail, fromName };
}

async function sendViaBrevo({ apiKey, fromEmail, fromName }, mail) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: fromName, email: fromEmail },
      to: [{ email: mail.to }],
      subject: mail.subject,
      textContent: mail.text,
      htmlContent: mail.html,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      `Brevo API error (${res.status}): ${data?.message || res.statusText}`
    );
    err.status = res.status;
    throw err;
  }
  return { messageId: data.messageId };
}

// ───────────────────────────── Gmail SMTP (fallback) ─────────────────────

// In-memory cache of the resolved IPv4 address for smtp.gmail.com so we
// don't do a fresh DNS lookup on every single send. Short TTL because
// Google's frontend IPs are anycast/load-balanced and can change.
let cachedIPv4 = null; // { address, expiresAt }
const IPV4_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function resolveIPv4(hostname) {
  if (cachedIPv4 && cachedIPv4.expiresAt > Date.now()) {
    return cachedIPv4.address;
  }

  let address;
  try {
    // Pure DNS A-record query — this only talks to the configured DNS
    // resolver (normally over the container's internal/IPv4 network) and
    // does not depend on outbound IPv6 routing at all, so it works even
    // on hosts where IPv6 egress is completely absent.
    const addresses = await dnsResolve4(hostname);
    address = addresses[Math.floor(Math.random() * addresses.length)];
  } catch (_err) {
    // Fall back to the OS resolver forced to IPv4, in case resolve4()
    // itself is unavailable in this environment for some reason.
    const result = await dnsLookup(hostname, { family: 4 });
    address = result.address;
  }

  cachedIPv4 = { address, expiresAt: Date.now() + IPV4_CACHE_TTL_MS };
  return address;
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
function getGmailCredentials() {
  const user = process.env.GMAIL_USER?.trim();
  // Google's UI displays App Passwords as "abcd efgh ijkl mnop" with spaces
  // for readability — copy-pasting them verbatim (spaces included) is a
  // common cause of "email isn't sending", so we strip whitespace
  // defensively rather than fail on it.
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!user || !pass) return null;
  return { user, pass };
}

/**
 * Two ways to reach Gmail's SMTP, tried in order. 465/SSL is tried first
 * (fewer round trips), falling back to 587/STARTTLS if the connection
 * itself fails — some networks/hosts allow one port but not the other.
 *
 * `host` is the IPv4 address we resolved ourselves (see resolveIPv4
 * above) rather than "smtp.gmail.com" — this is what actually forces the
 * IPv4-only connection, since nodemailer's own `family` option does not
 * do that reliably (see the big comment at the top of this file).
 * `servername` is set explicitly to "smtp.gmail.com" so TLS still
 * validates the certificate against the real hostname instead of the
 * raw IP.
 */
function buildTransportConfigs(user, pass, ipv4Address) {
  const shared = {
    host: ipv4Address,
    servername: "smtp.gmail.com",
    family: 4, // harmless to keep; belt-and-braces for other nodemailer versions
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    auth: { user, pass },
  };
  return [
    { ...shared, port: 465, secure: true },
    { ...shared, port: 587, secure: false, requireTLS: true },
  ];
}

async function sendViaGmailSmtp(creds, mail) {
  let ipv4Address;
  try {
    ipv4Address = await resolveIPv4("smtp.gmail.com");
  } catch (err) {
    const wrapped = new Error(
      `Could not resolve smtp.gmail.com to an IPv4 address: ${err.message}`
    );
    wrapped.code = err.code;
    throw wrapped;
  }

  const configs = buildTransportConfigs(creds.user, creds.pass, ipv4Address);

  let lastErr = null;
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const tx = nodemailer.createTransport(config);
    try {
      const info = await tx.sendMail(mail);
      console.log(
        `[email] Sent via Gmail SMTP port ${config.port} (resolved IP ${ipv4Address}, messageId: ${info.messageId})`
      );
      return { messageId: info.messageId };
    } catch (err) {
      lastErr = err;
      const isLastConfig = i === configs.length - 1;
      const willRetry = isConnectionLevelError(err) && !isLastConfig;
      console.error(
        `[email] Gmail SMTP send via port ${config.port} (IP ${ipv4Address}) failed: ${err.message}` +
          (willRetry ? " — retrying on fallback port…" : "")
      );
      if (isConnectionLevelError(err)) {
        // The resolved IP itself might be the problem (e.g. it went stale
        // or that particular Google frontend IP is unreachable) — drop
        // the cache so the *next* independent send attempt re-resolves
        // instead of reusing a possibly-bad address for 5 more minutes.
        cachedIPv4 = null;
      }
      if (!isConnectionLevelError(err)) break; // auth/other errors won't be fixed by switching ports
    }
  }

  throw lastErr;
}

// ───────────────────────────── Public API ─────────────────────────────

/**
 * Sends (or, if no provider is configured, logs) the 6-digit verification
 * code an Admin/School Owner/School Proprietor needs to complete
 * registration.
 *
 * Provider selection (checked in this order):
 *   1. RESEND_API_KEY set            -> send via Resend's HTTP API
 *   2. GMAIL_USER + GMAIL_APP_PASSWORD set -> send via Gmail SMTP
 *   3. neither set                   -> log the code to the console (dev mode)
 *
 * Set EMAIL_PROVIDER=smtp to force Gmail SMTP even if RESEND_API_KEY is
 * also set (useful for testing the SMTP path specifically).
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

  return deliverCodeEmail({ to: toEmail, subject, text, html }, code);
}

/**
 * Sends (or, in dev mode, logs) the 6-digit code a user needs to reset a
 * forgotten password. Uses exactly the same provider selection and
 * error handling as sendAdminAuthCodeEmail (Resend -> Gmail SMTP -> console).
 */
async function sendPasswordResetCodeEmail(toEmail, code) {
  const subject = "Your Result Generation System password reset code";
  const text =
    `Your password reset code is: ${code}\n\n` +
    `This code expires in 10 minutes. If you didn't request a password reset, ` +
    `you can ignore this email — your password will not change.\n\n` +
    `You can request a new code after 30 seconds if this one doesn't arrive.`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
      <h2 style="color:#111827;">Reset your password</h2>
      <p style="color:#4B5563;font-size:14px;">
        Use the code below to choose a new password for your
        <strong>Result Generation System</strong> account.
      </p>
      <div style="font-size:32px;font-weight:800;letter-spacing:6px;background:#EEF4FF;
                  color:#0c0c0c;padding:16px 24px;border-radius:10px;text-align:center;margin:20px 0;">
        ${code}
      </div>
      <p style="color:#6B7280;font-size:12px;">
        This code expires in 10 minutes. Didn't request this? You can safely ignore this
        email — your password will not change.
      </p>
    </div>`;

  return deliverCodeEmail({ to: toEmail, subject, text, html }, code);
}

/**
 * Shared delivery logic for every code email.
 *
 * Providers are tried in this order, and if one is configured but FAILS
 * (e.g. Resend's sandbox 403), the next configured provider is tried
 * instead of immediately failing the signup:
 *   1. Brevo   (BREVO_API_KEY + BREVO_FROM_EMAIL)       - HTTPS, any recipient, no domain needed
 *   2. Resend  (RESEND_API_KEY [+ RESEND_FROM_EMAIL])    - HTTPS, needs a verified domain for real recipients
 *   3. Gmail SMTP (GMAIL_USER + GMAIL_APP_PASSWORD)      - blocked on many PaaS hosts (e.g. Render free tier)
 *   4. none configured -> log the code to the console (dev mode)
 *
 * Set EMAIL_PROVIDER=brevo|resend|smtp to force exactly one provider.
 */
function resendHint(err, resendConfig) {
  const msg = err.message || "";
  if (err.status === 403 && /domain is not verified/i.test(msg)) {
    const consumerDomain = /@(gmail|yahoo|outlook|hotmail|live|icloud)\.com\s*$/i.test(resendConfig.from);
    return consumerDomain
      ? " (You can't send FROM a @gmail.com/@yahoo.com/etc address through Resend. Use a domain you own, " +
        "or set BREVO_API_KEY + BREVO_FROM_EMAIL to send from a single verified address instead.)"
      : " (RESEND_FROM_EMAIL is on a domain you haven't verified in Resend. Verify it at " +
        "https://resend.com/domains, or set BREVO_API_KEY + BREVO_FROM_EMAIL as an alternative.)";
  }
  if (err.status === 403 && /only send testing emails to your own email/i.test(msg)) {
    return (
      " (Resend's sandbox sender can only deliver to the email your Resend account is registered with. " +
      "For real signups either verify a domain at https://resend.com/domains and set RESEND_FROM_EMAIL, " +
      "or set BREVO_API_KEY + BREVO_FROM_EMAIL to send to any address without owning a domain.)"
    );
  }
  return "";
}

async function deliverCodeEmail(mail, code) {
  const forced = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  const brevoConfig = getBrevoConfig();
  const resendConfig = getResendConfig();
  const gmailCreds = getGmailCredentials();

  // Build the ordered list of providers to try.
  const all = [
    brevoConfig && {
      name: "brevo",
      send: () => sendViaBrevo(brevoConfig, mail),
      hint: (err) => {
        const m = err.message || "";
        if (err.status === 401) return " (Brevo rejected the API key — regenerate it and paste it without spaces or quotes.)";
        if (/sender|from/i.test(m)) return " (BREVO_FROM_EMAIL must exactly match a sender that is verified in Brevo under Settings > Senders, Domains, IPs > Senders.)";
        if (err.status === 403 || /ip|unrecognised|not allowed/i.test(m)) return " (Brevo may be blocking this server's IP. In Brevo go to Security > Authorised IPs and deactivate IP blocking, or add your host's IPs.)";
        return "";
      },
    },
    resendConfig && {
      name: "resend",
      send: () => sendViaResend(resendConfig, mail),
      hint: (err) => resendHint(err, resendConfig),
    },
    gmailCreds && {
      name: "smtp",
      send: () => sendViaGmailSmtp(gmailCreds, mail),
      hint: (err) => {
        if (err.responseCode === 535 || /invalid login|username and password/i.test(err.message || "")) {
          return " (Gmail rejected the credentials — use a 16-character App Password, not your normal password.)";
        }
        if (isConnectionLevelError(err)) {
          return " (This host appears to block outbound SMTP. Use Brevo or Resend over HTTPS instead.)";
        }
        return "";
      },
    },
  ].filter(Boolean);

  const providers = forced ? all.filter((p) => p.name === forced) : all;

  if (providers.length === 0) {
    if (forced) {
      const err = new Error(
        `EMAIL_PROVIDER=${forced} is set but that provider's credentials are missing.`
      );
      err.status = 502;
      throw err;
    }
    // No provider configured — dev mode.
    console.log(`[email:dev-mode] Auth code for ${mail.to}: ${code}`);
    console.warn(
      "[email] No email provider configured (BREVO_API_KEY / RESEND_API_KEY / GMAIL_USER+GMAIL_APP_PASSWORD) — " +
        "codes are only logged to the console."
    );
    return { devMode: true, sent: false };
  }

  // Try each provider in order; remember EVERY failure so the final error
  // shows what went wrong with each one (not just the last).
  const failures = [];
  for (const provider of providers) {
    try {
      const { messageId } = await provider.send();
      console.log(`[email] Sent auth code to ${mail.to} via ${provider.name} (id: ${messageId})`);
      return { devMode: false, sent: true, provider: provider.name, messageId };
    } catch (err) {
      failures.push(`${provider.name}: ${err.message}${provider.hint(err)}`);
      console.error(`[email] ${provider.name} send to ${mail.to} failed: ${err.message}`);
    }
  }

  const skipped = [];
  if (!brevoConfig) {
    skipped.push("brevo: NOT configured on this server (BREVO_API_KEY and/or BREVO_FROM_EMAIL missing)");
  }
  console.error(`[email] All providers failed. The code that failed to send was: ${code}`);
  const wrapped = new Error(
    `Could not send verification email. ${[...failures, ...skipped].join(" | ")}`
  );
  wrapped.status = 502;
  throw wrapped;
}

module.exports = { sendAdminAuthCodeEmail, sendPasswordResetCodeEmail };