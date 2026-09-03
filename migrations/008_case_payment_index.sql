--
-- `revenue_recovered` asks "did this payment ever have a case?" for every
-- payment in the window. The only index on recovery_cases(payment_id) was the
-- partial `cases_one_live`, which a plain EXISTS cannot use; the summary query
-- went from milliseconds to thirty seconds and, run a few times at once,
-- starved the relay of pool connections.

CREATE INDEX IF NOT EXISTS recovery_cases_payment
  ON recovery_cases (payment_id);
