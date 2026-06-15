# Importing USDA data into the food API

This is a **one-time** job that loads USDA FoodData Central into your Railway
Postgres. Run it on a machine with plenty of RAM (the 64GB PC), **not** the 8GB
Mac. The data lands in Railway either way — it doesn't matter which machine runs
the import, only that it has enough RAM and Node installed.

---

## 1. Get the code + dependencies

```bash
git clone https://github.com/breihana/brfitness-food-api.git
cd brfitness-food-api
npm install
```

(Node 18+ required. On a fresh Windows PC, install Node from https://nodejs.org first.)

## 2. Download the USDA data

Go to https://fdc.nal.usda.gov/download-datasets.html and download
**"Full Download of All Data Types"** (CSV), then unzip it.

You need a folder containing: `food.csv`, `nutrient.csv`, `food_nutrient.csv`,
`branded_food.csv`.

> **Lighter option:** download **Foundation Foods + SR Legacy** only (~8k clean
> whole foods, skips the ~1.9M branded set). Smaller and near-instant. The app
> already ranks whole foods highest and covers packaged products via barcode
> scanning, so deferring branded loses little.

## 3. Get the PUBLIC database URL

In Railway → **Postgres service → Variables** → copy **`DATABASE_PUBLIC_URL`**.

> ⚠️ Use **`DATABASE_PUBLIC_URL`**, NOT the plain internal `DATABASE_URL`. This
> machine is outside Railway's network and can only reach the public one.

## 4. Run the import

**Windows (PowerShell):**
```powershell
$env:DATABASE_URL="<paste DATABASE_PUBLIC_URL>"
node --max-old-space-size=8192 import.js "C:\path\to\unzipped-usda-folder"
```

**macOS / Linux:**
```bash
DATABASE_URL="<paste DATABASE_PUBLIC_URL>" node --max-old-space-size=8192 import.js "/path/to/unzipped-usda-folder"
```

The `--max-old-space-size=8192` flag lifts Node's default ~2GB heap cap — the
importer holds the full dataset in memory before inserting, so the full 1.9M set
needs the headroom. Expect ~5–10 minutes; it prints `Inserted N...` as it goes.

## 5. Verify

When it finishes you'll see `Done. Imported N foods.` Then hit the live API
(replace with your food-api domain):

```bash
curl "https://<your-food-api-domain>/api/foods/search?q=banana"
```

You should get JSON with a `foods` array. Done.
