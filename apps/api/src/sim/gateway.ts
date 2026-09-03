import { createHash } from 'node:crypto';
import { ingestBatch } from '../app/ingest.ts';
import type { WebhookEvent } from '../app/events.ts';
import { gatewayInstrument, groundTruthLabel, type GroundTruthLabelRow } from '../db/queries.ts';
import {
  counterfactualFor,
  drawFault,
  routeAccepts,
  routeFor,
  settleDelayMinutes,
  type Route,
} from '../domain/execution.ts';
import type { ActionKind } from '../domain/policy.ts';
import { AppError } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';
import { Rng } from '../lib/rng.ts';

/**
 * The simulated gateway (§8.6).
 *
 * Stands in for the processor the executor would call in production. It is
 * honest where it matters: it answers from the ground-truth counterfactual
 * decided at generation time (§8.3) — never from a fresh coin toss, which
 * would make recovery an assertion — and its verdict reaches the system
 * through the **real webhook path**, the same transactional outbox a live
 * gateway would hit. It writes nothing to `payments` itself.
 *
 * It also misbehaves on purpose, so the reliability code is exercised rather
 * than merely written: 5% RETRYABLE, 2% timeouts with an unknown outcome, 1%
 * TERMINAL. Every draw is seeded from the idempotency key, so a replay of the
 * same dataset produces the same faults on the same actions.
 */

export interface GatewayResult {
  reference: string;
  route: Route;
  /** What the counterfactual said. The events carrying it are already in flight. */
  recovered: boolean;
  /** Simulated time the gateway will report the outcome. */
  settlesAt: string;
  /** Simulated time the new attempt was registered. */
  attemptedAt: string;
}

export class GatewayError extends AppError {
  constructor(code: string, message: string, errorClass: 'RETRYABLE' | 'TERMINAL', detail?: Record<string, unknown>) {
    super(code, message, { status: 502, errorClass, ...(detail ? { detail } : {}) });
    this.name = 'GatewayError';
  }
}

/**
 * The call did not come back. The gateway may or may not have acted, and the
 * caller must not guess: `outcomeUnknown` is the signal to reconcile by
 * reference before doing anything else.
 */
export class GatewayTimeout extends AppError {
  readonly outcomeUnknown = true as const;
  constructor(idempotencyKey: string) {
    super('GATEWAY_TIMEOUT', 'gateway did not answer in time', {
      status: 504,
      errorClass: 'RETRYABLE',
      detail: { idempotencyKey },
    });
    this.name = 'GatewayTimeout';
  }
}

export interface GatewayStats {
  calls: number;
  effects: number;
  deduplicated: number;
  faults: { retryable: number; timeout: number; terminal: number };
  refusedByRoute: number;
  /** Actions on a payment with no counterfactual on record — a dataset defect, counted rather than hidden. */
  unlabelled: number;
}

/** A uint32 seed from any string, so every draw is a pure function of its key. */
const seedOf = (s: string) => createHash('sha256').update(s).digest().readUInt32BE(0);

export class SimulatedGateway {
  /**
   * What the gateway remembers about each idempotency key. This is the
   * *external* system's memory: the same key returns the first result and
   * never acts twice, whatever the caller does (§8.6).
   */
  private readonly memory = new Map<string, GatewayResult>();
  private readonly attemptsByKey = new Map<string, number>();
  /**
   * The answer key, held by the simulator that owns it. The runner hands the
   * dataset's labels over at load, so the gateway can answer for a payment
   * the moment it exists — the `ground_truth_labels` row is written later,
   * once the foreign key allows, and is the fallback for a seeded database.
   */
  private readonly labels = new Map<string, GroundTruthLabelRow>();
  private readonly stats: GatewayStats = {
    calls: 0,
    effects: 0,
    deduplicated: 0,
    faults: { retryable: 0, timeout: 0, terminal: 0 },
    refusedByRoute: 0,
    unlabelled: 0,
  };

  rememberLabels(rows: Iterable<{ paymentId: string } & Omit<GroundTruthLabelRow, never>>): void {
    for (const l of rows) {
      this.labels.set(l.paymentId, {
        recoverable_by_retry: l.recoverable_by_retry,
        recoverable_by_link: l.recoverable_by_link,
        recoverable_by_alternate: l.recoverable_by_alternate,
        recoverable_by_gateway: l.recoverable_by_gateway,
        recoverable: l.recoverable,
      });
    }
  }

  async executeAction(kind: ActionKind, paymentId: string, idempotencyKey: string, now: Date): Promise<GatewayResult> {
    this.stats.calls += 1;

    // Idempotency first, before any fault can fire: a key the gateway has
    // already honoured is answered from memory, exactly as a real one would.
    const remembered = this.memory.get(idempotencyKey);
    if (remembered) {
      this.stats.deduplicated += 1;
      return remembered;
    }

    const attempt = (this.attemptsByKey.get(idempotencyKey) ?? 0) + 1;
    this.attemptsByKey.set(idempotencyKey, attempt);
    const rng = new Rng(seedOf(`${idempotencyKey}#${attempt}`));

    switch (drawFault(rng.next())) {
      case 'retryable': {
        this.stats.faults.retryable += 1;
        const status = rng.bool(0.5) ? 429 : 503;
        throw new GatewayError('GATEWAY_UNAVAILABLE', `gateway answered ${status}`, 'RETRYABLE', { status, attempt });
      }
      case 'terminal':
        this.stats.faults.terminal += 1;
        throw new GatewayError('GATEWAY_REJECTED', 'gateway rejected the request', 'TERMINAL', { attempt });
      case 'timeout': {
        this.stats.faults.timeout += 1;
        // Half the time the request got through before the connection dropped.
        // The caller cannot tell which half — that is what `lookup` is for.
        if (rng.bool(0.5)) await this.effect(kind, paymentId, idempotencyKey, now, rng);
        throw new GatewayTimeout(idempotencyKey);
      }
      case 'none':
        return this.effect(kind, paymentId, idempotencyKey, now, rng);
    }
  }

  /** Reconciliation by reference: what, if anything, did this key do? */
  async lookup(idempotencyKey: string): Promise<GatewayResult | null> {
    return this.memory.get(idempotencyKey) ?? null;
  }

  private async effect(kind: ActionKind, paymentId: string, key: string, now: Date, rng: Rng): Promise<GatewayResult> {
    const route = routeFor(kind);
    const instrument = await gatewayInstrument(paymentId);
    if (!instrument) {
      throw new GatewayError('PAYMENT_UNKNOWN', 'no such payment at the gateway', 'TERMINAL', { paymentId });
    }
    if (!routeAccepts(route, { method: instrument.method, cardNetwork: instrument.card_network })) {
      this.stats.refusedByRoute += 1;
      throw new GatewayError('ROUTE_UNSUPPORTED', `${route} route does not support this instrument`, 'TERMINAL', {
        route,
        method: instrument.method,
      });
    }

    const column = counterfactualFor(kind);
    const label = column ? (this.labels.get(paymentId) ?? (await groundTruthLabel(paymentId))) : null;
    if (column && !label) {
      // No counterfactual was ever decided for this payment. The answer is
      // "did not recover" — never a fresh coin toss — but it is a dataset
      // defect, so it is counted and said out loud rather than passed off as
      // a measurement.
      this.stats.unlabelled += 1;
      log.warn('gateway has no counterfactual for this payment', { paymentId, kind });
    }
    const recovered = column !== null && label !== null && label[column];

    const reference = `gw_${route === 'secondary' ? 's' : 'p'}_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
    const attemptedAt = new Date(now.getTime() + 30_000).toISOString();
    const settlesAt = new Date(now.getTime() + settleDelayMinutes(kind, rng.next()) * 60_000).toISOString();

    const attempted: WebhookEvent = {
      event_id: `evt_${key}_a`,
      payment_id: paymentId,
      kind: 'payment.attempted',
      occurred_at: attemptedAt,
      data: { gateway: route, gateway_reference: reference, recovery_action: key },
    };
    const verdict: WebhookEvent = recovered
      ? {
          event_id: `evt_${key}_c`,
          payment_id: paymentId,
          kind: 'payment.captured',
          occurred_at: settlesAt,
          data: { gateway: route, gateway_reference: reference, recovery_action: key },
        }
      : {
          event_id: `evt_${key}_f`,
          payment_id: paymentId,
          kind: 'payment.failed',
          occurred_at: settlesAt,
          data: {
            gateway: route,
            gateway_reference: reference,
            recovery_action: key,
            failure_code: instrument.failure_code ?? 'DO_NOT_HONOR',
          },
        };

    // Through the real ingest path: both events and their outbox rows commit
    // together, and the projector moves the payment the way it would for any
    // other gateway.
    await ingestBatch([attempted, verdict]);

    const result: GatewayResult = { reference, route, recovered, settlesAt, attemptedAt };
    this.memory.set(key, result);
    this.stats.effects += 1;
    log.debug('gateway effect', { key, kind, route, recovered, paymentId });
    return result;
  }

  snapshot(): GatewayStats {
    return { ...this.stats, faults: { ...this.stats.faults } };
  }

  /** A dataset reset forgets every key: the keys are derived from ids that no longer exist. */
  reset(): void {
    this.memory.clear();
    this.attemptsByKey.clear();
    this.stats.calls = 0;
    this.stats.effects = 0;
    this.stats.deduplicated = 0;
    this.stats.faults = { retryable: 0, timeout: 0, terminal: 0 };
    this.stats.refusedByRoute = 0;
    this.stats.unlabelled = 0;
  }
}

export const gateway = new SimulatedGateway();
