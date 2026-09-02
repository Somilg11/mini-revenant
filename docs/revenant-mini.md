# Revenant Mini — Hackathon MVP Build Spec

**What this is.** A single, self-contained specification for building a working
end-to-end prototype of **Revenant** — an autonomous revenue recovery control
plane for payments — in TypeScript, in one sitting.

The production system is Go + Postgres + RabbitMQ + Redis + Python/sklearn. That
is the right shape for money at volume, and more moving parts than a hackathon
day affords. **Revenant Mini keeps every decision, formula and invariant of the
real system, keeps PostgreSQL, and swaps only the parts whose absence changes
nothing about the demo**: an in-process outbox relay instead of RabbitMQ, a
logistic regression trained in TypeScript instead of scikit-learn, and Bun
instead of Go.

Postgres runs in its own container — one service, `docker compose -p
revenant-mini up -d postgres`. Everything else runs on the host.

Nothing about the *reasoning* is mocked. The detector really detects, the root
cause analysis really apportions excess failures, the model is really trained on
generated data with a chronological split, the policy engine really blocks the
executor at the type level, and the executor really talks to a simulated
gateway with idempotency keys. What is mocked is **the payment gateway and the
passage of time** — a deterministic simulator replays 7 days of synthetic
traffic in ~3 minutes so a judge can watch the whole loop happen live.

> Read this file top to bottom once, then build in the order of §12. Every
> number in this document is load-bearing; do not invent different ones.

---

## 1. The product in six lines

Merchants lose payment revenue and nobody can say *which* failures matter, *why*
they are happening, or *which* fix is worth its cost. Revenant watches the
payment stream and runs one loop:

```
DETECT → DIAGNOSE → QUANTIFY → DECIDE → GATE → ACT → VERIFY → LEARN
```

- **DETECT** — rolling 5-minute rollups feed an EWMA + z-score anomaly detector; an anomaly opens an **incident**.
- **DIAGNOSE** — deterministic root-cause analysis apportions *excess* failures across dimension tuples and ranks hypotheses with evidence.
- **QUANTIFY** — every unresolved failure gets `P(recovery)` from a trained, calibrated model (rule baseline if the model is unavailable).
- **DECIDE** — an expected-value strategy engine picks `retry` / `payment_link` / `alternate_method` / `do_nothing`.
- **GATE** — a deterministic policy engine returns ALLOW / DENY / REQUIRE_APPROVAL with reasons. The executor accepts nothing else.
- **ACT → VERIFY → LEARN** — an idempotent executor calls the gateway, outcomes are attributed (direct / assisted / organic), predictions are scored against reality.

An LLM narrates and picks from a closed enum. **It never computes a number and
never executes.** The system is correct with the LLM switched off.

---

## 1.1 The wedge: cross-border acceptance

The demo needs one specific, real, currently-unsolved pain rather than a generic
"payments fail sometimes". This is it — an Indian SaaS founder selling globally,
posted publicly:

> "India-registered SaaS founder selling globally, using Razorpay. Checked my
> dashboard today: **25 failed payments in the last 30 days.** The frustrating
> part is these are international customers. If their card gets rejected they
> don't care whether it's Razorpay, 3DS, risk checks or their bank — they just
> see *payment failed* and leave. Stripe rejected my India entity, and
> Paddle/Lemon Squeezy don't work for my pricing. Has anyone actually switched
> and seen better international acceptance?"

Four things in that post are the entire product thesis:

1. **The number is too small to eyeball and too big to ignore.** 25 failures is a rounding error on a dashboard and a meaningful share of an early-stage SaaS's MRR. Nobody is going to open 25 payment records and find the pattern by hand — which is exactly the size of problem an automated diagnosis is for.
2. **The founder does not know *why*.** 3DS, issuer risk, cross-border rules, the PSP's own risk engine — the dashboard says `payment_failed` and stops. Every answer available to them is a guess, which is why the thread is asking strangers instead of reading data.
3. **The proposed fix is "switch processor", which is a 3-month migration made on a hunch.** Nobody in that thread can say what acceptance would be on Cashfree or PayU, because nobody has the counterfactual. **Revenant's what-if simulator (§8.7) is precisely that counterfactual**, computed rather than argued.
4. **The customer is already gone.** A failed international payment gets no retry, no link, no alternate route. The revenue is not lost to a hard decline — it is lost to nobody following up.

**What Revenant does about it, concretely:**

- Treats `is_international` as a **first-class analytics dimension**, so a cross-border acceptance collapse is a detectable incident rather than a slow bleed hidden inside an overall 7% failure rate.
- Root-causes it to the actual tuple — `international × card × 3DS_FAILED` — instead of "cards are failing", and quantifies what share of the excess it explains.
- Puts a rupee figure on it: what those 25 failures are worth, and what is recoverable at what probability.
- Adds `alternate_gateway` to the strategy set: route the retry through a second processor. **This is the only honest answer to "should I switch?" — not a migration, a per-payment routing decision made on expected value.**
- Answers the thread's real question on `/whatif`: same failed payments, current routing vs EV-driven routing, with the incremental revenue printed.

**Do not overclaim this.** Revenant does not fix a hard issuer decline and does
not make an unsupported card work. It finds the failures that *are* recoverable,
says which ones and why, and refuses to spend money on the rest. Say exactly
that on the landing screen; the audience for this demo has been marketed at
enough.

---

## 2. Hard invariants — never violate these

1. **PostgreSQL is the source of truth.** Anything else — a cache, a rollup, an incident, a case — is derived and rebuildable from `payment_events`.
2. **At-least-once delivery, at-most-once effect.** Idempotency is enforced by `UNIQUE` constraints, never by an `if (exists)` check.
3. **Every money action passes the policy engine.** The executor's signature accepts only `PolicyApprovedAction`, a branded type whose constructor is not exported. Bypassing it is a *type error*, not a review comment.
4. **The LLM never produces a number and never executes.** It receives computed context and returns a value from a closed enum plus prose.
5. **Money is integer paise (`number`, but always whole paise).** No float arithmetic touches an amount. Rates are computed from two integers at the moment of display.
6. **Never print an unmeasured metric.** Not-yet-measured is `null` with a label, never `0`.
7. **Time is UTC everywhere in code. IST only in the browser.**

These are the demo. A judge who asks "what stops it double-charging?" must get a
concrete answer, and the answer must be visible in the UI.

---

## 3. Scope: what is real, what is swapped

| Concern | Production (Go) | Mini (TypeScript) | Why the swap is honest |
|---|---|---|---|
| Language | Go | **TypeScript on Bun** | Same logic, no performance claim made |
| Store | PostgreSQL 16 | **PostgreSQL 16, in Docker** — unchanged | Same SQL, same constraints, same transactions, same locking |
| Queue | RabbitMQ quorum queues | **Outbox table + in-process relay** (200 ms tick, `FOR UPDATE SKIP LOCKED`) | Same transactional-outbox guarantee; loses only cross-process fan-out |
| Cache/locks | Redis | In-memory `Map` + `pg_advisory_xact_lock` | Non-authoritative in both |
| Model | Python/sklearn logistic + isotonic | **Logistic regression trained in TS** (batch gradient descent) + Platt-ish bucket calibration | Real training, real chronological split, real calibration curve |
| Gateway | Razorpay Test Mode | **Simulated gateway** driven by ground-truth labels | Outcomes come from pre-decided counterfactuals, so recovery is measurable |
| Time | Wall clock | **Simulated clock**, 1 real second = 30 simulated minutes | Lets a 7-day story play in 3 minutes |
| LLM | Claude | Claude (`claude-sonnet-5`), optional, off by default | Deterministic fallback always present |

**Explicitly out of scope for the MVP:** auth (single hardcoded merchant switcher), multi-tenancy enforcement, Prometheus/Grafana, load testing, real webhooks over the internet.

---

## 4. Stack

```
Runtime      Bun 1.2+ (workspaces, native TS, no build step)
Backend      Hono · postgres.js · zod · @anthropic-ai/sdk (optional)
Database     PostgreSQL 16 in Docker (one container, one volume)
Frontend     Next.js 15 (App Router) · React 19 · Tailwind CSS 4 · shadcn/ui · Recharts · lucide-react
Transport    REST + Server-Sent Events (/api/v1/stream), fed by Postgres LISTEN/NOTIFY
Test         bun test (domain modules only — they are pure functions)
```

**Why Bun.** It runs TypeScript directly, so there is no build step between an
edit and a running API; `bun install` on this dependency set is seconds rather
than a minute; `bun --watch` restarts faster than nodemon; and `bun test` needs
no vitest config. Nothing in this spec depends on Bun — every line runs on Node
20 with `tsx` if Bun misbehaves on the day. **If anything Bun-specific costs more
than five minutes, switch that package to Node and move on.** The frontend runs
Next.js normally; Bun is its package manager, not necessarily its runtime.

**Why Hono over Fastify.** Bun-native, Web-standard `Request`/`Response`, SSE in
four lines, and typed routes without a plugin system. Fastify is a fine
substitute if it is more familiar.

One container. `docker compose -p revenant-mini up -d postgres` is the only
infrastructure command in the whole build.

---

## 5. Repository layout

```
revenant-mini/
├─ package.json                    # bun workspace root: dev, seed, train, whatif, db:*
├─ bunfig.toml
├─ docker-compose.yml              # ONE service: postgres. project name revenant-mini
├─ migrations/
│  ├─ 001_schema.sql               # §6, forward-only
│  └─ 002_seed_merchants.sql
├─ .env.example
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ index.ts               # Hono bootstrap, wires everything, starts the loops
│  │  │  ├─ config.ts              # env parsing (zod), redacted logging
│  │  │  ├─ db/
│  │  │  │  ├─ client.ts           # postgres.js pool, migrate-on-boot under an advisory lock
│  │  │  │  ├─ migrate.ts          # applies ../../migrations/*.sql in order, once
│  │  │  │  ├─ notify.ts           # LISTEN revenant_events → SSE fan-out
│  │  │  │  └─ queries.ts          # every SQL statement, one place, typed
│  │  │  ├─ domain/                # PURE. no db, no clock, no network, no imports from ../
│  │  │  │  ├─ money.ts            # paise helpers, amount bands
│  │  │  │  ├─ payment-state.ts    # state machine (§7.1)
│  │  │  │  ├─ failure-codes.ts    # codes → families (§7.2)
│  │  │  │  ├─ detector.ts         # EWMA + z-score anomaly detection (§7.3)
│  │  │  │  ├─ rca.ts              # excess-failure apportionment (§7.4)
│  │  │  │  ├─ recovery-model.ts   # feature vector, logistic scoring, rule baseline (§7.5)
│  │  │  │  ├─ strategy.ts         # expected-value engine (§7.6)
│  │  │  │  └─ policy.ts           # policy engine + PolicyApprovedAction brand (§7.7)
│  │  │  ├─ app/                   # use cases; orchestrates domain over ports
│  │  │  │  ├─ ingest.ts           # event + outbox in ONE transaction
│  │  │  │  ├─ relay.ts            # outbox → handlers, 200 ms tick
│  │  │  │  ├─ projector.ts        # applies state machine, writes payment + attempt + transition + marker in ONE txn
│  │  │  │  ├─ analytics.ts        # rollups (incremental) + recompute + drift
│  │  │  │  ├─ detection.ts        # opens/resolves incidents, runs RCA
│  │  │  │  ├─ recovery.ts         # opens cases, predicts, chooses strategy
│  │  │  │  ├─ agent.ts            # LLM proposal + deterministic fallback
│  │  │  │  ├─ executor.ts         # idempotent action execution
│  │  │  │  └─ verify.ts           # attribution + prediction scoring
│  │  │  ├─ sim/
│  │  │  │  ├─ generator.ts        # deterministic dataset + ground truth (§8)
│  │  │  │  ├─ clock.ts            # simulated clock, speed control
│  │  │  │  ├─ gateway.ts          # simulated Razorpay
│  │  │  │  ├─ runner.ts           # replays the dataset into the webhook path
│  │  │  │  └─ whatif.ts           # BASELINE vs AGENT counterfactual replay (§8.7)
│  │  │  ├─ ml/
│  │  │  │  └─ train.ts            # logistic regression trainer + calibration + model card
│  │  │  ├─ http/
│  │  │  │  ├─ routes/*.ts         # one file per resource group (§10)
│  │  │  │  └─ sse.ts              # event stream to the dashboard
│  │  │  └─ lib/rng.ts             # seeded PRNG (mulberry32) — the whole demo is reproducible
│  │  └─ package.json
│  └─ web/
│     ├─ app/
│     │  ├─ layout.tsx
│     │  ├─ globals.css            # Linear theme tokens (§11)
│     │  ├─ page.tsx               # Command Center
│     │  ├─ incidents/page.tsx     # + [id]/page.tsx
│     │  ├─ recovery/page.tsx
│     │  ├─ policy/page.tsx
│     │  ├─ simulator/page.tsx
│     │  ├─ whatif/page.tsx
│     │  ├─ audit/[paymentId]/page.tsx
│     │  └─ model/page.tsx
│     ├─ components/               # shadcn primitives + Revenant components (§11.4)
│     ├─ lib/api.ts                # typed fetch client
│     ├─ lib/stream.ts             # EventSource hook
│     └─ package.json
└─ revenant-mini.md                # this file
```

**Dependency rule, enforced by review and by an eslint `no-restricted-imports`
rule:** `domain/` imports nothing from the project. `app/` imports `domain/` and
`db/`. `http/` imports `app/`. Nothing imports `http/`.

---

## 6. Data model (PostgreSQL DDL)

Conventions: money is `BIGINT` **paise**; every timestamp is `TIMESTAMPTZ` in
UTC; structured columns are `JSONB`; append-only tables are never updated or
deleted; `version` on mutable rows. Migrations live in `migrations/NNN_*.sql`,
are forward-only, and are applied on boot inside a transaction guarded by an
advisory lock so two processes starting at once cannot both migrate.

```sql
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
```

**Why the ground truth is in its own tables:** a truth column on `payments`
eventually gets mistaken for a prediction or leaks into a feature. Separation
makes that mistake structural rather than a matter of care.

### 6.1 The four Postgres features doing real work

Four things here are not decoration — they are the concurrency story, and each
one is a question a judge can ask:

**`FOR UPDATE SKIP LOCKED` on the outbox.** The relay claims work instead of
scanning it, so N relay loops never hand the same row to two consumers:

```sql
UPDATE outbox SET attempts = attempts + 1
WHERE id IN (
  SELECT id FROM outbox
  WHERE sent_at IS NULL AND NOT dead_lettered
  ORDER BY id
  FOR UPDATE SKIP LOCKED
  LIMIT 50
)
RETURNING id, topic, payload;
```

**Row locks in the projector.** `SELECT … FROM payments WHERE id = $1 FOR
UPDATE` inside the transaction that applies the state transition. Two events
for one payment arriving at once serialise on the row rather than racing to
overwrite `state`.

**Partial unique indexes as business rules.** `cases_one_live`,
`incidents_one_open` and `model_one_active` make "one open case per payment",
"no duplicate incident for a slice" and "one active model" impossible at the
storage layer. Every one of those would otherwise be a read-then-write race
somebody eventually loses.

**`LISTEN` / `NOTIFY` for the dashboard.** Handlers `NOTIFY revenant_events`
with a small JSON payload inside the same transaction as their write; one
dedicated connection listens and fans out to SSE clients. The dashboard shows an
event only after it has committed — no polling loop, and nothing appears on
screen that a rollback later un-happened.

Also used: window functions for the rollup recompute (`sum() OVER` per bucket),
`GENERATED`-free integer paise arithmetic everywhere, and
`pg_advisory_xact_lock` to keep the detection sweep single-flighted.

---

## 7. Domain modules — exact contracts

Everything in this section is a **pure function**: no database, no clock, no
network, no randomness that is not passed in. These are the four components with
the highest correctness risk, so they are the ones kept free of infrastructure
and covered by vitest.

### 7.1 Payment state machine — `domain/payment-state.ts`

```
CREATED → ATTEMPTED → FAILED
                    → AUTHORIZED → CAPTURED → REFUNDED
```

```ts
export type State = 'CREATED'|'ATTEMPTED'|'AUTHORIZED'|'CAPTURED'|'FAILED'|'REFUNDED';
export type EventKind = 'payment.created'|'payment.attempted'|'payment.authorized'
                      |'payment.captured'|'payment.failed'|'refund.processed';

export type TransitionResult =
  | { ok: true;  next: State; stale: false }
  | { ok: true;  next: State; stale: true }      // out-of-order: record it, do not move
  | { ok: false; error: 'INVALID_TRANSITION'|'UNKNOWN_STATE'|'TERMINAL_PROTECTED' };

export function transition(
  current: State, event: EventKind,
  occurredAt: string, lastEventAt: string,
): TransitionResult;
```

Rules, in this order:
1. `occurredAt < lastEventAt` → `{ok:true, stale:true, next:current}`. Out-of-order events are normal, not errors.
2. `CAPTURED` and `REFUNDED` are **terminal**: only `refund.processed` may move `CAPTURED`. Anything else returns `TERMINAL_PROTECTED`. **This single rule is what stops the system retrying a payment that already succeeded.**
3. A `FAILED` payment may re-enter `ATTEMPTED` (that is what a recovery retry is), incrementing `attempt_index`.
4. Anything else not in the table → `INVALID_TRANSITION`.

A payment left in `ATTEMPTED` with no failure event and no activity for 30
simulated minutes is **abandoned** — it stays `ATTEMPTED` (no gateway ever
reported a failure) and gets `abandoned = 1`.

### 7.2 Failure codes → families — `domain/failure-codes.ts`

The family is what generalises; a model that has only seen `CARD_EXPIRED` can
still say something useful about `CARD_DECLINED`.

| Family | Codes |
|---|---|
| `TRANSIENT` | `GATEWAY_ERROR`, `BANK_DOWN`, `PAYMENT_TIMEOUT`, `NETWORK_ERROR` |
| `CUSTOMER` | `INSUFFICIENT_FUNDS`, `CARD_EXPIRED`, `CARD_DECLINED`, `INCORRECT_OTP`, `PAYMENT_LIMIT_EXCEEDED` |
| `TERMINAL` | `FRAUD_SUSPECTED`, `INVALID_ACCOUNT` |
| `ABANDONMENT` | `CHECKOUT_ABANDONED` |
| **`CROSS_BORDER`** | `THREEDS_FAILED`, `THREEDS_NOT_SUPPORTED`, `INTERNATIONAL_CARD_BLOCKED`, `ISSUER_DECLINED_CROSS_BORDER`, `CURRENCY_NOT_SUPPORTED` |
| `UNKNOWN` | anything else — and unknown means *ask a human*, never *retry* |

**`CROSS_BORDER` is its own family, not a subset of `CUSTOMER`,** because its
recovery profile is completely different: nothing about the customer or their
balance is wrong, so a plain retry through the same route fails identically
every time, while the *same payment on a different route* often succeeds. Folding
these codes into `CUSTOMER` teaches the model that an international 3DS failure
behaves like an insufficient-funds decline, which is the single most expensive
mistake available in this dataset.

### 7.3 Anomaly detection — `domain/detector.ts`

```ts
export interface Bucket { start: string; attempts: number; failures: number }
export interface DetectorConfig {
  baselineBuckets: 288;      // 24 h of 5-minute buckets
  baselineGapBuckets: 6;     // 30 min of separation from the evaluation window
  evaluationBuckets: 3;
  sustainedBuckets: 2;       // must be bad for 2 of the last 3 buckets
  minAttempts: 20;           // volume floor for the evaluation window
  minBaselineAttempts: 200;
  minAbsoluteLift: 0.08;     // +8 percentage points
  minRelativeLift: 1.8;      // nearly double the baseline
  minZScore: 5.0;
  sustainedZRatio: 0.4;
  ewmaAlpha: 0.3;
  resolveBuckets: 3;         // 3 clean buckets closes the incident
}
export interface Verdict {
  anomalous: boolean; reasons: string[];
  baselineRate: number; currentRate: number; smoothedRate: number;
  zScore: number; absoluteLift: number; relativeLift: number;
  attempts: number; failures: number;
}
export function evaluate(series: Bucket[], cfg: DetectorConfig): Verdict;
export function isResolved(series: Bucket[], baselineRate: number, cfg: DetectorConfig): boolean;
```

Fire **only if every gate passes**: volume floor, absolute lift, relative lift,
z-score, and sustained-ness. `z = (p̂ − p₀) / sqrt(p₀(1−p₀)/n)`, EWMA smooths the
recent rates. Five gates instead of one threshold is what keeps precision up on
the unlabelled noise windows (§8.4).

Deduplication: an open incident covering the same dimension tuple suppresses a
new one for 60 simulated minutes.

### 7.4 Root cause analysis — `domain/rca.ts`

**Apportion excess failures, never total failures.** When a bank goes down, UPI
failures rise too, because UPI carries most of that bank's traffic. Total
failures name the *busiest* slice; excess failures name the slice that *changed*.

```
excess = observed_failures − (attempts × expected_rate)
```

The expected rate is shrunk toward the pooled rate so a brand-new slice with no
history is not handed the whole incident:

```
expected_rate = (baseline_failures + k·pooled_rate) / (baseline_attempts + k),  k = 30
```

If nothing has history, the window's own failure rate is the reference.

Each candidate tuple (1 to 3 dimensions drawn from `bank`, `method`,
`amount_band`, `customer_cohort`, **`is_international`**, **`card_network`**,
**`card_country`**) is scored on four inputs:

| Input | Question | Formula |
|---|---|---|
| **Excess share** | how much damage does it explain? | `tuple_excess / incident_excess` |
| **Specificity** | how clean is everything else? | `1 − (rest_rate / tuple_rate)` |
| **Support** | could this be chance? | two-proportion z-test **against the rest of the same window**, not against history |
| **Volume** | how much traffic backs the claim? | `min(1, attempts / 50)` |

```
confidence = 0.40·share + 0.25·specificity + 0.20·min(1, z/6) + 0.15·volume
```

Return the top 3 hypotheses, each with its own evidence numbers, so the UI can
show *why* — not just *what*. The baseline rate quoted on a hypothesis must be
the shrunk one, the same arithmetic the share came from.

**Comparing slices against each other, not against their own past, is the whole
trick:** during a gateway-wide outage every slice looks terrible against history.

### 7.5 Recovery probability — `domain/recovery-model.ts` + `ml/train.ts`

Feature vector, derived by **one shared pipeline used by both training and
serving** — skew between those two paths is silent and makes live predictions
quietly wrong:

```ts
export interface Features {
  failedAt: string;
  amountPaise: number; method: string; bank: string | null; failureCode: string;
  attemptIndex: number;                    // position in the CURRENT failure run, not lifetime count
  customerPriorAttempts: number;
  customerPriorSuccessRate: number;
  merchantPriorSuccessRate: number;
  secondsSinceLastAttempt: number;         // negative → explicit "no history" indicator
  incidentActive: boolean;                 // from incidents the DETECTOR opened, never the answer key
}
```

Encoding: one-hot `method` (4) and `failure_family` (5), log1p on
`amountPaise` and `secondsSinceLastAttempt`, hour-of-day in **IST** as
sin/cos, plus the numeric features standardised with train-split means.

`ml/train.ts`: batch gradient descent, ~400 epochs, lr 0.1, L2 1e-4, **70/15/15
chronological split by position — never random**. A random split lets the model
learn a customer's later behaviour and be tested on their earlier behaviour;
every metric improves and the model collapses. Calibrate with 10 equal-width
probability buckets mapping predicted → observed. Persist coefficients,
calibration map, AUC, Brier, log loss and the calibration curve to
`model_versions`, and render a **model card** page (§11.3).

**The fallback is not optional and not a constant.** If no active model exists,
score from the measured family rates below and set `probability_source =
'baseline'`. Every prediction carries its source, and the UI shows it. *A
payment that fails while the model is down is exactly the payment worth acting
on.*

| Failure kind | Retry | Link | Alternate | Why |
|---|---|---|---|---|
| Gateway / timeout / network (`TRANSIENT`) | 0.72 | 0.60 | 0.63 | Transient; the same payment later usually works |
| `INSUFFICIENT_FUNDS` | 0.18 | 0.46 | 0.32 | Retrying now fails the same way; a link later may not |
| `CARD_EXPIRED` | 0.04 | 0.38 | 0.55 | The card will not become unexpired |
| `CARD_DECLINED` / `INCORRECT_OTP` | 0.22 | 0.44 | 0.48 | |
| `FRAUD_SUSPECTED` / `INVALID_ACCOUNT` | 0.01 | 0.02 | 0.02 | Recovers under nothing |
| `CHECKOUT_ABANDONED` | 0.30 | 0.62 | 0.45 | Most recoverable — nothing was ever wrong |
| `THREEDS_FAILED` / `THREEDS_NOT_SUPPORTED` | 0.09 | 0.28 | 0.34 | Same route, same challenge, same failure |
| `INTERNATIONAL_CARD_BLOCKED` / `ISSUER_DECLINED_CROSS_BORDER` | 0.06 | 0.24 | 0.30 | The route is the problem, not the card |
| `CURRENCY_NOT_SUPPORTED` | 0.02 | 0.20 | 0.26 | Presentment currency is a config issue |

`CROSS_BORDER` codes carry a sixth column the others do not: **`alternate_gateway`
0.55–0.62**. Routing the same card through a second processor is the only
intervention whose probability is meaningfully above the floor here, and that
asymmetry is the entire argument of §1.1 expressed as a number.

Adjustments: `× 0.62` per additional attempt (a customer who failed twice is
telling us something); `× 1.25` on retry during an active incident (the cause is
temporary and external to the customer). Clamp to `[0.01, 0.95]`.

### 7.6 Strategy engine — `domain/strategy.ts`

Pure expected value, in integer paise, `do_nothing` always on the ballot:

```ts
export type Strategy =
  | 'retry'              // same route, later
  | 'payment_link'       // ask the customer again, out of band
  | 'alternate_method'   // ask the customer for a different instrument
  | 'alternate_gateway'  // same card, second processor — the cross-border answer (§1.1)
  | 'do_nothing';

export interface StrategyOption {
  strategy: Strategy;
  probability: number;
  grossValuePaise: number;    // round(probability × amountPaise × customerMultiplier)
  costPaise: number;
  frictionPaise: number;
  expectedValuePaise: number; // gross − cost − friction
  rationale: string;
}
export function choose(input: StrategyInput): { chosen: StrategyOption; options: StrategyOption[] };
```

```
customerMultiplier = 1.0 + min(0.5, customerLifetimeValuePaise / 5_000_000)   // caps at 1.5×
```

| Strategy | Cost | Friction | Notes |
|---|---|---|---|
| `retry` | 200 paise (₹2) | 0 | Invisible to the customer |
| `payment_link` | 500 paise (₹5) | 0.5% of amount | One message to a human being |
| `alternate_method` | 300 paise (₹3) | 0.3% of amount | Asks them to change instrument |
| `alternate_gateway` | 900 paise (₹9) | 0 | Higher MDR on the secondary processor; **invisible to the customer** |
| `do_nothing` | 0 | 0 | `expectedValue = 0` |

`alternate_gateway` is the most expensive option and still wins on cross-border
declines, because it is the only one whose probability is not near the floor and
the only one that asks the customer for nothing. On a domestic
`INSUFFICIENT_FUNDS` it loses to a plain retry every time — **the engine must be
seen choosing it selectively, or it is just a second retry bot.**

**The strategy set is closed.** The agent picks from it; it cannot invent a
money action. The matrix below is what the economics is expected to reproduce —
it is the sanity check on the EV numbers, not a second decision path. If the EV
engine disagrees with this table on a case, one of the two is wrong and the case
is worth reading.

| Situation | Expected strategy |
|---|---|
| Temporary bank degradation (`TRANSIENT`, incident active) | delayed `retry` |
| Customer-specific failure (`CARD_EXPIRED`, `INSUFFICIENT_FUNDS`) | `alternate_method` |
| Checkout abandonment | `payment_link` |
| High-value customer, high amount | `payment_link` + human approval |
| Multiple prior failures (`attempt_index > 2`) | `do_nothing` — stop retrying |
| Low-value payment where cost exceeds EV | `do_nothing` |
| System-wide incident still OPEN | pause immediate retries — approval required |
| Customer opted out | `do_nothing`, unconditionally |
| `TERMINAL` family (fraud, invalid account) | `do_nothing` |
| **Cross-border decline / 3DS failure on an international card** | **`alternate_gateway`** — the card is fine, the route is not |
| Cross-border failure where no secondary route supports the currency | `payment_link` in the customer's currency |

**`do_nothing` wins whenever no option clears zero.** A system that always acts
is a retry bot; the restraint is the product. The UI must show the losing
options and their EV beside the winner — that comparison is the demo moment.

### 7.7 Policy engine — `domain/policy.ts`

A pure function over **passed-in state** returning a verdict, reasons, a policy
version and a hash of its inputs. Every decision is persisted, **including the
ALLOWs** — you cannot audit a gate that only records refusals.

```ts
export const POLICY_VERSION = 'v1.0.0';

export type Verdict = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
export interface RuleResult { rule: string; passed: boolean; verdict: Verdict; detail: string }
export interface PolicyDecision {
  verdict: Verdict; reasons: RuleResult[]; policyVersion: string; inputHash: string;
}
export function evaluatePolicy(input: PolicyInput): PolicyDecision;

// The brand. Its constructor is NOT exported.
declare const approved: unique symbol;
export type PolicyApprovedAction = { readonly [approved]: true; /* … action fields … */ };
export function approve(input: PolicyInput, decision: PolicyDecision): PolicyApprovedAction | null;
// returns null unless decision.verdict === 'ALLOW'
```

`executor.execute(action: PolicyApprovedAction)` therefore **cannot be called
with an unapproved action — it is a compile error, not a review comment.**
Guardrails enforced by review get bypassed under deadline pressure. Guardrails
enforced by the compiler do not.

Rules, evaluated in order, **all of them, always** (collect every reason — never
short-circuit; a user needs the full picture, not the first objection):

| # | Rule | Verdict on failure |
|---|---|---|
| 1 | `merchant.is_paused = 0` | DENY — kill switch |
| 2 | Payment not in a terminal state (`CAPTURED`/`REFUNDED`) | DENY — *this is the double-charge guard; never act after success* |
| 3 | `customer.opted_out = 0` | DENY — opt-out is absolute, whatever the EV says |
| 4 | Failure family is not `TERMINAL` (fraud / invalid account) | DENY |
| 5 | `attempt_index ≤ 3` — at most 2 recovery attempts per payment | DENY |
| 6 | ≥ 30 simulated minutes since the last action on this payment | DENY — cooldown |
| 7 | Merchant's actions today `< daily_action_budget_count` | DENY |
| 8 | Merchant's action spend today `+ cost ≤ daily_action_budget_paise` | DENY |
| 9 | Merchant's recovered exposure this hour `+ amount ≤ 20_000_000` (₹2L/hour) | DENY — blast radius cap |
| 10 | `expectedValuePaise > 0` | DENY — never act at a loss |
| 11 | `amountPaise ≤ 2_500_000` (₹25,000) | **REQUIRE_APPROVAL** — a human signs for large money |
| 12 | Not a `retry` into an incident that is still OPEN | **REQUIRE_APPROVAL** — retrying into a live outage burns the attempt |

A worked refusal, which the `/policy` page must be able to show:

```
Agent proposes:   retry ₹50,000 payment, 5th attempt
Policy engine:    DENY  (policy v1.0.0, input 9f3c…a41)
Reasons:
  ✗ rule 5   attempt_index 5 > 3          — retry limit exceeded
  ✗ rule 11  amount ₹50,000 > ₹25,000     — approval required
  ✓ rule 2   payment state FAILED         — not terminal
  ✓ rule 3   customer has not opted out
  … 8 more rules evaluated
```

Precedence: any DENY wins; otherwise any REQUIRE_APPROVAL wins; otherwise ALLOW.
`inputHash` = SHA-256 of the canonicalised input JSON, so any decision can be
recomputed from stored inputs and shown to be reproducible.

### 7.8 Agent — `app/agent.ts` (LLM at the edge)

```
LLM  ──►  structured proposal  ──►  POLICY ENGINE  ──►  executor
          (closed enum only)        (deterministic)      (idempotent)
```

The agent's **read tools** are pure lookups — `getIncident`, `getPayment`,
`getCustomerHistory`, `getPaymentHistory`, `getFailurePatterns`,
`estimateRecovery`. Its only **write** is `proposeAction`, and a proposal is not
an action: it is an input to the gate. The five executable kinds
(`retry_payment`, `route_alternate_gateway`, `create_payment_link`,
`notify_customer`, `escalate`) exist solely behind the policy engine.

The agent receives **already-computed** context — incident, RCA hypotheses,
probability, all five strategy options with their EV — and returns:

```ts
{ choice: Strategy;            // parsed into the closed enum; anything else is REJECTED
  confidence: 'low'|'medium'|'high';
  narrative: string }          // prose for humans only
```

Guarantees:
- Model: `claude-sonnet-5`. Off unless `ANTHROPIC_API_KEY` is set.
- **Prompt injection is assumed.** Output is parsed into the closed enum; the policy engine reads structured fields only, so injected text has no path to authority.
- If the LLM is absent, slow (>4 s), or returns anything unparseable → deterministic fallback: take the strategy engine's argmax, template the narrative. Record `source = 'fallback'` and show that badge in the UI.
- If the LLM picks an option whose EV ≤ 0 → override to the deterministic choice and record `rejected_reason`.
- Every call is written to `agent_decisions` with a prompt hash. **The pipeline is correct with the LLM switched off; the demo must prove it by toggling it live.**

---

## 8. The simulator

### 8.1 Generator — `sim/generator.ts`

Deterministic from a seed (mulberry32). Defaults: **5,000 payments · 5 merchants
· 7 days · ending 2026-08-01T00:00:00Z · baseline failure rate 0.07**. Fixed end
date, never `now`, so the dataset is comparable across machines.

- **Method mix follows Indian commerce**: upi 54.8%, card 24.9%, netbanking 12.2%, wallet 8.1%. A card-heavy dataset would tune everything for a market this does not serve.
- **Amounts log-normal** (median ≈ ₹1,200, thin tail past ₹100k). A symmetric distribution makes the high-value incident pattern meaningless.
- **Traffic has a daily rhythm** — near-dead at 04:00, peak ~19:00 IST, damped at weekends. A detector tuned on flat traffic calls every evening an anomaly.
- **Failure codes are tied to the method** — UPI times out and runs out of funds; cards decline and expire. A code on the wrong method teaches the model a relationship that does not exist.
- **~400 customers per merchant**, a fifth generating most traffic; failing once raises the odds of failing again, a success resets the run.
- **18% of payments are international** (`is_international = true`): card only, `card_country` drawn from US/GB/DE/AE/SG/AU, `card_network` visa/mastercard/amex, `threeds_required` on 70% of them, amounts ~2.4× the domestic median because they are SaaS subscriptions rather than retail. Their **baseline failure rate is 19%, against 7% domestic** — the gap is the product, and it must exist in the data before any of §1.1 can be demonstrated. Cross-border failures skew to the `CROSS_BORDER` family; domestic ones never draw those codes.
- Emit a SHA-256 **checksum** over each payment's identifying facts in order, store it on `dataset_runs`. Same seed ⇒ same checksum on any machine.

Amount bands — one definition, shared by analytics, RCA and the model, lower
bound inclusive, every amount in exactly one band:

```
<500 · 500-2k · 2k-10k · 10k-50k · >50k
```

### 8.2 Injected incidents — the answer key for detection

Five degradations, each with a window and the tuple that actually degraded.
Placed **in daytime traffic (10:00–21:00 IST)** — an outage at 04:00 affects
almost nothing, and a ground-truth row asserting an invisible incident scores
every detector as a miss. They are **infrastructure-wide, not per-merchant**;
scoping one to a single tenant divides the affected traffic by the merchant
count and produces "incidents" of four payments.

| Pattern | Duration | Peak failure rate | Dimensions |
|---|---|---|---|
| `BANK_OUTAGE` | 2 h | 52% | one bank, every method |
| `METHOD_DEGRADATION` | 3 h | 35% | UPI across banks |
| `HIGH_VALUE_FAILURES` | 12 h | 35% | the ₹10k–50k band |
| `CUSTOMER_COHORT` | 5 h | 60% | a tenth of customers |
| `ABANDONMENT_SPIKE` | 3 h | 30% | card checkouts abandoned |
| **`INTERNATIONAL_3DS_BLOCK`** | **8 h** | **64%** | **`is_international × card × THREEDS_FAILED`** — the §1.1 scenario |

The sixth pattern is the demo's centrepiece and is deliberately the **hardest to
detect**: international traffic is 18% of volume, so an 8-hour collapse to a 64%
failure rate moves the *overall* failure rate by roughly 4 points — a wobble any
merchant would put down to noise. It is only visible when the detector runs per
dimension rather than on the aggregate, and that is the point being made.

Refuse to generate silently: any labelled incident affecting fewer than **20**
payments must be reported as a dataset defect at seed time.

### 8.3 Recovery labels — the answer key for the model

Every unsuccessful payment carries counterfactuals — `recoverable_by_retry`,
`recoverable_by_link`, `recoverable_by_alternate`, `recoverable_by_gateway`,
`recoverable` — drawn at
generation time from the probability table in §7.5. **They can only be decided
here**: once a payment exists, whether a retry *would* have worked is
unknowable. This is what makes recovery measurable rather than asserted, and
what lets the simulated gateway answer honestly.

### 8.4 Noise — the precision test

Generate **two extra windows with mild fluctuation and never label them**. A
detector that fires on them is wrong. Without unlabelled noise there is no way
to catch a detector that simply alerts on everything, and "we detected all 5
incidents" means nothing on its own.

Report at the end of a run: **detection precision / recall against
`ground_truth_incidents`**, and **RCA top-1 accuracy** against the labelled
dimension tuples.

### 8.5 Clock and runner — `sim/clock.ts`, `sim/runner.ts`

- **1 real second = 30 simulated minutes** (configurable 1×/10×/60×/300×). 7 days replays in ~5.6 minutes at default speed.
- The runner walks payments in `created_at` order and pushes their events through **the real webhook handler** — the same code path a live gateway would hit. It does not write to `payments` directly. A dataset built on its own notion of state validates nothing.
- Controls: `POST /api/v1/sim/{start,pause,reset,speed}` and `jump-to-incident`, so a demo can skip to the interesting minute.

### 8.6 Simulated gateway — `sim/gateway.ts`

The simulator exposes **two routes**: `primary` (the merchant's current
processor) and `secondary` (the alternate). `secondary` refuses INR-only
instruments — UPI, netbanking, RuPay — so `alternate_gateway` is unavailable on
most domestic traffic and the strategy engine has to earn its choice rather than
defaulting to it.

`executeAction(kind, paymentId, idempotencyKey)` →
- Looks up the payment's ground-truth counterfactual for that intervention (`route_alternate_gateway` reads `recoverable_by_gateway`).
- Recovers ⇒ emits `payment.attempted` then `payment.captured` through the normal webhook path after a simulated delay.
- Does not recover ⇒ emits `payment.failed`.
- **Injects realistic faults** so the reliability code is exercised, not merely written: 5% `RETRYABLE` (429/503 — capped backoff with jitter, 2 retries then escalate), 2% timeout with unknown outcome (**never blind-retried** — reconciled by querying the gateway with our reference), 1% `TERMINAL`.
- Honours the idempotency key: the same key returns the first result and never acts twice.

### 8.7 What-if simulator — the closing number

The ground-truth counterfactuals (§8.3) make one comparison possible that a
normal system can never run: **what the same history would have produced under a
different policy.** Replay the dataset twice against the stored labels — no
gateway calls, no clock — and diff the results.

- **BASELINE** — what a merchant does today: one blind immediate retry on every failure, single processor, no targeting, no economics. Resolved by `recoverable_by_retry`.
- **AGENT** — the full loop: probability, EV strategy choice, policy gate, and the intervention actually chosen, resolved by that intervention's own label.

```
                        BASELINE      AGENT
Failed payments            2,140      2,140      ← identical input, by construction
Interventions attempted    2,140        884      ← the agent declines to act on 59%
Recovered                    280        711
Recovery rate               13.1%      33.2%
Intervention cost          ₹4,280     ₹3,120
Revenue recovered           ₹2.7L      ₹6.9L
────────────────────────────────────────────
Incremental revenue                    ₹4.2L
```

Rules that keep this honest, and they must be printed on the page:

- Both arms see **exactly the same** failed payments. The only difference is the decision.
- Outcomes come from labels decided **before either arm ran** — neither arm can be tuned to its own answer key.
- Run it on the **held-out test split only**. Reporting a lift measured on training data is the oldest way to lie with a model.
- Label the whole page a **simulation over recorded counterfactuals, not a live result.** The number is real arithmetic on synthetic data, and saying so costs nothing and buys all the credibility.

**Split the table by `is_international`.** That row is the answer to the question
the founder in §1.1 actually asked — *should I switch processors?* — and the
honest form of the answer is: not entirely, and not on a hunch.

```
INTERNATIONAL ONLY      BASELINE      AGENT
Failed payments              386        386
Recovered                     31        174
Acceptance after recovery  81.4%      88.8%
Revenue recovered          ₹0.4L      ₹2.3L
```

Which reads, in the founder's terms: *you don't need a three-month migration.
You need the ~45% of these that are route failures rather than real declines to
go out through a second route, and the rest to be left alone.*

---

## 9. The processing pipeline

```
sim/runner ──► POST /webhooks/gateway
                 │  ONE transaction: INSERT payment_events (UNIQUE event_id) + INSERT outbox
                 ▼  return 200 immediately, nothing else synchronous
              outbox relay (200 ms tick, FOR UPDATE SKIP LOCKED, marks sent_at after handlers ack)
                 ▼
      ┌──────────┴──────────┬──────────────────┐
      ▼                     ▼                  ▼
  projector             analytics          detection sweep (every 5 sim-minutes)
  ONE txn:              rollups in the      evaluate → open/resolve incidents → RCA
  payment + attempt     same txn as its
  + transition          idempotency marker         │
  + processed_events                               ▼
      │                                     recovery: open cases → predict → strategy
      ▼                                            │
  abandonment sweep                                ▼
  (ATTEMPTED, idle 30 sim-min)              agent proposes → POLICY GATE → executor
                                                   │
                                                   ▼
                                            verify: attribution + prediction scoring
```

Failure handling, mirroring production:

| Failure | Response |
|---|---|
| Duplicate webhook | `UNIQUE(event_id)` — the second insert is a no-op |
| Out-of-order event | Recorded with `stale = 1`; state does not move; terminal states protected |
| Handler throws mid-way | Transaction rolls back; the outbox row is retried; `processed_events` makes the effect happen once |
| Outbox row fails 5× | `dead_lettered = 1` + an escalation row. The queue never blocks. |
| Gateway 429/5xx | Classified `RETRYABLE`; capped backoff with jitter; 2 retries then escalate |
| Gateway timeout, unknown outcome | **Never blind-retried**; reconciled by reference lookup |
| Model missing | Rule baseline, flagged on the prediction and counted |
| LLM missing or malformed | Deterministic strategy; `source = 'fallback'` |
| Unclassified error | Defaults to `NEEDS_HUMAN` — in a money system, "I don't know" means "ask a person" |

Errors are classified `RETRYABLE` / `TERMINAL` / `NEEDS_HUMAN`, and the retry
logic reads the class rather than the message text.

---

## 10. HTTP API

All money in paise. Every metrics response carries the window it was computed
over **and the two amounts the rate came from**, so any figure can be checked
against its inputs.

```
GET  /health                                  liveness
GET  /ready                                   readiness, per-dependency breakdown

POST /webhooks/gateway                        the ingest path (signature-verified, HMAC, constant-time)

GET  /api/v1/merchants
GET  /api/v1/metrics/summary?from&to&merchant_id
GET  /api/v1/metrics/timeseries?from&to&granularity=hour|5m
GET  /api/v1/metrics/breakdown?dimension=bank|method|amount_band|hour|is_international|card_country|card_network
GET  /api/v1/metrics/acceptance                domestic vs international acceptance, side by side (§1.1)

GET  /api/v1/incidents?status=OPEN|RESOLVED
GET  /api/v1/incidents/:id                    verdict + evidence + ranked RCA + narrative
GET  /api/v1/incidents/:id/timeseries

GET  /api/v1/cases?status&limit
GET  /api/v1/cases/:id                        probability + all 4 strategy options + policy decision + actions + outcome
POST /api/v1/cases/:id/approve                resolves a REQUIRE_APPROVAL, then executes
POST /api/v1/cases/:id/reject

GET  /api/v1/policy/decisions?limit=50        the audit log, ALLOWs included
GET  /api/v1/policy/rules                     the twelve rules and the current policy version

GET  /api/v1/model                            active model card: coefficients, AUC, Brier, calibration curve
GET  /api/v1/model/calibration                predicted vs observed, 10 buckets
GET  /api/v1/evaluation                       detection precision/recall + RCA top-1 vs ground truth
GET  /api/v1/calibration/live                 predicted vs actual on VERIFIED outcomes (the feedback loop)

GET  /api/v1/audit/:paymentId                 the full chain: event → detection → diagnosis → decision
                                              → policy → action → outcome, in order, with timestamps

POST /api/v1/simulation/whatif                run BASELINE vs AGENT on the held-out split (§8.7)
GET  /api/v1/simulation/whatif                the last stored comparison

POST /api/v1/sim/start | pause | reset | speed | jump-to-incident
GET  /api/v1/sim/state                        simulated clock, progress, counters

GET  /api/v1/stream                           SSE: payment, incident.opened, incident.resolved,
                                              case.opened, policy.decided, action.executed,
                                              outcome.verified, metrics.tick
```

`GET /api/v1/metrics/summary` response shape:

```json
{
  "window": { "from": "…", "to": "…" },
  "revenue_at_risk_paise": 4820000,
  "revenue_recovered_paise": 1260000,
  "recoverable_revenue_paise": 2140000,
  "recoverable_estimated": true,
  "recovery_rate": 0.2072,
  "attribution": { "direct_paise": 940000, "assisted_paise": 320000, "organic_paise": 180000 },
  "counts": { "attempts": 5000, "successes": 4440, "failures": 363, "abandoned": 197 },
  "failure_rate": 0.112,
  "probability_source_mix": { "model": 331, "baseline": 32 }
}
```

### Metric definitions — the single source of truth

Ambiguous metrics are how demos lie. Every figure the dashboard shows resolves
to one of these.

```
revenue_at_risk      = Σ amount WHERE payment did not succeed
                                  AND still unresolved (never since captured)
                                  AND created_at ∈ window
revenue_recovered    = Σ amount WHERE payment is now CAPTURED
                                  AND it was FAILED at some earlier point   ← reads payment_state_transitions
                                  AND created_at ∈ window
recoverable_revenue  = Σ (amount × P(recovery))  over OPEN cases            ← an expected value, label it as such
recovery_rate        = revenue_recovered / (revenue_recovered + revenue_at_risk)
failure_rate         = (failures + abandoned) / attempts
```

- The two revenue columns are **mutually exclusive by construction** — that is what stops the same rupee being counted twice.
- The "was previously failed" test reads the transition history, not the current state: a captured payment that never failed is an ordinary sale, and counting it inflates the number that matters most.
- The rate denominator is every rupee that was *ever* at risk. Dividing by `revenue_at_risk` alone gives rates above 100% once most failures are recovered, which is how a metric becomes a joke.
- **A payment belongs to the window it was created in**, not the one it settled in — otherwise it is a failure in one window and a recovery in another, and the two never reconcile.
- **Empty windows return zeros, not nulls** — except `recoverable_revenue`, which is `null` with `recoverable_estimated: false` when no model has run. "Not measured" and "zero" are different claims.
- **Attribution is a separate question from recovery.** `revenue_recovered` says the money came back, not that Revenant brought it back. Only `direct` and `assisted` are credited; `organic` credits **zero**. Where attribution has not run, the UI says `unattributed` rather than implying credit.
- Rollups are maintained incrementally *and* recomputed by a sweep. Any difference is **drift** — logged and surfaced on the dashboard, never silently corrected, because a rollup that repairs itself hides the bug that caused it.

Attribution rules (`app/verify.ts`):

| Attribution | Condition | Credit |
|---|---|---|
| `direct` | Captured within 30 sim-minutes of our action, and the gateway reference matches ours | full |
| `assisted` | Captured within 6 sim-hours of our action, different reference | full |
| `organic` | Captured with no action, or beyond the assist window | **zero** |

**The feedback loop.** Every prediction must eventually meet an outcome. On
verification, store `predicted_probability` beside `actual_recovered` and
recompute the **live calibration curve** — predicted vs observed on real
outcomes, not on the test split. Two curves on `/model`, side by side: what the
model promised at training time and what it has actually delivered since. A
model whose live curve has drifted off the diagonal is saying so out loud rather
than waiting to be caught.

---

## 11. Frontend — Next.js, Linear theming

### 11.1 Design tokens (`app/globals.css`)

Linear's look: near-black ground, one indigo accent, hairline borders, small
type, generous line height, near-zero chrome. **Restraint is the theme** — no
gradients, no shadows heavier than a 1px border, no colour that is not carrying
information.

```css
:root {
  --bg:            #08090a;   /* page */
  --bg-elevated:   #0f1011;   /* cards, panels */
  --bg-hover:      #16171a;
  --border:        #1f2023;   /* hairline, the primary separator */
  --border-strong: #2a2c31;
  --text:          #f7f8f8;
  --text-secondary:#8a8f98;   /* labels, metadata, units */
  --text-tertiary: #62666d;
  --accent:        #5e6ad2;   /* Linear indigo — actions and the primary series */
  --accent-hover:  #6e79dd;
  --accent-subtle: #5e6ad21a;
  --success:       #4cb782;   /* recovered */
  --warning:       #f2c94c;   /* requires approval */
  --danger:        #eb5757;   /* at risk, denied */
  --info:          #4ea7fc;   /* incident open */
  --radius:        6px;
  --radius-lg:     8px;
  --font: "Inter var", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "Berkeley Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
```

Rules that make it read as Linear rather than "a dark dashboard":

- **Type scale:** 11px uppercase `letter-spacing: 0.04em` labels · 13px body · 15px section titles · 28px `font-variant-numeric: tabular-nums` metric values. Never bold body text; weight 510 is the maximum outside headings.
- **Borders, not shadows.** `1px solid var(--border)` on every card. A single elevation level.
- **Density.** 12–16px card padding, 8px grid gaps, 32px row height in tables. Information per pixel is the aesthetic.
- **Motion:** 120 ms `cubic-bezier(0.4,0,0.2,1)` on hover and mount only. New rows fade in over 150 ms — never slide, never bounce.
- **All money in tabular numerals, right-aligned in tables**, formatted `₹1,24,500` (Indian grouping) from paise, with the paise value in a `title` attribute.
- Keyboard-first: `⌘K` command palette (jump to incident / case / page), `g i` incidents, `g r` recovery, `g p` policy, `Space` toggles the simulator.

### 11.2 Pages

**`/` — Command Center.** The demo's home.
- Four metric tiles: Revenue at Risk · Revenue Recovered · Recoverable (EV) · Recovery Rate. Each shows the two integers the rate came from, on hover. `Recoverable` shows `— not measured` when no model has run.
- Live activity feed (SSE), newest first, one line per event, colour-coded by kind.
- Failure-rate timeseries with incident windows shaded and detected-incident markers.
- **A domestic vs international acceptance strip** under the tiles: two rates, the gap between them in points, and the rupee value of the gap. On the seeded dataset this reads roughly `domestic 93.0% · international 81.0% · gap 12.0 pts · ₹6.1L`. It is the first thing on screen after the money, because it is the thing no merchant dashboard shows them today (§1.1).
- A drift indicator: incremental vs recomputed rollup delta. Green at 0.
- Simulator control bar pinned to the top: play/pause, speed, simulated clock, progress through the 7 days.

**`/incidents` and `/incidents/[id]`.** The diagnosis story.
- List: status, opened at, current vs baseline rate, z-score, affected payments, revenue at risk.
- Detail: the timeseries with the detection moment marked; the **five gates** with pass/fail and their numbers; the **ranked root-cause hypotheses**, each showing excess share, specificity, z, volume and confidence, with the shrunk baseline beside the observed rate; the narrative with an `LLM` or `template` badge; and the linked recovery cases.

**`/recovery` and `/recovery/[id]`.** The decision story — the strongest page.
- List: payment, amount, failure code + family, `P(recovery)` with a `model`/`baseline` badge, chosen strategy, EV, status.
- Detail, top to bottom: the payment and its state history → the probability with its source → **all five strategy options as a bar comparison with EV in paise, the winner highlighted and the losers greyed but visible** → the policy decision as **twelve rules with pass/fail, reasons and the input hash** → the action with its idempotency key and attempts → the verified outcome with its attribution.
- When the verdict is `REQUIRE_APPROVAL`, an Approve / Reject bar sits at the top. **Clicking Approve in front of a judge is the demo.**

**`/policy`.** The twelve rules, the policy version, and the append-only decision log — ALLOW, DENY and REQUIRE_APPROVAL together, with counts. Show the `PolicyApprovedAction` type snippet on this page: the guardrail is a compile error, and a screenshot of the type says it faster than prose.

**`/model`.** The model card: what it is, what it is not, where it breaks. AUC, Brier, log loss, the calibration curve (predicted vs observed, 10 buckets, with the diagonal), coefficient weights as a horizontal bar chart, the train/val/test split boundaries and dates, and the count of predictions served from the baseline instead.

**`/audit/[paymentId]`.** The chain of custody, as one vertical timeline:

```
EVENT → DETECTION → DIAGNOSIS → AGENT DECISION → POLICY → ACTION → OUTCOME
```

Every node carries its timestamp, its inputs and the artefact it produced —
event id, incident id + z-score, top hypothesis + confidence, proposed strategy
+ source badge, policy verdict + input hash, idempotency key + attempts,
attribution + credited amount. **Every number on this page is reproducible from
stored inputs**; that is the claim the page exists to make. Reachable from any
case, incident or feed row.

**`/whatif`.** The closing screen. The BASELINE vs AGENT table (§8.7) with the
incremental revenue as the single large figure, a bar pair for recovered
revenue, the intervention counts beneath (the agent acting *less* is the point),
and the honesty banner: held-out split, pre-decided counterfactuals, simulation
not live result.

**`/simulator`.** Seed, parameters, checksum, progress, the five injected incidents with detected/missed status, the two noise windows with fired/clean status, and the live scoreboard: **detection precision, recall, RCA top-1 accuracy**. Buttons to jump to any incident.

### 11.3 Components to build

`MetricTile` · `LiveFeed` · `FailureRateChart` (Recharts area + incident shading) ·
`GateChecklist` · `HypothesisCard` · `StrategyComparison` (the EV bars) ·
`PolicyRuleList` · `AttributionBadge` · `SourceBadge` (`model`/`baseline`,
`llm`/`template`) · `SimControlBar` · `CalibrationChart` · `AuditTimeline` ·
`WhatIfTable` · `CommandPalette`.

### 11.4 Chart rules

One accent series (`--accent`) per chart, `--text-tertiary` for the baseline
reference, `--danger` for the at-risk area. Grid lines at 6% white. No legend
when a chart has one series. Axis labels 11px `--text-secondary`. Tooltips are
bordered cards, never native. Y-axis money in ₹k / ₹L, never raw paise.

---

## 12. Build order

Each step ends with something visible. Do not proceed until it is.

| # | Step | Done when |
|---|---|---|
| 0 | `docker-compose.yml`, Bun workspace, TS strict, Hono + Next skeleton, Linear tokens in `globals.css` | `docker compose -p revenant-mini up -d postgres` is healthy, `bun dev` serves a themed shell, `/health` 200 and `/ready` reports the database |
| 1 | `migrations/001_schema.sql`, migrate-on-boot under an advisory lock, `queries.ts` | Tables exist; a smoke insert round-trips; running two API processes at once migrates exactly once |
| 2 | `domain/money.ts`, `payment-state.ts`, `failure-codes.ts` + vitest | Exhaustive state-machine test passes, including terminal protection and staleness |
| 3 | Webhook ingest + outbox + relay + projector | Posting the same event twice produces one payment and one transition |
| 4 | `sim/generator.ts` + seed script | 5,000 payments, checksum printed, same seed ⇒ same checksum; ground-truth tables populated; the <20-payment defect check runs |
| 5 | `app/analytics.ts` rollups + recompute + drift; metrics endpoints | `/` shows four tiles with real numbers and drift 0 |
| 6 | `sim/clock.ts` + `runner.ts` + SSE | Press play: the feed streams, the chart fills, the clock advances |
| 7 | `domain/detector.ts` + `app/detection.ts` | Incidents open on the injected windows and **not** on the noise windows; precision/recall printed |
| 8 | `domain/rca.ts` | Top-1 hypothesis matches the labelled tuple for ≥ 4 of 5 incidents |
| 9 | `domain/recovery-model.ts` baseline + case opening | Cases open with `probability_source: 'baseline'` |
| 10 | `ml/train.ts` + `/model` page | AUC and calibration curve rendered; predictions flip to `source: 'model'` |
| 11 | `domain/strategy.ts` + the EV comparison UI | Four options with EV; `do_nothing` visibly wins on fraud and tiny amounts |
| 12 | **`domain/policy.ts` — build this BEFORE the agent** | Twelve rules evaluated, all reasons stored, `PolicyApprovedAction` compiles as a gate |
| 13 | `app/executor.ts` + `sim/gateway.ts` | Actions execute idempotently; injected 429s retry and escalate; the timeout path reconciles rather than retries |
| 14 | `app/verify.ts` | Outcomes attributed; `revenue_recovered` climbs; organic credits zero |
| 15 | `app/agent.ts` (LLM optional) | Narratives appear; unplugging the key falls back and the badge flips to `template` |
| 16 | `/audit/[paymentId]` timeline | Any payment renders event → outcome with every input shown |
| 17 | **What-if simulator + `/whatif`** | BASELINE vs AGENT on the held-out split; incremental revenue printed |
| 18 | `/policy`, `/simulator`, `⌘K`, polish | The full demo script (§13) runs start to finish without a reload |

**Build 12 before 15.** The gate must exist before anything proposes an action,
or "the LLM cannot act on its own" becomes a claim instead of a property.

---

## 13. The demo script (5 minutes)

1. **(25 s)** Open on the quote from §1.1, one slide, verbatim. "An Indian founder selling SaaS globally. 25 failed international payments last month. He doesn't know why, and the only fix anyone offers him is a three-month processor migration made on a hunch. Hold that."
2. **(20 s)** Command Center, simulator at 60×, **₹18.4L Revenue at Risk**. "Seven days across five merchants, replaying live, everything computed from the event stream." Point at the acceptance strip: "**domestic 93%, international 81%.** No merchant dashboard shows him that line."
3. **(25 s)** An incident opens on its own — `INTERNATIONAL_3DS_BLOCK`. "The overall failure rate moved four points; he'd have called that noise. Per-dimension, international card acceptance fell to 36%." The five gates: "one threshold fires on everything. Five gates is why it ignored these two unlabelled noise windows — precision 100% on this run."
4. **(40 s)** Root cause. "The naive answer is 'cards are failing', because cards carry the excess. We apportion *excess* failures, not total ones, and the answer is `international × card × THREEDS_FAILED` — 86% of the excess, specificity 0.91, z 14.2. That is the sentence he could not get out of his dashboard." Point at the evidence numbers.
5. **(15 s)** "₹4.8L exposed. ₹1.72L expected recoverable — expected value, not a promise, and the label says so."
6. **(45 s)** Open a recovery case on an international 3DS decline. Probability with its source badge. **The five strategy options side by side**: "a retry is worth 9 paise on the rupee — same route, same challenge, same failure. Routing the same card through a second processor is worth 58. It picks `alternate_gateway`, and it costs ₹9 to find out. On a domestic insufficient-funds decline it picks a plain retry instead, and on a fraud decline it does nothing at all. Doing nothing is on the ballot in every case."
7. **(60 s)** The policy gate. A DENY with its twelve reasons. Then a REQUIRE_APPROVAL on a ₹40,000 payment — **approve it live**: the action executes, the outcome verifies as `direct`, Revenue Recovered moves.
8. **(25 s)** `/audit` on that payment. "Event, detection, diagnosis, decision, policy, action, outcome — with the hash of the inputs. Every number recomputable from what is stored."
9. **(25 s)** Inject a gateway failure from the simulator panel. "429s: classified retryable, capped backoff, two attempts, then it escalates instead of looping. A timeout with an unknown outcome is never blind-retried — it reconciles by reference. It stops rather than double-charges."
10. **(20 s)** Kill the LLM key, refresh: "narratives go template, choices stay identical. The model narrates and picks from a closed enum. It never computes a number and never executes."
11. **(45 s)** `/whatif`, and close the loop opened in step 1. "Same 2,140 failed payments, two policies. Blind retries recover ₹2.7L. Revenant acts on 884 — **59% fewer interventions** — and recovers ₹6.9L. **Incremental ₹4.2L.** And the row he asked about: international acceptance 81.4% to 88.8%, without switching processors, because only 45% of those failures were ever route failures. That is a computed answer to a question that thread could only argue about."

**The closing line:** *Revenant does not retry payments. It decides which
failures are worth money, proves why, and refuses to act when acting loses.*

---

## 14. Acceptance checklist

Correctness
- [ ] Posting the same webhook 3× creates exactly one payment, one transition, one rollup increment.
- [ ] An out-of-order event is recorded with `stale = 1` and does not move state.
- [ ] No action is ever created for a `CAPTURED` payment (policy rule 2 + terminal protection). Assert it in a test.
- [ ] The executor cannot be called without `PolicyApprovedAction` — delete the brand and the build must fail.
- [ ] The same idempotency key never produces two gateway effects.
- [ ] An opted-out customer is never contacted, whatever the EV (policy rule 3).
- [ ] `alternate_gateway` wins on `CROSS_BORDER` codes and loses to `retry` on domestic `INSUFFICIENT_FUNDS` — assert both, or it is a second retry bot.
- [ ] The `INTERNATIONAL_3DS_BLOCK` window is detected on the `is_international` dimension and **missed** on the aggregate series — that contrast is the demo, so test it explicitly.
- [ ] International baseline failure rate is materially above domestic in the generated data (~19% vs ~7%) before any detection runs.
- [ ] `/api/v1/audit/:paymentId` returns every stage in causal order with its inputs.
- [ ] Same seed ⇒ same checksum, twice in a row.
- [ ] Two API processes booting simultaneously run the migrations exactly once.
- [ ] Two relay loops running at once never deliver the same outbox row twice (`SKIP LOCKED`).
- [ ] A second OPEN incident for the same slice is rejected by `incidents_one_open`, not by an `if`.
- [ ] A second live case for the same payment is rejected by `cases_one_live`, not by an `if`.

Honesty
- [ ] `recoverable_revenue` is `null` with `recoverable_estimated: false` before the model trains — never 0.
- [ ] Every probability carries `model` or `baseline`, and the UI shows it.
- [ ] Every narrative carries `llm` or `template`.
- [ ] Organic recoveries credit zero and say `organic` in the UI.
- [ ] `recovery_rate` is recomputable from the two amounts printed beside it.
- [ ] Rollup drift is displayed, not corrected.

Measured, not asserted
- [ ] Detection precision and recall against `ground_truth_incidents` are shown on `/simulator`.
- [ ] The detector fires on **zero** of the two unlabelled noise windows.
- [ ] RCA top-1 accuracy against labelled tuples is shown.
- [ ] Model AUC, Brier and a calibration curve are shown on `/model`.
- [ ] The **live** calibration curve (predicted vs verified outcomes) is shown beside the training one.
- [ ] The what-if comparison runs on the **held-out split only** and says so on the page.
- [ ] Both what-if arms operate on an identical set of failed payments — assert the counts match.

Resilience (each demonstrable live)
- [ ] Unset `ANTHROPIC_API_KEY` → everything still works, badges flip to `template`.
- [ ] Delete the trained model row → predictions fall back to the baseline, flagged.
- [ ] Injected gateway 429 → retries with backoff, then escalates rather than looping.
- [ ] Injected timeout → reconciles by reference, never blind-retries.

---

## 15. Running it

### 15.1 The one container

```yaml
# docker-compose.yml
name: revenant-mini                      # every resource is namespaced under this

services:
  postgres:
    image: postgres:16-alpine
    container_name: revenant-mini-postgres
    environment:
      POSTGRES_USER: revenant
      POSTGRES_PASSWORD: revenant
      POSTGRES_DB: revenant_mini
    ports:
      - "5433:5432"                      # 5433 on the host: cannot collide with an existing postgres
    volumes:
      - revenant-mini-pgdata:/var/lib/postgresql/data
    shm_size: 256mb
    command: >
      postgres -c shared_buffers=256MB -c max_connections=50
               -c log_min_duration_statement=500
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U revenant -d revenant_mini"]
      interval: 5s
      timeout: 3s
      retries: 12

volumes:
  revenant-mini-pgdata:
```

> **Container scope rule.** Every command carries `-p revenant-mini`. Use
> `docker compose -p revenant-mini down -v` to remove this project's container
> and volume. **Never run `docker system prune`, `docker volume prune`, or any
> unscoped cleanup** — this machine runs other stacks, and those commands do not
> know the difference.

Memory footprint is ~200 MB. The API and the web app run on the host, so there
is no image to rebuild between edits — that is the point of putting only
Postgres in Docker.

### 15.2 Environment

```bash
# .env.example
PORT=8090
DATABASE_URL=postgres://revenant:revenant@localhost:5433/revenant_mini
PGPOOL_MAX=10

SIM_SEED=42
SIM_PAYMENTS=5000
SIM_MERCHANTS=5
SIM_DAYS=7
SIM_ENDS_AT=2026-08-01T00:00:00Z
SIM_SPEED=60                 # 1 real second = 60 simulated minutes

WEBHOOK_SECRET=revenant_mini_dev_secret
ANTHROPIC_API_KEY=           # optional — leave empty to prove the deterministic path
ANTHROPIC_MODEL=claude-sonnet-5
NEXT_PUBLIC_API_URL=http://localhost:8090
```

Secrets come only from the environment, `.env` is gitignored, and configuration
is logged only in its redacted form. Payment payloads and PII are never logged.

### 15.3 Commands

```bash
bun install
cp .env.example .env

bun db:up          # docker compose -p revenant-mini up -d postgres, then wait for healthy
bun db:migrate     # apply migrations/*.sql (also runs automatically on API boot)
bun seed           # generate the dataset, print the checksum, report dataset defects
bun train          # train the recovery model, print AUC / Brier, activate it
bun dev            # api on :8090 (bun --watch), web on :3000

bun whatif         # BASELINE vs AGENT on the held-out split, print the table
bun test           # domain unit tests

bun db:reset       # drop the volume and re-migrate — scoped to revenant-mini only
bun db:psql        # docker compose -p revenant-mini exec postgres psql -U revenant revenant_mini
```

`bun dev` must not require `bun seed` to have run: an empty database renders an
empty dashboard with zeros and a "no dataset — run `bun seed`" banner, never a
crash and never a fake number.

---

## 16. If time runs out

Cut in this order. Everything above the line still tells a complete story.

1. `⌘K` command palette
2. `/model` coefficient chart (keep AUC, Brier and the calibration curve)
3. The live calibration curve (keep the training one)
4. The LLM entirely — deterministic narratives read fine
5. `alternate_method` as a strategy (keep retry, link, do_nothing)
6. Incremental rollups — recompute-only is correct, just slower
7. The trained model itself — the rule baseline is a measured fallback, and every prediction already says which one produced it

**Never cut:** the cross-border wedge (§1.1) and `alternate_gateway`, the policy
engine, the EV comparison across all five options, the audit
trail, the what-if comparison, ground truth with precision/recall, the
idempotency constraints, or the source badges. Those are the difference between
a product and a demo — the first tells you what it refused to do and why, and
the last one puts a rupee figure on the difference.
