'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { after, before, beforeEach, test } = require('node:test');

process.env.DATABASE_URL = 'postgresql://localhost/brfitness_food_api_test';
delete process.env.APP_SECRET;

const { pool } = require('../db');
const { app, FOOD_CACHE_CONTROL } = require('../server');

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
      rows: [{
        description: 'Rolled oats', brand: '', market_country: 'NZ',
        serving_size: 100, serving_size_unit: 'g',
        calories: '380', protein: '13', carbs: '68', fat: '7', fiber: '10',
        saturated_fat: null, trans_fat: null, monounsat_fat: null,
        polyunsat_fat: null, sugar: null, added_sugars: null,
        sugar_alcohol: null, sodium: null, potassium: null, calcium: null,
        iron: null, vitamin_a: null, vitamin_c: null, vitamin_d: null,
        vitamin_b6: null, vitamin_b12: null, vitamin_k1: null, vitamin_k2: null
      }]
    };
  };

  const response = await fetch(`${baseURL}/api/foods/search?q=rolled%20oats&country=NZ`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), FOOD_CACHE_CONTROL);
  assert.equal(body.foods[0].description, 'Rolled oats');
  assert.equal(captured[1][0], 'rolled oats');
  assert.equal(captured[1][2], 'NZ');
  assert.equal(captured[1].at(-1), 20);
});

test('search, brand, market_country, and limit use isolated SQL parameters', async () => {
  let sql;
  let values;
  queryImplementation = async (capturedSQL, capturedValues) => {
    sql = capturedSQL;
    values = capturedValues;
    return { rows: [] };
  };

  const response = await fetch(
    `${baseURL}/foods?search=chicken&brand=Acme&market_country=NZ&limit=7`
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), FOOD_CACHE_CONTROL);
  assert.match(sql, /COALESCE\(brand, ''\) ILIKE \$5/);
  assert.match(sql, /LOWER\(COALESCE\(market_country, ''\)\) = LOWER\(\$6\)/);
  assert.match(sql, /LIMIT \$7/);
  assert.deepEqual(values, ['chicken', 'NZ', '', '%chicken%', '%Acme%', 'NZ', 7]);
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
