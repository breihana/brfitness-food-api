-- Run this migration with autocommit enabled. CREATE INDEX CONCURRENTLY cannot
-- run inside an explicit transaction.
--
-- This file is intentionally not run by application startup. Review the
-- EXPLAIN plans and obtain production approval before applying it to Railway.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_foods_desc_trgm
ON foods USING GIN (description gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_foods_brand_trgm
ON foods USING GIN (brand gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_foods_normalized_search_trgm
ON foods USING GIN (
  (
    regexp_replace(
      lower(coalesce(description, '') || ' ' || coalesce(brand, '')),
      '[‘’''`´]',
      '',
      'g'
    )
  ) gin_trgm_ops
);
