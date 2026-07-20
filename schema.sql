-- Trigram matching for typo-tolerant ("chiken" -> "chicken") fuzzy search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One denormalized table: each food with its per-100g macros and the micros
-- BRFitness tracks. A generated tsvector column powers full-text search.
CREATE TABLE IF NOT EXISTS foods (
  id           SERIAL PRIMARY KEY,
  fdc_id       INTEGER UNIQUE,
  description  TEXT NOT NULL,
  brand        TEXT DEFAULT '',
  data_type    TEXT,
  calories     DOUBLE PRECISION,
  protein      DOUBLE PRECISION,
  carbs        DOUBLE PRECISION,
  fat          DOUBLE PRECISION,
  fiber        DOUBLE PRECISION,
  sugar        DOUBLE PRECISION,
  sodium       DOUBLE PRECISION,
  potassium    DOUBLE PRECISION,
  calcium      DOUBLE PRECISION,
  iron         DOUBLE PRECISION,
  vitamin_c    DOUBLE PRECISION,
  vitamin_a    DOUBLE PRECISION,
  vitamin_d    DOUBLE PRECISION,
  vitamin_b12  DOUBLE PRECISION,
  search_tsv   tsvector GENERATED ALWAYS AS
                 (to_tsvector('english', description || ' ' || coalesce(brand, ''))) STORED
);

CREATE INDEX IF NOT EXISTS idx_foods_search ON foods USING GIN(search_tsv);
CREATE INDEX IF NOT EXISTS idx_foods_desc_trgm ON foods USING GIN(description gin_trgm_ops);
-- Brand trigram index so brand-name search ("burgerfuel") is fast and typo-tolerant.
CREATE INDEX IF NOT EXISTS idx_foods_brand_trgm ON foods USING GIN(brand gin_trgm_ops);
-- This expression must remain equivalent to the substring predicate in
-- server.js. It preserves Egg'd/Eggd matching without a full-table expression
-- scan.
CREATE INDEX IF NOT EXISTS idx_foods_normalized_search_trgm ON foods USING GIN (
  (
    regexp_replace(
      lower(coalesce(description, '') || ' ' || coalesce(brand, '')),
      '[‘’''`´]',
      '',
      'g'
    )
  ) gin_trgm_ops
);
