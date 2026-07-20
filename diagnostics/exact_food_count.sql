-- Exact row-count check. Run separately and deliberately: unlike catalog
-- estimates, COUNT(*) must inspect the table or a covering index.

SELECT COUNT(*)::bigint AS exact_rows
FROM foods;
