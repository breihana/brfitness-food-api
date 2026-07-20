'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const migrationPath = path.resolve(
  __dirname,
  '..',
  'migrations',
  '20260721_indexed_search.sql'
);

function statementLabel(statement) {
  const indexMatch = statement.match(/CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+(\w+)/i);
  if (indexMatch) return indexMatch[1];
  return 'pg_trgm extension';
}

function migrationStatements(migrationSQL) {
  return migrationSQL
    .replace(/^\s*--.*$/gm, '')
    .match(/CREATE\s+EXTENSION[\s\S]*?;|CREATE\s+INDEX[\s\S]*?;/gi);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const client = new Client({
    connectionString,
    ssl: /(?:localhost|127\.0\.0\.1)/.test(connectionString)
      ? false
      : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    application_name: 'brfitness_indexed_search_migration'
  });

  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query('SET statement_timeout = 0');

    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    const statements = migrationStatements(migrationSQL);
    if (!statements || statements.length !== 4) {
      throw new Error('Unexpected indexed-search migration structure');
    }

    for (const statement of statements) {
      const label = statementLabel(statement);
      const started = Date.now();
      console.log(JSON.stringify({ event: 'migration_start', label }));
      await client.query(statement);
      console.log(JSON.stringify({
        event: 'migration_complete',
        label,
        durationMs: Date.now() - started
      }));
    }

    const validation = await client.query(`
      SELECT
        indexrelid::regclass::text AS index_name,
        indisready,
        indisvalid
      FROM pg_index
      WHERE indexrelid IN (
        'idx_foods_desc_trgm'::regclass,
        'idx_foods_brand_trgm'::regclass,
        'idx_foods_normalized_search_trgm'::regclass
      )
      ORDER BY index_name
    `);

    const statistics = await client.query(`
      SELECT
        s.n_live_tup,
        s.n_dead_tup,
        s.n_mod_since_analyze,
        s.last_analyze,
        s.last_autoanalyze,
        c.reltuples::bigint AS estimated_rows
      FROM pg_stat_user_tables AS s
      JOIN pg_class AS c ON c.oid = s.relid
      WHERE s.schemaname = 'public'
        AND s.relname = 'foods'
    `);

    console.log(JSON.stringify({
      event: 'migration_validation',
      indexes: validation.rows,
      statistics: statistics.rows[0] || null
    }));

    if (validation.rows.some(index => !index.indisready || !index.indisvalid)) {
      throw new Error('One or more indexed-search indexes are not valid');
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({
      event: 'migration_failed',
      errorCode: typeof error.code === 'string' ? error.code : 'UNKNOWN',
      errorName: error.name
    }));
    process.exit(1);
  });
}

module.exports = { migrationStatements, statementLabel };
