import { randomUUID } from 'node:crypto';
import { sql } from '../db/client.ts';
import { notify } from '../db/notify.ts';
import {
  completeAction,
  markActionSent,
  reserveAction,
  type ActionRow,
} from '../db/queries.ts';
import { backoffMs, classify, nextStep, type ErrorClass } from '../domain/execution.ts';
import type { ActionKind, PolicyApprovedAction } from '../domain/policy.ts';
import { log } from '../lib/logger.ts';
import { gateway as simulatedGateway, type GatewayResult } from '../sim/gateway.ts';

/**
 * The executor (§7.7, §8.6, §9).
 *
 * `execute` accepts only a `PolicyApprovedAction`. The type is branded with a
 * symbol that is not exported, and the only function that produces one
 * returns `null` for anything but an ALLOW — so calling this with an
 * unapproved action is a compile error, not a review comment.
 *
 * Order of operations is the whole design:
 *   1. reserve the idempotency key in the database — UNIQUE, before any call;
 *   2. call the gateway; on RETRYABLE back off and retry, twice, then
 *      escalate rather than loop; on TERMINAL fail; on anything unclassified
 *      ask a person;
 *   3. a timeout is an *unknown* outcome and is never blind-retried: the
 *      gateway is asked what it did with our reference first.
 */

export interface GatewayPort {
  executeAction(kind: ActionKind, paymentId: string, idempotencyKey: string, now: Date): Promise<GatewayResult>;
  lookup(idempotencyKey: string): Promise<GatewayResult | null>;
}

export interface ActionStore {
  reserve: typeof reserveAction;
  markSent: typeof markActionSent;
  complete: typeof completeAction;
  announce?: (row: ActionRow, paymentId: string) => Promise<void>;
}

export interface ExecutorDeps {
  gateway: GatewayPort;
  store: ActionStore;
  sleep: (ms: number) => Promise<void>;
  /** A uniform draw in [0, 1) for backoff jitter. */
  jitter: () => number;
}

export interface ExecutionResult {
  action: ActionRow;
  /** True when the key was already reserved and nothing new was sent. */
  replayed: boolean;
  /** True when a timeout was resolved by asking the gateway for our reference. */
  reconciled: boolean;
  gateway: GatewayResult | null;
}

const isOutcomeUnknown = (err: unknown): boolean =>
  err !== null && typeof err === 'object' && (err as { outcomeUnknown?: unknown }).outcomeUnknown === true;

export function createExecutor(deps: ExecutorDeps) {
  async function execute(action: PolicyApprovedAction, decisionId: string, now: Date): Promise<ExecutionResult> {
    // One key per decision: the same approval can never be sent twice, and a
    // fresh decision (a re-approval, a later case) gets a fresh key.
    const idempotencyKey = `ik_${decisionId}`;
    const { row, fresh } = await deps.store.reserve({
      id: `act_${randomUUID().slice(0, 12)}`,
      caseId: action.caseId,
      decisionId,
      kind: action.kind,
      idempotencyKey,
      costPaise: action.costPaise,
      now: now.toISOString(),
    });

    if (!fresh) {
      log.info('action replayed, nothing sent', { actionId: row.id, key: idempotencyKey, status: row.status });
      return { action: row, replayed: true, reconciled: false, gateway: null };
    }

    const finish = async (
      status: 'SUCCEEDED' | 'FAILED' | 'ESCALATED',
      attempts: number,
      result: GatewayResult | null,
      errorClass: ErrorClass | null,
      reconciled = false,
    ): Promise<ExecutionResult> => {
      const done = await deps.store.complete(row.id, {
        status,
        attempts,
        gatewayReference: result?.reference ?? null,
        errorClass,
        completedAt: now.toISOString(),
      });
      await deps.store.announce?.(done, action.paymentId);
      return { action: done, replayed: false, reconciled, gateway: result };
    };

    // `escalate` is the one kind with no gateway leg: it exists to put a
    // person in the loop, and that is all it does.
    if (action.kind === 'escalate') return finish('ESCALATED', 0, null, 'NEEDS_HUMAN');

    let attempt = 0;
    for (;;) {
      attempt += 1;
      await deps.store.markSent(row.id, attempt);
      try {
        const result = await deps.gateway.executeAction(action.kind, action.paymentId, idempotencyKey, now);
        return finish('SUCCEEDED', attempt, result, null);
      } catch (err) {
        let cls: ErrorClass;
        if (isOutcomeUnknown(err)) {
          // Never blind-retry a timeout. Ask the gateway what it did with our
          // reference; only a confirmed "nothing" makes a retry safe.
          const found = await deps.gateway.lookup(idempotencyKey);
          if (found) {
            log.info('timeout reconciled by reference', { actionId: row.id, key: idempotencyKey, reference: found.reference });
            return finish('SUCCEEDED', attempt, found, null, true);
          }
          log.info('timeout reconciled: gateway has no record, retry is safe', { actionId: row.id, key: idempotencyKey });
          cls = 'RETRYABLE';
        } else {
          cls = classify(err);
        }

        const step = nextStep(cls, attempt);
        if (step === 'retry') {
          const wait = backoffMs(attempt, deps.jitter());
          log.warn('gateway call failed, retrying', { actionId: row.id, attempt, errorClass: cls, backoffMs: wait });
          await deps.sleep(wait);
          continue;
        }
        if (step === 'fail') {
          log.warn('gateway call failed terminally', { actionId: row.id, attempt, err });
          return finish('FAILED', attempt, null, 'TERMINAL');
        }
        log.warn('gateway call escalated to a human', { actionId: row.id, attempt, errorClass: cls, err });
        return finish('ESCALATED', attempt, null, cls);
      }
    }
  }

  return { execute };
}

const announce = async (row: ActionRow, paymentId: string): Promise<void> => {
  await sql.begin(async (tx) => {
    await notify(tx, 'action.executed', {
      action_id: row.id,
      case_id: row.case_id,
      payment_id: paymentId,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      gateway_reference: row.gateway_reference,
      error_class: row.error_class,
      idempotency_key: row.idempotency_key,
    });
  });
};

/** The real thing: Postgres for the reservation, the simulated gateway for the call. */
export const executor = createExecutor({
  gateway: simulatedGateway,
  store: { reserve: reserveAction, markSent: markActionSent, complete: completeAction, announce },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  jitter: Math.random,
});
