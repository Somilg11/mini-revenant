# Revenant Mini

**An autonomous revenue recovery control plane for payments.**

Merchants lose payment revenue and nobody can say *which* failures matter, *why*
they are happening, or *which* fix is worth its cost. Revenant watches the
payment stream and runs one loop:

```
DETECT → DIAGNOSE → QUANTIFY → DECIDE → GATE → ACT → VERIFY → LEARN
```

It does not retry payments. It decides which failures are worth money, proves
why, and refuses to act when acting loses.

- **Spec:** [`docs/revenant-mini.md`](docs/revenant-mini.md) — the authority on *what*. Every number in it is load-bearing.
- **Plan:** [`docs/phase.md`](docs/phase.md) — the authority on *order, gates and status*.

---

## Quick start

Four commands from a clean checkout.

```bash
bun install
cp .env.example .env
bun db:up          # starts Postgres in Docker, waits for healthy
bun dev            # api on :8090, web on :3000
```

Open **http://localhost:3000**. With an empty database you get an empty
dashboard and a "no dataset" banner — never a crash, never a fake number. Then:

```bash
bun seed           # 5,000 payments, prints a checksum, reports dataset defects
bun train          # trains the recovery model, prints AUC / Brier, activates it
bun whatif         # BASELINE vs AGENT on the held-out split
```

**Requires:** [Bun](https://bun.sh) 1.2+ and Docker. Nothing else — no Razorpay
account, no API keys, no cloud services.

---

## Do I need Razorpay keys?

**No.** The payment gateway is simulated, and that is a design decision rather
than a shortcut.

§8.3 pre-decides every counterfactual at dataset generation time —
`recoverable_by_retry`, `recoverable_by_link`, `recoverable_by_alternate`,
`recoverable_by_gateway`. Against a real gateway, even in test mode, you can
never know whether a retry *would* have worked, so recovery becomes an assertion
instead of a measurement and the what-if comparison that closes the demo cannot
be computed at all.

`WEBHOOK_SECRET` is the only Razorpay-shaped thing in the project: it mimics
their webhook HMAC so the ingest path verifies signatures the way the real one
would. It is a development secret you generate yourself.

**No API keys are required for anything.** The LLM is optional and off by
default; see [The LLM is optional](#the-llm-is-optional).

---

## Architecture

```
sim/runner ──► POST /webhooks/gateway
                 │  ONE transaction: INSERT payment_events + INSERT outbox
                 ▼  returns 200 immediately, nothing else synchronous
              outbox relay (200 ms tick, FOR UPDATE SKIP LOCKED)
                 ▼
      ┌──────────┴──────────┬──────────────────┐
      ▼                     ▼                  ▼
  projector             analytics          detection sweep
  payment + attempt     rollups in the     evaluate → incidents → RCA
  + transition          same txn as its           │
  + processed_events    idempotency marker        ▼
                                          recovery: cases → predict → strategy
                                                   │
                                                   ▼
                                            agent proposes → POLICY GATE → executor
                                                   │
                                                   ▼
                                            verify: attribution + scoring
```

**One container.** Postgres only. The API and web app run on the host, so there
is no image to rebuild between edits. Memory footprint is ~70 MB.

RabbitMQ and Redis are deliberately absent. The queue is an `outbox` table plus
an in-process relay, which is *stronger* than a broker here: the event insert
and the outbox insert commit in one transaction, so a message cannot exist
without its event. Matching that with RabbitMQ needs two-phase commit. Locks are
`pg_advisory_xact_lock`, and caches are in-memory `Map`s — non-authoritative in
both designs, because Postgres is the source of truth.

### Layout

```
apps/api/src/
  config.ts       env parsing (zod), redacted logging
  db/             client, migrations, queries — every SQL statement, one place
  domain/         PURE. no db, no clock, no network, no project imports
  app/            use cases; orchestrates domain over ports
  sim/            generator, clock, gateway, runner, what-if
  ml/             logistic regression trainer + calibration
  http/           routes and the error boundary
  lib/            logger, errors, shutdown, LLM port, seeded RNG
apps/web/         Next.js 15 App Router, Linear theming
migrations/       forward-only SQL
```

**The dependency rule is enforced by the linter, not by review.** `domain/`
imports nothing from the project; `app/` imports `domain/` and `db/`; `http/`
imports `app/`; nothing imports `http/`. `bun run lint` fails the build if a
domain module reaches for the database. Guardrails enforced by review get
bypassed under deadline pressure.

---

## Hard invariants

These are not style preferences. Each one is a question a judge can ask, and the
answer has to be visible in the UI.

1. **PostgreSQL is the source of truth.** Every cache, rollup, incident and case is derived and rebuildable from `payment_events`.
2. **At-least-once delivery, at-most-once effect.** Idempotency is enforced by `UNIQUE` constraints, never by an `if (exists)` check.
3. **Every money action passes the policy engine.** The executor accepts only `PolicyApprovedAction`, a branded type whose constructor is not exported. Bypassing it is a *type error*, not a review comment.
4. **The LLM never produces a number and never executes.** It receives computed context and returns a value from a closed enum plus prose.
5. **Money is integer paise.** No float arithmetic touches an amount. Rates are computed from two integers at the moment of display.
6. **Never print an unmeasured metric.** Not-yet-measured is `null` with a label, never `0`.
7. **UTC everywhere in code. IST only in the browser.**

Four Postgres features do real work, and each is a concurrency answer:
`FOR UPDATE SKIP LOCKED` on the outbox, row locks in the projector, partial
unique indexes as business rules (`cases_one_live`, `incidents_one_open`,
`model_one_active`), and `LISTEN`/`NOTIFY` feeding SSE from inside the writing
transaction — so nothing reaches the screen that a rollback later un-happened.

---

## The LLM is optional

Provider-agnostic through the [Vercel AI SDK](https://ai-sdk.dev). The agent
receives already-computed context and returns a closed-enum choice plus prose,
so which vendor answers is an implementation detail — it is configuration, not
code.

```bash
LLM_PROVIDER=none        # default — deterministic, narratives read `template`
LLM_PROVIDER=gateway     # Vercel AI Gateway: one key, any vendor
LLM_PROVIDER=anthropic   # ANTHROPIC_API_KEY
LLM_PROVIDER=openai      # OPENAI_API_KEY
LLM_PROVIDER=google      # GOOGLE_GENERATIVE_AI_API_KEY
```

Structured output is enforced by the SDK against a zod schema, so a response
that does not satisfy the closed enum never becomes a value. Prompt injection is
assumed: the policy engine reads structured fields only, so injected text has no
path to authority.

`generateStructured()` returns `null` on **every** failure mode — no provider,
no key, timeout, off-schema output, transport error — because all of them have
the same correct response: take the deterministic choice and record
`source: 'fallback'`. There is no throwing path.

**The pipeline is correct with the LLM switched off, and the demo proves it by
toggling it live.**

---

## Commands

| Command | What it does |
|---|---|
| `bun install` | Install both workspaces |
| `bun db:up` | Start Postgres, wait for healthy |
| `bun db:migrate` | Apply `migrations/*.sql` (also runs on API boot) |
| `bun db:psql` | `psql` into the container |
| `bun db:logs` | Follow Postgres logs |
| `bun db:down` | Stop the container, keep the volume |
| `bun db:reset` | Drop the volume and re-migrate — **scoped to this project only** |
| `bun dev` | API on :8090 and web on :3000 |
| `bun dev:api` / `bun dev:web` | One at a time |
| `bun seed` | Generate the dataset, print the checksum, report defects (~2 min) |
| `bun train` | Train the model, print AUC / Brier, activate it |
| `bun whatif` | BASELINE vs AGENT on the held-out split |
| `bun test` | Domain unit tests (pure functions only) |
| `bun run test:integration` | Pipeline tests against Postgres — **stop `bun dev` first** |
| `bun run test:all` | Unit + integration |
| `bun run lint` | ESLint, including the layer rule |
| `bun run typecheck` | `tsc --noEmit` on both workspaces |
| `bun run check` | lint + typecheck + test |

### Container scope

Every Docker command carries `-p minirevenant`.

> **Never run `docker system prune`, `docker volume prune`, or any unscoped
> cleanup.** This machine runs other stacks and those commands do not know the
> difference. To remove only this project:
> `docker compose -p minirevenant down -v`

---

## Configuration

Copy `.env.example` to `.env`. It is gitignored, secrets come only from the
environment, and configuration is logged only in its redacted form. Payment
payloads and PII are never logged.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8090` | API |
| `WEB_PORT` | `3000` | Dashboard |
| `POSTGRES_HOST_PORT` | `5434` | Host port for the container |
| `DATABASE_URL` | `…@localhost:5434/revenant_mini` | Keep in sync with the above |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowlist |
| `SIM_SEED` | `42` | Same seed ⇒ same checksum, on any machine |
| `SIM_PAYMENTS` / `SIM_MERCHANTS` / `SIM_DAYS` | `75000` / `5` / `7` | 75,000, not the spec's 5,000 — see below |
| `SIM_ENDS_AT` | `2026-08-01T00:00:00Z` | Fixed, never `now` — the dataset must be comparable across machines |
| `SIM_SPEED` | `60` | 1 real second = 60 simulated minutes |
| `WEBHOOK_SECRET` | dev value | HMAC for the ingest path |
| `LLM_PROVIDER` | `none` | See [above](#the-llm-is-optional) |
| `LLM_TIMEOUT_MS` | `4000` | Slower than this and the deterministic fallback takes over |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

### Dataset size differs from the spec

`SIM_PAYMENTS` defaults to **75,000**, not §8.1's 5,000. At 5,000 payments over
7 days the aggregate series carries 7.4 attempts per 15-minute evaluation
window, so §7.3's `minAttempts: 20` can never be met and the anomaly detector
cannot fire on anything at all. Two other spec numbers agree: §8.7's what-if
table expects 2,140 failed payments (5,000 yields ~470), and §8.2 calls any
incident affecting fewer than 20 payments a dataset defect (at 5,000,
`BANK_OUTAGE` gets 13).

75,000 is the smallest size where the demo's centrepiece — detecting
`INTERNATIONAL_3DS_BLOCK` on the international slice, which is 18% of traffic —
clears §7.3's volume floor with the spec's own numbers unmodified. Seeding takes
about two minutes and the database lands at ~193 MB. Lower it if you only need
the pipeline and not the detector.

### One port differs from the spec

The web app runs on the spec's **3000** and the API on its **8090**. Postgres
uses **5434** rather than the spec's 5433, because 5432 and 5433 are both taken
by another stack on the development machine this was built on — and the spec
chose 5433 solely to avoid colliding with an existing Postgres, so 5434 serves
that same reason. Override any of them with `POSTGRES_HOST_PORT`, `WEB_PORT` or
`PORT`.

If you change `WEB_PORT`, change `CORS_ORIGINS` to match or the browser's
requests are rejected.

---

## Operational behaviour

**Failure handling** mirrors production:

| Failure | Response |
|---|---|
| Duplicate webhook | `UNIQUE(event_id)` — the second insert is a no-op |
| Out-of-order event | Recorded with `stale = true`; state does not move; terminal states protected |
| Handler throws mid-way | Transaction rolls back; the outbox row is retried; `processed_events` makes the effect happen once |
| Outbox row fails 5× | `dead_lettered` + an escalation row. The queue never blocks |
| Gateway 429/5xx | Classified `RETRYABLE`; capped backoff with jitter; 2 retries then escalate |
| Gateway timeout, unknown outcome | **Never blind-retried**; reconciled by reference lookup |
| Model missing | Rule baseline, flagged on the prediction and counted |
| LLM missing or malformed | Deterministic strategy; `source = 'fallback'` |
| Unclassified error | Defaults to `NEEDS_HUMAN` — in a money system, "I don't know" means "ask a person" |

Errors are classified `RETRYABLE` / `TERMINAL` / `NEEDS_HUMAN`, and the retry
logic reads the **class**, never the message text. Message matching is how a
reliability policy silently stops working after a vendor rewords its copy.

**Migrations** are forward-only and checksummed. Editing a file after it has
been applied fails the next boot with the two checksums, rather than leaving a
database that no longer matches its own history. Two processes booting at once
migrate exactly once — the advisory lock is taken on a *reserved* connection and
before any DDL, because `CREATE TABLE IF NOT EXISTS` is not atomic against a
concurrent create.

**Shutdown** is graceful on `SIGINT`/`SIGTERM` with a 10-second bound: the
relay's claimed outbox rows and any in-flight gateway call unwind before the
pool closes.

**The API error boundary** never returns a stack trace or a driver message to a
client. Each response carries an `X-Request-Id` that matches the log line
holding the full error.

### Health

```bash
curl localhost:8090/health   # liveness — touches nothing
curl localhost:8090/ready    # readiness — per-dependency, with reasons
```

`/ready` gates on the database and its migrations only. An unseeded database and
a disabled LLM are both normal states, reported with their reason rather than
treated as failures.

---

## Troubleshooting

**`bun dev` says a port is in use.** Set `PORT`, `WEB_PORT` or
`POSTGRES_HOST_PORT` in `.env`. Check with `lsof -nP -iTCP:3000 -sTCP:LISTEN`.

**`ECONNREFUSED … :5434`.** Postgres is not running: `bun db:up`. Confirm with
`docker compose -p minirevenant ps`.

**"changed after it was applied — migrations are forward-only".** An applied
migration was edited. Restore the file, or if the data is disposable,
`bun db:reset`.

**"could not acquire the migration lock".** Another process is migrating, or one
died holding the lock. Check for stray processes; the lock clears when their
session ends.

**The dashboard shows "No dataset".** Correct behaviour on an empty database.
`bun seed`.

**"Another relay is draining this database".** A `bun dev` API is running and
ticking its own relay against the same outbox, which competes with the
integration tests. Stop it: `pkill -f "src/index.ts"`.

**Narratives say `template` instead of `llm`.** `LLM_PROVIDER` is `none` or its
key is unset. `/ready` names the reason. This is a supported state.

---

## Development

```bash
bun run check      # lint + typecheck + test, the pre-commit gate
```

`domain/` modules are pure functions and are the only things unit-tested — they
carry the highest correctness risk, which is exactly why they are kept free of
infrastructure. Everything else is covered by the acceptance checks in
[`docs/phase.md`](docs/phase.md), each phase gated on something demonstrable in
a running system rather than on "code written".
