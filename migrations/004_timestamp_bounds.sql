-- 004_timestamp_bounds.sql
--
-- 003 was already applied when this constraint was written, and migrations are
-- forward-only: editing an applied file fails the next boot with both
-- checksums, which is exactly what should happen. New constraint, new file.
-- A timestamp outside this range is not a payment, it is a bug or an attack.
-- `created_at` decides rollup bucketing and window membership, so a single row
-- dated 9999 stretches the dashboard's default window across eight millennia.
ALTER TABLE payments
  ADD CONSTRAINT payments_created_at_sane
  CHECK (created_at >= TIMESTAMPTZ '2000-01-01' AND created_at < TIMESTAMPTZ '2100-01-01');

