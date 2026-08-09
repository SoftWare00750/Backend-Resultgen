/**
 * googleSheets.js
 * ─────────────────────────────────────────────────────────────────────────
 * Thin wrapper around the Google Sheets + Drive APIs used ONLY as an
 * emergency overflow store: when Postgres reports that it's out of storage
 * (see isStorageFullError in dbOverflow.js), writes get redirected here
 * instead of being lost.
 *
 * The spreadsheet lives in the Google account that issued the OAuth refresh
 * token below (GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN) — for this project that's
 * tdsoft01@gmail.com. Using a real user OAuth token (rather than a service
 * account) means the sheet is actually owned by that Gmail account and shows
 * up in that account's own Google Drive / Sheets, with no manual
 * "share with me" step required.
 *
 * One-time setup (see scripts/get-google-sheets-token.js):
 *   1. Create an OAuth "Desktop app" client in Google Cloud Console and
 *      copy its Client ID / Client Secret.
 *   2. Run `node scripts/get-google-sheets-token.js`, sign in as
 *      tdsoft01@gmail.com when the browser opens, and approve access.
 *   3. Paste the printed values into .env:
 *        GOOGLE_SHEETS_OAUTH_CLIENT_ID=...
 *        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET=...
 *        GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN=...
 *
 * If those three env vars are not set, every function here is a safe no-op
 * (isConfigured() === false) so the app runs fine without this feature.
 */

const { google } = require("googleapis");

const SPREADSHEET_TITLE =
  process.env.GOOGLE_SHEETS_SPREADSHEET_TITLE || "RGS Overflow Storage";

function isConfigured() {
  return !!(
    process.env.GOOGLE_SHEETS_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_SHEETS_OAUTH_CLIENT_SECRET &&
    process.env.GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN
  );
}

let authClient = null;
function getAuthClient() {
  if (authClient) return authClient;
  authClient = new google.auth.OAuth2(
    process.env.GOOGLE_SHEETS_OAUTH_CLIENT_ID,
    process.env.GOOGLE_SHEETS_OAUTH_CLIENT_SECRET
  );
  authClient.setCredentials({
    refresh_token: process.env.GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN,
  });
  return authClient;
}

function sheetsApi() {
  return google.sheets({ version: "v4", auth: getAuthClient() });
}
function driveApi() {
  return google.drive({ version: "v3", auth: getAuthClient() });
}

// Cached for the lifetime of the process — avoids a Drive search + possible
// spreadsheet creation on every single fallback write.
let spreadsheetIdPromise = null;

/**
 * Finds the overflow spreadsheet by title in the authorized account's
 * Drive, creating it if it doesn't exist yet. Safe to call concurrently.
 */
async function ensureSpreadsheet() {
  if (spreadsheetIdPromise) return spreadsheetIdPromise;

  spreadsheetIdPromise = (async () => {
    const drive = driveApi();
    const escapedTitle = SPREADSHEET_TITLE.replace(/'/g, "\\'");
    const { data } = await drive.files.list({
      q: `name = '${escapedTitle}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
    });

    if (data.files && data.files.length > 0) {
      return data.files[0].id;
    }

    const sheets = sheetsApi();
    const { data: created } = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: SPREADSHEET_TITLE },
        sheets: [{ properties: { title: "_meta" } }],
      },
    });
    console.log(
      `📊 Created Google Sheets overflow store "${SPREADSHEET_TITLE}" (${created.spreadsheetId}) ` +
        `in the account that owns the configured OAuth refresh token.`
    );
    return created.spreadsheetId;
  })().catch((err) => {
    // Don't poison the cache with a rejected promise — let the next call retry.
    spreadsheetIdPromise = null;
    throw err;
  });

  return spreadsheetIdPromise;
}

/**
 * Ensures a tab (Sheets calls these "sheets") named `tabName` exists with
 * `headerRow` as its first row. One tab per logical table (e.g. "results",
 * "students"), keeping the whole overflow store in a single spreadsheet.
 */
async function ensureTab(tabName, headerRow) {
  const spreadsheetId = await ensureSpreadsheet();
  const sheets = sheetsApi();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(
    (s) => s.properties.title === tabName
  );

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [headerRow] },
    });
  }

  return spreadsheetId;
}

/** Appends one row (in headerRow column order) to the given tab. */
async function appendRow(tabName, headerRow, rowObject) {
  const spreadsheetId = await ensureTab(tabName, headerRow);
  const sheets = sheetsApi();
  const values = headerRow.map((col) => stringifyCell(rowObject[col]));

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
}

/** Returns every data row in the tab as plain objects keyed by headerRow. */
async function getAllRows(tabName, headerRow) {
  const spreadsheetId = await ensureTab(tabName, headerRow);
  const sheets = sheetsApi();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A2:${columnLetter(headerRow.length)}`,
  });

  return (data.values || []).map((row, i) => {
    const obj = { __sheetRow: i + 2 }; // 1-based, +1 for header row
    headerRow.forEach((col, idx) => {
      obj[col] = parseCell(row[idx]);
    });
    return obj;
  });
}

/** Finds one row by an arbitrary column value (e.g. "id"). */
async function findRowByColumn(tabName, headerRow, column, value) {
  const rows = await getAllRows(tabName, headerRow);
  return rows.find((r) => r[column] === value) || null;
}

/** Patches specific columns of the row matching column === value. */
async function updateRowByColumn(tabName, headerRow, column, value, patch) {
  const spreadsheetId = await ensureTab(tabName, headerRow);
  const existing = await findRowByColumn(tabName, headerRow, column, value);
  if (!existing) return null;

  const sheets = sheetsApi();
  const merged = { ...existing, ...patch };
  const values = headerRow.map((col) => stringifyCell(merged[col]));

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A${existing.__sheetRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });

  return merged;
}

/** Deletes the row matching column === value. Returns true if one was removed. */
async function deleteRowByColumn(tabName, headerRow, column, value) {
  const spreadsheetId = await ensureTab(tabName, headerRow);
  const existing = await findRowByColumn(tabName, headerRow, column, value);
  if (!existing) return false;

  const sheets = sheetsApi();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetId = meta.data.sheets.find(
    (s) => s.properties.title === tabName
  ).properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: existing.__sheetRow - 1,
              endIndex: existing.__sheetRow,
            },
          },
        },
      ],
    },
  });

  return true;
}

// JSON-stringify objects/arrays so nested data (subjects, attendance, etc.)
// still fits in a single flat cell; leave primitives as-is.
function stringifyCell(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Reverse of stringifyCell: try JSON first (covers objects/arrays/booleans/
// numbers we wrote out as JSON), fall back to the raw string.
function parseCell(value) {
  if (value === undefined || value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function columnLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

module.exports = {
  isConfigured,
  ensureSpreadsheet,
  appendRow,
  getAllRows,
  findRowByColumn,
  updateRowByColumn,
  deleteRowByColumn,
};
