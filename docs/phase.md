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

## 0.2 Security and correctness audit (after P5)

Eight findings across P0–P5. Six fixed, two accepted and documented. Every fix
carries a regression test in `test/security.integration.test.ts`.

### Fixed

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | **An accepted webhook could permanently break the metrics API.** Two payments near `MAX_SAFE_INTEGER` sum past it; the driver refuses to round a `BIGINT` it cannot represent exactly, so `/api/v1/metrics/summary` answered **500 and kept answering 500** until the rows were deleted. | High | `MAX_AMOUNT_PAISE` (₹10 crore) at the edge **and** a `payments_amount_sane` CHECK, so no code path routes around it |
| 2 | **`abandoned` rollups were never decremented.** A payment leaving the abandoned state cleared the flag on its row but not in the rollup. | High | Projector gives the count back |
| 3 | **The drift check was blind to exactly that bug.** It compared only attempts/successes/failures/gross — never `abandoned` or `captured_amount_paise` — so it reported **drift 0 while the rollup was wrong**. A drift detector with a blind spot asserts correctness it never tested. | High | Both columns now compared; corrupting either is detected |
| 4 | **A far-future timestamp poisoned the dashboard.** One event dated 9999 stretched the default window to `2026 → 9999`. | Medium | `occurred_at` bounded to [2000, now+5y] plus a `payments_created_at_sane` CHECK |
| 5 | **The webhook answered 200 for payloads it then silently discarded.** Under at-least-once delivery the sender believes it delivered — a gateway quietly losing payment events is the exact failure this system exists to make visible. | Medium | Kind-specific payload validated at the edge; unprocessable input is a 400 the sender can act on |
| 6 | **Unbounded request body.** `c.req.text()` buffered whatever arrived before the signature was checked. | Medium | 64 KB cap, checked on `Content-Length` before the body is read and again after |
| 7 | **`/metrics/drift` cost ~750 ms and the dashboard called it every render** — an unauthenticated scan of every payment across seven dimensions, triggerable by holding down refresh. | Medium | 15 s TTL cache with request coalescing; **0.84 s → 0.0005 s**. Invalidated by a recompute |
| 8 | **A one-character `WEBHOOK_SECRET` was accepted.** A signing key short enough to guess is the same as no signature. | Low | Minimum 16 characters, enforced at boot |

`measureDrift`'s `from` is concatenated into raw SQL (the fragment spans a
`UNION ALL`). It was already effectively safe, but it now normalises through
`Date.parse` explicitly and **throws** on unparseable input rather than reaching
the database — asserted with a `'; DROP TABLE payments; --` payload.

### Accepted, not fixed

- **No authentication on the metrics API, and `merchant_id` reads any tenant's
  data.** §3 puts auth and multi-tenancy enforcement explicitly out of scope for
  the MVP (single hardcoded merchant switcher). This is a real gap for anything
  beyond a local demo and is called out in the README, not silently left.
- **`processed_events` and `outbox` are never pruned.** `processed_events` is at
  292k rows / 37 MB after one seed and grows with every event forever. Correct
  but unbounded; a retention sweep is operational work this build does not need
  over a 7-day simulated window.

### Verified sound, no change needed

Parameterised SQL everywhere outside the one hardened path · HMAC over the
**raw** body with a constant-time compare · replay of a captured request is a
no-op by `UNIQUE(event_id)` · error responses carry a code and a request id,
never a stack or driver text · secrets redacted in logs by key, so a careless
call site fails safe · CORS is an allowlist, not an echo.

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

**Status:** DONE — 120 tests, `bun run check` green

- `domain/money.ts` — `Paise` nominal type, `assertPaise` at the boundaries,
  `scalePaise` as the single place a float touches money, `rate()` returning
  `null` on a zero denominator, the five amount bands (§8.1) as one definition
  shared by analytics, RCA and the model, Indian-grouped formatting (§11.1)
- `domain/payment-state.ts` — the state machine (§7.1), plus
  `incrementsAttemptIndex`, `isTerminal` and `isAbandoned`
- `domain/failure-codes.ts` — codes to families (§7.2), `CROSS_BORDER` as its
  own family, `isUnactionable` and `isRouteFailure`

**Gate:** all 6 × 6 = 36 state/event pairs asserted individually · terminal
protection (`CAPTURED` moves only on `refund.processed`; `REFUNDED` moves on
nothing) · staleness records without moving state, **and is checked before
terminal protection**, per the rule order in §7.1 · `bun run check` green.

**Verified by mutation, not just by passing:** removing terminal protection
fails 4 tests, folding `THREEDS_FAILED` into `CUSTOMER` fails 4, and reordering
the staleness check after terminal protection fails 2. A guardrail whose test
cannot fail is not a guardrail.

**One edge the spec implies but does not spell out.** `ATTEMPTED + payment.captured
→ CAPTURED` is legal, because §8.6 has the simulated gateway emit
`payment.attempted` then `payment.captured` when a recovery succeeds. Without
that edge a recovered payment could never reach `CAPTURED` and
`revenue_recovered` would be structurally zero. Asserted explicitly.

**Watch for:** folding `CROSS_BORDER` codes into `CUSTOMER` is called out in §7.2
as the single most expensive mistake available in this dataset. The family split
must exist before the model trains.

---

## P3 — Ingest, outbox, relay, projector

**Status:** DONE — 15 integration tests, stable over 15 consecutive runs

- `app/events.ts` — the webhook envelope and its zod schema
- `app/ingest.ts` — `payment_events` + `outbox` in ONE transaction; a duplicate
  is rejected by `UNIQUE(event_id)` and **never reaches the outbox**
- `app/relay.ts` — 200 ms self-scheduling tick, `FOR UPDATE SKIP LOCKED`,
  `sent_at` only after the handler acknowledges, dead-letter at 5 attempts
- `app/projector.ts` — `SELECT … FOR UPDATE` on the payment row, then the
  `processed_events` marker + payment + transition + NOTIFY in ONE transaction
- `app/abandonment.ts` — `ATTEMPTED`, idle 30 simulated minutes; `now` is passed
  in, because a wall clock here would never fire during a 3-minute demo
- `lib/signature.ts` — HMAC-SHA256 over the **raw** body, constant-time compare
- `db/notify.ts` — the `NOTIFY` write half; the listener lands in P6
- `POST /webhooks/gateway`

**Gate:** the same webhook posted 3× yields one payment, one event row and the
right number of transitions · an out-of-order event is written with
`stale = true` and does not move state · concurrent drains deliver every row
**exactly once, with zero duplicates and zero misses** · a `CAPTURED` payment is
never re-attempted · an unroutable row dead-letters and the row behind it still
delivers · unsigned and tampered bodies are 401.

**Two real bugs, both found by the gate:**

1. **The relay could double-deliver.** The claim `UPDATE` ran in autocommit, so
   `FOR UPDATE SKIP LOCKED` held its lock for that one statement only. It
   committed, released the locks, and because `sent_at` is not set until the
   handler acknowledges, a second relay found the row still pending and
   delivered it again. `SKIP LOCKED` protects concurrent *statements*, not a
   claim-then-handle gap. **The claim and the delivery now share one
   transaction**, so the lock spans the whole delivery.
2. **One relay could destroy another's messages.** An unknown topic was
   dead-lettered on sight — but §6.1 contemplates N relay loops, and a topic
   *this* process cannot route may be one *another* process handles. Unknown
   topics now count toward `MAX_ATTEMPTS` like any other failure: a genuinely
   unroutable row still dies, after five tries rather than instantly.

**A test that was wrong rather than a bug:** the first concurrency test asserted
a global claim count, which fails for reasons unrelated to the property. It now
counts deliveries per row and asserts zero duplicates and zero misses.

**Integration tests need the dev API stopped.** A running `bun dev` ticks its
own relay against the same database and competes for rows, which looks exactly
like a relay concurrency bug and is not one. `test/helpers.ts` detects a
competing relay and fails with that instruction rather than leaving somebody to
debug a phantom.

**Run them with:** `bun run test:integration` (needs Postgres up; `bun run
test:all` runs unit and integration together).

---

## P4 — Deterministic dataset

**Status:** DONE — 27 generator tests, checksum reproduced across two full runs

- `lib/rng.ts` — mulberry32
- `sim/generator.ts` — §8.1 distributions: method mix, log-normal amounts, daily
  rhythm in IST, method-tied failure codes, 18% international with cross-border
  codes never leaking onto domestic traffic
- Six injected incidents including `INTERNATIONAL_3DS_BLOCK` (§8.2), placed in
  daytime IST, infrastructure-wide
- Two **unlabelled** noise windows (§8.4)
- Counterfactual labels + chronological `train`/`val`/`test` split (§8.3)
- SHA-256 checksum → `dataset_runs`; the <20-payment defect check
- `sim/seed.ts` / `bun seed`

**Gate:** 75,000 payments · **the same seed produced an identical checksum on
two consecutive full runs** (`94211eded…`) · ground truth populated · **zero
dataset defects** · international failure rate **18.6%** against domestic
**6.9%**, verified in SQL against the projected state, not just in the
generator's own stats.

**Events go through the real projector, never straight into `payments` (§8.5).**
A dataset built on its own notion of state validates nothing — it is perfectly
possible to load 75,000 rows the state machine could never have produced, and
every later phase would then be measuring a fiction. All 291,939 events were
applied by the projector; the 216,939 transitions are its output.

### The spec contradicts itself on dataset size

`SIM_PAYMENTS=5000` (§8.1) is incompatible with three other numbers in the same
document. At 5,000 payments over 7 days the aggregate series carries **7.4
attempts per 15-minute evaluation window**, so §7.3's `minAttempts: 20` can
never be met and **the detector cannot fire on anything** — P7 would have
nothing to demonstrate.

| Spec number | At 5,000 | Needs |
|---|---|---|
| §8.7 what-if: 2,140 failed payments | ~470 | ~23,000 |
| §7.3 `minAttempts: 20` per evaluation window | 7.4 | ~13,500 |
| §8.2 <20 payments per incident is a defect | `BANK_OUTAGE` = 13 → defect | ~13,000 |
| §8.2 centrepiece detected on the 18% international slice | 1.3 | **~75,000** |

**Resolved at 75,000**, which is the only value where §7.3's gates hold *as
written* on the international slice — the dimension the demo's centrepiece
incident is detected on. Seed takes ~1m50s and the database is 193 MB.
`SIM_PAYMENTS` is the knob.

### Calibration

The failure rates in `DEFAULT_PARAMS` are **draw** rates, not observed rates:
customer failure-runs, incident windows and noise all push the observed rate
above the draw rate. They are calibrated against generated output — 0.051
domestic and 0.138 international land the dataset on §8.1's stated ~7% and ~19%.
The tests assert the observed gap, because the gap is the product (§1.1).

**One semantic fix:** `affected_payments` on a ground-truth incident counts
payments **in the degraded slice during the window**, not failures caused. The
detector sees attempts *and* failures in that slice, so slice volume is what
decides whether an incident is detectable at all — which is exactly what the
<20 defect check is guarding.

**A test-runner bug found on the way:** `bunfig.toml` pinned `[test] root` to
`domain/`, which **overrides the paths passed on the command line**. The
generator tests appeared to pass while never running. The pin is gone; the
scripts name their own paths.

---

## P5 — Analytics and metrics

**Status:** DONE — 26 integration tests, stable over 8 consecutive runs

- `app/analytics.ts` — incremental rollups written **in the same transaction as
  the projection that caused them**, a full recompute, and a drift measurement
  that reports without repairing
- `app/recompute.ts` / `bun rollups:recompute` — repairing drift is a
  deliberate command, never a side effect of noticing it
- `db/queries.ts` — §10's metric definitions in SQL
- `/api/v1/merchants`, `/api/v1/metrics/{summary,acceptance,timeseries,breakdown,drift}`
- `/` Command Center: four tiles, the acceptance strip, the drift indicator, a
  volume panel and a by-method table

**Gate:** four tiles with real numbers · **drift 0** across 165,902 rollup rows ·
`recovery_rate` printed beside the two amounts it was divided from ·
`recoverable_revenue` is `null` with `recoverable_estimated: false`, never 0 ·
drift displayed, not corrected.

**On screen, matching §13 step 2's script:** Revenue at Risk **₹2.4Cr** ·
domestic **93.1%** · international **81.4%** · gap **11.7 pts / ₹84.3L**.

### A money bug the tests caught

`sum()` over a `BIGINT` column returns `numeric`, which postgres.js hands back
as a **string**. Every money figure was arriving as text, so
`revenue_recovered + revenue_at_risk` evaluated to `"0" + "2400918253"` =
`"02400918253"` — the `recovery_rate` denominator, silently. Every money `sum()`
is now cast `::bigint`, and a regression test asserts `typeof … === 'number'`
across summary, acceptance, breakdown, timeseries and drift.

This is exactly what invariant 5 exists to prevent, and it was invisible until
something divided by it.

### Two more real bugs

1. **`recomputeRollups` collided with itself.** The `DELETE` lived in a
   data-modifying CTE beside the `INSERT`. Every CTE in a statement sees the
   same snapshot and they are **not ordered relative to one another**, so the
   insert hit rows the delete had not yet removed:
   `duplicate key value violates unique constraint "metrics_rollup_pkey"`.
   Now `DELETE` then `INSERT`, two statements in one transaction.
2. **Tests corrupted the seeded rollups.** Deleting a test payment does not
   undo the rollup row it contributed, so orphaned rows showed up as drift in
   later tests that had done nothing wrong. Both integration files now live in
   2027, outside any seeded dataset, and clear rollups for that range;
   `measureDrift` takes an optional window so a test only measures its own.
   Verified: eight consecutive runs leave global drift at **0**.

**Also fixed:** both integration files shared the `sql` pool singleton and the
first file's `afterAll` closed it out from under the second (`CONNECTION_ENDED`
in a file that did nothing wrong). Teardown now happens once, in a preloaded
`test/setup.ts`.

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
