-- Read-only, low-cost catalog diagnostics. Run exact_food_count.sql separately
-- because COUNT(*) can be materially more expensive than planner estimates.

SELECT
  n_live_tup,
  n_dead_tup,
  n_mod_since_analyze,
  last_analyze,
  last_autoanalyze,
  last_autovacuum
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND relname = 'foods';

SELECT
  reltuples::bigint AS estimated_rows,
  relpages
FROM pg_class
WHERE oid = 'public.foods'::regclass;

SELECT
  indexrelname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND relname = 'foods'
ORDER BY indexrelname;

-- If pg_stat_statements is already enabled, inspect normalized food-search
-- statements separately. Enabling the extension/configuration is deliberately
-- outside this migration and requires production approval.
--
-- SELECT queryid, calls, total_exec_time, mean_exec_time, max_exec_time, rows
-- FROM pg_stat_statements
-- WHERE query ILIKE '%FROM foods%'
-- ORDER BY total_exec_time DESC
-- LIMIT 25;
