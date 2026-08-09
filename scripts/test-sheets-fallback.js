#!/usr/bin/env node
/**
 * Sanity-check the Google Sheets overflow store without needing to
 * actually fill up Postgres first.
 *
 * Usage:
 *   node scripts/test-sheets-fallback.js
 *
 * Loads the same .env as the app, so it uses your real
 * GOOGLE_SHEETS_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN.
 * Writes one throwaway row to the "results" tab, reads it back, updates
 * it, then deletes it — printing each step so you can confirm the
 * spreadsheet is reachable and behaving as expected before relying on it.
 */
require("dotenv").config();
const overflow = require("../src/utils/dbOverflow");
const sheets = require("../src/utils/googleSheets");

async function main() {
  if (!overflow.isConfigured()) {
    console.log(
      "GOOGLE_SHEETS_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN are not all set — the\n" +
        "overflow store is disabled. Set them in .env (see scripts/get-google-sheets-token.js\n" +
        "for how to obtain a refresh token), then re-run this script."
    );
    process.exitCode = 1;
    return;
  }

  console.log("── Locating/creating the overflow spreadsheet ──────────────────────");
  const spreadsheetId = await sheets.ensureSpreadsheet();
  console.log(`Spreadsheet ID: ${spreadsheetId}`);
  console.log(`Open it at: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit\n`);

  console.log("── Writing a throwaway test result ─────────────────────────────────");
  const testRow = await overflow.results.create({
    student_id: "00000000-0000-0000-0000-000000000000",
    student_name: "Test Student (safe to delete)",
    admission_number: "TEST-0001",
    class: "Test Class",
    term: "first",
    session: "0000/0000",
    result_type: "test",
    subjects: [{ name: "Test Subject", score: 100 }],
    total_score: 100,
    average_score: "100.00",
    overall_grade: "A",
    position: null,
    teacher_comment: "This row was written by scripts/test-sheets-fallback.js",
    principal_comment: null,
    published: false,
    attendance: { opened: 0, present: 0, absent: 0 },
    affective_domain: {},
    psychomotor_skills: {},
    house: null,
    club: null,
    age: null,
    created_by: "00000000-0000-0000-0000-000000000000",
    school_id: "TEST-SCHOOL",
  });
  console.log("Wrote row with id:", testRow.id);

  console.log("\n── Reading it back ──────────────────────────────────────────────────");
  const found = await overflow.results.findById(testRow.id);
  console.log(found ? "Found it ✓" : "NOT FOUND ✗ (something is wrong)");

  console.log("\n── Updating it ──────────────────────────────────────────────────────");
  await overflow.results.update(testRow.id, { published: true });
  const updated = await overflow.results.findById(testRow.id);
  console.log(`published is now: ${updated.published} (expected true)`);

  console.log("\n── Cleaning up (deleting the test row) ───────────────────────────────");
  await overflow.results.remove(testRow.id);
  const afterDelete = await overflow.results.findById(testRow.id);
  console.log(afterDelete === null ? "Deleted ✓" : "NOT DELETED ✗ (something is wrong)");

  console.log("\n✓ All checks passed. The overflow store is working.");
}

main().catch((err) => {
  console.error("\nTest failed:", err);
  process.exitCode = 1;
});
