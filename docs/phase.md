# Revenant Mini — Phase Plan

Execution plan derived from [`revenant-mini.md`](./revenant-mini.md) §12 (build order),
§14 (acceptance) and §15 (running it). The spec is the authority on *what*; this
file is the authority on *order, gates and status*.

**Rule for every phase: it is not done until its Gate column is demonstrable in
a running system.** No phase is marked complete on "code written".

---

## 0. Ground rules carried into every phase

These come from §2 and are non-negotiable at any phase boundary.

| # | Invariant | Where it bites |
|---|---|---|
| 1 | PostgreSQL is the source of truth; everything else is derived from `payment_events` | P1, P5 |
| 2 | At-least-once delivery, at-most-once effect — idempotency by `UNIQUE`, never `if (exists)` | P3, P13 |
| 3 | Every money action passes the policy engine (`PolicyApprovedAction` brand) | P12, P13 |
| 4 | The LLM never produces a number and never executes | P15 |
| 5 | Money is integer paise; rates computed from two integers at display time | all |
| 6 | Never print an unmeasured metric — `null` with a label, never `0` | P5, P9, P10 |
| 7 | UTC in code, IST only in the browser | all |

**Dependency rule (§5):** `domain/` imports nothing from the project. `app/`
imports `domain/` + `db/`. `http/` imports `app/`. Nothing imports `http/`.
Enforced by an eslint `no-restricted-imports` rule added in P0.

**Container scope rule (§15.1):** every docker command carries `-p minirevenant`.
Never run `docker system prune`, `docker volume prune`, or any unscoped cleanup —
this machine runs other stacks.

---

## 0.1 Deviations from the spec, and why

Four, all deliberate. Everything else follows `revenant-mini.md` exactly.

| # | Spec says | This build | Reason |
|---|---|---|---|
| 1 | Postgres on host port `5433` | **`5434`** | 5432 and 5433 are held by the `recriauth` stack on this machine. The spec chose 5433 solely to avoid colliding with an existing Postgres; 5434 serves that reason. `POSTGRES_HOST_PORT` in `.env`. |
| 2 | — | — | *(was `:3002` while 3000 was occupied; now back on the spec's `:3000`. `WEB_PORT` + `CORS_ORIGINS` in `.env`.)* |
| 3 | Compose project `revenant-mini` | **`minirevenant`** | Matches the directory. Every command carries `-p minirevenant`. |
| 4 | `@anthropic-ai/sdk`, `claude-sonnet-5` | **Vercel AI SDK (`ai` v7)**, provider-agnostic | See below. |

### On the LLM: provider-agnostic through the AI SDK

§7.8 puts the model at the edge — it receives already-computed context and
returns a value from a closed enum plus prose. It never produces a number and
never executes. **Which vendor answers is therefore an implementation detail**,
so it is configuration rather than code.

`LLM_PROVIDER` takes `none` | `gateway` | `anthropic` | `openai` | `google`.
`gateway` routes any vendor through the Vercel AI Gateway on one key; the other
three go direct on that vendor's own key. `none` is the **default**, so the
deterministic path is what runs unless somebody opts in — which is exactly the
state §14 requires to be demonstrable.

This is stricter than the spec's hand-parsing, not looser: structured output is
enforced by the SDK against a zod schema (`Output.object`), so a response that
does not satisfy the closed enum never becomes a value. Prompt injection is
assumed; anything off-schema is rejected and the caller falls back.

`lib/llm.ts` exposes `resolveModel()` (returns `null` when the deterministic
path is correct — `null` is a supported state, not an error) and
`generateStructured()`, which is time-boxed by `AbortSignal.timeout` and returns
`null` on **every** failure mode §7.8 enumerates: absent model, slow model,
unparseable output, transport error. All four have the same correct response, so
they share one return value. There is no throwing path.

### On RabbitMQ and Redis: not containers, by design

Neither is installed, and that is §3, not an omission.

| Concern | Production | Here | Why the swap is honest |
|---|---|---|---|
| Queue | RabbitMQ quorum queues | **`outbox` table + in-process relay**, 200 ms tick, `FOR UPDATE SKIP LOCKED` | Same transactional-outbox guarantee. Stronger, in fact: the event insert and the outbox insert commit in **one transaction**, so a message cannot exist without its event. Matching that with a broker needs two-phase commit. Loses only cross-process fan-out. |
| Cache / locks | Redis | **in-memory `Map` + `pg_advisory_xact_lock`** | Non-authoritative in both. Postgres is the source of truth (invariant 1), so a cache that disappears on restart costs nothing. |

Adding either would mean ~200 MB of RAM serving no code path, and an
architecture diagram that claims more than the system does. The concurrency
story is told by the four Postgres features in §6.1 instead, each of which a
judge can interrogate directly.

---

## Phase status legend

`TODO` · `WIP` · `DONE` · `CUT` (see §16 cut order)

---

## P0 — Foundation

**Status:** DONE

Scaffold that everything else lands on. Nothing domain-specific.

- `docker-compose.yml` — one service, `postgres:16-alpine`, project `minirevenant`
- Bun workspace root: `apps/api`, `apps/web`
- TypeScript strict everywhere; `no-restricted-imports` guarding the layer rule
- Hono API skeleton with `/health` and `/ready`
- Next.js 15 skeleton with the Linear tokens from §11.1 in `globals.css`
- `.env.example`, `.env` gitignored, config parsed with zod and logged redacted
- `lib/logger.ts` — structured JSON logging with a key-based redaction pass, so
  §15.2 ("payment payloads and PII are never logged") fails safe rather than
  relying on care at each call site
- `lib/errors.ts` — the `RETRYABLE` / `TERMINAL` / `NEEDS_HUMAN` taxonomy of §9,
  plus `isUniqueViolation` for the §6.1 constraints and `describeError`
- `lib/shutdown.ts` — bounded graceful shutdown on SIGINT/SIGTERM
- `lib/llm.ts` — provider-agnostic LLM port, defaulting to off
- `http/app.ts` — CORS allowlist, request id, access log, `notFound`, `onError`
- `eslint.config.mjs` — the §5 layer rule as a lint error

**Gate:** `docker compose -p minirevenant up -d postgres` reports healthy ·
`bun dev` serves a themed shell on :3000 · `GET /health` 200 ·
`GET /ready` reports each dependency separately **with the reason** when one is
down · every secret in the boot log is redacted · an unknown route returns a
structured 404 · SIGTERM unwinds and exits 0 · a domain module importing `db/`
**fails the lint** · `bun run check` is clean · `next build` succeeds.

> **Ports.** Postgres **5434**, web **3000**, api **8090**. The spec's 5433 and
> 3000 are both occupied on this machine — see §0.1. `POSTGRES_HOST_PORT` and
> `WEB_PORT` in `.env`.

---

## P1 — Schema and data access

**Status:** DONE

- `migrations/001_schema.sql` — §6 verbatim, forward-only
- `migrations/002_seed_merchants.sql` — 5 synthetic merchants
- `db/migrate.ts` — applies `migrations/*.sql` in order, once, on a **reserved**
  connection under `pg_advisory_lock`, with per-file checksums and a lock timeout
- `db/client.ts` — postgres.js pool, BIGINT paise parsed to `number` with a
  safe-integer guard that throws rather than silently rounding a money value
- `db/queries.ts` — every SQL statement, one place, typed

**Gate:** tables exist · a smoke insert round-trips · BIGINT paise arrive as
`number` · **three API processes started at once migrate exactly once** (§14) ·
editing an applied migration fails the next boot with both checksums · a stuck
lock surfaces as a clear error inside 30 s rather than hanging the boot.

**Two concurrency bugs found by that gate, both fixed — worth not
reintroducing:**
1. `pg_advisory_lock` is **session**-scoped. Taking it on a pooled connection
   and running the migrations on whichever connection the pool hands out next
   leaves the lock guarding nothing, and the unlock runs on a session that never
   held it. Hence `sql.reserve()`.
2. `CREATE TABLE IF NOT EXISTS` is **not atomic** against a concurrent create —
   racing processes fail with a duplicate key on `pg_type_typname_nsp_index`.
   Everything, the bookkeeping table included, happens inside the lock.

**Watch for:** the four partial unique indexes (`incidents_one_open`,
`cases_one_live`, `model_one_active`, `outbox_pending`) are business rules, not
optimisations. They must be in 001, not added later.

---

## P2 — Pure domain primitives

**Status:** TODO

- `domain/money.ts` — paise helpers, the five amount bands (§8.1), one definition
  shared by analytics, RCA and the model
- `domain/payment-state.ts` — the state machine (§7.1)
- `domain/failure-codes.ts` — codes to families (§7.2), `CROSS_BORDER` as its
  own family

**Gate:** exhaustive state-machine test passes under `bun test`, including
terminal protection (`CAPTURED` moves only on `refund.processed`) and staleness
(`occurredAt < lastEventAt` records but does not move state) · **`bun run check`
goes green** — it fails today only because `bun test` finds zero test files, and
that strictness is deliberate.

**Watch for:** folding `CROSS_BORDER` codes into `CUSTOMER` is called out in §7.2
as the single most expensive mistake available in this dataset. The family split
must exist before the model trains.

---

## P3 — Ingest, outbox, relay, projector

**Status:** TODO

- `app/ingest.ts` — `payment_events` + `outbox` in ONE transaction, return 200
  immediately, nothing else synchronous
- `app/relay.ts` — 200 ms tick, `FOR UPDATE SKIP LOCKED`, `sent_at` after
  handlers ack, dead-letter at 5 attempts
- `app/projector.ts` — `SELECT … FOR UPDATE` on the payment row, then payment +
  attempt + transition + `processed_events` marker in ONE transaction
- `POST /webhooks/gateway` — HMAC signature, constant-time compare
- abandonment sweep — `ATTEMPTED`, idle 30 simulated minutes, sets `abandoned`

**Gate:** posting the same event **three times** produces exactly one payment,
one transition, one rollup increment · an out-of-order event lands with
`stale = true` and does not move state · two relay loops never deliver the same
outbox row twice.

---

## P4 — Deterministic dataset

**Status:** TODO

- `lib/rng.ts` — mulberry32, seeded
- `sim/generator.ts` — §8.1 distributions: method mix, log-normal amounts, daily
  rhythm, method-tied failure codes, 18% international at a 19% baseline failure
  rate against 7% domestic
- Five injected incidents + `INTERNATIONAL_3DS_BLOCK` (§8.2) into
  `ground_truth_incidents`
- Two **unlabelled** noise windows (§8.4)
- Counterfactual labels + chronological `train`/`val`/`test` split (§8.3)
- SHA-256 checksum onto `dataset_runs`
- `bun seed`

**Gate:** 5,000 payments · checksum printed · **same seed produces the same
checksum, twice in a row** · ground-truth tables populated · any labelled
incident affecting fewer than 20 payments is reported as a dataset defect ·
international baseline failure rate is materially above domestic (~19% vs ~7%)
**before any detection runs**.

**Watch for:** the labels are counterfactuals decided at generation time. Once a
payment exists, whether a retry *would* have worked is unknowable — there is no
later phase in which this can be added.

---

## P5 — Analytics and metrics

**Status:** TODO

- `app/analytics.ts` — incremental rollups in the same transaction as their
  idempotency marker, plus a recompute sweep; the delta is **drift**
- `/api/v1/metrics/{summary,timeseries,breakdown,acceptance}`
- `/` Command Center: four tiles, the domestic vs international acceptance strip,
  the drift indicator

**Gate:** `/` shows four tiles with real numbers and drift 0 ·
`recovery_rate` is recomputable from the two amounts printed beside it ·
`recoverable_revenue` is `null` with `recoverable_estimated: false` — never 0 ·
drift is **displayed, not corrected**.

**Metric definitions are §10's table verbatim.** The two revenue columns are
mutually exclusive by construction; `revenue_recovered` reads
`payment_state_transitions`, not current state.

---

## P6 — Clock, runner, SSE

**Status:** TODO

- `sim/clock.ts` — simulated clock, 1 real second = 30 simulated minutes,
  speeds 1×/10×/60×/300×
- `sim/runner.ts` — walks payments in `created_at` order, pushes events through
  **the real webhook handler**, never writes `payments` directly
- `db/notify.ts` — `LISTEN revenant_events` on a dedicated connection, fan out
  to SSE
- `http/sse.ts` + `/api/v1/stream`
- `POST /api/v1/sim/{start,pause,reset,speed,jump-to-incident}`

**Gate:** press play — the feed streams, the chart fills, the clock advances.
Nothing appears on screen that a rollback later un-happened (NOTIFY rides inside
the writing transaction).

---

## P7 — Detection

**Status:** TODO

- `domain/detector.ts` — EWMA + z-score, the **five gates** of §7.3 (volume
  floor, absolute lift, relative lift, z-score, sustained-ness); fire only if
  every gate passes
- `app/detection.ts` — sweep every 5 simulated minutes under
  `pg_advisory_xact_lock`, opens/resolves incidents, 60-simulated-minute
  suppression per slice
- `/incidents` list + detail with the gate checklist

**Gate:** incidents open on the injected windows and **not** on the two noise
windows · precision and recall printed against `ground_truth_incidents` ·
**the `INTERNATIONAL_3DS_BLOCK` window is detected on the `is_international`
dimension and missed on the aggregate series** — that contrast is the demo, so
it gets its own explicit test (§14).

---

## P8 — Root cause analysis

**Status:** TODO

- `domain/rca.ts` — apportion **excess** failures, never total; shrink the
  expected rate toward the pooled rate with `k = 30`; score each 1-to-3
  dimension tuple on excess share, specificity, support (two-proportion z
  **against the rest of the same window**) and volume;
  `confidence = 0.40·share + 0.25·specificity + 0.20·min(1, z/6) + 0.15·volume`
- Top 3 hypotheses with their own evidence numbers, rendered as `HypothesisCard`

**Gate:** top-1 hypothesis matches the labelled tuple for **at least 4 of 5**
incidents · RCA top-1 accuracy is shown on `/simulator`.

**Watch for:** the baseline rate quoted on a hypothesis must be the *shrunk* one
— the same arithmetic the share came from.

---

## P9 — Recovery cases and the rule baseline

**Status:** TODO

- `domain/recovery-model.ts` — the `Features` vector and the shared encoding
  pipeline used by **both** training and serving
- The measured family-rate fallback table of §7.5, including the
  `alternate_gateway` column that only `CROSS_BORDER` codes carry
- Adjustments: `× 0.62` per additional attempt, `× 1.25` on retry during an
  active incident, clamp `[0.01, 0.95]`
- `app/recovery.ts` — opens cases (blocked from duplicating by `cases_one_live`)

**Gate:** cases open with `probability_source: 'baseline'` and the UI shows that
badge · a second live case for the same payment is rejected by the constraint,
not by an `if`.

---

## P10 — Trained model

**Status:** TODO

- `ml/train.ts` — batch gradient descent, ~400 epochs, lr 0.1, L2 1e-4,
  **70/15/15 chronological split by position, never random**
- 10-bucket calibration map, AUC, Brier, log loss, calibration curve persisted
  to `model_versions`; activation guarded by `model_one_active`
- `/model` page — the model card
- `bun train`

**Gate:** AUC and the calibration curve render · predictions flip to
`source: 'model'` · **deleting the active model row falls the system back to the
baseline, flagged** (§14 resilience).

**Watch for:** feature-pipeline skew between training and serving is silent. One
pipeline, imported by both, or this phase is quietly wrong.

---

## P11 — Strategy engine

**Status:** TODO

- `domain/strategy.ts` — five options, `do_nothing` always on the ballot,
  integer paise throughout
- `customerMultiplier = 1.0 + min(0.5, ltvPaise / 5_000_000)`, caps at 1.5×
- Cost/friction table of §7.6
- `StrategyComparison` — winner highlighted, **losers greyed but visible**

**Gate:** four options with EV rendered · `do_nothing` visibly wins on fraud and
on tiny amounts · **`alternate_gateway` wins on `CROSS_BORDER` codes and loses to
`retry` on domestic `INSUFFICIENT_FUNDS`** — both asserted in tests, or it is a
second retry bot (§14).

---

## P12 — Policy engine

**Status:** TODO

**Build this before P15. The gate must exist before anything proposes an action,
or "the LLM cannot act on its own" is a claim rather than a property.**

- `domain/policy.ts` — the twelve rules of §7.7, evaluated **in order, all of
  them, always**; never short-circuit, collect every reason
- Precedence: any DENY wins, else any REQUIRE_APPROVAL, else ALLOW
- `inputHash` = SHA-256 of the canonicalised input JSON
- The `PolicyApprovedAction` brand — `unique symbol`, constructor not exported;
  `approve()` returns `null` unless the verdict is ALLOW
- Every decision persisted, **ALLOWs included**
- `/policy` page: the twelve rules, the version, the append-only log, and the
  type snippet itself

**Gate:** twelve rules evaluated with all reasons stored ·
**deleting the brand makes the build fail** — assert it (§14) · a DENY renders
with its full reason list, not the first objection.

---

## P13 — Executor and simulated gateway

**Status:** TODO

- `app/executor.ts` — signature accepts only `PolicyApprovedAction`;
  idempotency key **reserved before** the gateway call
- `sim/gateway.ts` — two routes; `secondary` refuses INR-only instruments (UPI,
  netbanking, RuPay) so `alternate_gateway` has to be earned
- Reads the ground-truth counterfactual for the intervention actually chosen
- Injected faults: 5% RETRYABLE (429/503), 2% timeout with unknown outcome,
  1% TERMINAL
- Error classification `RETRYABLE` / `TERMINAL` / `NEEDS_HUMAN`; retry logic
  reads the **class**, never the message text; unclassified defaults to
  `NEEDS_HUMAN`

**Gate:** actions execute idempotently · injected 429s retry with capped backoff
and jitter, twice, then **escalate rather than loop** · **a timeout with an
unknown outcome reconciles by reference and is never blind-retried** · the same
idempotency key never produces two gateway effects.

---

## P14 — Verification and attribution

**Status:** TODO

- `app/verify.ts` — `direct` (captured within 30 simulated minutes, our
  reference), `assisted` (within 6 simulated hours, different reference),
  `organic` (**credits zero**)
- Store `predicted_probability` beside `actual_recovered`; recompute the **live**
  calibration curve
- Second curve on `/model` beside the training one

**Gate:** outcomes attributed · `revenue_recovered` climbs · **organic
recoveries credit zero and say `organic` in the UI** · where attribution has not
run the UI says `unattributed`, never implying credit.

---

## P15 — The agent

**Status:** TODO

- `app/agent.ts` — read tools are pure lookups; the only write is
  `proposeAction`, and a proposal is an input to the gate, not an action
- Receives already-computed context; returns `{ choice, confidence, narrative }`
- Output enforced against a zod schema by `lib/llm.ts` (`Output.object`) — the
  closed enum is a schema constraint, so an off-enum answer never becomes a value
- Fallback on **any** of: `LLM_PROVIDER=none`, absent key, latency over
  `LLM_TIMEOUT_MS`, off-schema output, transport error → strategy-engine argmax
  + templated narrative, `source: 'fallback'`
- LLM choice with EV ≤ 0 is overridden and `rejected_reason` recorded
- Every call written to `agent_decisions` with a prompt hash
- Provider-agnostic (§0.1): set `LLM_PROVIDER` to `gateway`, `anthropic`,
  `openai` or `google`. Default `none`.

**Gate:** narratives appear with an `llm` badge · **setting `LLM_PROVIDER=none`
mid-demo falls back, flips the badge to `template`, and the choices stay
identical** · the same demo runs on any of the three vendors without a code
change. Prompt injection is assumed — injected text has no path to authority
because the policy engine reads structured fields only.

---

## P16 — Audit trail

**Status:** TODO

- `/api/v1/audit/:paymentId` and `/audit/[paymentId]`
- One vertical timeline: EVENT → DETECTION → DIAGNOSIS → AGENT DECISION →
  POLICY → ACTION → OUTCOME, in causal order, each node with its timestamp,
  inputs and the artefact it produced

**Gate:** any payment renders event to outcome with every input shown ·
**every number on the page is recomputable from stored inputs** · reachable from
any case, incident or feed row.

---

## P17 — What-if simulator

**Status:** TODO

- `sim/whatif.ts` — replay against the stored labels, no gateway calls, no clock
- BASELINE (one blind immediate retry on every failure, single processor) vs
  AGENT (probability, EV, policy gate, chosen intervention)
- **Held-out test split only**
- Split the table by `is_international`
- `/whatif` page with the honesty banner and `bun whatif`

**Gate:** incremental revenue printed · **both arms operate on an identical set
of failed payments — assert the counts match** · the page states: held-out
split, counterfactuals decided before either arm ran, simulation not live result.

---

## P18 — Polish

**Status:** TODO

- `/simulator` — seed, params, checksum, progress, five injected incidents with
  detected/missed, two noise windows with fired/clean, the live scoreboard
- `⌘K` command palette, `g i` / `g r` / `g p`, `Space` toggles the simulator
- Chart rules of §11.4; Indian money grouping with the paise value in `title`

**Gate:** the full §13 demo script runs start to finish **without a reload**.

---

## Cut order if time runs out (§16)

Cut from the top. Everything below the line still tells a complete story.

1. `⌘K` command palette
2. `/model` coefficient chart (keep AUC, Brier, calibration curve)
3. The live calibration curve (keep the training one)
4. The LLM entirely — deterministic narratives read fine
5. `alternate_method` as a strategy (keep retry, link, do_nothing)
6. Incremental rollups — recompute-only is correct, just slower
7. The trained model itself — the rule baseline is a measured fallback

**Never cut:** the cross-border wedge and `alternate_gateway` · the policy
engine · the EV comparison across all five options · the audit trail · the
what-if comparison · ground truth with precision/recall · the idempotency
constraints · the source badges.

---

## Commands

```bash
bun install
cp .env.example .env

bun db:up          # docker compose -p minirevenant up -d postgres, wait for healthy
bun db:migrate     # apply migrations/*.sql (also runs on API boot)
bun seed           # generate the dataset, print the checksum, report defects
bun train          # train the recovery model, print AUC / Brier, activate it
bun dev            # api on :8090, web on :3000

bun whatif         # BASELINE vs AGENT on the held-out split
bun test           # domain unit tests
bun run lint       # eslint, including the §5 layer rule
bun run typecheck  # both workspaces
bun run check      # lint + typecheck + test

bun db:reset       # drop the volume and re-migrate — scoped to minirevenant only
bun db:psql        # psql into the container
```

`bun dev` must not require `bun seed` to have run: an empty database renders an
empty dashboard with zeros and a "no dataset — run `bun seed`" banner, never a
crash and never a fake number.
