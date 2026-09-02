import { config } from '../config.ts';
import { sql, closeDb } from '../db/client.ts';
import { migrate } from '../db/migrate.ts';
import { listMerchants } from '../db/queries.ts';
import { project } from '../app/projector.ts';
import { sweepAbandoned } from '../app/abandonment.ts';
import { formatInr, formatRate } from '../domain/money.ts';
import { log } from '../lib/logger.ts';
import { installSignalHandlers } from '../lib/shutdown.ts';
import { DEFAULT_PARAMS, GENERATOR_VERSION, generate, type Dataset } from './generator.ts';
import type { WebhookEvent } from '../app/events.ts';

/**
 * `bun seed` — generate the dataset and load it (§12 step 4).
 *
 * Events are pushed through the **real projector**, not written to `payments`
 * directly (§8.5). A dataset built on its own notion of state validates
 * nothing: it would be perfectly possible to load 5,000 rows that the state
 * machine could never have produced, and every later phase would be measuring
 * a fiction. The outbox and relay are bypassed only because they are a
 * *delivery* mechanism — the projector is what builds state, and it is the
 * projector's rules that matter here.
 */

const BATCH = 500;

export async function seed(): Promise<Dataset> {
  await migrate();

  const merchants = await listMerchants();
  if (merchants.length === 0) {
    throw new Error('no merchants — run migrations first (bun db:migrate)');
  }

  const params = {
    ...DEFAULT_PARAMS,
    seed: config.SIM_SEED,
    payments: config.SIM_PAYMENTS,
    days: config.SIM_DAYS,
    endsAt: config.SIM_ENDS_AT,
    merchants: merchants.slice(0, config.SIM_MERCHANTS).map((m) => m.id),
  };

  const startedAt = performance.now();
  const dataset = generate(params);
  log.info('dataset generated', {
    payments: dataset.payments.length,
    checksum: dataset.checksum,
    ms: Math.round(performance.now() - startedAt),
  });

  await wipe();
  await loadCustomers(dataset);
  await loadEvents(dataset);
  await loadGroundTruth(dataset);

  // Abandoned payments have no terminal event, so they sit in ATTEMPTED until
  // the sweep flags them. Run it once at the end of the simulated window.
  const abandoned = await sweepAbandoned(new Date(Date.parse(params.endsAt)));
  log.info('abandonment sweep complete', { abandoned });

  await sql`
    INSERT INTO dataset_runs (id, seed, params, checksum, generator_version)
    VALUES (
      ${`ds_${params.seed}_${Date.now().toString(36)}`}, ${params.seed},
      ${sql.json({ ...params, merchants: [...params.merchants] })},
      ${dataset.checksum}, ${GENERATOR_VERSION}
    )
  `;

  return dataset;
}

/**
 * Removes only generated data. Merchants come from a migration and stay, so
 * re-seeding does not require re-migrating.
 */
async function wipe(): Promise<void> {
  await sql`TRUNCATE
    outcome_verifications, recovery_actions, policy_decisions, agent_decisions,
    recovery_cases, incidents, ground_truth_labels, ground_truth_incidents,
    metrics_rollup, payment_state_transitions, payment_events, processed_events,
    outbox, payments, customers, dataset_runs, simulations
    RESTART IDENTITY CASCADE`;
}

async function loadCustomers(dataset: Dataset): Promise<void> {
  for (let i = 0; i < dataset.customers.length; i += BATCH) {
    const slice = dataset.customers.slice(i, i + BATCH);
    await sql`
      INSERT INTO customers ${sql(
        slice.map((c) => ({
          id: c.id,
          merchant_id: c.merchantId,
          lifetime_value_paise: c.lifetimeValuePaise,
          opted_out: c.optedOut,
        })),
      )}
    `;
  }
  log.info('customers loaded', { count: dataset.customers.length });
}

async function loadEvents(dataset: Dataset): Promise<void> {
  // Flatten and sort by occurrence, so the projector sees the same ordering a
  // live gateway would produce and staleness is exercised the same way.
  const events = dataset.payments
    .flatMap((p) => p.events)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId));

  // The append-only log first, in bulk. `payment_events` is the source of
  // truth (invariant 1) and everything else is rebuildable from it.
  for (let i = 0; i < events.length; i += BATCH) {
    const slice = events.slice(i, i + BATCH);
    await sql`
      INSERT INTO payment_events ${sql(
        slice.map((e) => ({
          event_id: e.eventId,
          payment_id: e.paymentId,
          kind: e.kind,
          payload: JSON.stringify(e.data),
          occurred_at: e.occurredAt,
        })),
      )}
      ON CONFLICT (event_id) DO NOTHING
    `;
  }

  // Payments are independent of one another, so they project concurrently.
  // Events *within* a payment stay strictly ordered — they contend on the same
  // row lock, and reordering them would change the state machine's outcome.
  // Serial projection costs ~0.75 ms per event, which is minutes at the volumes
  // the detector's gates actually require.
  const byPayment = new Map<string, typeof events>();
  for (const e of events) {
    const list = byPayment.get(e.paymentId);
    if (list) list.push(e);
    else byPayment.set(e.paymentId, [e]);
  }

  let applied = 0;
  const startedAt = performance.now();
  const groups = [...byPayment.values()];
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= groups.length) return;
      for (const e of groups[i]!) {
        const message: WebhookEvent = {
          event_id: e.eventId,
          payment_id: e.paymentId,
          kind: e.kind,
          occurred_at: e.occurredAt,
          data: e.data,
        };
        const r = await project(message);
        if (r.outcome === 'created' || r.outcome === 'applied') applied += 1;
      }
    }
  };

  // Bounded by the pool: more workers than connections just queues them.
  const workers = Math.max(1, Math.min(config.PGPOOL_MAX - 1, 8));
  await Promise.all(Array.from({ length: workers }, worker));

  log.info('events projected', {
    events: events.length,
    applied,
    ms: Math.round(performance.now() - startedAt),
  });
}

async function loadGroundTruth(dataset: Dataset): Promise<void> {
  for (const inc of dataset.incidents) {
    await sql`
      INSERT INTO ground_truth_incidents
        (id, kind, started_at, ended_at, dimensions, affected_payments, revenue_at_risk_paise)
      VALUES (
        ${inc.id}, ${inc.kind}, ${inc.startedAt}, ${inc.endedAt},
        ${sql.json(inc.dimensions)}, ${inc.affectedPayments}, ${inc.revenueAtRiskPaise}
      )
    `;
  }

  for (let i = 0; i < dataset.labels.length; i += BATCH) {
    const slice = dataset.labels.slice(i, i + BATCH);
    await sql`
      INSERT INTO ground_truth_labels ${sql(
        slice.map((l) => ({
          payment_id: l.paymentId,
          recoverable_by_retry: l.recoverableByRetry,
          recoverable_by_link: l.recoverableByLink,
          recoverable_by_alternate: l.recoverableByAlternate,
          recoverable_by_gateway: l.recoverableByGateway,
          recoverable: l.recoverable,
          split: l.split,
        })),
      )}
    `;
  }

  log.info('ground truth loaded', {
    incidents: dataset.incidents.length,
    labels: dataset.labels.length,
    noiseWindows: dataset.noiseWindows.length,
  });
}

function report(d: Dataset): void {
  const s = d.stats;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  const lines = [
    '',
    '  ── Dataset ─────────────────────────────────────────────',
    `  seed              ${d.params.seed}   generator ${d.generatorVersion}`,
    `  checksum          ${d.checksum}`,
    `  window            ${d.params.days} days ending ${d.params.endsAt}`,
    `  payments          ${s.total.toLocaleString('en-IN')}`,
    `  captured          ${s.captured.toLocaleString('en-IN')}`,
    `  failed            ${s.failed.toLocaleString('en-IN')}`,
    `  abandoned         ${s.abandoned.toLocaleString('en-IN')}`,
    '',
    '  ── The wedge (§1.1) ────────────────────────────────────',
    `  international     ${s.international.toLocaleString('en-IN')} (${pct(s.international / s.total)} of volume)`,
    `  failure rate      international ${pct(s.internationalFailureRate)}  ·  domestic ${pct(s.domesticFailureRate)}`,
    `  gap               ${((s.internationalFailureRate - s.domesticFailureRate) * 100).toFixed(1)} points`,
    `  overall           ${pct(s.overallFailureRate)}`,
    '',
    '  ── Injected incidents (the answer key) ─────────────────',
    ...d.incidents.map(
      (i) =>
        `  ${i.kind.padEnd(24)} ${String(i.affectedPayments).padStart(4)} payments  ${formatInr(i.revenueAtRiskPaise).padStart(12)}  ${i.startedAt.slice(5, 16)}`,
    ),
    `  noise windows            ${d.noiseWindows.length} unlabelled — a detector that fires on these is wrong`,
    '',
    '  ── Counterfactual labels (§8.3) ────────────────────────',
    `  labelled          ${d.labels.length.toLocaleString('en-IN')} unsuccessful payments`,
    `  recoverable       ${d.labels.filter((l) => l.recoverable).length.toLocaleString('en-IN')} (${formatRate(d.labels.filter((l) => l.recoverable).length, d.labels.length)})`,
    `  by gateway        ${d.labels.filter((l) => l.recoverableByGateway).length.toLocaleString('en-IN')}  ← the second processor, §1.1`,
    `  split             train ${d.labels.filter((l) => l.split === 'train').length} · val ${d.labels.filter((l) => l.split === 'val').length} · test ${d.labels.filter((l) => l.split === 'test').length}`,
    '',
    '  ── Failure families ────────────────────────────────────',
    ...Object.entries(d.stats.byFamily)
      .sort((a, b) => b[1] - a[1])
      .map(([f, n]) => `  ${f.padEnd(24)} ${String(n).padStart(4)}`),
    '',
  ];

  if (d.defects.length > 0) {
    lines.push('  ── DATASET DEFECTS ─────────────────────────────────────');
    for (const def of d.defects) lines.push(`  ! ${def.kind}: ${def.detail}`);
    lines.push('');
  } else {
    lines.push('  no dataset defects', '');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

if (import.meta.main) {
  installSignalHandlers();
  try {
    const dataset = await seed();
    report(dataset);
    if (dataset.defects.length > 0) {
      log.error('dataset has defects — fix the generator before relying on this run');
      process.exitCode = 1;
    }
  } catch (err) {
    log.error('seed failed', { err });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
