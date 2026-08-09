/**
 * dbOverflow.js
 * ─────────────────────────────────────────────────────────────────────────
 * When a write to Postgres fails because the database has run out of
 * storage, route it to a Google Sheet instead of losing it (and instead of
 * just returning an error to the user). Rows written this way carry
 * `_source: "sheets_fallback"` so callers/UI can tell them apart, and are
 * merged back into GET responses so nothing written during an overflow
 * window silently disappears.
 *
 * This is deliberately generic (one `resource(...)` factory per table) so
 * new routes can opt in with a few lines — see results.js / students.js.
 */

const { v4: uuidv4 } = require("uuid");
const sheets = require("./googleSheets");

// Postgres error codes that indicate the server (or its disk/tablespace)
// is out of room, as opposed to a normal query error.
// 53100 disk_full, 53200 out_of_memory, 53300 too_many_connections,
// 54000 program_limit_exceeded (e.g. "out of shared memory").
const STORAGE_ERROR_CODES = new Set(["53100", "53200", "54000"]);

// Fallback heuristic for managed Postgres providers (Render, Neon, Supabase,
// etc.) that sometimes surface storage-cap errors as a generic error with a
// human-readable message rather than a proper SQLSTATE code.
const STORAGE_ERROR_MESSAGE = /no space left|disk.?full|out of storage|storage (limit|quota)|quota exceeded|database.*full/i;

function isStorageFullError(err) {
  if (!err) return false;
  if (err.code && STORAGE_ERROR_CODES.has(err.code)) return true;
  if (err.code === "ENOSPC") return true;
  if (typeof err.message === "string" && STORAGE_ERROR_MESSAGE.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Builds a small CRUD-ish helper for one resource/table, backed by one tab
 * in the shared overflow spreadsheet.
 *
 * @param {string} tabName   Sheet tab name, e.g. "results"
 * @param {string[]} columns Column order for that tab. Must include "id"
 *                           and "school_id" (used for scoping/lookup).
 */
function resource(tabName, columns) {
  return {
    columns,

    async create(data) {
      const row = {
        id: data.id || uuidv4(),
        created_at: new Date().toISOString(),
        ...data,
      };
      await sheets.appendRow(tabName, columns, row);
      return { ...row, _source: "sheets_fallback" };
    },

    async list(schoolId, extraFilter) {
      const rows = await sheets.getAllRows(tabName, columns);
      return rows
        .filter((r) => r.school_id === schoolId)
        .filter((r) => (extraFilter ? extraFilter(r) : true))
        .map((r) => {
          const { __sheetRow, ...clean } = r;
          return { ...clean, _source: "sheets_fallback" };
        });
    },

    async findById(id) {
      const row = await sheets.findRowByColumn(tabName, columns, "id", id);
      if (!row) return null;
      const { __sheetRow, ...clean } = row;
      return { ...clean, _source: "sheets_fallback" };
    },

    async update(id, patch) {
      const merged = await sheets.updateRowByColumn(tabName, columns, "id", id, patch);
      if (!merged) return null;
      const { __sheetRow, ...clean } = merged;
      return { ...clean, _source: "sheets_fallback" };
    },

    async remove(id) {
      return sheets.deleteRowByColumn(tabName, columns, "id", id);
    },
  };
}

const results = resource("results", [
  "id", "student_id", "student_name", "admission_number", "class", "term",
  "session", "result_type", "subjects", "total_score", "average_score",
  "overall_grade", "position", "teacher_comment", "principal_comment",
  "published", "attendance", "affective_domain", "psychomotor_skills",
  "house", "club", "age", "created_by", "school_id", "created_at",
]);

const students = resource("students", [
  "id", "name", "admission_number", "class", "parent_id", "date_of_birth",
  "gender", "guardian_name", "guardian_phone", "address", "photo_url",
  "school_id", "created_at",
]);

module.exports = {
  isConfigured: sheets.isConfigured,
  isStorageFullError,
  results,
  students,
};
