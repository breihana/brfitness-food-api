'use strict';

const express = require('express');
const { pool } = require('./db');

const app = express();
const APP_SECRET = process.env.APP_SECRET;
const FOOD_CACHE_CONTROL = 'public, max-age=86400';

app.disable('x-powered-by');

// Ensure every client-visible error is non-cacheable, including authentication
// failures and Express responses added in the future.
app.use((_req, res, next) => {
  const send = res.send;
  res.send = function sendWithoutCachingErrors(body) {
    if (res.statusCode >= 400) {
      res.set('Cache-Control', 'no-store');
    }
    return send.call(this, body);
  };
  next();
});

// Optional shared-secret gate — only enforced if APP_SECRET is set in the env.
app.use((req, res, next) => {
  if (APP_SECRET && req.headers['x-app-secret'] !== APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// DB column -> USDA nutrient number, so the response mirrors USDA's
// /foods/search shape and the app's existing parser works unchanged.
const NUTRIENT_NUMBERS = {
  calories: '208', protein: '203', carbs: '205', fat: '204',
  saturated_fat: '606', trans_fat: '605', monounsat_fat: '645', polyunsat_fat: '646',
  fiber: '291', sugar: '269', added_sugars: '539', sugar_alcohol: '299',
  sodium: '307', potassium: '306', calcium: '301', iron: '303',
  vitamin_a: '320', vitamin_c: '401', vitamin_d: '328', vitamin_b6: '415',
  vitamin_b12: '418', vitamin_k1: '430', vitamin_k2: '428'
};

function stringQueryValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requestedLimit(value) {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}

function foodFromRow(row) {
  const foodNutrients = [];
  for (const [column, nutrientNumber] of Object.entries(NUTRIENT_NUMBERS)) {
    if (row[column] !== null) {
      foodNutrients.push({ nutrientNumber, value: Number(row[column]) });
    }
  }

  const netCarbs = row.carbs !== null && row.fiber !== null
    ? Math.max(0, Number(row.carbs) - Number(row.fiber))
    : null;

  return {
    description: row.description,
    brandName: row.brand || '',
    market_country: row.market_country || null,
    servingSize: row.serving_size !== null ? Number(row.serving_size) : null,
    servingSizeUnit: row.serving_size_unit || null,
    netCarbs,
    foodNutrients
  };
}

function sendFoods(res, foods) {
  res.set('Cache-Control', FOOD_CACHE_CONTROL);
  return res.json({ foods });
}

async function searchFoods(req, res) {
  // Preserve the mobile app's q/country inputs and support the hardened API's
  // search/brand/market_country/limit names on both food-search routes.
  const search = stringQueryValue(req.query.search) || stringQueryValue(req.query.q);
  const brand = stringQueryValue(req.query.brand);
  const marketCountry = stringQueryValue(req.query.market_country);
  const countryName = stringQueryValue(req.query.country_name);
  const countryCode = stringQueryValue(req.query.country);
  const limit = requestedLimit(req.query.limit);

  if (limit === null) {
    return res.status(400).json({ error: 'limit must be an integer from 1 to 100' });
  }

  if (!search && !brand && !marketCountry) {
    return sendFoods(res, []);
  }

  try {
    // Split search into keywords and require every keyword to occur in the
    // combined description and brand. Apostrophe variants are ignored on both
    // sides so Egg'd, Egg’d, and Eggd match consistently.
    const stripQuotes = value => value.replace(/[’'`´]/g, '');
    const keywords = stripQuotes(search.toLowerCase()).split(/\s+/).filter(Boolean);
    const preferredCountryName = countryName || marketCountry;
    const preferredCountryCode = countryCode;
    const values = [search.toLowerCase(), preferredCountryName, preferredCountryCode];
    const whereConditions = [];

    for (const keyword of keywords) {
      values.push(`%${keyword}%`);
      whereConditions.push(
        `REPLACE(REPLACE(REPLACE(LOWER(COALESCE(description, '') || ' ' || COALESCE(brand, '')), '’', ''), '''', ''), '\`', '') ILIKE $${values.length}`
      );
    }

    if (brand) {
      values.push(`%${brand}%`);
      whereConditions.push(`COALESCE(brand, '') ILIKE $${values.length}`);
    }

    if (marketCountry) {
      values.push(marketCountry);
      whereConditions.push(`LOWER(COALESCE(market_country, '')) = LOWER($${values.length})`);
    }

    values.push(limit);
    const limitParameter = values.length;
    const { rows } = await pool.query(
      `SELECT description, brand, market_country, serving_size, serving_size_unit,
              calories, protein, carbs, fat,
              saturated_fat, trans_fat, monounsat_fat, polyunsat_fat,
              fiber, sugar, added_sugars, sugar_alcohol,
              sodium, potassium, calcium, iron,
              vitamin_a, vitamin_c, vitamin_d, vitamin_b6,
              vitamin_b12, vitamin_k1, vitamin_k2
       FROM foods
       WHERE ${whereConditions.join(' AND ')}
       ORDER BY (CASE WHEN ($2 <> '' OR $3 <> '')
                       AND LOWER(COALESCE(market_country, '')) IN (LOWER($2), LOWER($3))
                      THEN 1 ELSE 0 END) DESC,
                GREATEST(
                  similarity(LOWER(COALESCE(description, '')), $1),
                  similarity(LOWER(COALESCE(brand, '')), $1)
                ) * CASE WHEN data_type IN ('foundation_food', 'sr_legacy_food')
                         THEN 3.0 ELSE 1.0 END DESC
       LIMIT $${limitParameter}`,
      values
    );

    return sendFoods(res, rows.map(foodFromRow));
  } catch (error) {
    console.error('Food search failed:', error);
    return res.status(500).json({ error: 'Food search failed' });
  }
}

app.get(['/api/foods/search', '/foods'], searchFoods);

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  console.error('Unexpected API error:', error);
  return res.status(500).json({ error: 'Internal server error' });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

function startServer(port = process.env.PORT || 3000) {
  const server = app.listen(port, () => {
    console.log(`BRFitness Food API listening on port ${port}`);
  });
  let shuttingDown = false;

  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received; shutting down`);
    server.close(async closeError => {
      try {
        await pool.end();
      } catch (poolError) {
        console.error('Failed to close PostgreSQL pool:', poolError);
        process.exitCode = 1;
      }
      if (closeError) {
        console.error('Failed to close HTTP server:', closeError);
        process.exitCode = 1;
      }
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  FOOD_CACHE_CONTROL,
  requestedLimit,
  searchFoods,
  startServer
};
