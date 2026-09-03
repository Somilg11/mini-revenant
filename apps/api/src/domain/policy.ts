import { createHash } from 'node:crypto';
import type { FailureFamily } from './failure-codes.ts';
import type { Strategy } from './recovery-model.ts';

/**
 * The policy engine (§7.7).
 *
 * PURE. A function over **passed-in state** returning a verdict, its reasons, a
 * policy version and a hash of its inputs. Every decision is persisted by the
 * caller, ALLOWs included — you cannot audit a gate that only records refusals.
 *
 * Rules are evaluated in order, **all of them, always**. Never short-circuit: a
 * user needs the full picture, not the first objection.
 */

export const POLICY_VERSION = 'v1.0.0';

export type Verdict = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface RuleResult {
  rule: number;
  name: string;
  passed: boolean;
  /** The verdict this rule imposes when it fails. */
  verdict: Verdict;
  detail: string;
}

export interface PolicyDecision {
  verdict: Verdict;
  reasons: RuleResult[];
  policyVersion: string;
  /** SHA-256 of the canonicalised input, so any decision is reproducible. */
  inputHash: string;
}

/** The five executable kinds. Nothing else can be proposed (§7.8). */
export const ACTION_KINDS = [
  'retry_payment',
  'route_alternate_gateway',
  'create_payment_link',
  'notify_customer',
  'escalate',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export function actionKindFor(strategy: Strategy): ActionKind | null {
  switch (strategy) {
    case 'retry':
      return 'retry_payment';
    case 'alternate_gateway':
      return 'route_alternate_gateway';
    case 'payment_link':
      return 'create_payment_link';
    case 'alternate_method':
      return 'notify_customer';
    case 'do_nothing':
      return null;
  }
}

export interface PolicyInput {
  now: string;
  merchant: {
    id: string;
    isPaused: boolean;
    dailyActionBudgetPaise: number;
    dailyActionBudgetCount: number;
  };
  /** Merchant activity so far today (UTC day), from persisted actions. */
  merchantToday: { actionCount: number; actionSpendPaise: number };
  /** Amount already put in motion this hour, for the blast-radius cap. */
  merchantHour: { exposurePaise: number };
  customer: { optedOut: boolean };
  payment: {
    id: string;
    state: string;
    amountPaise: number;
    attemptIndex: number;
    failureFamily: FailureFamily;
  };
  /** When this payment was last acted on, if ever. */
  lastActionAt: string | null;
  proposal: {
    caseId: string;
    strategy: Strategy;
    actionKind: ActionKind;
    expectedValuePaise: number;
    costPaise: number;
  };
  /** An incident the detector opened is still OPEN on a slice this payment is in. */
  openIncidentOnSlice: boolean;
}

// ── Limits (§7.7) ────────────────────────────────────────────────────────────
export const MAX_ATTEMPT_INDEX = 3;
export const COOLDOWN_MINUTES = 30;
export const BLAST_RADIUS_PAISE_PER_HOUR = 20_000_000; // ₹2,00,000
export const APPROVAL_THRESHOLD_PAISE = 2_500_000; // ₹25,000

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

/**
 * Canonical JSON: keys sorted at every depth, so the same input always hashes
 * the same regardless of the order fields were assembled in.
 */
export function canonicalise(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashInput(input: PolicyInput): string {
  return createHash('sha256').update(canonicalise(input)).digest('hex');
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { merchant, merchantToday, merchantHour, customer, payment, proposal } = input;

  const minutesSinceLastAction =
    input.lastActionAt === null
      ? null
      : (Date.parse(input.now) - Date.parse(input.lastActionAt)) / 60_000;

  const reasons: RuleResult[] = [
    {
      rule: 1,
      name: 'merchant not paused',
      passed: !merchant.isPaused,
      verdict: 'DENY',
      detail: merchant.isPaused ? 'kill switch is on for this merchant' : 'merchant is active',
    },
    {
      rule: 2,
      name: 'payment not terminal',
      passed: payment.state !== 'CAPTURED' && payment.state !== 'REFUNDED',
      verdict: 'DENY',
      // This is the double-charge guard: never act after success.
      detail: `payment state ${payment.state}${payment.state === 'CAPTURED' || payment.state === 'REFUNDED' ? ' — already settled, acting would double-charge' : ' — not terminal'}`,
    },
    {
      rule: 3,
      name: 'customer not opted out',
      passed: !customer.optedOut,
      verdict: 'DENY',
      detail: customer.optedOut
        ? 'customer has opted out — absolute, whatever the EV says'
        : 'customer has not opted out',
    },
    {
      rule: 4,
      name: 'failure family not terminal',
      passed: payment.failureFamily !== 'TERMINAL',
      verdict: 'DENY',
      detail: `family ${payment.failureFamily}${payment.failureFamily === 'TERMINAL' ? ' — recovers under nothing' : ''}`,
    },
    {
      rule: 5,
      name: 'attempt limit',
      passed: payment.attemptIndex <= MAX_ATTEMPT_INDEX,
      verdict: 'DENY',
      detail: `attempt_index ${payment.attemptIndex} ${payment.attemptIndex <= MAX_ATTEMPT_INDEX ? '≤' : '>'} ${MAX_ATTEMPT_INDEX}${payment.attemptIndex > MAX_ATTEMPT_INDEX ? ' — retry limit exceeded' : ''}`,
    },
    {
      rule: 6,
      name: 'cooldown',
      passed: minutesSinceLastAction === null || minutesSinceLastAction >= COOLDOWN_MINUTES,
      verdict: 'DENY',
      detail:
        minutesSinceLastAction === null
          ? 'no previous action on this payment'
          : `${Math.floor(minutesSinceLastAction)} simulated minutes since the last action (need ${COOLDOWN_MINUTES})`,
    },
    {
      rule: 7,
      name: 'daily action count',
      passed: merchantToday.actionCount < merchant.dailyActionBudgetCount,
      verdict: 'DENY',
      detail: `${merchantToday.actionCount} of ${merchant.dailyActionBudgetCount} actions used today`,
    },
    {
      rule: 8,
      name: 'daily action spend',
      passed: merchantToday.actionSpendPaise + proposal.costPaise <= merchant.dailyActionBudgetPaise,
      verdict: 'DENY',
      detail: `${rupees(merchantToday.actionSpendPaise)} spent + ${rupees(proposal.costPaise)} this action, against a ${rupees(merchant.dailyActionBudgetPaise)} daily budget`,
    },
    {
      rule: 9,
      name: 'blast radius',
      passed: merchantHour.exposurePaise + payment.amountPaise <= BLAST_RADIUS_PAISE_PER_HOUR,
      verdict: 'DENY',
      detail: `${rupees(merchantHour.exposurePaise)} in motion this hour + ${rupees(payment.amountPaise)}, cap ${rupees(BLAST_RADIUS_PAISE_PER_HOUR)}/hour`,
    },
    {
      rule: 10,
      name: 'positive expected value',
      passed: proposal.expectedValuePaise > 0,
      verdict: 'DENY',
      detail: `EV ${rupees(proposal.expectedValuePaise)}${proposal.expectedValuePaise > 0 ? '' : ' — never act at a loss'}`,
    },
    {
      rule: 11,
      name: 'amount within auto-approval limit',
      passed: payment.amountPaise <= APPROVAL_THRESHOLD_PAISE,
      verdict: 'REQUIRE_APPROVAL',
      detail: `amount ${rupees(payment.amountPaise)} ${payment.amountPaise <= APPROVAL_THRESHOLD_PAISE ? '≤' : '>'} ${rupees(APPROVAL_THRESHOLD_PAISE)}${payment.amountPaise > APPROVAL_THRESHOLD_PAISE ? ' — a human signs for large money' : ''}`,
    },
    {
      rule: 12,
      name: 'no retry into a live incident',
      passed: !(proposal.strategy === 'retry' && input.openIncidentOnSlice),
      verdict: 'REQUIRE_APPROVAL',
      detail:
        proposal.strategy === 'retry' && input.openIncidentOnSlice
          ? 'a retry into an open incident burns the attempt — approval required'
          : proposal.strategy === 'retry'
            ? 'no open incident on this slice'
            : 'not a retry',
    },
  ];

  // Precedence: any DENY wins; otherwise any REQUIRE_APPROVAL; otherwise ALLOW.
  const failed = reasons.filter((r) => !r.passed);
  const verdict: Verdict = failed.some((r) => r.verdict === 'DENY')
    ? 'DENY'
    : failed.some((r) => r.verdict === 'REQUIRE_APPROVAL')
      ? 'REQUIRE_APPROVAL'
      : 'ALLOW';

  return { verdict, reasons, policyVersion: POLICY_VERSION, inputHash: hashInput(input) };
}

// ── The brand ────────────────────────────────────────────────────────────────

/**
 * Not exported. This is the entire mechanism.
 *
 * `PolicyApprovedAction` can only be constructed by `approve()` below, and
 * `approve()` returns one only for an ALLOW verdict. The executor's signature
 * accepts nothing else, so calling it with an unapproved action is a **type
 * error, not a review comment**. Guardrails enforced by review get bypassed
 * under deadline pressure; guardrails enforced by the compiler do not.
 */
const approved: unique symbol = Symbol('policy.approved');

export interface PolicyApprovedAction {
  readonly [approved]: true;
  readonly caseId: string;
  readonly paymentId: string;
  readonly merchantId: string;
  readonly kind: ActionKind;
  readonly strategy: Strategy;
  readonly amountPaise: number;
  readonly costPaise: number;
  readonly expectedValuePaise: number;
  readonly policyVersion: string;
  readonly inputHash: string;
  /** Set when a human resolved a REQUIRE_APPROVAL. */
  readonly approvedBy: 'policy' | 'human';
}

/**
 * Returns an approved action only for an ALLOW verdict, or for a
 * REQUIRE_APPROVAL that a human has explicitly resolved. A DENY never becomes
 * an action by any path.
 */
export function approve(
  input: PolicyInput,
  decision: PolicyDecision,
  humanApproval = false,
): PolicyApprovedAction | null {
  if (decision.verdict === 'DENY') return null;
  if (decision.verdict === 'REQUIRE_APPROVAL' && !humanApproval) return null;
  // The hash must match: an approval carried over to a different input is not
  // an approval of that input.
  if (decision.inputHash !== hashInput(input)) return null;

  return {
    [approved]: true,
    caseId: input.proposal.caseId,
    paymentId: input.payment.id,
    merchantId: input.merchant.id,
    kind: input.proposal.actionKind,
    strategy: input.proposal.strategy,
    amountPaise: input.payment.amountPaise,
    costPaise: input.proposal.costPaise,
    expectedValuePaise: input.proposal.expectedValuePaise,
    policyVersion: decision.policyVersion,
    inputHash: decision.inputHash,
    approvedBy: decision.verdict === 'ALLOW' ? 'policy' : 'human',
  };
}

/** The twelve rules, for the `/policy` page. */
export const RULES: readonly { rule: number; name: string; verdict: Verdict; description: string }[] = [
  { rule: 1, name: 'merchant not paused', verdict: 'DENY', description: 'Kill switch. A paused merchant gets no actions at all.' },
  { rule: 2, name: 'payment not terminal', verdict: 'DENY', description: 'The double-charge guard. Never act on a CAPTURED or REFUNDED payment.' },
  { rule: 3, name: 'customer not opted out', verdict: 'DENY', description: 'Opt-out is absolute, whatever the expected value says.' },
  { rule: 4, name: 'failure family not terminal', verdict: 'DENY', description: 'Fraud and invalid accounts recover under nothing.' },
  { rule: 5, name: 'attempt limit', verdict: 'DENY', description: `attempt_index ≤ ${MAX_ATTEMPT_INDEX} — at most two recovery attempts per payment.` },
  { rule: 6, name: 'cooldown', verdict: 'DENY', description: `≥ ${COOLDOWN_MINUTES} simulated minutes since the last action on this payment.` },
  { rule: 7, name: 'daily action count', verdict: 'DENY', description: "Merchant's actions today below its daily count budget." },
  { rule: 8, name: 'daily action spend', verdict: 'DENY', description: "Merchant's spend today plus this cost within its daily paise budget." },
  { rule: 9, name: 'blast radius', verdict: 'DENY', description: `Amount in motion this hour plus this payment ≤ ${rupees(BLAST_RADIUS_PAISE_PER_HOUR)}.` },
  { rule: 10, name: 'positive expected value', verdict: 'DENY', description: 'Never act at a loss.' },
  { rule: 11, name: 'amount within auto-approval limit', verdict: 'REQUIRE_APPROVAL', description: `Above ${rupees(APPROVAL_THRESHOLD_PAISE)} a human signs for large money.` },
  { rule: 12, name: 'no retry into a live incident', verdict: 'REQUIRE_APPROVAL', description: 'Retrying into an open outage burns the attempt.' },
];
