# BRFitness Food API

A self-hosted replacement for the USDA FoodData Central API. It serves food
search from your own Postgres database (bulk-imported from USDA), returning the
same JSON shape USDA's `/foods/search` does — so the BRFitness app needs only a
URL change.

**Scope:** food search only. Meals stay on-device; barcode lookups still go
through Open Food Facts in the app.

## Endpoint

```
GET /api/foods/search?q=chicken
GET /foods?search=chicken&brand=&market_country=NZ&limit=20
```

Returns up to 20 matches, mirroring USDA's response:

```json
{
  "foods": [
    {
      "description": "Chicken, breast, raw",
      "brandName": "",
      "foodNutrients": [
        { "nutrientNumber": "208", "value": 165 },
        { "nutrientNumber": "203", "value": 31 }
      ]
    }
  ]
}
```

All nutrient values are per 100 g.

Successful food-search responses are cacheable for 24 hours. The current app
route (`q`, `country`, and `country_name`) remains supported; `search`, `brand`,
`market_country`, and `limit` are also accepted on either route. `limit` defaults
to 20 and must be between 1 and 100.

## Search behavior

Ordinary word searches use the `search_tsv` GIN index first. If full-text search
returns no rows and the query contains an indexable term of at least three
characters, the API performs one trigram-backed substring fallback. The
fallback searches the indexed `description` and `brand` columns directly and an
indexed normalized expression so `Egg'd`, `Egg’d`, and `Eggd` remain equivalent.

Apply `migrations/20260721_indexed_search.sql` before deploying code that uses
the normalized fallback. It creates indexes concurrently and therefore must be
run with autocommit enabled, outside an explicit transaction. On a large live
table, review the migration and query plans and obtain deployment approval
before running it.

PostgreSQL statements default to a 2500 ms server-side timeout, with a 3000 ms
client-side read guard. The optional `DB_STATEMENT_TIMEOUT_MS` and
`DB_QUERY_TIMEOUT_MS` settings can override those defaults. Timeout responses
use HTTP 504 and are never cacheable.

Each database-backed search emits one structured JSON log containing a request
ID, bounded search inputs, query stages, result count, database duration, total
request duration, and outcome. The same request ID is returned in the
`X-Request-ID` response header. Secrets and database connection values are not
logged.

`diagnostics/search_statistics.sql` reports table statistics, planner row
estimates, and index usage. `diagnostics/exact_food_count.sql` performs the more
expensive exact count separately. The optional `pg_stat_statements` query is
commented out because enabling that extension or changing hosted Postgres
configuration is a separate production operation.

## Local setup

1. `npm install`
2. Start a local Postgres and set `DATABASE_URL` (see `.env.example`).
3. Download USDA data — the **"Full Download of All Data Types"** (Foundation +
   SR Legacy + Branded, ~1.9M foods) from
   <https://fdc.nal.usda.gov/download-datasets.html> — and unzip into one folder
   containing `food.csv`, `nutrient.csv`, `food_nutrient.csv`, `branded_food.csv`.
4. Import: `DATABASE_URL=... node import.js /path/to/that/folder`
   (creates the table + indexes, then batch-loads the data — a few minutes).
5. `npm start`, then test: `curl "localhost:3000/api/foods/search?q=egg%20white"`

## Deploy to Railway

1. Push this repo to GitHub.
2. New Railway project → deploy from the repo.
3. Add a **Postgres** plugin (one click). Railway injects `DATABASE_URL`.
4. (Optional) set `APP_SECRET` to gate the endpoint.
5. Run the import once against the Railway database. Easiest: locally set
   `DATABASE_URL` to Railway's public Postgres URL (Railway → Postgres → Connect)
   and run `node import.js /path/to/usda-folder`.
6. Generate a public domain (Railway → Settings → Networking) and put it in the
   app's `BackendConfig.foodAPIBaseURL`.

## Notes

- Branded foods (~1.9M products) are intentionally skipped for the MVP — the app
  uses Open Food Facts for branded/barcode items. Add them later by including
  `branded_food` in `DATA_TYPES` and joining `branded_food.csv` for brand names.
- Re-import quarterly if you want USDA's latest; the data changes infrequently.
