#!/usr/bin/env node
/**
 * One-time helper: obtains a Google OAuth refresh token for the Sheets
 * overflow store (see src/utils/googleSheets.js) and prints it so you can
 * paste it into .env as GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN.
 *
 * Run this LOCALLY (it opens a browser and starts a temporary local web
 * server to catch the OAuth redirect) — not on a headless server.
 *
 * Prerequisites:
 *   1. In Google Cloud Console > APIs & Services > Library, enable:
 *        - Google Sheets API
 *        - Google Drive API
 *   2. In APIs & Services > Credentials, create an OAuth client ID of type
 *      "Desktop app". Note its Client ID and Client Secret.
 *   3. Export them for this script:
 *        export GOOGLE_SHEETS_OAUTH_CLIENT_ID=...
 *        export GOOGLE_SHEETS_OAUTH_CLIENT_SECRET=...
 *      (or put them in .env — this script loads .env via dotenv too)
 *
 * Usage:
 *   node scripts/get-google-sheets-token.js
 *
 * When the browser opens, sign in as the Google account that should own
 * the overflow spreadsheet (tdsoft01@gmail.com for this project) and
 * approve access. The refresh token is printed once at the end — Google
 * only returns it on the first consent, so if you ever need a new one,
 * revoke prior access first at https://myaccount.google.com/permissions.
 */
require("dotenv").config();
const http = require("http");
const { URL } = require("url");
const { google } = require("googleapis");

const CLIENT_ID = process.env.GOOGLE_SHEETS_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_SHEETS_OAUTH_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing GOOGLE_SHEETS_OAUTH_CLIENT_ID / GOOGLE_SHEETS_OAUTH_CLIENT_SECRET.\n" +
      "Set them (env vars or .env) before running this script — see the header comment for setup steps."
  );
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: "offline", // required to get a refresh_token
  prompt: "consent", // force Google to re-issue a refresh_token even on repeat runs
  scope: SCOPES,
});

console.log("── Google Sheets overflow store — one-time authorization ───────────");
console.log("\n1. Open this URL in a browser and sign in as tdsoft01@gmail.com:\n");
console.log(authUrl);
console.log("\n2. Approve access. You'll be redirected back here automatically.\n");
console.log(`Waiting for the redirect on ${REDIRECT_URI} ...`);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404).end();
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end(`Authorization failed: ${error}`);
      console.error(`\nAuthorization failed: ${error}`);
      server.close();
      process.exitCode = 1;
      return;
    }

    const { tokens } = await oAuth2Client.getToken(code);
    res
      .writeHead(200, { "Content-Type": "text/plain" })
      .end("Authorization complete — you can close this tab and return to the terminal.");

    console.log("\n✓ Authorization complete.\n");
    if (tokens.refresh_token) {
      console.log("Add this to your .env:\n");
      console.log(`GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
    } else {
      console.log(
        "⚠ No refresh_token was returned (Google only issues one on first consent for a given\n" +
          "  client/account pair). Revoke existing access at https://myaccount.google.com/permissions\n" +
          "  (look for this app) and re-run this script."
      );
    }
    server.close();
  } catch (err) {
    console.error("\nFailed to exchange authorization code for tokens:", err.message);
    res.writeHead(500, { "Content-Type": "text/plain" }).end("Token exchange failed — see terminal.");
    server.close();
    process.exitCode = 1;
  }
});

server.listen(PORT);
