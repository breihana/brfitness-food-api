const { Pool } = require('pg');

// Railway provides DATABASE_URL. Locally you can point it at your own Postgres.
const isLocal = (process.env.DATABASE_URL || '').includes('localhost');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

module.exports = { pool };
