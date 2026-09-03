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
  pendingExecutions,
  type GateCandidate,
} from '../db/queries.ts';
import { failureFamily } from '../domain/failure-codes.ts';
import {
  actionKindFor,
  approve,
  evaluatePolicy,
  isDeferrable,
  type PolicyApprovedAction,
  type PolicyDecision,
  type PolicyInput,
} from '../domain/policy.ts';
import type { Strategy } from '../domain/recovery-model.ts';
import { NotFoundError, ValidationError } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';
import { executor, type ExecutionResult } from './executor.ts';

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
  // A refusal on capacity alone (rules 6–9) is recorded like any other DENY
  // but leaves the case OPEN: the gate judges it again once the hour or the
  // day has moved on. Any other DENY closes the case.
  const deferred = isDeferrable(decision);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO policy_decisions
        (id, case_id, proposed_action, verdict, reasons, policy_version, input_hash, decided_at)
      VALUES (
        ${id}, ${input.proposal.caseId}, ${input.proposal.actionKind}, ${decision.verdict},
        ${tx.json({ rules: decision.reasons, input, ...(deferred ? { deferred: true } : {}), ...extra } as never)},
        ${decision.policyVersion}, ${decision.inputHash}, ${input.now}
      )`;

    if (decision.verdict === 'DENY' && !deferred) {
      await tx`
        UPDATE recovery_cases SET status = 'ABANDONED_BY_POLICY', closed_at = ${input.now}
        WHERE id = ${input.proposal.caseId} AND status = 'OPEN'`;
    }

    await notify(tx, 'policy.decided', {
      decision_id: id,
      case_id: input.proposal.caseId,
      payment_id: input.payment.id,
      verdict: decision.verdict,
      deferred,
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
  /** DENYs on capacity alone — the case stays OPEN and is judged again later. */
  deferred: number;
  requireApproval: number;
  /** Actions the gate cleared, ready for the executor (P13). */
  approved: PolicyApprovedAction[];
}

/** Evaluates every undecided proposal. */
/** `onlyCases` scopes the worklist — one case, or a test's own — instead of the global queue. */
export async function gateOpenCases(now: Date, limit = 300, onlyCases?: string[]): Promise<GateResult> {
  const result: GateResult = { evaluated: 0, allow: 0, deny: 0, deferred: 0, requireApproval: 0, approved: [] };
  const candidates = await gateCandidates(limit, now.toISOString(), onlyCases);

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
      if (isDeferrable(decision)) result.deferred += 1;
    } else {
      result.requireApproval += 1;
    }
  }

  if (result.evaluated > 0) {
    log.info('policy gate', {
      evaluated: result.evaluated,
      allow: result.allow,
      deny: result.deny,
      deferred: result.deferred,
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
    throw new ValidationError(
      isDeferrable(decision)
        ? 'policy defers this action — capacity is exhausted, try again later'
        : 'policy denies this action even with approval',
      {
      caseId,
      decisionId: id,
      failedRules: decision.reasons.filter((r) => !r.passed).map((r) => `${r.rule}: ${r.detail}`),
      },
    );
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

export interface ExecuteResult {
  executed: number;
  succeeded: number;
  failed: number;
  escalated: number;
  replayed: number;
  skipped: number;
}

/**
 * Executes every approved decision that has no action yet.
 *
 * The action is **reconstructed from the stored decision**: the input is
 * re-read from the row, re-evaluated, and `approve()` is asked for the brand
 * again. That is the reproducibility claim of §7.7 doing real work — the
 * executor never trusts an in-memory object that outlived its transaction,
 * and a crash between the decision and the action loses nothing.
 */
export async function executeApproved(now: Date, limit = 300, onlyCases?: string[]): Promise<ExecuteResult> {
  const result: ExecuteResult = { executed: 0, succeeded: 0, failed: 0, escalated: 0, replayed: 0, skipped: 0 };
  const pending = await pendingExecutions(limit, onlyCases);

  for (const p of pending) {
    const stored = p.reasons as { input?: PolicyInput; human_approval?: unknown };
    if (!stored.input) {
      result.skipped += 1;
      continue;
    }
    const decision = evaluatePolicy(stored.input);
    if (decision.inputHash !== p.input_hash) {
      // The stored input no longer hashes to what was decided — a policy
      // version change, or a tampered row. Either way, not ours to execute.
      log.warn('stored decision does not reproduce, skipping', { decisionId: p.decision_id });
      result.skipped += 1;
      continue;
    }
    const action = approve(stored.input, decision, stored.human_approval !== undefined);
    if (!action) {
      log.warn('stored ALLOW no longer approves, skipping', { decisionId: p.decision_id, verdict: decision.verdict });
      result.skipped += 1;
      continue;
    }

    let r: ExecutionResult;
    try {
      r = await executor.execute(action, p.decision_id, now);
    } catch (err) {
      // One action failing must not stop the rest: the row is left RESERVED or
      // SENT and the next sweep sees it as done — a person reads the log.
      log.error('executor threw', { decisionId: p.decision_id, err });
      result.skipped += 1;
      continue;
    }
    result.executed += 1;
    if (r.replayed) result.replayed += 1;
    else if (r.action.status === 'SUCCEEDED') result.succeeded += 1;
    else if (r.action.status === 'FAILED') result.failed += 1;
    else result.escalated += 1;
  }

  if (result.executed > 0 || result.skipped > 0) log.info('executor', { ...result });
  return result;
}

/** Gate, then act: the two halves of §9's "agent proposes → POLICY GATE → executor". */
export async function runGate(now: Date, limit = 300, onlyCases?: string[]): Promise<{ gate: GateResult; execute: ExecuteResult }> {
  const gate = await gateOpenCases(now, limit, onlyCases);
  const execute = await executeApproved(now, limit, onlyCases);
  return { gate, execute };
}
