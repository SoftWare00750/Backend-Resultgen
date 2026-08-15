// Validates that a value is a syntactically well-formed UUID before it ever
// reaches a query bound to a `uuid`-typed column. Without this, a malformed
// id (e.g. a client-generated placeholder like "local_1699999999999" from an
// offline/failed-save fallback) reaches Postgres as-is and the driver throws
// a raw `invalid input syntax for type uuid: "..."` error, which the global
// error handler forwards verbatim as a confusing 500. Catching it here lets
// routes return a clean, actionable 400 instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

module.exports = { isUuid };