const express = require('express');
const { pool } = require('./db');

const app = express();
const APP_SECRET = process.env.APP_SECRET;

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

app.get('/api/foods/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ foods: [] });
  // The app sends the device-region country (no personal data): name + code.
  const countryName = (req.query.country_name || '').trim();
  const countryCode = (req.query.country || '').trim();

  try {
    // Split query into keywords, require ALL to appear (case-insensitive) in description/brand combined.
    // Strip apostrophes (straight, curly, backtick, acute) so "Egg'd", "Egg’d" (iOS smart
    // quote) and "Eggd" all match the stored "EGG'D" — the brand column uses a straight ' .
    const stripQuotes = s => s.replace(/[’'`´]/g, '');
    const keywords = stripQuotes(q.toLowerCase()).split(/\s+/).filter(k => k.length > 0);
    const combined = `${countryName}${countryCode}`;  // dummy to preserve param positions

    // Build WHERE: all keywords must match (case-insensitive substring), with apostrophes
    // stripped from the searched text too so the match is apostrophe-insensitive both ways.
    let whereConditions = keywords
      .map((_, i) => `REPLACE(REPLACE(REPLACE(LOWER(COALESCE(description, '') || ' ' || COALESCE(brand, '')), '’', ''), '''', ''), '\`', '') ILIKE $${i + 4}`)
      .join(' AND ');

    const { rows } = await pool.query(
      `SELECT description, brand, market_country, serving_size, serving_size_unit,
              calories, protein, carbs, fat,
              saturated_fat, trans_fat, monounsat_fat, polyunsat_fat,
              fiber, sugar, added_sugars, sugar_alcohol,
              sodium, potassium, calcium, iron,
              vitamin_a, vitamin_c, vitamin_d, vitamin_b6,
              vitamin_b12, vitamin_k1, vitamin_k2
       FROM foods
       WHERE ${whereConditions}
       ORDER BY (CASE WHEN ($2 <> '' OR $3 <> '')
                       AND LOWER(COALESCE(market_country, '')) IN (LOWER($2), LOWER($3))
                      THEN 1 ELSE 0 END) DESC,
                GREATEST(
                  similarity(LOWER(COALESCE(description, '')), $1),
                  similarity(LOWER(COALESCE(brand, '')), $1)
                ) * CASE WHEN data_type IN ('foundation_food', 'sr_legacy_food')
                         THEN 3.0 ELSE 1.0 END DESC
       LIMIT 20`,
      [q.toLowerCase(), countryName, countryCode, ...keywords.map(k => `%${k}%`)]
    );

    const foods = rows.map(r => {
      const foodNutrients = [];
      for (const [col, number] of Object.entries(NUTRIENT_NUMBERS)) {
        if (r[col] != null) foodNutrients.push({ nutrientNumber: number, value: Number(r[col]) });
      }
      const netCarbs = (r.carbs != null && r.fiber != null)
        ? Math.max(0, Number(r.carbs) - Number(r.fiber))
        : null;
      return {
        description: r.description,
        brandName: r.brand || '',
        market_country: r.market_country || null,
        servingSize: r.serving_size != null ? Number(r.serving_size) : null,
        servingSizeUnit: r.serving_size_unit || null,
        netCarbs,
        foodNutrients
      };
    });

    res.json({ foods });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`BRFitness Food API listening on port ${port}`));
