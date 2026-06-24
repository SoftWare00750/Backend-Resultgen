require("dotenv").config();
const { Pool } = require("pg");

function createPool() {
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false,
      },
    });
  }

  return new Pool({
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT || "5432", 10),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: process.env.PGHOST && process.env.PGHOST !== "localhost"
      ? { rejectUnauthorized: false }
      : false,
  });
}

const pool = createPool();

pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error", err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};