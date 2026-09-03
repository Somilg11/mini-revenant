import { randomUUID } from 'node:crypto';
import { sql } from '../db/client.ts';
import { notify } from '../db/notify.ts';
import {
  decisionsForCase,
  gateCandidates,
  lastActionOnPayment,
  merchantActivity,
  merchantForPolicy,
  openIncidentOnPayment,
  type GateCandidate,
} from '../db/queries.ts';
import { failureFamily } from '../domain/failure-codes.ts';
import {
  actionKindFor,
  approve,
  evaluatePolicy,
  type PolicyApprovedAction,
  type PolicyDecision,
  type PolicyInput,
} from '../domain/policy.ts';
import type { Strategy } from '../domain/recovery-model.ts';
import { NotFoundError, ValidationError } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';

/**
 * Time-sortable id. Several decisions on one case can share a simulated
 * `decided_at` (the clock is frozen while a human clicks), so the id carries
 * wall-clock order and the log sorts by `(decided_at, id)`.
 */
const decisionId = () => `pd_${Date.now().toString(36).padStart(9, '0')}${randomUUID().slice(0, 6)}`;

/**
 * The gate (§7.7, §9).
 *
 * Every proposed money action passes through here. The decision is persisted
 * **including ALLOWs** — you cannot audit a gate that only records refusals —
 * and the input is stored beside its hash, so any verdict can be recomputed
 * from what was recorded and shown to be reproducible.
 */

export async function buildInput(c: GateCandidate, now: Date): Promise<PolicyInput | null> {
  const strategy = c.chosen_strategy as Strategy;
  const actionKind = actionKindFor(strategy);
  if (!actionKind) return null;

  const merchant = await merchantForPolicy(c.merchant_id);
  if (!merchant) return null;

  const [activity, lastActionAt, openIncident] = await Promise.all([
    merchantActivity(c.merchant_id, now.toISOString()),
    lastActionOnPayment(c.payment_id),
    openIncidentOnPayment(c),
  ]);

  const option = c.strategy_options.find((o) => o.strategy === strategy);
  const failureCode = c.failure_code ?? (c.abandoned ? 'CHECKOUT_ABANDONED' : 'UNKNOWN');

  return {
    now: now.toISOString(),
    merchant: {
      id: merchant.id,
      isPaused: merchant.is_paused,
      dailyActionBudgetPaise: merchant.daily_action_budget_paise,
      dailyActionBudgetCount: merchant.daily_action_budget_count,
    },
    merchantToday: { actionCount: activity.todayCount, actionSpendPaise: activity.todaySpendPaise },
    merchantHour: { exposurePaise: activity.hourExposurePaise },
    customer: { optedOut: c.opted_out },
    payment: {
      id: c.payment_id,
      state: c.payment_state,
      amountPaise: c.amount_paise,
      attemptIndex: c.attempt_index,
      failureFamily: failureFamily(failureCode),
    },
    lastActionAt,
    proposal: {
      caseId: c.case_id,
      strategy,
      actionKind,
      expectedValuePaise: c.expected_value_paise,
      costPaise: option?.costPaise ?? 0,
    },
    openIncidentOnSlice: openIncident,
  };
}

async function persist(
  input: PolicyInput,
  decision: PolicyDecision,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = decisionId();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO policy_decisions
        (id, case_id, proposed_action, verdict, reasons, policy_version, input_hash, decided_at)
      VALUES (
        ${id}, ${input.proposal.caseId}, ${input.proposal.actionKind}, ${decision.verdict},
        ${tx.json({ rules: decision.reasons, input, ...extra } as never)},
        ${decision.policyVersion}, ${decision.inputHash}, ${input.now}
      )`;

    if (decision.verdict === 'DENY') {
      await tx`
        UPDATE recovery_cases SET status = 'ABANDONED_BY_POLICY', closed_at = ${input.now}
        WHERE id = ${input.proposal.caseId} AND status = 'OPEN'`;
    }

    await notify(tx, 'policy.decided', {
      decision_id: id,
      case_id: input.proposal.caseId,
      payment_id: input.payment.id,
      verdict: decision.verdict,
      proposed_action: input.proposal.actionKind,
      amount_paise: input.payment.amountPaise,
      failed_rules: decision.reasons.filter((r) => !r.passed).map((r) => r.rule),
    });
  });
  return id;
}

export interface GateResult {
  evaluated: number;
  allow: number;
  deny: number;
  requireApproval: number;
  /** Actions the gate cleared, ready for the executor (P13). */
  approved: PolicyApprovedAction[];
}

/** Evaluates every undecided proposal. */
export async function gateOpenCases(now: Date, limit = 300): Promise<GateResult> {
  const result: GateResult = { evaluated: 0, allow: 0, deny: 0, requireApproval: 0, approved: [] };
  const candidates = await gateCandidates(limit);

  for (const c of candidates) {
    const input = await buildInput(c, now);
    if (!input) continue;

    const decision = evaluatePolicy(input);
    await persist(input, decision);
    result.evaluated += 1;

    if (decision.verdict === 'ALLOW') {
      result.allow += 1;
      const action = approve(input, decision);
      if (action) result.approved.push(action);
    } else if (decision.verdict === 'DENY') {
      result.deny += 1;
    } else {
      result.requireApproval += 1;
    }
  }

  if (result.evaluated > 0) {
    log.info('policy gate', {
      evaluated: result.evaluated,
      allow: result.allow,
      deny: result.deny,
      requireApproval: result.requireApproval,
    });
  }
  return result;
}

/**
 * A human resolves a REQUIRE_APPROVAL (§10 `POST /cases/:id/approve`).
 *
 * The policy is re-evaluated against the **current** state — not the state at
 * the time of the original decision — because a case can change between the
 * verdict and the click. A DENY at re-evaluation still denies: a human can
 * sign for large money, not override a kill switch.
 */
export async function approveCase(caseId: string, now: Date, approvedBy = 'human'): Promise<{
  action: PolicyApprovedAction;
  decisionId: string;
}> {
  const prior = await decisionsForCase(caseId);
  const pending = prior.filter((d) => d.verdict === 'REQUIRE_APPROVAL').at(-1);
  if (!pending) throw new NotFoundError('pending approval for case', caseId);
  // Once: a second click must not mint a second approval for the same request.
  const resolved = prior.find(
    (d) => (d.reasons as { human_approval?: { resolves?: string } }).human_approval?.resolves === pending.id,
  );
  if (resolved) {
    throw new ValidationError('already approved', { caseId, decisionId: resolved.id });
  }

  const [c] = await sql<(GateCandidate & { case_status: string })[]>`
    SELECT c.id AS case_id, c.status AS case_status,
           c.payment_id, c.merchant_id, c.chosen_strategy, c.expected_value_paise,
           c.strategy_options,
           p.state::text AS payment_state, p.amount_paise, p.attempt_index, p.failure_code,
           p.abandoned, p.method::text AS method, p.bank, p.is_international, p.card_network,
           cu.opted_out
    FROM recovery_cases c
    JOIN payments p ON p.id = c.payment_id
    JOIN customers cu ON cu.id = p.customer_id
    WHERE c.id = ${caseId}`;
  if (!c) throw new NotFoundError('case', caseId);
  if (c.case_status !== 'OPEN') {
    throw new ValidationError(`case is ${c.case_status}, not awaiting approval`, { caseId });
  }
  if (c.chosen_strategy === 'do_nothing' || !c.chosen_strategy) {
    throw new ValidationError('nothing to approve — the strategy is do_nothing', { caseId });
  }

  const input = await buildInput(c, now);
  if (!input) throw new ValidationError('case has no executable proposal', { caseId });

  const decision = evaluatePolicy(input);
  if (decision.verdict === 'DENY') {
    const id = await persist(input, decision, { approval_attempted_by: approvedBy });
    throw new ValidationError('policy denies this action even with approval', {
      caseId,
      decisionId: id,
      failedRules: decision.reasons.filter((r) => !r.passed).map((r) => `${r.rule}: ${r.detail}`),
    });
  }

  const action = approve(input, decision, true);
  if (!action) throw new ValidationError('approval did not yield an action', { caseId });

  const decisionId = await persist(input, { ...decision, verdict: 'ALLOW' }, {
    human_approval: { by: approvedBy, at: now.toISOString(), resolves: pending.id },
  });
  log.info('case approved by human', { caseId, decisionId, by: approvedBy });
  return { action, decisionId };
}

export async function rejectCase(caseId: string, now: Date, rejectedBy = 'human'): Promise<string> {
  const [c] = await sql<{ status: string }[]>`SELECT status FROM recovery_cases WHERE id = ${caseId}`;
  if (!c) throw new NotFoundError('case', caseId);
  if (c.status !== 'OPEN' && c.status !== 'ACTING') {
    throw new ValidationError(`case is ${c.status}, nothing to reject`, { caseId });
  }
  const id = decisionId();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO policy_decisions
        (id, case_id, proposed_action, verdict, reasons, policy_version, input_hash, decided_at)
      VALUES (${id}, ${caseId}, 'escalate', 'DENY',
              ${tx.json({ rules: [], human_rejection: { by: rejectedBy, at: now.toISOString() } } as never)},
              'human', 'n/a', ${now.toISOString()})`;
    await tx`
      UPDATE recovery_cases SET status = 'ABANDONED_BY_POLICY', closed_at = ${now.toISOString()}
      WHERE id = ${caseId} AND status IN ('OPEN', 'ACTING')`;
    await notify(tx, 'policy.decided', { decision_id: id, case_id: caseId, verdict: 'DENY', proposed_action: 'escalate', by: rejectedBy });
  });
  return id;
}
