'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  migrationStatements,
  statementLabel
} = require('../scripts/apply-indexed-search-migration');

test('indexed-search migration parser ignores SQL mentioned in comments', () => {
  const migrationPath = path.resolve(
    __dirname,
    '..',
    'migrations',
    '20260721_indexed_search.sql'
  );
  const statements = migrationStatements(fs.readFileSync(migrationPath, 'utf8'));

  assert.equal(statements.length, 4);
  assert.deepEqual(statements.map(statementLabel), [
    'pg_trgm extension',
    'idx_foods_desc_trgm',
    'idx_foods_brand_trgm',
    'idx_foods_normalized_search_trgm'
  ]);
  assert.equal(statements.some(statement => statement.includes('cannot run')), false);
});
