import { describe, expect, test } from 'bun:test';
import {
  APPROVAL_THRESHOLD_PAISE,
  BLAST_RADIUS_PAISE_PER_HOUR,
  POLICY_VERSION,
  RULES,
  actionKindFor,
  approve,
  canonicalise,
  evaluatePolicy,
  hashInput,
  isDeferrable,
  type PolicyApprovedAction,
  type PolicyInput,
} from './policy.ts';

const base: PolicyInput = {
  now: '2026-07-28T14:30:00.000Z',
  merchant: { id: 'mch_a', isPaused: false, dailyActionBudgetPaise: 5_000_000, dailyActionBudgetCount: 200 },
  merchantToday: { actionCount: 12, actionSpendPaise: 40_000 },
  merchantHour: { exposurePaise: 1_000_000 },
  customer: { optedOut: false },
  payment: { id: 'pay_1', state: 'FAILED', amountPaise: 480_000, attemptIndex: 1, failureFamily: 'CROSS_BORDER' },
  lastActionAt: null,
  proposal: { caseId: 'case_1', strategy: 'alternate_gateway', actionKind: 'route_alternate_gateway', expectedValuePaise: 250_000, costPaise: 900 },
  openIncidentOnSlice: false,
};

type Override = Omit<Partial<PolicyInput>, 'payment' | 'proposal'> & {
  payment?: Partial<PolicyInput['payment']>;
  proposal?: Partial<PolicyInput['proposal']>;
};

const withInput = (over: Override): PolicyInput => ({
  ...base,
  ...over,
  payment: { ...base.payment, ...(over.payment ?? {}) },
  proposal: { ...base.proposal, ...(over.proposal ?? {}) },
});

const rule = (d: ReturnType<typeof evaluatePolicy>, n: number) => d.reasons.find((r) => r.rule === n)!;

describe('a clean proposal is allowed', () => {
  const d = evaluatePolicy(base);
  test('ALLOW, with all twelve rules evaluated and passing', () => {
    expect(d.verdict).toBe('ALLOW');
    expect(d.reasons).toHaveLength(12);
    expect(d.reasons.every((r) => r.passed)).toBe(true);
    expect(d.policyVersion).toBe(POLICY_VERSION);
    expect(d.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('every rule refuses on its own, and all twelve are still evaluated', () => {
  const cases: [number, string, Override, 'DENY' | 'REQUIRE_APPROVAL'][] = [
    [1, 'kill switch', { merchant: { ...base.merchant, isPaused: true } }, 'DENY'],
    [2, 'terminal payment — the double-charge guard', { payment: { state: 'CAPTURED' } }, 'DENY'],
    [3, 'opted out', { customer: { optedOut: true } }, 'DENY'],
    [4, 'terminal family', { payment: { failureFamily: 'TERMINAL' } }, 'DENY'],
    [5, 'attempt limit', { payment: { attemptIndex: 4 } }, 'DENY'],
    [6, 'cooldown', { lastActionAt: '2026-07-28T14:15:00.000Z' }, 'DENY'],
    [7, 'daily count', { merchantToday: { actionCount: 200, actionSpendPaise: 0 } }, 'DENY'],
    [8, 'daily spend', { merchantToday: { actionCount: 0, actionSpendPaise: 4_999_500 } }, 'DENY'],
    [9, 'blast radius', { merchantHour: { exposurePaise: BLAST_RADIUS_PAISE_PER_HOUR - 100 } }, 'DENY'],
    [10, 'negative EV', { proposal: { expectedValuePaise: -50 } }, 'DENY'],
    [11, 'large amount', { payment: { amountPaise: APPROVAL_THRESHOLD_PAISE + 1 } }, 'REQUIRE_APPROVAL'],
    [12, 'retry into a live incident', { proposal: { strategy: 'retry', actionKind: 'retry_payment' }, openIncidentOnSlice: true }, 'REQUIRE_APPROVAL'],
  ];

  for (const [n, label, over, verdict] of cases) {
    test(`rule ${n} — ${label} → ${verdict}`, () => {
      const d = evaluatePolicy(withInput(over));
      expect(d.verdict).toBe(verdict);
      expect(rule(d, n).passed).toBe(false);
      expect(rule(d, n).verdict).toBe(verdict);
      // Never short-circuit: the other eleven are still there with their detail.
      expect(d.reasons).toHaveLength(12);
      expect(d.reasons.filter((r) => r.passed)).toHaveLength(11);
      for (const r of d.reasons) expect(r.detail.length).toBeGreaterThan(0);
    });
  }
});

describe('precedence', () => {
  test('any DENY wins over any REQUIRE_APPROVAL', () => {
    // The worked refusal from §7.7: a ₹50,000 payment on its 5th attempt.
    const d = evaluatePolicy(withInput({ payment: { amountPaise: 5_000_000, attemptIndex: 5 }, proposal: { strategy: 'retry', actionKind: 'retry_payment' } }));
    expect(d.verdict).toBe('DENY');
    expect(rule(d, 5).passed).toBe(false);
    expect(rule(d, 11).passed).toBe(false);
    expect(d.reasons.filter((r) => !r.passed)).toHaveLength(2);
  });

  test('REQUIRE_APPROVAL wins over ALLOW', () => {
    expect(evaluatePolicy(withInput({ payment: { amountPaise: 4_000_000 } })).verdict).toBe('REQUIRE_APPROVAL');
  });

  test('boundary: exactly the threshold is auto-approved', () => {
    expect(evaluatePolicy(withInput({ payment: { amountPaise: APPROVAL_THRESHOLD_PAISE } })).verdict).toBe('ALLOW');
    expect(evaluatePolicy(withInput({ payment: { attemptIndex: 3 } })).verdict).toBe('ALLOW');
    expect(evaluatePolicy(withInput({ lastActionAt: '2026-07-28T14:00:00.000Z' })).verdict).toBe('ALLOW');
  });
});

describe('the input hash makes every decision reproducible', () => {
  test('the same input hashes the same regardless of field order', () => {
    // Rebuild the object with every key, at every depth, in reverse order.
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(Object.keys(v as object).reverse().map((k) => [k, reverse((v as Record<string, unknown>)[k])]))
          : v;
    const reordered = reverse(base) as PolicyInput;
    expect(Object.keys(reordered)).toEqual(Object.keys(base).reverse());
    expect(hashInput(reordered)).toBe(hashInput(base));
    expect(canonicalise({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  test('a different input hashes differently', () => {
    expect(hashInput(withInput({ payment: { amountPaise: 480_001 } }))).not.toBe(hashInput(base));
  });

  test('the decision can be recomputed from its stored input and match', () => {
    const d = evaluatePolicy(base);
    const again = evaluatePolicy(JSON.parse(JSON.stringify(base)) as PolicyInput);
    expect(again.verdict).toBe(d.verdict);
    expect(again.inputHash).toBe(d.inputHash);
    expect(again.reasons).toEqual(d.reasons);
  });
});

describe('approve() — the only way to obtain a PolicyApprovedAction', () => {
  test('ALLOW yields an action, marked as approved by policy', () => {
    const d = evaluatePolicy(base);
    const a = approve(base, d);
    expect(a).not.toBeNull();
    expect(a!.approvedBy).toBe('policy');
    expect(a!.kind).toBe('route_alternate_gateway');
    expect(a!.inputHash).toBe(d.inputHash);
  });

  test('DENY never yields an action, even with human approval', () => {
    const input = withInput({ customer: { optedOut: true } });
    const d = evaluatePolicy(input);
    expect(approve(input, d)).toBeNull();
    expect(approve(input, d, true)).toBeNull();
  });

  test('REQUIRE_APPROVAL yields nothing until a human resolves it', () => {
    const input = withInput({ payment: { amountPaise: 4_000_000 } });
    const d = evaluatePolicy(input);
    expect(approve(input, d)).toBeNull();
    const a = approve(input, d, true);
    expect(a).not.toBeNull();
    expect(a!.approvedBy).toBe('human');
  });

  test('an approval does not carry over to a different input', () => {
    // A decision made about one input must not authorise another: the hash on
    // the decision has to match the input being approved.
    const d = evaluatePolicy(base);
    const other = withInput({ payment: { amountPaise: 999_999 } });
    expect(approve(other, d)).toBeNull();
  });

  test('the brand cannot be forged from a plain object', () => {
    // If the `unique symbol` brand were removed from PolicyApprovedAction this
    // assignment would compile, the expect-error directive below would become
    // unused, and `tsc` would fail the build. That is the §14 assertion:
    // delete the brand and the build must fail.
    // @ts-expect-error — a plain object is not a PolicyApprovedAction
    const forged: PolicyApprovedAction = {
      caseId: 'c', paymentId: 'p', merchantId: 'm', kind: 'retry_payment', strategy: 'retry',
      amountPaise: 1, costPaise: 1, expectedValuePaise: 1, policyVersion: 'v', inputHash: 'h', approvedBy: 'policy',
    };
    expect(forged).toBeDefined();
  });
});

describe('closed action set', () => {
  test('every acting strategy maps to exactly one executable kind; do_nothing to none', () => {
    expect(actionKindFor('retry')).toBe('retry_payment');
    expect(actionKindFor('alternate_gateway')).toBe('route_alternate_gateway');
    expect(actionKindFor('payment_link')).toBe('create_payment_link');
    expect(actionKindFor('alternate_method')).toBe('notify_customer');
    expect(actionKindFor('do_nothing')).toBeNull();
  });

  test('twelve rules are published for the policy page, numbered in order', () => {
    expect(RULES.map((r) => r.rule)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('a capacity DENY defers; any other DENY abandons', () => {
  test('blast radius alone is "not now"', () => {
    const d = evaluatePolicy(withInput({ merchantHour: { exposurePaise: BLAST_RADIUS_PAISE_PER_HOUR } }));
    expect(d.verdict).toBe('DENY');
    expect(isDeferrable(d)).toBe(true);
  });
  test('cooldown, daily count and daily spend are all capacity rules', () => {
    expect(isDeferrable(evaluatePolicy(withInput({ lastActionAt: '2026-07-28T14:20:00.000Z' })))).toBe(true);
    expect(isDeferrable(evaluatePolicy(withInput({ merchantToday: { actionCount: 200, actionSpendPaise: 0 } })))).toBe(true);
    expect(isDeferrable(evaluatePolicy(withInput({ merchantToday: { actionCount: 0, actionSpendPaise: 5_000_000 } })))).toBe(true);
  });
  test('a capacity rule beside a large amount still defers — rule 11 asks a human, it does not refuse', () => {
    const d = evaluatePolicy(withInput({ payment: { amountPaise: 4_000_000 }, merchantHour: { exposurePaise: BLAST_RADIUS_PAISE_PER_HOUR } }));
    expect(d.verdict).toBe('DENY');
    expect(isDeferrable(d)).toBe(true);
  });
  test('a capacity rule beside an opt-out is still "never"', () => {
    const d = evaluatePolicy(withInput({ customer: { optedOut: true }, merchantHour: { exposurePaise: BLAST_RADIUS_PAISE_PER_HOUR } }));
    expect(d.verdict).toBe('DENY');
    expect(isDeferrable(d)).toBe(false);
  });
  test('ALLOW and REQUIRE_APPROVAL are never deferred', () => {
    expect(isDeferrable(evaluatePolicy(base))).toBe(false);
    expect(isDeferrable(evaluatePolicy(withInput({ payment: { amountPaise: 4_000_000 } })))).toBe(false);
  });
});
