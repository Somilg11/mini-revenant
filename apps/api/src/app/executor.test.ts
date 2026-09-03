import { describe, expect, test } from 'bun:test';
import { createExecutor, type ActionStore, type GatewayPort } from './executor.ts';
import { approve, evaluatePolicy, type PolicyInput } from '../domain/policy.ts';
import type { ActionRow } from '../db/queries.ts';
import type { GatewayResult } from '../sim/gateway.ts';

/**
 * The executor's control flow against fakes — no database, no clock, no
 * network. The Postgres side of the same guarantees (the UNIQUE reservation)
 * is covered by `test/executor.integration.test.ts`.
 */

const input: PolicyInput = {
  now: '2026-07-28T14:30:00.000Z',
  merchant: { id: 'mch_a', isPaused: false, dailyActionBudgetPaise: 5_000_000, dailyActionBudgetCount: 200 },
  merchantToday: { actionCount: 0, actionSpendPaise: 0 },
  merchantHour: { exposurePaise: 0 },
  customer: { optedOut: false },
  payment: { id: 'pay_1', state: 'FAILED', amountPaise: 480_000, attemptIndex: 1, failureFamily: 'CROSS_BORDER' },
  lastActionAt: null,
  proposal: { caseId: 'case_1', strategy: 'alternate_gateway', actionKind: 'route_alternate_gateway', expectedValuePaise: 250_000, costPaise: 900 },
  openIncidentOnSlice: false,
};
const approved = approve(input, evaluatePolicy(input))!;
const NOW = new Date('2026-07-28T14:30:00.000Z');

class RetryableError extends Error {
  errorClass = 'RETRYABLE';
}
class TerminalError extends Error {
  errorClass = 'TERMINAL';
}
class Timeout extends Error {
  outcomeUnknown = true as const;
  errorClass = 'RETRYABLE';
}

/** A gateway whose behaviour per attempt is scripted, counting real effects. */
function fakeGateway(script: (attempt: number) => 'ok' | 'retryable' | 'terminal' | 'timeout-acted' | 'timeout-lost' | 'boom') {
  const memory = new Map<string, GatewayResult>();
  let attempts = 0;
  let effects = 0;
  const result = (key: string): GatewayResult => ({ reference: `ref_${key}`, route: 'secondary', recovered: true, settlesAt: NOW.toISOString(), attemptedAt: NOW.toISOString() });
  const gateway: GatewayPort = {
    async executeAction(_kind, _paymentId, key) {
      const remembered = memory.get(key);
      if (remembered) return remembered;
      attempts += 1;
      switch (script(attempts)) {
        case 'ok': {
          effects += 1;
          const r = result(key);
          memory.set(key, r);
          return r;
        }
        case 'retryable':
          throw new RetryableError('503');
        case 'terminal':
          throw new TerminalError('rejected');
        case 'timeout-acted': {
          effects += 1;
          memory.set(key, result(key));
          throw new Timeout('timeout');
        }
        case 'timeout-lost':
          throw new Timeout('timeout');
        case 'boom':
          throw new Error('something nobody classified');
      }
    },
    async lookup(key) {
      return memory.get(key) ?? null;
    },
  };
  return { gateway, get attempts() { return attempts; }, get effects() { return effects; } };
}

/** An in-memory action table with the UNIQUE(idempotency_key) behaviour. */
function fakeStore() {
  const rows = new Map<string, ActionRow>();
  const sleeps: number[] = [];
  const store: ActionStore = {
    async reserve(a) {
      const existing = [...rows.values()].find((r) => r.idempotency_key === a.idempotencyKey);
      if (existing) return { row: existing, fresh: false };
      const row: ActionRow = {
        id: a.id, case_id: a.caseId, policy_decision_id: a.decisionId, kind: a.kind, idempotency_key: a.idempotencyKey,
        status: 'RESERVED', attempts: 0, cost_paise: a.costPaise, gateway_reference: null, error_class: null,
        created_at: a.now, completed_at: null,
      };
      rows.set(row.id, row);
      return { row, fresh: true };
    },
    async markSent(id, attempts) {
      const r = rows.get(id)!;
      r.status = 'SENT';
      r.attempts = attempts;
    },
    async complete(id, o) {
      const r = rows.get(id)!;
      Object.assign(r, { status: o.status, attempts: o.attempts, gateway_reference: o.gatewayReference, error_class: o.errorClass, completed_at: o.completedAt });
      return r;
    },
  };
  return { store, rows, sleeps };
}

function build(script: Parameters<typeof fakeGateway>[0]) {
  const g = fakeGateway(script);
  const s = fakeStore();
  const executor = createExecutor({
    gateway: g.gateway,
    store: s.store,
    sleep: async (ms) => { s.sleeps.push(ms); },
    jitter: () => 0.5,
  });
  return { executor, g, s };
}

describe('the happy path', () => {
  test('reserves, sends once, succeeds with the reference', async () => {
    const { executor, g, s } = build(() => 'ok');
    const r = await executor.execute(approved, 'pd_1', NOW);
    expect(r.action.status).toBe('SUCCEEDED');
    expect(r.action.attempts).toBe(1);
    expect(r.action.idempotency_key).toBe('ik_pd_1');
    expect(r.action.gateway_reference).toBe('ref_ik_pd_1');
    expect(r.action.created_at).toBe(NOW.toISOString());
    expect(g.effects).toBe(1);
    expect(s.sleeps).toEqual([]);
  });
});

describe('idempotency', () => {
  test('the same decision executed twice reserves once and produces one gateway effect', async () => {
    const { executor, g, s } = build(() => 'ok');
    const first = await executor.execute(approved, 'pd_1', NOW);
    const second = await executor.execute(approved, 'pd_1', NOW);
    expect(second.replayed).toBe(true);
    expect(second.action.id).toBe(first.action.id);
    expect(g.attempts).toBe(1);
    expect(g.effects).toBe(1);
    expect(s.rows.size).toBe(1);
  });

  test('a different decision is a different key', async () => {
    const { executor, g } = build(() => 'ok');
    await executor.execute(approved, 'pd_1', NOW);
    await executor.execute(approved, 'pd_2', NOW);
    expect(g.effects).toBe(2);
  });
});

describe('RETRYABLE — capped backoff with jitter, twice, then escalate', () => {
  test('a 503 that clears on the second try succeeds with attempts = 2', async () => {
    const { executor, s } = build((n) => (n === 1 ? 'retryable' : 'ok'));
    const r = await executor.execute(approved, 'pd_1', NOW);
    expect(r.action.status).toBe('SUCCEEDED');
    expect(r.action.attempts).toBe(2);
    expect(s.sleeps).toEqual([150]);
  });

  test('three 503s escalate rather than loop; the backoff grows and never exceeds the cap', async () => {
    const { executor, g, s } = build(() => 'retryable');
    const r = await executor.execute(approved, 'pd_1', NOW);
    expect(r.action.status).toBe('ESCALATED');
    expect(r.action.error_class).toBe('RETRYABLE');
    expect(r.action.attempts).toBe(3);
    expect(g.attempts).toBe(3);
    expect(g.effects).toBe(0);
    expect(s.sleeps).toEqual([150, 300]);
  });
});

describe('TERMINAL and unclassified', () => {
  test('a terminal rejection fails at once, no retry', async () => {
    const { executor, g, s } = build(() => 'terminal');
    const r = await executor.execute(approved, 'pd_1', NOW);
    expect(r.action.status).toBe('FAILED');
    expect(r.action.error_class).toBe('TERMINAL');
    expect(g.attempts).toBe(1);
    expect(s.sleeps).toEqual([]);
  });

  test('an error nobody classified goes to a person, never to a retry', async () => {
    const { executor, g } = build(() => 'boom');
    const r = await executor.execute(approved, 'pd_1', NOW);
    expect(r.action.status).toBe('ESCALATED');
    expect(r.action.error_class).toBe('NEEDS_HUMAN');
    expect(g.attempts).toBe(1);
  });

  test('escalate has no gateway leg', async () => {
    const { executor, g } = build(() => 'ok');
    const escalate = { ...approved, kind: 'escalate' as const };
    const r = await executor.execute(escalate, 'pd_1', NOW);
    expect(r.action.status).toBe('ESCALATED');
    expect(g.attempts).toBe(0);
  });
});

describe('timeouts with an unknown outcome are never blind-retried', () => {
  test('the gateway acted before the connection dropped: reconciled by reference, one effect, no second send', async () => {
    const { executor, g, s } = build(() => 'timeout-acted');
    const r = await executor.execute(approved, 'pd_1', NOW);
    expect(r.reconciled).toBe(true);
    expect(r.action.status).toBe('SUCCEEDED');
    expect(r.action.gateway_reference).toBe('ref_ik_pd_1');
    expect(r.action.attempts).toBe(1);
    expect(g.attempts).toBe(1);
    expect(g.effects).toBe(1);
    expect(s.sleeps).toEqual([]);
  });

  test('the gateway never received it: only then is a retry sent, and it is bounded', async () => {
    const { executor, g } = build((n) => (n < 3 ? 'timeout-lost' : 'ok'));
    const r = await executor.execute(approved, 'pd_1', NOW);
    expect(r.action.status).toBe('SUCCEEDED');
    expect(r.action.attempts).toBe(3);
    expect(g.effects).toBe(1);
  });

  test('lost every time: escalates after the retry budget, no effect ever produced', async () => {
    const { executor, g } = build(() => 'timeout-lost');
    const r = await executor.execute(approved, 'pd_1', NOW);
    expect(r.action.status).toBe('ESCALATED');
    expect(g.attempts).toBe(3);
    expect(g.effects).toBe(0);
  });
});
