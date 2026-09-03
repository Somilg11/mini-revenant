-- 005_recovery_indexes.sql
--
-- The recovery worklist computes each candidate's customer and merchant
-- history with correlated subqueries on `payments`. There was no index on
-- `customer_id`, so every candidate scanned the table: with 6,800 candidates
-- over 75,000 payments the sweep doubled the length of a replay.

CREATE INDEX IF NOT EXISTS payments_customer_created
  ON payments (customer_id, created_at);

-- The case list joins cases to payments and sorts by opened_at; the status
-- filter is the common case.
CREATE INDEX IF NOT EXISTS recovery_cases_status_opened
  ON recovery_cases (status, opened_at DESC);
