import { config } from '../config.ts';
import { sql } from '../db/client.ts';
import { ingestBatch } from '../app/ingest.ts';
import { pendingOutbox } from '../app/relay.ts';
import { ABANDONMENT_IDLE_MINUTES } from '../domain/payment-state.ts';
import { sweepAbandoned } from '../app/abandonment.ts';
import { catchUp as detectionCatchUp } from '../app/detection.ts';
import { diagnosePending } from '../app/rca.ts';
import { openCases } from '../app/recovery.ts';
import { listMerchants } from '../db/queries.ts';
import { log } from '../lib/logger.ts';
import { SimClock, type ClockState } from './clock.ts';
import {
  DEFAULT_PARAMS,
  generate,
  type Dataset,
  type GeneratedEvent,
} from './generator.ts';
import type { WebhookEvent } from '../app/events.ts';

/**
 * The replay runner (§8.5).
 *
 * Walks the generated events in `occurred_at` order and pushes them through
 * **the real ingest path** — the same transactional outbox a live gateway
 * would hit. It never writes to `payments` directly: a dataset built on its own
 * notion of state validates nothing, because it could contain rows the state
 * machine could not have produced.
 *
 * The dataset is regenerated in memory from the seed rather than read back from
 * the database. The generator is deterministic, so this is the same data `bun
 * seed` produced, and it means a replay does not depend on the tables it is
 * about to refill.
 */

const TICK_MS = 250;
/**
 * Bounded so one tick at 300× cannot try to ingest a whole simulated day in a
 * single transaction. When the cap bites, the clock is held back to the last
 * event actually ingested — see `emitBatch`.
 */
const MAX_EVENTS_PER_TICK = 3000;
/** Rows per transaction inside a tick. */
const INGEST_CHUNK = 500;

export interface RunnerState {
  clock: ClockState;
  dataset: {
    seed: number;
    payments: number;
    events: number;
    checksum: string;
  } | null;
  emitted: number;
  /** Ground-truth incident windows, so the UI can shade and jump to them. */
  incidents: {
    id: string;
    kind: string;
    startedAt: string;
    endedAt: string;
    affectedPayments: number;
  }[];
  /** Deliberately unlabelled — a detector that fires on these is wrong (§8.4). */
  noiseWindows: { startedAt: string; endedAt: string }[];
}

class Runner {
  private dataset: Dataset | null = null;
  private events: GeneratedEvent[] = [];
  private cursor = 0;
  private clock: SimClock | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = true;
  private lastSweepMs = 0;
  private lastDetectionMs = 0;
  /**
   * How far the abandonment sweep has actually settled, which is the real bound
   * on what detection may judge — not a fixed offset from the clock. A tick at
   * 300× advances simulated time by 75 minutes, so the sweep runs far less
   * often than every five simulated minutes and a fixed offset lets detection
   * judge buckets whose abandoned counts have not landed.
   */
  private abandonmentSettledMs = 0;

  /** Builds the dataset and the clock. Cheap enough to call on every reset. */
  private async prepare(): Promise<void> {
    const merchants = await listMerchants();
    if (merchants.length === 0) throw new Error('no merchants — run bun db:migrate');

    const params = {
      ...DEFAULT_PARAMS,
      seed: config.SIM_SEED,
      payments: config.SIM_PAYMENTS,
      days: config.SIM_DAYS,
      endsAt: config.SIM_ENDS_AT,
      merchants: merchants.slice(0, config.SIM_MERCHANTS).map((m) => m.id),
    };

    const startedAt = performance.now();
    this.dataset = generate(params);
    this.events = this.dataset.payments
      .flatMap((p) => p.events)
      .sort(
        (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId),
      );
    this.cursor = 0;

    const windowStart = this.events[0]?.occurredAt ?? params.endsAt;
    this.clock = new SimClock(windowStart, params.endsAt, config.SIM_SPEED);
    this.lastSweepMs = Date.parse(windowStart);
    this.lastDetectionMs = Date.parse(windowStart);
    this.abandonmentSettledMs = Date.parse(windowStart);

    log.info('runner prepared', {
      payments: this.dataset.payments.length,
      events: this.events.length,
      checksum: this.dataset.checksum,
      ms: Math.round(performance.now() - startedAt),
    });
  }

  private async ensure(): Promise<void> {
    if (!this.dataset || !this.clock) await this.prepare();
  }

  /**
   * Clears everything derived from events and reloads the ground truth.
   *
   * `payments` is emptied, so the counterfactual labels that reference it go
   * too and are re-inserted as their payments reappear during the replay. The
   * labels are still decided at generation time — only the moment they are
   * written moves, which is what the foreign key requires.
   */
  async reset(): Promise<RunnerState> {
    await this.pause();
    await this.ensure();

    await sql`TRUNCATE
      outcome_verifications, recovery_actions, policy_decisions, agent_decisions,
      recovery_cases, incidents, ground_truth_labels, ground_truth_incidents,
      metrics_rollup, payment_state_transitions, payment_events, processed_events,
      outbox, payments, customers, simulations
      RESTART IDENTITY CASCADE`;

    const d = this.dataset!;
    for (let i = 0; i < d.customers.length; i += 500) {
      const slice = d.customers.slice(i, i + 500);
      await sql`
        INSERT INTO customers ${sql(
          slice.map((c) => ({
            id: c.id,
            merchant_id: c.merchantId,
            lifetime_value_paise: c.lifetimeValuePaise,
            opted_out: c.optedOut,
          })),
        )}`;
    }

    // Ground-truth incidents carry no foreign key to payments, so they load up
    // front and the UI can shade their windows before the replay reaches them.
    for (const inc of d.incidents) {
      await sql`
        INSERT INTO ground_truth_incidents
          (id, kind, started_at, ended_at, dimensions, affected_payments, revenue_at_risk_paise)
        VALUES (${inc.id}, ${inc.kind}, ${inc.startedAt}, ${inc.endedAt},
                ${sql.json(inc.dimensions)}, ${inc.affectedPayments}, ${inc.revenueAtRiskPaise})`;
    }

    this.cursor = 0;
    this.clock!.reset();
    this.lastSweepMs = Date.parse(this.clock!.state().startsAt);
    this.lastDetectionMs = this.lastSweepMs;
    this.abandonmentSettledMs = this.lastSweepMs;
    log.info('simulator reset', { customers: d.customers.length, incidents: d.incidents.length });
    return this.state();
  }

  async start(): Promise<RunnerState> {
    await this.ensure();
    // A finished run restarts from the beginning rather than doing nothing,
    // which is what pressing play twice on stage should mean.
    if (this.clock!.isFinished()) await this.reset();
    this.clock!.start();
    this.stopped = false;
    this.schedule();
    log.info('simulator started', { speed: this.clock!.speed });
    return this.state();
  }

  async pause(): Promise<RunnerState> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clock?.pause();
    // Let an in-flight tick finish so a half-ingested batch is not abandoned.
    const deadline = Date.now() + 2000;
    while (this.ticking && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.state();
  }

  async setSpeed(speed: number): Promise<RunnerState> {
    await this.ensure();
    this.clock!.setSpeed(speed);
    log.info('simulator speed changed', { speed });
    return this.state();
  }

  /**
   * Jumps the clock to just before an incident and fast-forwards the backlog,
   * so a demo can skip to the interesting minute (§8.5).
   */
  async jumpToIncident(id: string): Promise<RunnerState> {
    await this.ensure();
    const inc = this.dataset!.incidents.find((i) => i.id === id || i.kind === id);
    if (!inc) throw new Error(`unknown incident ${id}`);

    // Land a little before it opens, so the detector sees a normal baseline
    // immediately before the degradation rather than starting inside it.
    const target = new Date(Date.parse(inc.startedAt) - 30 * 60_000).toISOString();
    await this.fastForwardTo(target);
    this.clock!.jumpTo(target);
    log.info('simulator jumped to incident', { incident: inc.kind, at: target });
    return this.state();
  }

  /** Ingests everything up to `iso` without waiting for the clock. */
  private async fastForwardTo(iso: string): Promise<void> {
    const targetMs = Date.parse(iso);
    while (this.cursor < this.events.length) {
      const next = this.events[this.cursor]!;
      if (Date.parse(next.occurredAt) > targetMs) break;
      const { emitted } = await this.emitBatch(targetMs, 5000);
      if (emitted === 0) break;
      await this.sweep(targetMs);
    }
    await this.waitForDrain();
    await this.sweep(targetMs);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), TICK_MS);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const nowMs = this.clock!.nowMs();
      const { heldAt } = await this.emitBatch(nowMs, MAX_EVENTS_PER_TICK);
      // The emitter could not keep up, so the clock waits for it rather than
      // reporting progress the data has not made.
      if (heldAt) this.clock!.jumpTo(heldAt);
      await this.sweep(this.clock!.nowMs());

      // Emitting the last event is not the end of the run: the outbox may
      // still hold tens of thousands of rows, and reporting 100% while a
      // quarter of the payments have not been projected is exactly the kind of
      // confident-but-wrong number this project exists to avoid.
      if (this.cursor >= this.events.length && this.clock!.isFinished()) {
        const pending = await pendingOutbox();
        if (pending === 0) {
          await this.finalise();
          this.stopped = true;
          this.clock!.pause();
          log.info('simulator finished', { emitted: this.cursor });
          return;
        }
        log.debug('simulator draining backlog', { pending });
      }
    } catch (err) {
      log.error('simulator tick failed', { err });
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }

  /**
   * Pushes every event whose simulated moment has arrived, up to a cap.
   *
   * Returns the `occurred_at` of the last event ingested when the cap bit, so
   * the caller can hold the clock there. **Simulated time must never run ahead
   * of the data**: without this the clock reached 100% having replayed 10% of
   * the events, and the dashboard confidently showed a finished run that was
   * missing nine tenths of its payments.
   */
  private async emitBatch(nowMs: number, cap: number): Promise<{ emitted: number; heldAt: string | null }> {
    const due: WebhookEvent[] = [];
    while (this.cursor + due.length < this.events.length && due.length < cap) {
      const e = this.events[this.cursor + due.length]!;
      if (Date.parse(e.occurredAt) > nowMs) break;
      due.push({
        event_id: e.eventId,
        payment_id: e.paymentId,
        kind: e.kind,
        occurred_at: e.occurredAt,
        data: e.data,
      });
    }
    if (due.length === 0) return { emitted: 0, heldAt: null };

    // The real ingest path: every event row and its outbox row commit together.
    for (let i = 0; i < due.length; i += INGEST_CHUNK) {
      await ingestBatch(due.slice(i, i + INGEST_CHUNK));
    }
    this.cursor += due.length;

    const hitCap = due.length === cap;
    const next = this.events[this.cursor];
    const stillDue = next !== undefined && Date.parse(next.occurredAt) <= nowMs;
    return {
      emitted: due.length,
      heldAt: hitCap && stillDue ? due[due.length - 1]!.occurred_at : null,
    };
  }

  /**
   * The runner does **not** drain the outbox.
   *
   * The background relay is the single drainer, and that is load-bearing: two
   * concurrent `drainOnce` calls claim disjoint row sets via `SKIP LOCKED`, so
   * a payment's `created` and `captured` can end up in different drains running
   * at the same time. The projector's marker is written even when a transition
   * is refused, so an event delivered too early is refused *permanently* and
   * the payment is stranded — 573 payments sat in `AUTHORIZED` forever with
   * nothing in the dead-letter queue to show for it.
   *
   * One drainer, partitioned into per-payment lanes, is what keeps delivery
   * ordered within a payment while staying parallel across payments.
   */
  private async sweep(nowMs: number): Promise<void> {
    // Abandonment first, detection second: detection is bounded by how far the
    // abandonment sweep has settled, so sweeping after would always leave
    // detection one interval behind for no reason.
    await this.sweepAbandonment(nowMs);
    await this.runDetection(nowMs);
  }

  private async runDetection(nowMs: number): Promise<void> {
    // Detection runs every 5 simulated minutes (§9) — the rollup bucket size,
    // so each sweep sees exactly one new bucket. It is driven by how far the
    // *data* has got, not by the clock: the relay trails the clock by whatever
    // the outbox depth happens to be, and sweeping ahead of the data evaluates
    // empty windows and then never revisits them.
    if (nowMs - this.lastDetectionMs >= 5 * 60_000) {
      try {
        // Only judge buckets the abandonment sweep has already settled.
        const { sweptTo, result } = await detectionCatchUp(new Date(this.lastDetectionMs), {
          until: new Date(this.abandonmentSettledMs),
        });
        this.lastDetectionMs = sweptTo.getTime();
        // Diagnose immediately: RCA reads the incident's own window, and the
        // sooner it runs the fewer rows it has to sift.
        if (result.opened.length > 0) await diagnosePending();
        // Cases follow detection: a failure inside a live incident is scored
        // with `incidentActive` set, which lifts its retry odds (§7.5).
        await openCases(new Date(this.abandonmentSettledMs));
      } catch (err) {
        // Detection failing must not stop the replay: the pipeline is the
        // thing under test, and a stalled clock hides that it still works.
        log.error('detection sweep failed', { err });
      }
    }

  }

  private async sweepAbandonment(nowMs: number): Promise<void> {
    // Abandonment is decided in simulated minutes, so the sweep runs on
    // simulated time. It runs at the bucket cadence rather than every 30
    // simulated minutes: at the coarser interval the flags land in bursts, and
    // a bucket's abandoned count arrives long after the detector judged it.
    if (nowMs - this.lastSweepMs >= 5 * 60_000) {
      this.lastSweepMs = nowMs;
      await sweepAbandoned(new Date(nowMs));
      // Everything older than the idle window now carries its final verdict.
      this.abandonmentSettledMs = nowMs - ABANDONMENT_IDLE_MINUTES * 60_000;
      await this.insertPendingLabels();
    }
  }

  /**
   * Writes counterfactual labels for payments that now exist.
   *
   * The labels were decided at generation time (§8.3); only the write is
   * deferred, because `ground_truth_labels.payment_id` references `payments`
   * and a payment does not exist until its `payment.created` event has been
   * projected.
   */
  private async insertPendingLabels(): Promise<void> {
    const d = this.dataset;
    if (!d) return;
    const rows = d.labels.map((l) => ({
      payment_id: l.paymentId,
      recoverable_by_retry: l.recoverableByRetry,
      recoverable_by_link: l.recoverableByLink,
      recoverable_by_alternate: l.recoverableByAlternate,
      recoverable_by_gateway: l.recoverableByGateway,
      recoverable: l.recoverable,
      split: l.split,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const slice = rows[i] ? rows.slice(i, i + 500) : [];
      if (slice.length === 0) continue;
      await sql`
        INSERT INTO ground_truth_labels ${sql(slice)}
        ON CONFLICT (payment_id) DO NOTHING`.catch(() => {
        // Payments this batch's labels point at have not all been projected
        // yet. The next sweep picks them up; the labels are not lost.
      });
    }
  }

  /**
   * Runs the sweeps one last time, after the outbox is empty.
   *
   * The periodic sweeps are gated on **simulated** time having advanced, and
   * while the runner drains its final backlog the clock is already parked at
   * the end of the window — so that condition fires exactly once and every
   * payment projected afterwards is never swept. That left most genuinely
   * abandoned payments unflagged (237 of 1,312), which in turn hid the
   * abandonment spike from the detector entirely.
   */
  private async finalise(): Promise<void> {
    const endMs = Date.parse(this.clock!.state().endsAt);
    const abandoned = await sweepAbandoned(new Date(endMs));
    this.abandonmentSettledMs = endMs;
    await this.insertPendingLabels();
    // Detection is held behind the abandonment verdict, so it runs last and is
    // allowed as many buckets as it needs to reach the end.
    const { result } = await detectionCatchUp(new Date(this.lastDetectionMs), {
      until: new Date(endMs),
      maxBuckets: 4000,
    });
    this.lastDetectionMs = endMs;
    await diagnosePending(500);
    // Keep opening until the worklist is empty: the last simulated minutes
    // produce failures too, and a case that never opens is revenue never priced.
    for (let i = 0; i < 200; i += 1) {
      const r = await openCases(new Date(endMs), 500);
      if (r.opened === 0 && r.considered === 0) break;
    }
    log.info('simulator finalised', {
      abandoned,
      incidentsOpened: result.opened.length,
      incidentsResolved: result.resolved.length,
    });
  }

  /** Lets the single relay catch up, e.g. after a jump fast-forwards a backlog. */
  private async waitForDrain(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await pendingOutbox()) === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    log.warn('waited for the relay to drain and it did not');
  }

  state(): RunnerState {
    return {
      clock: this.clock?.state() ?? {
        now: config.SIM_ENDS_AT,
        running: false,
        speed: config.SIM_SPEED,
        startsAt: config.SIM_ENDS_AT,
        endsAt: config.SIM_ENDS_AT,
        progress: 0,
        etaSeconds: null,
      },
      dataset: this.dataset
        ? {
            seed: this.dataset.params.seed,
            payments: this.dataset.payments.length,
            events: this.events.length,
            checksum: this.dataset.checksum,
          }
        : null,
      emitted: this.cursor,
      incidents: (this.dataset?.incidents ?? []).map((i) => ({
        id: i.id,
        kind: i.kind,
        startedAt: i.startedAt,
        endedAt: i.endedAt,
        affectedPayments: i.affectedPayments,
      })),
      noiseWindows: this.dataset?.noiseWindows ?? [],
    };
  }

  async shutdown(): Promise<void> {
    await this.pause();
  }
}

export const runner = new Runner();
