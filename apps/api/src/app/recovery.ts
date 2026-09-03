import { randomUUID } from 'node:crypto';
import { sql } from '../db/client.ts';
import { notify } from '../db/notify.ts';
import {
  activeModelRow,
  candidateForPayment,
  recoveryCandidates,
  type RecoveryCandidate,
} from '../db/queries.ts';
import {
  baselineOdds,
  predict,
  secondaryRouteSupports,
  type ActiveModel,
  type Features,
} from '../domain/recovery-model.ts';
import { failureFamily } from '../domain/failure-codes.ts';
import { choose, type StrategyDecision } from '../domain/strategy.ts';
import { isUniqueViolation } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';

/**
 * Opening recovery cases (§9).
 *
 * One case per unresolved failure, carrying the probability that it can be
 * recovered at all and **which scorer produced it**. The strategy engine, the
 * policy gate and the executor come later; this phase decides what is worth
 * looking at and prices it.
 */

/** Turns a database row into the feature vector, in one place. */
export function featuresOf(c: RecoveryCandidate): Features {
  // An abandoned payment carries no gateway code — nothing failed, the customer
  // left — but "the customer left" is the most recoverable case there is, so it
  // is named rather than lumped in with UNKNOWN.
  const failureCode = c.failure_code ?? (c.abandoned ? 'CHECKOUT_ABANDONED' : 'UNKNOWN');

  return {
    failedAt: new Date(c.last_event_at).toISOString(),
    amountPaise: c.amount_paise,
    method: c.method,
    bank: c.bank,
    failureCode,
    attemptIndex: c.attempt_index,
    customerPriorAttempts: c.customer_prior_attempts,
    customerPriorSuccessRate:
      c.customer_prior_attempts === 0 ? 0 : c.customer_prior_successes / c.customer_prior_attempts,
    merchantPriorSuccessRate:
      c.merchant_prior_attempts === 0 ? 0 : c.merchant_prior_successes / c.merchant_prior_attempts,
    secondsSinceLastAttempt: c.seconds_since_last_attempt,
    incidentActive: c.incident_active,
    secondaryRouteAvailable: secondaryRouteSupports(c.method, c.card_network),
  };
}

/**
 * Runs the strategy engine for one candidate (§7.6).
 *
 * The per-intervention odds come from the measured table; the case-level
 * probability from whichever scorer is active rescales them so a calibrated
 * model's number reaches the EVs. All five options are returned, `do_nothing`
 * included, because the losers beside the winner are the demo moment.
 */
export function decide(c: RecoveryCandidate, caseProbability: number | null): StrategyDecision {
  const f = featuresOf(c);
  return choose({
    amountPaise: c.amount_paise,
    odds: baselineOdds(f),
    caseProbability: caseProbability ?? undefined,
    customerLifetimeValuePaise: c.lifetime_value_paise,
    customerOptedOut: c.opted_out,
    secondaryRouteAvailable: f.secondaryRouteAvailable,
    failureFamily: failureFamily(f.failureCode),
    failureCode: f.failureCode,
    attemptIndex: f.attemptIndex,
    incidentActive: f.incidentActive,
  });
}

/** Loads the active model once per sweep rather than once per case. */
export async function loadActiveModel(): Promise<ActiveModel | null> {
  const row = await activeModelRow();
  if (!row) return null;
  try {
    const c = row.coefficients as {
      weights?: number[];
      intercept?: number;
      means?: number[];
      std_devs?: number[];
    };
    const cal = row.calibration as { buckets?: number[] };
    if (!c.weights || !c.means || !c.std_devs) return null;
    return {
      coefficients: c.weights,
      intercept: c.intercept ?? 0,
      means: c.means,
      stdDevs: c.std_devs,
      calibration: cal.buckets ?? [],
    };
  } catch (err) {
    // A malformed model row must not stop cases opening — the baseline is a
    // measured fallback, not a degraded mode (§7.5).
    log.warn('active model row could not be read; using the baseline', { err });
    return null;
  }
}

export interface OpenCasesResult {
  considered: number;
  opened: number;
  skipped: number;
  bySource: { model: number; baseline: number };
}

const BATCH = 300;

/**
 * Opens cases for unresolved failures.
 *
 * `now` is simulated time: a case must not be opened for a payment that, from
 * the simulation's point of view, has not failed yet.
 */
export async function openCases(now: Date, limit = BATCH): Promise<OpenCasesResult> {
  const result: OpenCasesResult = {
    considered: 0,
    opened: 0,
    skipped: 0,
    bySource: { model: 0, baseline: 0 },
  };

  const candidates = await recoveryCandidates(now.toISOString(), limit);
  result.considered = candidates.length;
  if (candidates.length === 0) return result;

  const model = await loadActiveModel();

  for (const candidate of candidates) {
    const features = featuresOf(candidate);
    const { probability, source } = predict(features, model);
    const decision = decide(candidate, probability);

    try {
      await sql.begin(async (tx) => {
        const id = `case_${randomUUID().slice(0, 12)}`;
        await tx`
          INSERT INTO recovery_cases (
            id, payment_id, merchant_id, status,
            recovery_probability, probability_source,
            chosen_strategy, strategy_options, expected_value_paise, opened_at
          ) VALUES (
            ${id}, ${candidate.id}, ${candidate.merchant_id}, 'OPEN',
            ${probability}, ${source},
            ${decision.chosen.strategy}, ${tx.json(decision.options as never)},
            ${decision.chosen.expectedValuePaise}, ${now.toISOString()}
          )`;

        await notify(tx, 'case.opened', {
          case_id: id,
          payment_id: candidate.id,
          merchant_id: candidate.merchant_id,
          amount_paise: candidate.amount_paise,
          probability,
          probability_source: source,
          failure_code: features.failureCode,
          chosen_strategy: decision.chosen.strategy,
          expected_value_paise: decision.chosen.expectedValuePaise,
        });
      });

      result.opened += 1;
      result.bySource[source] += 1;
    } catch (err) {
      // One live case per payment is a database constraint, not a read-then-write
      // check (§6.1). A concurrent sweep getting there first is a normal
      // outcome, not an error.
      if (isUniqueViolation(err, 'cases_one_live')) {
        result.skipped += 1;
        continue;
      }
      throw err;
    }
  }

  if (result.opened > 0) {
    log.info('recovery cases opened', {
      opened: result.opened,
      skipped: result.skipped,
      model: result.bySource.model,
      baseline: result.bySource.baseline,
    });
  }
  return result;
}

/**
 * Re-prices every OPEN case with whichever scorer is currently active.
 *
 * Run after a model is activated (badges flip `baseline` → `model`) and after
 * one is deleted (they flip back). The stored probability and source always
 * describe the scorer that is live, which is what makes "unplug the model on
 * stage and watch the badges flip" a demonstration rather than a claim.
 */
export async function rescoreOpenCases(): Promise<{ rescored: number; model: number; baseline: number }> {
  const model = await loadActiveModel();
  const open = await sql<{ id: string; payment_id: string }[]>`
    SELECT id, payment_id FROM recovery_cases WHERE status = 'OPEN'`;

  const counts = { rescored: 0, model: 0, baseline: 0 };
  for (const c of open) {
    const candidate = await candidateForPayment(c.payment_id);
    if (!candidate) continue;
    const { probability, source } = predict(featuresOf(candidate), model);
    const decision = decide(candidate, probability);
    await sql`
      UPDATE recovery_cases
      SET recovery_probability = ${probability}, probability_source = ${source},
          chosen_strategy = ${decision.chosen.strategy},
          strategy_options = ${sql.json(decision.options as never)},
          expected_value_paise = ${decision.chosen.expectedValuePaise}
      WHERE id = ${c.id}`;
    counts.rescored += 1;
    counts[source] += 1;
  }
  return counts;
}

/** Per-strategy odds for one case, for the UI and for P11's EV engine. */
export function oddsFor(candidate: RecoveryCandidate) {
  return baselineOdds(featuresOf(candidate));
}
