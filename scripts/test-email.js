#!/usr/bin/env node
/**
 * Email connectivity diagnostic + live send test.
 *
 * Run this ON THE SAME HOST that runs your backend (e.g. Render's shell,
 * or your local machine before deploying) — network behavior differs
 * between environments, so testing locally only tells you about your
 * local machine, not about Render.
 *
 * Usage:
 *   node scripts/test-email.js you@example.com
 *
 * Loads the same .env as the app (via dotenv) so it uses your real
 * RESEND_API_KEY / GMAIL_USER / GMAIL_APP_PASSWORD.
 */
require("dotenv").config();
const dns = require("dns");
const net = require("net");
const { promisify } = require("util");

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

const recipient = process.argv[2];

function tcpProbe(host, port, family) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.connect({ host, port, family, timeout: 8000 });
    sock.on("connect", () => {
      const ms = Date.now() - start;
      sock.end();
      resolve({ ok: true, ms });
    });
    sock.on("timeout", () => {
      sock.destroy();
      resolve({ ok: false, reason: "timeout (likely blocked by firewall)", ms: Date.now() - start });
    });
    sock.on("error", (err) => {
      resolve({ ok: false, reason: `${err.code || err.message}`, ms: Date.now() - start });
    });
  });
}

async function main() {
  console.log("── DNS resolution for smtp.gmail.com ──────────────────────");
  let ipv4s = [];
  let ipv6s = [];
  try {
    ipv4s = await dnsResolve4("smtp.gmail.com");
    console.log("IPv4 (A) records:   ", ipv4s.join(", "));
  } catch (e) {
    console.log("IPv4 (A) records:    <failed to resolve>", e.code || e.message);
  }
  try {
    ipv6s = await dnsResolve6("smtp.gmail.com");
    console.log("IPv6 (AAAA) records:", ipv6s.join(", "));
  } catch (e) {
    console.log("IPv6 (AAAA) records: <none / failed to resolve>", e.code || e.message);
  }

  console.log("\n── Raw TCP connectivity ────────────────────────────────────");
  if (ipv4s[0]) {
    const r465v4 = await tcpProbe(ipv4s[0], 465, 4);
    console.log(`IPv4:465 -> ${ipv4s[0]}  `, r465v4.ok ? `OK (${r465v4.ms}ms)` : `FAILED — ${r465v4.reason}`);
    const r587v4 = await tcpProbe(ipv4s[0], 587, 4);
    console.log(`IPv4:587 -> ${ipv4s[0]}  `, r587v4.ok ? `OK (${r587v4.ms}ms)` : `FAILED — ${r587v4.reason}`);
  }
  if (ipv6s[0]) {
    const r465v6 = await tcpProbe(ipv6s[0], 465, 6);
    console.log(`IPv6:465 -> ${ipv6s[0]}`, r465v6.ok ? `OK (${r465v6.ms}ms)` : `FAILED — ${r465v6.reason}`);
  } else {
    console.log("IPv6:465 ->  skipped (no AAAA record resolved)");
  }

  const https = require("https");
  const httpsProbe = await new Promise((resolve) => {
    const start = Date.now();
    const req = https.request({ host: "api.resend.com", port: 443, method: "HEAD", timeout: 8000 }, (res) => {
      resolve({ ok: true, ms: Date.now() - start, status: res.statusCode });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, reason: "timeout" }); });
    req.on("error", (err) => resolve({ ok: false, reason: err.code || err.message }));
    req.end();
  });
  console.log(
    "HTTPS:443 -> api.resend.com",
    httpsProbe.ok ? `OK (${httpsProbe.ms}ms, status ${httpsProbe.status})` : `FAILED — ${httpsProbe.reason}`
  );

  console.log("\n── Interpretation ──────────────────────────────────────────");
  console.log("If HTTPS:443 to api.resend.com works but IPv4:465/587 don't:");
  console.log("  -> This host blocks outbound SMTP entirely. Use RESEND_API_KEY (Resend).");
  console.log("If IPv4:465 or :587 work but IPv6:465 fails/times out:");
  console.log("  -> This was the original bug: no outbound IPv6 route. The SMTP fix in");
  console.log("     src/utils/email.js (forcing the literal resolved IPv4 address) resolves it.");
  console.log("If everything above fails including HTTPS:");
  console.log("  -> This script itself is likely running somewhere with restricted egress");
  console.log("     (e.g. a locked-down sandbox) rather than your actual deploy target.");

  if (!recipient) {
    console.log("\nNo recipient email given — skipping live send test.");
    console.log("Re-run as: node scripts/test-email.js you@example.com  to actually send a test code.");
    return;
  }

  console.log(`\n── Live send test to ${recipient} ──────────────────────────`);
  const { sendAdminAuthCodeEmail } = require("../src/utils/email.js");
  try {
    const result = await sendAdminAuthCodeEmail(recipient, "000000");
    console.log("SUCCESS:", JSON.stringify(result));
    if (result.devMode) {
      console.log("⚠ No provider is configured (RESEND_API_KEY / GMAIL_USER+GMAIL_APP_PASSWORD are all");
      console.log("  blank) — the code was only logged above, nothing was actually emailed.");
    } else {
      console.log(`✓ Check ${recipient}'s inbox (and spam folder) for a test code.`);
    }
  } catch (err) {
    console.log("SEND FAILED:", err.message);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Diagnostic script crashed:", err);
  process.exitCode = 1;
});