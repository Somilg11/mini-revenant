-- 001_schema.sql

CREATE TABLE merchants (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  is_synthetic              BOOLEAN NOT NULL DEFAULT TRUE,
  is_paused                 BOOLEAN NOT NULL DEFAULT FALSE,   -- kill switch, read by the policy engine
  daily_action_budget_paise BIGINT  NOT NULL DEFAULT 5000000, -- ₹50,000
  daily_action_budget_count INTEGER NOT NULL DEFAULT 200,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id                   TEXT PRIMARY KEY,
  merchant_id          TEXT NOT NULL REFERENCES merchants(id),
  lifetime_value_paise BIGINT NOT NULL DEFAULT 0,
  opted_out            BOOLEAN NOT NULL DEFAULT FALSE,        -- no contact, ever. read by the policy engine
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON customers (merchant_id);

CREATE TYPE payment_state AS ENUM
  ('CREATED','ATTEMPTED','AUTHORIZED','CAPTURED','FAILED','REFUNDED');
CREATE TYPE payment_method AS ENUM ('upi','card','netbanking','wallet');

CREATE TABLE payments (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  amount_paise  BIGINT NOT NULL CHECK (amount_paise > 0),
  method        payment_method NOT NULL,
  bank          TEXT,                             -- issuer, domestic only
  currency      CHAR(3) NOT NULL DEFAULT 'INR',
  card_country  CHAR(2),                          -- ISO-3166, NULL for non-card
  card_network  TEXT,                             -- visa | mastercard | amex | rupay
  is_international BOOLEAN NOT NULL DEFAULT FALSE, -- §1.1 — a first-class dimension, not a flag
  threeds_required BOOLEAN NOT NULL DEFAULT FALSE,
  gateway       TEXT NOT NULL DEFAULT 'primary',  -- 'primary' | 'secondary' — routing lives here
  state         payment_state NOT NULL,
  failure_code  TEXT,
  attempt_index INTEGER NOT NULL DEFAULT 1,       -- position in the customer's CURRENT failure run
  abandoned     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL,             -- window membership is decided by THIS column
  last_event_at TIMESTAMPTZ NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ON payments (merchant_id, created_at DESC);
CREATE INDEX ON payments (state, created_at DESC);
CREATE INDEX ON payments (is_international, created_at DESC);
-- the recovery worklist: unresolved failures only, so the index stays small
CREATE INDEX payments_unresolved ON payments (created_at DESC)
  WHERE state = 'FAILED' OR (state = 'ATTEMPTED' AND abandoned);

CREATE TABLE payment_events (                     -- append-only
  event_id    TEXT PRIMARY KEY,                   -- duplicate delivery = no-op, BY CONSTRAINT
  payment_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON payment_events (payment_id, occurred_at);

CREATE TABLE payment_state_transitions (          -- append-only; the recovery test reads this
  id          BIGSERIAL PRIMARY KEY,
  payment_id  TEXT NOT NULL REFERENCES payments(id),
  from_state  payment_state NOT NULL,
  to_state    payment_state NOT NULL,
  event_id    TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  stale       BOOLEAN NOT NULL DEFAULT FALSE      -- out-of-order: recorded, did not move state
);
CREATE INDEX ON payment_state_transitions (payment_id, occurred_at);
-- "was this payment ever FAILED?" — the revenue_recovered test, answered by an index
CREATE INDEX transitions_ever_failed ON payment_state_transitions (payment_id)
  WHERE to_state = 'FAILED' AND NOT stale;

CREATE TABLE outbox (
  id             BIGSERIAL PRIMARY KEY,
  topic          TEXT NOT NULL,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  dead_lettered  BOOLEAN NOT NULL DEFAULT FALSE
);
-- the relay's claim query rides this index; sent rows leave it entirely
CREATE INDEX outbox_pending ON outbox (id) WHERE sent_at IS NULL AND NOT dead_lettered;

CREATE TABLE processed_events (                   -- the at-most-once-effect marker
  consumer     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE metrics_rollup (
  merchant_id           TEXT NOT NULL REFERENCES merchants(id),
  bucket_start          TIMESTAMPTZ NOT NULL,     -- 5-minute UTC bucket
  dimension             TEXT NOT NULL,            -- 'all' | 'bank' | 'method' | 'amount_band'
  dimension_value       TEXT NOT NULL,
  attempts              INTEGER NOT NULL DEFAULT 0,
  successes             INTEGER NOT NULL DEFAULT 0,
  failures              INTEGER NOT NULL DEFAULT 0,
  abandoned             INTEGER NOT NULL DEFAULT 0,
  gross_amount_paise    BIGINT  NOT NULL DEFAULT 0,
  captured_amount_paise BIGINT  NOT NULL DEFAULT 0,
  failed_amount_paise   BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (merchant_id, bucket_start, dimension, dimension_value)
);
CREATE INDEX ON metrics_rollup (dimension, dimension_value, bucket_start DESC);

CREATE TABLE incidents (
  id                    TEXT PRIMARY KEY,
  merchant_id           TEXT REFERENCES merchants(id),   -- NULL = infrastructure-wide
  status                TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
  dimension             TEXT NOT NULL,                   -- the tuple the detector fired on
  dimension_value       TEXT NOT NULL,
  opened_at             TIMESTAMPTZ NOT NULL,
  resolved_at           TIMESTAMPTZ,
  baseline_rate         DOUBLE PRECISION NOT NULL,
  current_rate          DOUBLE PRECISION NOT NULL,
  z_score               DOUBLE PRECISION NOT NULL,
  gates                 JSONB NOT NULL,                  -- all five gates with their numbers
  affected_payments     INTEGER NOT NULL DEFAULT 0,
  revenue_at_risk_paise BIGINT  NOT NULL DEFAULT 0,
  root_cause            JSONB,                           -- ranked hypotheses (§7.4)
  narrative             TEXT,
  narrative_source      TEXT CHECK (narrative_source IN ('llm','template'))
);
-- deduplication is a constraint, not a lookup: one OPEN incident per slice
CREATE UNIQUE INDEX incidents_one_open ON incidents (dimension, dimension_value)
  WHERE status = 'OPEN';

CREATE TABLE recovery_cases (
  id                   TEXT PRIMARY KEY,
  payment_id           TEXT NOT NULL REFERENCES payments(id),
  merchant_id          TEXT NOT NULL REFERENCES merchants(id),
  incident_id          TEXT REFERENCES incidents(id),
  status               TEXT NOT NULL CHECK (status IN
                         ('OPEN','ACTING','RECOVERED','LOST','ABANDONED_BY_POLICY')),
  recovery_probability DOUBLE PRECISION,
  probability_source   TEXT CHECK (probability_source IN ('model','baseline')),
  chosen_strategy      TEXT,
  strategy_options     JSONB,                            -- all five, with their EV. the UI reads this
  expected_value_paise BIGINT,
  opened_at            TIMESTAMPTZ NOT NULL,
  closed_at            TIMESTAMPTZ
);
-- one live case per payment, enforced by the database rather than by a read-then-write race
CREATE UNIQUE INDEX cases_one_live ON recovery_cases (payment_id)
  WHERE status IN ('OPEN','ACTING');

CREATE TABLE policy_decisions (                   -- append-only; ALLOWs are stored too
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES recovery_cases(id),
  proposed_action TEXT NOT NULL,
  verdict         TEXT NOT NULL CHECK (verdict IN ('ALLOW','DENY','REQUIRE_APPROVAL')),
  reasons         JSONB NOT NULL,                 -- [{rule, passed, verdict, detail}]
  policy_version  TEXT NOT NULL,
  input_hash      TEXT NOT NULL,                  -- decision reproducible from stored inputs
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON policy_decisions (decided_at DESC);

CREATE TABLE recovery_actions (
  id                 TEXT PRIMARY KEY,
  case_id            TEXT NOT NULL REFERENCES recovery_cases(id),
  policy_decision_id TEXT NOT NULL REFERENCES policy_decisions(id),
  kind               TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL UNIQUE,        -- reserved BEFORE the gateway call
  status             TEXT NOT NULL CHECK (status IN
                       ('RESERVED','SENT','SUCCEEDED','FAILED','ESCALATED')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  cost_paise         BIGINT  NOT NULL DEFAULT 0,
  gateway_reference  TEXT,
  error_class        TEXT CHECK (error_class IN ('RETRYABLE','TERMINAL','NEEDS_HUMAN')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
);
CREATE INDEX ON recovery_actions (case_id, created_at);

CREATE TABLE outcome_verifications (
  id                     TEXT PRIMARY KEY,
  case_id                TEXT NOT NULL REFERENCES recovery_cases(id),
  attribution            TEXT NOT NULL CHECK (attribution IN ('direct','assisted','organic')),
  recovered_amount_paise BIGINT NOT NULL DEFAULT 0,
  credited_amount_paise  BIGINT NOT NULL DEFAULT 0,   -- organic credits ZERO
  predicted_probability  DOUBLE PRECISION,
  actual_recovered       BOOLEAN NOT NULL,
  verified_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_decisions (                    -- append-only audit of every LLM call
  id              TEXT PRIMARY KEY,
  case_id         TEXT REFERENCES recovery_cases(id),
  incident_id     TEXT REFERENCES incidents(id),
  prompt_hash     TEXT NOT NULL,
  raw_response    TEXT,
  parsed_choice   TEXT,                           -- must be in the closed enum, else rejected
  rejected_reason TEXT,
  source          TEXT NOT NULL CHECK (source IN ('llm','fallback')),
  latency_ms      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ground_truth_incidents (             -- the answer key, deliberately separate
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL,
  ended_at              TIMESTAMPTZ NOT NULL,
  dimensions            JSONB NOT NULL,
  affected_payments     INTEGER NOT NULL,
  revenue_at_risk_paise BIGINT NOT NULL,
  detected_incident_id  TEXT REFERENCES incidents(id)   -- filled by the scorer, never by the detector
);

CREATE TABLE ground_truth_labels (                -- counterfactuals, decided at generation time
  payment_id               TEXT PRIMARY KEY REFERENCES payments(id),
  recoverable_by_retry     BOOLEAN NOT NULL,
  recoverable_by_link      BOOLEAN NOT NULL,
  recoverable_by_alternate BOOLEAN NOT NULL,
  recoverable_by_gateway   BOOLEAN NOT NULL,      -- the second processor (§1.1)
  recoverable              BOOLEAN NOT NULL,
  split                    TEXT NOT NULL CHECK (split IN ('train','val','test'))
);
CREATE INDEX ON ground_truth_labels (split);

CREATE TABLE dataset_runs (
  id                TEXT PRIMARY KEY,
  seed              INTEGER NOT NULL,
  params            JSONB NOT NULL,
  checksum          TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE simulations (                        -- what-if runs, §8.7
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('baseline','agent')),
  params     JSONB NOT NULL,
  results    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE model_versions (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('logistic','baseline')),
  coefficients JSONB NOT NULL,
  calibration  JSONB NOT NULL,                    -- bucket map
  metrics      JSONB NOT NULL,                    -- auc, brier, log_loss, calibration curve
  trained_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active    BOOLEAN NOT NULL DEFAULT FALSE
);
-- at most one active model, by constraint
CREATE UNIQUE INDEX model_one_active ON model_versions ((TRUE)) WHERE is_active;
