// One-time import of USDA FoodData Central into Postgres.
//
// Usage:  DATABASE_URL=... node import.js /path/to/unzipped-usda-csv-folder
//
// Download the "Full Download of All Data Types" (or Foundation + SR Legacy +
// Branded) from https://fdc.nal.usda.gov/download-datasets.html, unzip, and
// point this at the folder with food.csv, nutrient.csv, food_nutrient.csv and
// branded_food.csv.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { pool } = require('./db');

const DIR = process.argv[2];
if (!DIR) {
  console.error('Usage: node import.js <path-to-unzipped-usda-csv-folder>');
  process.exit(1);
}

// USDA nutrient number -> our column.
const NUMBERS = {
  '208': 'calories', '203': 'protein', '205': 'carbs', '204': 'fat',
  '291': 'fiber', '269': 'sugar', '307': 'sodium', '306': 'potassium',
  '301': 'calcium', '303': 'iron', '401': 'vitamin_c', '320': 'vitamin_a',
  '328': 'vitamin_d', '418': 'vitamin_b12'
};
const DATA_TYPES = new Set(['foundation_food', 'sr_legacy_food', 'branded_food']);

const COLS = ['fdc_id', 'description', 'brand', 'data_type', ...Object.values(NUMBERS)];
const BATCH = 1000;

function readCsv(file, onRow) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(path.join(DIR, file))
      .pipe(parse({ columns: true, skip_empty_lines: true, relax_quotes: true }))
      .on('data', onRow)
      .on('end', resolve)
      .on('error', reject);
  });
}

async function flush(client, batch) {
  if (batch.length === 0) return;
  const params = [];
  const tuples = batch.map((row, i) => {
    const base = i * COLS.length;
    params.push(...row);
    return '(' + COLS.map((_, j) => `$${base + j + 1}`).join(',') + ')';
  });
  await client.query(
    `INSERT INTO foods (${COLS.join(',')}) VALUES ${tuples.join(',')}
     ON CONFLICT (fdc_id) DO NOTHING`,
    params
  );
}

async function main() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  // 1. nutrient.csv: internal nutrient id -> USDA nutrient number (we care about).
  const idToNumber = {};
  await readCsv('nutrient.csv', row => {
    const nbr = String(Number(row.nutrient_nbr)); // "208.0" -> "208"
    if (NUMBERS[nbr]) idToNumber[row.id] = nbr;
  });

  // 2. food.csv: keep Foundation, SR Legacy and Branded foods.
  const foods = new Map(); // fdc_id -> { description, data_type, brand, ...nutrients }
  await readCsv('food.csv', row => {
    if (DATA_TYPES.has(row.data_type)) {
      foods.set(row.fdc_id, { description: row.description, data_type: row.data_type, brand: '' });
    }
  });
  console.log(`Foods matched: ${foods.size}`);

  // 3. branded_food.csv: attach brand names (consumer brand, else the owner).
  try {
    await readCsv('branded_food.csv', row => {
      const food = foods.get(row.fdc_id);
      if (food) food.brand = (row.brand_name || row.brand_owner || '').trim();
    });
  } catch {
    console.log('No branded_food.csv found — skipping brand names.');
  }

  // 4. food_nutrient.csv: accumulate per-100g nutrient values onto each food.
  await readCsv('food_nutrient.csv', row => {
    const food = foods.get(row.fdc_id);
    if (!food) return;
    const number = idToNumber[row.nutrient_id];
    if (!number) return;
    const val = parseFloat(row.amount);
    if (!isNaN(val)) food[NUMBERS[number]] = val;
  });

  // 5. Batched insert (skip foods with no energy value — nothing to log).
  let count = 0;
  let batch = [];
  const client = await pool.connect();
  try {
    for (const [fdcId, f] of foods) {
      if (f.calories == null) continue;
      batch.push([
        parseInt(fdcId, 10), f.description, f.brand || '', f.data_type,
        f.calories ?? null, f.protein ?? null, f.carbs ?? null, f.fat ?? null,
        f.fiber ?? null, f.sugar ?? null, f.sodium ?? null, f.potassium ?? null,
        f.calcium ?? null, f.iron ?? null, f.vitamin_c ?? null, f.vitamin_a ?? null,
        f.vitamin_d ?? null, f.vitamin_b12 ?? null
      ]);
      if (batch.length >= BATCH) {
        await flush(client, batch);
        count += batch.length;
        batch = [];
        if (count % 10000 === 0) console.log(`Inserted ${count}...`);
      }
    }
    await flush(client, batch);
    count += batch.length;
  } finally {
    client.release();
  }

  console.log(`Done. Imported ${count} foods.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
