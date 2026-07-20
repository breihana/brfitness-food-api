const { Pool } = require('pg');

// Railway provides DATABASE_URL. Locally you can point it at your own Postgres.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

const isLocal = /(?:localhost|127\.0\.0\.1)/.test(connectionString);

function positiveIntegerEnvironmentValue(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') return fallback;

  const value = Number(rawValue);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const statementTimeoutMillis = positiveIntegerEnvironmentValue(
  'DB_STATEMENT_TIMEOUT_MS',
  2500
);
const queryTimeoutMillis = positiveIntegerEnvironmentValue(
  'DB_QUERY_TIMEOUT_MS',
  3000
);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // statement_timeout stops work on PostgreSQL; query_timeout bounds how long
  // this process waits for a query result.
  statement_timeout: statementTimeoutMillis,
  query_timeout: queryTimeoutMillis
});

module.exports = {
  pool,
  queryTimeoutMillis,
  statementTimeoutMillis
};
