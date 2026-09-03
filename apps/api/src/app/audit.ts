import {
  actionsForCases,
  agentDecisionsForCases,
  casesForPayment,
  eventsForPayment,
  incidentsTouchingPayment,
  paymentById,
  policyDecisionsForCases,
  transitionsForPayment,
  verificationsForCases,
  type PaymentRow,
} from '../db/queries.ts';
import { evaluatePolicy, type PolicyInput, type RuleResult } from '../domain/policy.ts';
import type { Hypothesis } from '../domain/rca.ts';
import type { StrategyOption } from '../domain/strategy.ts';
import { NotFoundError } from '../lib/errors.ts';

/**
 * The chain of custody for one payment (§10 `GET /audit/:paymentId`, §11.2):
 *
 *   EVENT → DETECTION → DIAGNOSIS → AGENT DECISION → POLICY → ACTION → OUTCOME
 *
 * Every node carries its timestamp, its inputs and the artefact it produced,
 * in causal order. The page exists to make one claim — every number on it is
 * reproducible from stored inputs — so where a stage stored its inputs
 * (policy decisions store the full `PolicyInput`; strategy options store the
 * arithmetic), the stage is **recomputed here** and the result compared,
 * rather than asserted.
 */

export type Stage = 'event' | 'transition' | 'detection' | 'diagnosis' | 'case' | 'agent' | 'policy' | 'action' | 'outcome';

export interface AuditNode {
  stage: Stage;
  /** Simulated time the node happened. */
  at: string;
  id: string;
  title: string;
  /** What the stage was given. */
  inputs: Record<string, unknown>;
  /** What it produced. */
  artefact: Record<string, unknown>;
  /** Where a stage could be recomputed from what it stored, whether it reproduced. */
  reproduced?: { ok: boolean; detail: string } | undefined;
  /** Links for the page. */
  href?: string | undefined;
}

export interface AuditTrail {
  payment: PaymentRow;
  nodes: AuditNode[];
  counts: Partial<Record<Stage, number>>;
  /** Stages that stored their inputs and were recomputed on this request. */
  reproduced: { checked: number; ok: number };
}

/** TIMESTAMPTZ arrives as a Date from the driver; the trail speaks ISO strings. */
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

const STAGE_ORDER: Record<Stage, number> = {
  event: 0, transition: 1, detection: 2, diagnosis: 3, case: 4, agent: 5, policy: 6, action: 7, outcome: 8,
};

export async function auditTrail(paymentId: string): Promise<AuditTrail> {
  const payment = await paymentById(paymentId);
  if (!payment) throw new NotFoundError('payment', paymentId);

  const [events, transitions, incidents, cases] = await Promise.all([
    eventsForPayment(paymentId),
    transitionsForPayment(paymentId),
    incidentsTouchingPayment(payment),
    casesForPayment(paymentId),
  ]);
  const caseIds = cases.map((c) => c.id);
  const [agents, policies, actions, outcomes] = await Promise.all([
    agentDecisionsForCases(caseIds),
    policyDecisionsForCases(caseIds),
    actionsForCases(caseIds),
    verificationsForCases(caseIds),
  ]);

  const nodes: AuditNode[] = [];
  const reproduced = { checked: 0, ok: 0 };

  for (const e of events) {
    const t = transitions.find((x) => x.event_id === e.event_id);
    nodes.push({
      stage: 'event',
      at: iso(e.occurred_at),
      id: e.event_id,
      title: e.kind,
      inputs: { payload: e.payload, received_at: e.received_at },
      artefact: t
        ? { transition: `${t.from_state} → ${t.to_state}`, stale: t.stale }
        : { transition: null, note: 'no state change recorded for this event' },
    });
  }

  for (const i of incidents) {
    nodes.push({
      stage: 'detection',
      at: iso(i.opened_at),
      id: i.id,
      title: `${i.dimension}=${i.dimension_value} · z ${i.z_score.toFixed(1)}`,
      inputs: { baseline_rate: i.baseline_rate, current_rate: i.current_rate, gates: i.gates },
      artefact: {
        status: i.status,
        z_score: i.z_score,
        affected_payments: i.affected_payments,
        revenue_at_risk_paise: i.revenue_at_risk_paise,
        resolved_at: i.resolved_at,
      },
      href: `/incidents/${i.id}`,
    });
    const rc = i.root_cause as { hypotheses?: Hypothesis[]; incident_excess?: number; window?: unknown; baseline?: unknown } | null;
    const top = rc?.hypotheses?.[0];
    if (rc) {
      nodes.push({
        stage: 'diagnosis',
        at: iso(i.opened_at),
        id: `${i.id}:rca`,
        title: top ? `${top.label} · ${Math.round(top.excessShare * 100)}% of the excess` : 'no single slice explains the excess',
        inputs: { window: rc.window, baseline: rc.baseline, incident_excess: rc.incident_excess },
        artefact: {
          top_hypothesis: top ? { label: top.label, excess_share: top.excessShare, confidence: top.confidence, observed_rate: top.observedRate, expected_rate: top.expectedRate } : null,
          hypotheses: rc.hypotheses?.length ?? 0,
          narrative: i.narrative,
          narrative_source: i.narrative_source,
        },
        href: `/incidents/${i.id}`,
      });
    }
  }

  for (const c of cases) {
    const options = (c.strategy_options as StrategyOption[] | null) ?? [];
    const chosen = options.find((o) => o.strategy === c.chosen_strategy);
    // The EV arithmetic is stored beside its inputs: gross − cost − friction.
    let evCheck: AuditNode['reproduced'];
    if (chosen) {
      const recomputed = chosen.grossValuePaise - chosen.costPaise - chosen.frictionPaise;
      const ok = recomputed === chosen.expectedValuePaise && (c.expected_value_paise === null || c.expected_value_paise === chosen.expectedValuePaise);
      reproduced.checked += 1;
      if (ok) reproduced.ok += 1;
      evCheck = { ok, detail: `gross ${chosen.grossValuePaise} − cost ${chosen.costPaise} − friction ${chosen.frictionPaise} = ${recomputed} paise${ok ? '' : ` ≠ stored ${chosen.expectedValuePaise}`}` };
    }
    nodes.push({
      stage: 'case',
      at: iso(c.opened_at),
      id: c.id,
      title: `P(recovery) ${c.recovery_probability === null ? '—' : `${Math.round(c.recovery_probability * 100)}%`} (${c.probability_source ?? 'none'}) · ${c.chosen_strategy ?? '—'}`,
      inputs: { probability: c.recovery_probability, probability_source: c.probability_source, options: options.map((o) => ({ strategy: o.strategy, probability: o.probability, expected_value_paise: o.expectedValuePaise, available: o.available })) },
      artefact: { status: c.status, chosen_strategy: c.chosen_strategy, expected_value_paise: c.expected_value_paise, closed_at: c.closed_at },
      reproduced: evCheck,
      href: `/recovery/${c.id}`,
    });
  }

  for (const a of agents) {
    nodes.push({
      stage: 'agent',
      at: iso(a.created_at),
      id: a.id,
      title: `${a.source}${a.parsed_choice ? ` · proposed ${a.parsed_choice}` : ''}${a.rejected_reason ? ' · overridden' : ''}`,
      inputs: { prompt_hash: a.prompt_hash, latency_ms: a.latency_ms },
      artefact: { source: a.source, parsed_choice: a.parsed_choice, rejected_reason: a.rejected_reason, confidence: a.confidence, narrative: a.narrative },
      href: a.case_id ? `/recovery/${a.case_id}` : undefined,
    });
  }

  for (const d of policies) {
    const stored = d.reasons as { rules?: RuleResult[]; input?: PolicyInput; deferred?: boolean; human_approval?: unknown; human_rejection?: unknown };
    let check: AuditNode['reproduced'];
    if (stored.input) {
      // The claim, tested on every request: the decision is a pure function of
      // the input it stored. Re-evaluate and compare hash, verdict and rules.
      const again = evaluatePolicy(stored.input);
      const sameVerdict = again.verdict === d.verdict || (stored.human_approval !== undefined && again.verdict === 'REQUIRE_APPROVAL' && d.verdict === 'ALLOW');
      const sameRules = JSON.stringify(again.reasons.map((r) => [r.rule, r.passed])) === JSON.stringify((stored.rules ?? []).map((r) => [r.rule, r.passed]));
      const ok = again.inputHash === d.input_hash && sameVerdict && sameRules;
      reproduced.checked += 1;
      if (ok) reproduced.ok += 1;
      check = { ok, detail: ok ? `re-evaluated from the stored input: hash ${again.inputHash.slice(0, 8)}… matches, verdict ${again.verdict}${stored.human_approval !== undefined ? ' resolved by a human' : ''}, twelve rules identical` : `re-evaluation differs: hash ${again.inputHash.slice(0, 8)}… vs stored ${d.input_hash.slice(0, 8)}…, verdict ${again.verdict} vs ${d.verdict}` };
    }
    const failed = (stored.rules ?? []).filter((r) => !r.passed).map((r) => r.rule);
    nodes.push({
      stage: 'policy',
      at: iso(d.decided_at),
      id: d.id,
      title: `${d.verdict}${stored.deferred ? ' (deferred)' : ''} · ${d.proposed_action}${failed.length ? ` · rules ${failed.map((r) => `#${r}`).join(' ')}` : ''}`,
      inputs: { input: stored.input ?? null, input_hash: d.input_hash, policy_version: d.policy_version },
      artefact: { verdict: d.verdict, deferred: stored.deferred ?? false, rules: stored.rules ?? [], human_approval: stored.human_approval ?? null, human_rejection: stored.human_rejection ?? null },
      reproduced: check,
      href: `/recovery/${d.case_id}`,
    });
  }

  for (const a of actions) {
    nodes.push({
      stage: 'action',
      at: iso(a.created_at),
      id: a.id,
      title: `${a.status} · ${a.kind} · ${a.attempts} attempt${a.attempts === 1 ? '' : 's'}`,
      inputs: { policy_decision_id: a.policy_decision_id, idempotency_key: a.idempotency_key, cost_paise: a.cost_paise },
      artefact: { status: a.status, attempts: a.attempts, gateway_reference: a.gateway_reference, error_class: a.error_class, completed_at: a.completed_at },
      href: `/recovery/${a.case_id}`,
    });
  }

  for (const v of outcomes) {
    nodes.push({
      stage: 'outcome',
      at: iso(v.verified_at),
      id: v.id,
      title: v.actual_recovered ? `RECOVERED · ${v.attribution} · credited ${v.credited_amount_paise} paise` : 'LOST',
      inputs: { predicted_probability: v.predicted_probability },
      artefact: { attribution: v.attribution, actual_recovered: v.actual_recovered, recovered_amount_paise: v.recovered_amount_paise, credited_amount_paise: v.credited_amount_paise },
      href: `/recovery/${v.case_id}`,
    });
  }

  // Causal order: by simulated time, then by stage — several stages can share
  // an instant (a sweep opens, proposes, gates and executes at one `now`).
  nodes.sort((x, y) => x.at.localeCompare(y.at) || STAGE_ORDER[x.stage] - STAGE_ORDER[y.stage] || x.id.localeCompare(y.id));

  const counts: Partial<Record<Stage, number>> = {};
  for (const n of nodes) counts[n.stage] = (counts[n.stage] ?? 0) + 1;

  return { payment, nodes, counts, reproduced };
}
