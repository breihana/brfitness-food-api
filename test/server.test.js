'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { after, before, beforeEach, test } = require('node:test');

process.env.DATABASE_URL = 'postgresql://localhost/brfitness_food_api_test';
delete process.env.APP_SECRET;
delete process.env.DB_QUERY_TIMEOUT_MS;
delete process.env.DB_STATEMENT_TIMEOUT_MS;

const {
  pool,
  queryTimeoutMillis,
  statementTimeoutMillis
} = require('../db');
const {
  app,
  buildFoodSearchQuery,
  FOOD_CACHE_CONTROL,
  normalizeSearch
} = require('../server');

let baseURL;
let server;
let queryImplementation;

before(async () => {
  pool.query = (...args) => queryImplementation(...args);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseURL = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  await pool.end();
});

beforeEach(() => {
  queryImplementation = async () => ({ rows: [] });
});

function foodRow(overrides = {}) {
  return {
    description: 'Rolled oats', brand: '', market_country: 'NZ',
    serving_size: 100, serving_size_unit: 'g',
    calories: '380', protein: '13', carbs: '68', fat: '7', fiber: '10',
    saturated_fat: null, trans_fat: null, monounsat_fat: null,
    polyunsat_fat: null, sugar: null, added_sugars: null,
    sugar_alcohol: null, sodium: null, potassium: null, calcium: null,
    iron: null, vitamin_a: null, vitamin_c: null, vitamin_d: null,
    vitamin_b6: null, vitamin_b12: null, vitamin_k1: null, vitamin_k2: null,
    ...overrides
  };
}

test('startup fails closed when DATABASE_URL is missing', () => {
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  const result = spawnSync(process.execPath, ['-e', "require('./db')"], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: environment,
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL environment variable is required/);
});

test('health is non-cacheable and Express does not identify itself', async () => {
  const response = await fetch(`${baseURL}/health`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.deepEqual(await response.json(), { ok: true });
});

test('food search remains compatible and is cacheable for 24 hours', async () => {
  let captured;
  queryImplementation = async (...args) => {
    captured = args;
    return {
      rows: [foodRow()]
    };
  };

  const response = await fetch(`${baseURL}/api/foods/search?q=rolled%20oats&country=NZ`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), FOOD_CACHE_CONTROL);
  assert.equal(body.foods[0].description, 'Rolled oats');
  assert.match(captured[0], /search_tsv @@ plainto_tsquery\('english', \$4\)/);
  assert.equal(captured[1][0], 'rolled oats');
  assert.equal(captured[1][2], 'NZ');
  assert.equal(captured[1].at(-1), 20);
});

test('search, brand, market_country, and limit use isolated SQL parameters', async () => {
  const calls = [];
  queryImplementation = async (capturedSQL, capturedValues) => {
    calls.push({ sql: capturedSQL, values: capturedValues });
    return { rows: [] };
  };

  const response = await fetch(
    `${baseURL}/foods?search=chicken&brand=Acme&market_country=NZ&limit=7`
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), FOOD_CACHE_CONTROL);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /search_tsv @@ plainto_tsquery\('english', \$4\)/);
  assert.match(calls[0].sql, /brand ILIKE \$5/);
  assert.match(calls[0].sql, /LIMIT \$7/);
  assert.deepEqual(calls[0].values, ['chicken', 'NZ', '', 'chicken', '%Acme%', 'NZ', 7]);
  assert.match(calls[1].sql, /description ILIKE \$4/);
  assert.match(calls[1].sql, /OR brand ILIKE \$4/);
  assert.match(calls[1].sql, /regexp_replace\(lower\(coalesce\(description/);
  assert.match(calls[1].sql, /brand ILIKE \$5/);
  assert.deepEqual(calls[1].values, ['chicken', 'NZ', '', '%chicken%', '%Acme%', 'NZ', 7]);
});

test('apostrophe-insensitive fallback keeps indexed columns bare', async () => {
  const calls = [];
  queryImplementation = async (sql, values) => {
    calls.push({ sql, values });
    return calls.length === 1
      ? { rows: [] }
      : { rows: [foodRow({ description: "Egg'd breakfast", brand: "Egg'd" })] };
  };

  const response = await fetch(`${baseURL}/foods?search=Egg%E2%80%99d`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.foods[0].brandName, "Egg'd");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].values[3], '%eggd%');
  assert.match(calls[1].sql, /description ILIKE \$4/);
  assert.match(calls[1].sql, /brand ILIKE \$4/);
  assert.doesNotMatch(calls[1].sql, /lower\(coalesce\(description, ''\)\) ILIKE/);
  assert.equal(normalizeSearch("Egg'd Egg’d Eggd"), 'eggd eggd eggd');
});

test('short searches do not trigger trigram fallback', async () => {
  let calls = 0;
  queryImplementation = async () => {
    calls += 1;
    return { rows: [] };
  };

  const response = await fetch(`${baseURL}/foods?search=v`);

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test('query safeguards have finite defaults', () => {
  assert.equal(statementTimeoutMillis, 2500);
  assert.equal(queryTimeoutMillis, 3000);
});

test('query builder escapes wildcard characters in literal filters', () => {
  const query = buildFoodSearchQuery({
    mode: 'filters',
    search: '',
    brand: '100%_real',
    marketCountry: '',
    preferredCountryName: '',
    preferredCountryCode: '',
    limit: 20
  });

  assert.match(query.text, /brand ILIKE \$4 ESCAPE/);
  assert.equal(query.values[3], '%100\\%\\_real%');
});

test('invalid limits and missing routes are non-cacheable', async () => {
  const invalid = await fetch(`${baseURL}/foods?search=oats&limit=1000`);
  const missing = await fetch(`${baseURL}/missing`);

  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('cache-control'), 'no-store');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
});

test('database errors are logged but not returned to clients', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  queryImplementation = async () => {
    throw new Error('connection refused for postgresql://sensitive-database-internal');
  };

  try {
    const response = await fetch(`${baseURL}/foods?search=oats`);
    const responseText = await response.text();

    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(responseText.includes('postgresql://'), false);
    assert.equal(responseText.includes('connection refused'), false);
    assert.deepEqual(JSON.parse(responseText), { error: 'Food search failed' });
    assert.equal(logs.length, 1);
  } finally {
    console.error = originalError;
  }
});

test('statement timeouts return 504 and emit structured duration logging', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = message => logs.push(JSON.parse(message));
  queryImplementation = async () => {
    const error = new Error('canceling statement due to statement timeout');
    error.code = '57014';
    throw error;
  };

  try {
    const response = await fetch(`${baseURL}/foods?search=oats`);
    const body = await response.json();

    assert.equal(response.status, 504);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body, { error: 'Food search timed out' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, 'food_search');
    assert.equal(logs[0].outcome, 'timeout');
    assert.equal(logs[0].errorCode, '57014');
    assert.deepEqual(logs[0].stages, ['fts']);
    assert.equal(typeof logs[0].databaseDurationMs, 'number');
    assert.equal(response.headers.get('x-request-id'), logs[0].requestId);
  } finally {
    console.error = originalError;
  }
});
