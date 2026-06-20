require("dotenv").config();
const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      host: process.env.PGHOST,
      port: process.env.PGPORT,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
    });

pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error", err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
