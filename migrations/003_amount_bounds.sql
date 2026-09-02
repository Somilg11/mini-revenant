-- 003_amount_bounds.sql
--
-- Bound the amount by constraint, not by a validator alone.
--
-- Without an upper bound, two payments near MAX_SAFE_INTEGER sum past it and
-- every aggregate query for that window fails: the driver refuses to round a
-- BIGINT it cannot represent exactly, so `/api/v1/metrics/summary` answers 500
-- and keeps answering 500 until the rows are deleted. One accepted webhook
-- takes the dashboard down for good.
--
-- ₹10 crore is far above any real single payment (the seeded dataset tops out
-- near ₹4.7 lakh) and far below the point where realistic aggregate volumes
-- approach the safe-integer range.
--
-- This mirrors the project's rule for idempotency: enforce it with a database
-- constraint rather than an `if`, so no code path can route around it.

ALTER TABLE payments
  ADD CONSTRAINT payments_amount_sane
  CHECK (amount_paise > 0 AND amount_paise <= 1000000000);

ALTER TABLE customers
  ADD CONSTRAINT customers_ltv_sane
  CHECK (lifetime_value_paise >= 0 AND lifetime_value_paise <= 1000000000000);
