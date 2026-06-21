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

  try {
    // Match on full-text OR trigram similarity (typo tolerance). Score by the
    // stronger of the two, boosted for generic whole foods so they surface
    // above the ~1.9M branded products. The 3x boost is deliberate: a branded
    // item literally named "BANANA" scores similarity ~1.0, while "Bananas, raw"
    // scores ~0.45, so a smaller boost left whole foods buried under branded hits.
    const { rows } = await pool.query(
      `SELECT description, brand, serving_size, serving_size_unit,
              calories, protein, carbs, fat,
              saturated_fat, trans_fat, monounsat_fat, polyunsat_fat,
              fiber, sugar, added_sugars, sugar_alcohol,
              sodium, potassium, calcium, iron,
              vitamin_a, vitamin_c, vitamin_d, vitamin_b6,
              vitamin_b12, vitamin_k1, vitamin_k2
       FROM foods
       WHERE search_tsv @@ plainto_tsquery('english', $1)
          OR description % $1
          OR brand % $1
       ORDER BY GREATEST(
                  ts_rank(search_tsv, plainto_tsquery('english', $1)),
                  similarity(description, $1),
                  similarity(brand, $1)
                ) * CASE WHEN data_type IN ('foundation_food', 'sr_legacy_food')
                         THEN 3.0 ELSE 1.0 END DESC
       LIMIT 20`,
      [q]
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
