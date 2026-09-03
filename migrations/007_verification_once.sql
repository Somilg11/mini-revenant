--
-- One verified outcome per case, by constraint. The verifier runs on every
-- sweep and a case that captures between two sweeps must not be credited
-- twice; an `if (exists)` check is a race, a unique index is not (invariant 2).

CREATE UNIQUE INDEX IF NOT EXISTS outcome_verifications_one_per_case
  ON outcome_verifications (case_id);

CREATE INDEX IF NOT EXISTS outcome_verifications_verified
  ON outcome_verifications (verified_at DESC);
