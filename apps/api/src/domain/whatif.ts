import type { FailureFamily } from './failure-codes.ts';
import { evaluatePolicy, isDeferrable, actionKindFor, type PolicyInput } from './policy.ts';
import type { Features, ProbabilitySource, Strategy } from './recovery-model.ts';
import { baselineOdds } from './recovery-model.ts';
import { choose, type StrategyDecision } from './strategy.ts';

/**
 * The what-if simulator (§8.7) — the pure half.
 *
 * The same recorded history, replayed under two policies against the labels
 * decided at generation time. No gateway, no clock: an arm is a fold over the
 * rows in chronological order, and the only thing that differs between the
 * arms is the decision.
 *
 *   BASELINE  one blind immediate retry on every failure, single processor,
 *             no targeting, no economics — resolved by `recoverable_by_retry`
 *   AGENT     probability → EV strategy choice → policy gate → the chosen
 *             intervention, resolved by that intervention's own label
 *
 * Both arms see exactly the same rows; the caller asserts the counts match.
 */

export interface WhatIfRow {
  id: string;
  merchantId: string;
  createdAt: string;
  isInternational: boolean;
  amountPaise: number;
  attemptIndex: number;
  failureCode: string;
  failureFamily: FailureFamily;
  optedOut: boolean;
  lifetimeValuePaise: number;
  features: Features;
  labels: { retry: boolean; link: boolean; alternate: boolean; gateway: boolean };
  merchant: { isPaused: boolean; dailyActionBudgetPaise: number; dailyActionBudgetCount: number };
}

export type Scorer = (f: Features) => { probability: number; source: ProbabilitySource };

export interface ArmSegment {
  failed: number;
  attempted: number;
  recovered: number;
  /** recovered / failed, or null on zero failures. */
  recoveryRate: number | null;
  costPaise: number;
  revenueRecoveredPaise: number;
}

export interface ArmResult extends ArmSegment {
  byStrategy: Record<Strategy, { attempted: number; recovered: number; revenuePaise: number }>;
  /** Agent arm only: why a row was not attempted. */
  declined: { doNothing: number; denied: number; deferred: number };
  /** Agent arm only: attempts that a human would have had to sign for. */
  requiredApproval: number;
  bySource: Record<ProbabilitySource, number>;
  international: ArmSegment;
  domestic: ArmSegment;
}

const emptySegment = (): ArmSegment => ({ failed: 0, attempted: 0, recovered: 0, recoveryRate: null, costPaise: 0, revenueRecoveredPaise: 0 });

const emptyArm = (): ArmResult => ({
  ...emptySegment(),
  byStrategy: {
    retry: { attempted: 0, recovered: 0, revenuePaise: 0 },
    payment_link: { attempted: 0, recovered: 0, revenuePaise: 0 },
    alternate_method: { attempted: 0, recovered: 0, revenuePaise: 0 },
    alternate_gateway: { attempted: 0, recovered: 0, revenuePaise: 0 },
    do_nothing: { attempted: 0, recovered: 0, revenuePaise: 0 },
  },
  declined: { doNothing: 0, denied: 0, deferred: 0 },
  requiredApproval: 0,
  bySource: { model: 0, baseline: 0 },
  international: emptySegment(),
  domestic: emptySegment(),
});

function record(arm: ArmResult, row: WhatIfRow, strategy: Strategy | null, cost: number, recovered: boolean): void {
  const segs = [arm, row.isInternational ? arm.international : arm.domestic];
  for (const s of segs) {
    s.failed += 1;
    if (strategy && strategy !== 'do_nothing') {
      s.attempted += 1;
      s.costPaise += cost;
      if (recovered) {
        s.recovered += 1;
        s.revenueRecoveredPaise += row.amountPaise;
      }
    }
  }
  if (strategy) {
    const b = arm.byStrategy[strategy];
    if (strategy !== 'do_nothing') {
      b.attempted += 1;
      if (recovered) {
        b.recovered += 1;
        b.revenuePaise += row.amountPaise;
      }
    }
  }
}

function finish(arm: ArmResult): ArmResult {
  for (const s of [arm, arm.international, arm.domestic]) s.recoveryRate = s.failed > 0 ? s.recovered / s.failed : null;
  return arm;
}

export function labelFor(strategy: Strategy, labels: WhatIfRow['labels']): boolean {
  switch (strategy) {
    case 'retry':
      return labels.retry;
    case 'payment_link':
      return labels.link;
    case 'alternate_method':
      return labels.alternate;
    case 'alternate_gateway':
      return labels.gateway;
    case 'do_nothing':
      return false;
  }
}

/** The merchant's cost of one blind retry, in paise — the same figure the strategy engine charges. */
export const BLIND_RETRY_COST_PAISE = 200;

/** BASELINE: every failure gets one retry on the same route. */
export function runBaseline(rows: readonly WhatIfRow[]): ArmResult {
  const arm = emptyArm();
  for (const row of rows) record(arm, row, 'retry', BLIND_RETRY_COST_PAISE, row.labels.retry);
  return finish(arm);
}

interface MerchantLedger {
  day: string;
  count: number;
  spendPaise: number;
  hour: string;
  exposurePaise: number;
}

/**
 * AGENT: the full loop per row, in order. The policy engine is the real one,
 * fed a ledger of what this arm has already done for the merchant today and
 * this hour — so the budgets and the blast radius bite here exactly as they
 * do live. REQUIRE_APPROVAL is counted as signed: the simulation has no
 * human, and "a human would have been asked" is reported beside the number.
 */
export function runAgent(rows: readonly WhatIfRow[], score: Scorer): ArmResult {
  const arm = emptyArm();
  const ledgers = new Map<string, MerchantLedger>();

  for (const row of rows) {
    const { probability, source } = score(row.features);
    arm.bySource[source] += 1;

    const decision: StrategyDecision = choose({
      amountPaise: row.amountPaise as never,
      odds: baselineOdds(row.features),
      caseProbability: probability,
      customerLifetimeValuePaise: row.lifetimeValuePaise as never,
      customerOptedOut: row.optedOut,
      secondaryRouteAvailable: row.features.secondaryRouteAvailable,
      failureFamily: row.failureFamily,
      failureCode: row.failureCode,
      attemptIndex: row.attemptIndex,
      incidentActive: row.features.incidentActive,
    });
    const chosen = decision.chosen;
    if (chosen.strategy === 'do_nothing') {
      arm.declined.doNothing += 1;
      record(arm, row, 'do_nothing', 0, false);
      continue;
    }

    const day = row.createdAt.slice(0, 10);
    const hour = row.createdAt.slice(0, 13);
    const ledger = ledgers.get(row.merchantId) ?? { day, count: 0, spendPaise: 0, hour, exposurePaise: 0 };
    if (ledger.day !== day) Object.assign(ledger, { day, count: 0, spendPaise: 0 });
    if (ledger.hour !== hour) Object.assign(ledger, { hour, exposurePaise: 0 });
    ledgers.set(row.merchantId, ledger);

    const input: PolicyInput = {
      now: row.createdAt,
      merchant: { id: row.merchantId, ...row.merchant },
      merchantToday: { actionCount: ledger.count, actionSpendPaise: ledger.spendPaise },
      merchantHour: { exposurePaise: ledger.exposurePaise },
      customer: { optedOut: row.optedOut },
      payment: { id: row.id, state: 'FAILED', amountPaise: row.amountPaise, attemptIndex: row.attemptIndex, failureFamily: row.failureFamily },
      lastActionAt: null,
      proposal: {
        caseId: `whatif_${row.id}`,
        strategy: chosen.strategy,
        actionKind: actionKindFor(chosen.strategy) ?? 'escalate',
        expectedValuePaise: chosen.expectedValuePaise,
        costPaise: chosen.costPaise,
      },
      openIncidentOnSlice: row.features.incidentActive,
    };
    const verdict = evaluatePolicy(input);
    if (verdict.verdict === 'DENY') {
      if (isDeferrable(verdict)) arm.declined.deferred += 1;
      else arm.declined.denied += 1;
      record(arm, row, null, 0, false);
      continue;
    }
    if (verdict.verdict === 'REQUIRE_APPROVAL') arm.requiredApproval += 1;

    ledger.count += 1;
    ledger.spendPaise += chosen.costPaise;
    ledger.exposurePaise += row.amountPaise;
    record(arm, row, chosen.strategy, chosen.costPaise, labelFor(chosen.strategy, row.labels));
  }
  return finish(arm);
}

export interface SegmentTotals {
  /** Every payment in the segment inside the test window, captured or not. */
  payments: number;
  captured: number;
}

export interface WhatIfComparison {
  rows: number;
  baseline: ArmResult;
  agent: ArmResult;
  incrementalRevenuePaise: number;
  interventionsAvoided: number;
  /** (captured + recovered) / payments, per segment and arm. */
  acceptance: {
    international: { before: number | null; baseline: number | null; agent: number | null; totals: SegmentTotals };
    domestic: { before: number | null; baseline: number | null; agent: number | null; totals: SegmentTotals };
  };
}

const rate = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export function compare(rows: readonly WhatIfRow[], score: Scorer, totals: { international: SegmentTotals; domestic: SegmentTotals }): WhatIfComparison {
  const baseline = runBaseline(rows);
  const agent = runAgent(rows, score);
  if (baseline.failed !== agent.failed || baseline.failed !== rows.length) {
    // Both arms operate on an identical set of failed payments, by construction.
    // If this ever throws, the comparison is not worth printing.
    throw new Error(`arms diverged: baseline ${baseline.failed}, agent ${agent.failed}, rows ${rows.length}`);
  }
  const acc = (seg: 'international' | 'domestic') => ({
    before: rate(totals[seg].captured, totals[seg].payments),
    baseline: rate(totals[seg].captured + baseline[seg].recovered, totals[seg].payments),
    agent: rate(totals[seg].captured + agent[seg].recovered, totals[seg].payments),
    totals: totals[seg],
  });
  return {
    rows: rows.length,
    baseline,
    agent,
    incrementalRevenuePaise: agent.revenueRecoveredPaise - baseline.revenueRecoveredPaise,
    interventionsAvoided: baseline.attempted - agent.attempted,
    acceptance: { international: acc('international'), domestic: acc('domestic') },
  };
}
