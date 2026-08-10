require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

/**
 * Splits a SQL script into individual top-level statements on ';', while
 * treating dollar-quoted bodies (`$$ ... $$`, used by DO blocks and
 * CREATE FUNCTION) and single-quoted string literals as opaque — semicolons
 * inside those are never split points.
 *
 * Why this exists: `pool.query(wholeFileAsOneString)` sends the whole script
 * to Postgres as a single simple-query message, and Postgres runs a
 * multi-statement simple-query string as ONE IMPLICIT TRANSACTION. That
 * silently breaks this schema, because `ALTER TYPE user_role ADD VALUE
 * 'central_admin'` is followed later in the same file by statements that
 * *use* that new enum value (`role <> 'central_admin'` in the backfill DO
 * block) — and Postgres always rejects using an enum value in the same
 * transaction that added it ("unsafe use of new value ... of enum type"),
 * regardless of Postgres version. When that happens, the WHOLE implicit
 * transaction rolls back, silently undoing every earlier statement in the
 * same run — including `CREATE TABLE schools`, even though that statement
 * itself succeeded. That is the actual mechanism behind
 * `relation "schools" does not exist`: someone ran the migration, it failed
 * output an error, and the table it looked like it just created was rolled
 * back with everything else.
 *
 * Running each statement as its own separate query (like `psql` does by
 * default, statement-by-statement rather than as one blob) avoids this
 * entirely — each statement commits independently, which is also exactly
 * what the "IF NOT EXISTS" / "ADD COLUMN IF NOT EXISTS" guards throughout
 * schema.sql are written to support.
 */
function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  let inSingleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null; // e.g. "$$" or "$tag$" when inside a dollar-quoted body

  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (two === "*/") { current += sql[i + 1]; i += 2; inBlockComment = false; continue; }
      i++;
      continue;
    }
    if (dollarTag) {
      current += ch;
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag.slice(1);
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      i++;
      continue;
    }
    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && sql[i + 1] === "'") { current += "'"; i += 2; continue; } // escaped ''
      if (ch === "'") inSingleQuote = false;
      i++;
      continue;
    }

    // Not inside any quoted/commented region:
    if (two === "--") { inLineComment = true; current += two; i += 2; continue; }
    if (two === "/*") { inBlockComment = true; current += two; i += 2; continue; }
    if (ch === "'") { inSingleQuote = true; current += ch; i++; continue; }
    if (ch === "$") {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

// Reusable, idempotent migration runner. schema.sql is written entirely with
// IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / ADD VALUE IF NOT EXISTS /
// DROP ... IF EXISTS guards, so it is always safe to re-run against a
// database that already has some or all of the tables — nothing is dropped
// or overwritten. This is what lets us call it automatically on every server
// boot (see server.js) instead of relying on someone remembering to run
// `npm run migrate` by hand after every schema.sql change.
//
// Statements are executed one at a time (see splitSqlStatements above) rather
// than as a single pool.query(wholeFile) call — running the whole file as one
// string makes Postgres treat it as one implicit transaction, which breaks
// on the ALTER TYPE ... ADD VALUE / use-new-enum-value-later sequence in this
// schema and was the actual cause of `relation "schools" does not exist`
// (see the big comment above for the full mechanism).
async function runMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const statements = splitSqlStatements(sql);
  for (const statement of statements) {
    await pool.query(statement);
  }
}

// Only run as a standalone script (`npm run migrate`) — when required from
// server.js we just want the function, not the process.exit()/pool.end() side
// effects below.
if (require.main === module) {
  (async () => {
    console.log("Running migration against database...");
    try {
      await runMigrations();
      console.log("✅ Schema created/updated successfully.");
    } catch (err) {
      console.error("❌ Migration failed:", err.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}

module.exports = { runMigrations };