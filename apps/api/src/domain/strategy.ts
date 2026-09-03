import type { FailureFamily } from './failure-codes.ts';
import { scalePaise, type Paise } from './money.ts';
import {
  PROBABILITY_CEILING,
  PROBABILITY_FLOOR,
  STRATEGIES,
  type Strategy,
  type StrategyOdds,
} from './recovery-model.ts';

/**
 * Strategy engine — pure expected value, in integer paise (§7.6).
 *
 * PURE. No database, no clock, no network (§5).
 *
 * **`do_nothing` is on the ballot in every case and wins whenever no option
 * clears zero.** A system that always acts is a retry bot; the restraint is the
 * product. The engine must be seen choosing `alternate_gateway` on a
 * cross-border decline and a plain `retry` on a domestic insufficient-funds —
 * selectively, from the numbers — or it is just a second retry bot.
 */

export type { Strategy };
export { STRATEGIES };

export interface StrategyOption {
  strategy: Strategy;
  probability: number;
  /** `round(probability × amountPaise × customerMultiplier)`. */
  grossValuePaise: Paise;
  costPaise: Paise;
  frictionPaise: Paise;
  /** `gross − cost − friction`. Integer paise; may be negative. */
  expectedValuePaise: number;
  /** Whether this intervention can actually be attempted for this payment. */
  available: boolean;
  rationale: string;
}

export interface StrategyInput {
  amountPaise: Paise;
  /** Per-intervention odds, from the measured baseline (§7.5). */
  odds: StrategyOdds;
  /**
   * The case-level probability from whichever scorer is active. When the
   * trained model is live its calibration should reach the EVs, so the odds are
   * rescaled to make their best option agree with it. Omitted, the odds are
   * used as they are.
   */
  caseProbability?: number | undefined;
  customerLifetimeValuePaise: Paise;
  customerOptedOut: boolean;
  secondaryRouteAvailable: boolean;
  failureFamily: FailureFamily;
  failureCode: string;
  attemptIndex: number;
  incidentActive: boolean;
}

export interface StrategyDecision {
  chosen: StrategyOption;
  /** All five, so the UI can show the losers beside the winner. */
  options: StrategyOption[];
  customerMultiplier: number;
}

/** Fixed per-attempt cost, in paise (§7.6). */
const COST_PAISE: Record<Strategy, number> = {
  retry: 200,
  payment_link: 500,
  alternate_method: 300,
  alternate_gateway: 900,
  do_nothing: 0,
};

/** Friction as a fraction of the amount — the cost of asking a human to do something. */
const FRICTION_RATE: Record<Strategy, number> = {
  retry: 0,
  payment_link: 0.005,
  alternate_method: 0.003,
  alternate_gateway: 0,
  do_nothing: 0,
};

/** Strategies that require contacting the customer. */
const CUSTOMER_FACING = new Set<Strategy>(['payment_link', 'alternate_method']);

/**
 * `1.0 + min(0.5, ltv / ₹50,000)`, capping at 1.5×.
 *
 * A customer worth keeping is worth a little more effort, but not without
 * limit — the cap is what stops a whale's decline justifying any expense.
 */
export function customerMultiplier(lifetimeValuePaise: Paise): number {
  return 1 + Math.min(0.5, lifetimeValuePaise / 5_000_000);
}

function clamp(p: number): number {
  return Math.min(PROBABILITY_CEILING, Math.max(PROBABILITY_FLOOR, p));
}

const NOT_AVAILABLE = 'not available';

export function choose(input: StrategyInput): StrategyDecision {
  const multiplier = customerMultiplier(input.customerLifetimeValuePaise);

  // Let the active scorer's calibration flow into the EVs: scale the table so
  // its best option agrees with the case-level probability.
  let odds = input.odds;
  if (input.caseProbability !== undefined) {
    const best = Math.max(odds.retry, odds.payment_link, odds.alternate_method, odds.alternate_gateway);
    if (best > 0) {
      const k = input.caseProbability / best;
      odds = {
        retry: clamp(odds.retry * k),
        payment_link: clamp(odds.payment_link * k),
        alternate_method: clamp(odds.alternate_method * k),
        alternate_gateway: clamp(odds.alternate_gateway * k),
      };
    }
  }

  const options: StrategyOption[] = STRATEGIES.map((strategy) => {
    const probability = strategy === 'do_nothing' ? 0 : odds[strategy];

    // Availability is not a score; it is whether the thing can happen at all.
    let available = true;
    let unavailableBecause = '';
    if (strategy === 'alternate_gateway' && !input.secondaryRouteAvailable) {
      available = false;
      unavailableBecause = 'no second route carries this instrument (§8.6)';
    }
    if (CUSTOMER_FACING.has(strategy) && input.customerOptedOut) {
      available = false;
      unavailableBecause = 'the customer has opted out of contact';
    }
    if (strategy !== 'do_nothing' && input.customerOptedOut) {
      // The matrix is explicit: opted out means do nothing, unconditionally.
      // Policy rule 3 denies it again downstream; the engine saying so first
      // keeps the UI from ever showing a chosen action on an opted-out customer.
      available = false;
      unavailableBecause = 'the customer has opted out';
    }
    if (strategy !== 'do_nothing' && input.failureFamily === 'TERMINAL') {
      // §7.5: fraud and invalid accounts "recover under nothing". That is a
      // statement of impossibility, and the 1–2% in the odds table is the
      // clamping floor, not a chance — at ₹4,800 a 2% floor still shows a
      // positive EV and would have the engine asking a suspected fraudster for
      // a different card. Unavailable, not unlikely. Policy rule 4 denies it
      // again downstream.
      available = false;
      unavailableBecause = 'the failure family recovers under nothing (§7.5)';
    }

    const gross = available ? scalePaise(input.amountPaise, probability * multiplier) : 0;
    const cost = available ? COST_PAISE[strategy] : 0;
    const friction = available ? scalePaise(input.amountPaise, FRICTION_RATE[strategy]) : 0;
    const ev = strategy === 'do_nothing' ? 0 : available ? gross - cost - friction : Number.NEGATIVE_INFINITY;

    return {
      strategy,
      probability,
      grossValuePaise: gross,
      costPaise: cost,
      frictionPaise: friction,
      expectedValuePaise: Number.isFinite(ev) ? ev : 0,
      available,
      rationale: available ? rationale(strategy, input, probability, ev) : `${NOT_AVAILABLE}: ${unavailableBecause}`,
    };
  });

  // `do_nothing` wins whenever no option clears zero — strictly greater, so a
  // break-even intervention is not worth the risk of being wrong about it.
  let chosen = options.find((o) => o.strategy === 'do_nothing')!;
  for (const o of options) {
    if (!o.available || o.strategy === 'do_nothing') continue;
    if (o.expectedValuePaise > chosen.expectedValuePaise) chosen = o;
  }

  return { chosen, options, customerMultiplier: multiplier };
}

/** The sentence the founder could not get out of his dashboard. */
function rationale(s: Strategy, input: StrategyInput, p: number, ev: number): string {
  const perRupee = Math.round(p * 100);
  switch (s) {
    case 'retry':
      if (input.failureFamily === 'CROSS_BORDER') {
        return `${perRupee} paise on the rupee — same route, same challenge, same failure`;
      }
      if (input.incidentActive && input.failureFamily === 'TRANSIENT') {
        return `${perRupee} paise on the rupee — the cause is temporary and external, so waiting works`;
      }
      return `${perRupee} paise on the rupee, invisible to the customer`;
    case 'payment_link':
      return `${perRupee} paise on the rupee, at the cost of one message to a human being`;
    case 'alternate_method':
      return `${perRupee} paise on the rupee, but asks the customer to change instrument`;
    case 'alternate_gateway':
      if (input.failureFamily === 'CROSS_BORDER') {
        return `${perRupee} paise on the rupee — the card is fine, the route is not; costs ₹9 to find out`;
      }
      return `${perRupee} paise on the rupee — the most expensive option, and the route was not the problem`;
    case 'do_nothing':
      return ev > 0 ? 'always on the ballot' : 'no option clears zero — acting would lose money';
  }
}
