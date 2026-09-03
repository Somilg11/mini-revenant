import { randomUUID } from 'node:crypto';
import { sql } from '../db/client.ts';
import { notify } from '../db/notify.ts';
import {
  agentPendingCases,
  candidateForPayment,
  incidentsAwaitingNarrative,
  insertAgentDecision,
  openIncidentForPayment,
  setIncidentNarrative,
  type IncidentRow,
} from '../db/queries.ts';
import {
  CASE_SYSTEM_PROMPT,
  INCIDENT_SYSTEM_PROMPT,
  IncidentNarrativeSchema,
  ProposalSchema,
  buildCasePrompt,
  buildIncidentPrompt,
  promptHash,
  reconcile,
  templateIncidentNarrative,
  type CaseContext,
  type IncidentContext,
} from '../domain/agent.ts';
import { failureFamily } from '../domain/failure-codes.ts';
import type { Hypothesis } from '../domain/rca.ts';
import type { StrategyOption } from '../domain/strategy.ts';
import { generateStructured } from '../lib/llm.ts';
import { log } from '../lib/logger.ts';
import { decide, featuresOf } from './recovery.ts';

/**
 * The agent (§7.8) — LLM at the edge.
 *
 *   LLM ──► structured proposal ──► POLICY ENGINE ──► executor
 *
 * Read tools are pure lookups; the only write is a proposal, and a proposal
 * is an input to the gate, not an action. The model receives already-computed
 * context and returns a closed-enum choice plus prose. On *every* failure mode
 * — provider off, no key, timeout, off-schema output, transport error — the
 * strategy engine's argmax stands with a templated narrative and
 * `source = 'fallback'`. The pipeline is correct with the LLM switched off.
 *
 * Every call is written to `agent_decisions` with a prompt hash, so what the
 * model was asked can be recomputed from stored inputs.
 */

/** Calls in flight at once. Bounded so a slow provider cannot pin the pool. */
const CONCURRENCY = 6;

export interface AgentResult {
  proposed: number;
  llm: number;
  fallback: number;
  overridden: number;
  changed: number;
}

async function contextFor(c: Awaited<ReturnType<typeof agentPendingCases>>[number]): Promise<CaseContext | null> {
  const candidate = await candidateForPayment(c.payment_id);
  if (!candidate) return null;
  const f = featuresOf(candidate);
  const decision = decide(candidate, c.recovery_probability);
  const incident = f.incidentActive ? await openIncidentForPayment(candidate) : null;
  const top = incident ? ((incident.root_cause as { hypotheses?: Hypothesis[] } | null)?.hypotheses?.[0] ?? null) : null;
  return {
    caseId: c.case_id,
    paymentId: c.payment_id,
    amountPaise: candidate.amount_paise,
    method: candidate.method,
    bank: candidate.bank,
    cardNetwork: candidate.card_network,
    isInternational: candidate.is_international,
    failureCode: f.failureCode,
    failureFamily: failureFamily(f.failureCode),
    attemptIndex: f.attemptIndex,
    customer: {
      priorAttempts: candidate.customer_prior_attempts,
      priorSuccessRate: candidate.customer_prior_attempts > 0 ? candidate.customer_prior_successes / candidate.customer_prior_attempts : null,
      lifetimeValuePaise: candidate.lifetime_value_paise,
      optedOut: candidate.opted_out,
    },
    probability: c.recovery_probability,
    probabilitySource: c.probability_source,
    decision,
    incident: incident
      ? { dimension: incident.dimension, dimensionValue: incident.dimension_value, topHypothesis: top?.label ?? null, zScore: incident.z_score }
      : null,
  };
}

async function proposeOne(c: Awaited<ReturnType<typeof agentPendingCases>>[number], now: Date, result: AgentResult): Promise<void> {
  const ctx = await contextFor(c);
  if (!ctx) return;

  const prompt = buildCasePrompt(ctx);
  const hash = promptHash(CASE_SYSTEM_PROMPT, prompt);
  const answer = await generateStructured({ schema: ProposalSchema, system: CASE_SYSTEM_PROMPT, prompt });
  const r = reconcile(answer?.value ?? null, ctx);

  const chosen: StrategyOption = ctx.decision.options.find((o) => o.strategy === r.choice) ?? ctx.decision.chosen;
  const changed = chosen.strategy !== (c.chosen_strategy ?? ctx.decision.chosen.strategy);
  const id = `ad_${randomUUID().slice(0, 12)}`;

  await sql.begin(async (tx) => {
    await insertAgentDecision(
      {
        id,
        case_id: ctx.caseId,
        incident_id: null,
        prompt_hash: hash,
        raw_response: answer?.rawText ?? null,
        parsed_choice: r.proposed,
        rejected_reason: r.rejectedReason,
        source: r.source,
        latency_ms: answer?.latencyMs ?? null,
        narrative: r.narrative,
        confidence: r.confidence,
        created_at: now.toISOString(),
      },
      tx,
    );
    if (changed) {
      // The model may pick among the options that make money; when it does,
      // the case carries its choice and the gate judges that.
      await tx`
        UPDATE recovery_cases SET chosen_strategy = ${chosen.strategy}, expected_value_paise = ${chosen.expectedValuePaise}
        WHERE id = ${ctx.caseId} AND status = 'OPEN'`;
    }
    await notify(tx, 'case.opened', {
      agent_decision_id: id,
      case_id: ctx.caseId,
      payment_id: ctx.paymentId,
      choice: chosen.strategy,
      source: r.source,
      confidence: r.confidence,
      overridden: r.rejectedReason !== null,
      expected_value_paise: chosen.expectedValuePaise,
    });
  });

  result.proposed += 1;
  result[r.source] += 1;
  if (r.rejectedReason) result.overridden += 1;
  if (changed) result.changed += 1;
}

/** Runs `fn` over `items` with at most `n` in flight. */
async function pooled<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** Proposes for every open case the agent has not yet seen. */
export async function proposeForCases(now: Date, limit = 300): Promise<AgentResult> {
  const result: AgentResult = { proposed: 0, llm: 0, fallback: 0, overridden: 0, changed: 0 };
  const pending = await agentPendingCases(limit);
  await pooled(pending, CONCURRENCY, async (c) => {
    try {
      await proposeOne(c, now, result);
    } catch (err) {
      // One case failing must not stop the rest; it stays on the worklist.
      log.error('agent proposal failed', { caseId: c.case_id, err });
    }
  });
  if (result.proposed > 0) log.info('agent proposed', { ...result });
  return result;
}

function incidentContext(i: IncidentRow): IncidentContext {
  const rc = i.root_cause as { hypotheses?: Hypothesis[] } | null;
  return {
    incidentId: i.id,
    dimension: i.dimension,
    dimensionValue: i.dimension_value,
    baselineRate: i.baseline_rate,
    currentRate: i.current_rate,
    zScore: i.z_score,
    affectedPayments: i.affected_payments,
    revenueAtRiskPaise: i.revenue_at_risk_paise,
    status: i.status,
    hypotheses: (rc?.hypotheses ?? []).map((h) => ({
      label: h.label,
      excessShare: h.excessShare,
      confidence: h.confidence,
      observedRate: h.observedRate,
      expectedRate: h.expectedRate,
    })),
  };
}

/**
 * Writes a narrative for every diagnosed incident that lacks one. `llm` when
 * the model answered on schema and in time, `template` otherwise — and the
 * badge says which (§14).
 */
export async function narrateIncidents(now: Date, limit = 50): Promise<{ narrated: number; llm: number; template: number }> {
  const result = { narrated: 0, llm: 0, template: 0 };
  const pending = await incidentsAwaitingNarrative(limit);
  await pooled(pending, CONCURRENCY, async (incident) => {
    try {
      const ctx = incidentContext(incident);
      const prompt = buildIncidentPrompt(ctx);
      const hash = promptHash(INCIDENT_SYSTEM_PROMPT, prompt);
      const answer = await generateStructured({ schema: IncidentNarrativeSchema, system: INCIDENT_SYSTEM_PROMPT, prompt });
      const source = answer ? 'llm' : 'template';
      const narrative = answer?.value.narrative ?? templateIncidentNarrative(ctx);
      await sql.begin(async (tx) => {
        await setIncidentNarrative(incident.id, narrative, source, tx);
        await insertAgentDecision(
          {
            id: `ad_${randomUUID().slice(0, 12)}`,
            case_id: null,
            incident_id: incident.id,
            prompt_hash: hash,
            raw_response: answer?.rawText ?? null,
            parsed_choice: null,
            rejected_reason: null,
            source: answer ? 'llm' : 'fallback',
            latency_ms: answer?.latencyMs ?? null,
            narrative,
            confidence: null,
            created_at: now.toISOString(),
          },
          tx,
        );
      });
      result.narrated += 1;
      result[source] += 1;
    } catch (err) {
      log.error('incident narrative failed', { incidentId: incident.id, err });
    }
  });
  if (result.narrated > 0) log.info('incidents narrated', { ...result });
  return result;
}
