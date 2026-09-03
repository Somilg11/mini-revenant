import { createHash } from 'node:crypto';
import { z } from 'zod';
import { STRATEGIES, type Strategy } from './recovery-model.ts';
import type { StrategyDecision, StrategyOption } from './strategy.ts';

/**
 * The agent's contract (§7.8) — the pure half.
 *
 * The LLM sits at the edge. It receives **already-computed** context and
 * returns a value from a closed enum plus prose. It never produces a number
 * and never executes. Everything here is deterministic: the prompt is a pure
 * function of the context (so its hash is an audit key), the schema is what
 * the SDK enforces, and `reconcile` is the one place a model's opinion meets
 * the strategy engine's arithmetic.
 *
 * Prompt injection is assumed. A narrative can say anything; the policy
 * engine reads structured fields only, and the only structured field the
 * model controls is `choice` — which `reconcile` refuses whenever the
 * arithmetic says it loses money.
 */

export const CONFIDENCE = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** What the model may return. Anything off this shape never becomes a value. */
export const ProposalSchema = z.object({
  choice: z.enum(STRATEGIES),
  confidence: z.enum(CONFIDENCE),
  narrative: z.string().min(1).max(600),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const IncidentNarrativeSchema = z.object({
  narrative: z.string().min(1).max(600),
});

export type AgentSource = 'llm' | 'fallback';

export interface CaseContext {
  caseId: string;
  paymentId: string;
  amountPaise: number;
  method: string;
  bank: string | null;
  cardNetwork: string | null;
  isInternational: boolean;
  failureCode: string;
  failureFamily: string;
  attemptIndex: number;
  customer: { priorAttempts: number; priorSuccessRate: number | null; lifetimeValuePaise: number; optedOut: boolean };
  probability: number | null;
  probabilitySource: 'model' | 'baseline' | null;
  decision: StrategyDecision;
  incident: { dimension: string; dimensionValue: string; topHypothesis: string | null; zScore: number } | null;
}

export interface IncidentContext {
  incidentId: string;
  dimension: string;
  dimensionValue: string;
  baselineRate: number;
  currentRate: number;
  zScore: number;
  affectedPayments: number;
  revenueAtRiskPaise: number;
  hypotheses: { label: string; excessShare: number; confidence: number; observedRate: number; expectedRate: number }[];
  status: 'OPEN' | 'RESOLVED';
}

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
const pct = (p: number | null) => (p === null ? 'unknown' : `${Math.round(p * 100)}%`);

export const CASE_SYSTEM_PROMPT = [
  'You advise a payment-recovery system for an Indian merchant.',
  'You receive computed facts about one failed payment and five intervention options, each with an expected value in paise already calculated.',
  'Choose exactly one option by name. You may only choose from the list. You never invent numbers; if you cite a figure, it must be one given to you.',
  'A deterministic policy engine reviews your choice; you cannot approve, execute, or override anything.',
  'Prefer do_nothing whenever no option clears zero, or when acting would annoy a customer for a small amount.',
  'Reply with a short narrative (two to four sentences, plain language, for a human operator) explaining the choice.',
].join(' ');

export const INCIDENT_SYSTEM_PROMPT = [
  'You write a short incident summary for a payment operations team.',
  'You receive computed detection and root-cause facts. You never invent numbers; cite only figures you were given.',
  'Three to five sentences, plain language: what degraded, by how much against baseline, the most likely cause and how confident the analysis is, and what an operator should look at.',
].join(' ');

function optionLine(o: StrategyOption): string {
  return `- ${o.strategy}: expected value ${o.expectedValuePaise} paise (${rupees(o.expectedValuePaise)}), P=${pct(o.probability)}, cost ${o.costPaise} paise${o.available ? '' : ', NOT AVAILABLE'} — ${o.rationale}`;
}

/** Deterministic: the same context always yields the same prompt, so its hash is an audit key. */
export function buildCasePrompt(ctx: CaseContext): string {
  const lines = [
    `Payment ${ctx.paymentId}: ${rupees(ctx.amountPaise)} (${ctx.amountPaise} paise) via ${ctx.method}${ctx.bank ? ` / ${ctx.bank}` : ''}${ctx.cardNetwork ? ` / ${ctx.cardNetwork}` : ''}${ctx.isInternational ? ', international card' : ', domestic'}.`,
    `Failure: ${ctx.failureCode} (family ${ctx.failureFamily}), attempt ${ctx.attemptIndex}.`,
    `Customer: ${ctx.customer.priorAttempts} prior attempts, prior success rate ${pct(ctx.customer.priorSuccessRate)}, lifetime value ${rupees(ctx.customer.lifetimeValuePaise)}${ctx.customer.optedOut ? ', OPTED OUT of contact' : ''}.`,
    `Recovery probability: ${pct(ctx.probability)} (source: ${ctx.probabilitySource ?? 'none'}).`,
    ctx.incident
      ? `Live incident on ${ctx.incident.dimension}=${ctx.incident.dimensionValue} (z=${ctx.incident.zScore.toFixed(1)})${ctx.incident.topHypothesis ? `, top hypothesis: ${ctx.incident.topHypothesis}` : ''}.`
      : 'No live incident on this slice.',
    'Options (the strategy engine currently prefers ' + ctx.decision.chosen.strategy + '):',
    ...ctx.decision.options.map(optionLine),
    'Choose one option name from: ' + STRATEGIES.join(', ') + '.',
  ];
  return lines.join('\n');
}

export function buildIncidentPrompt(ctx: IncidentContext): string {
  const lines = [
    `Incident ${ctx.incidentId} (${ctx.status}) on ${ctx.dimension}=${ctx.dimensionValue}.`,
    `Failure rate ${pct(ctx.currentRate)} against a baseline of ${pct(ctx.baselineRate)}, z-score ${ctx.zScore.toFixed(1)}.`,
    `${ctx.affectedPayments} payments affected, ${rupees(ctx.revenueAtRiskPaise)} at risk.`,
    'Ranked root-cause hypotheses (share of the excess failures they explain):',
    ...ctx.hypotheses.slice(0, 5).map((h, i) => `${i + 1}. ${h.label}: ${Math.round(h.excessShare * 100)}% of the excess, observed ${pct(h.observedRate)} vs expected ${pct(h.expectedRate)}, confidence ${Math.round(h.confidence * 100)}%`),
  ];
  return lines.join('\n');
}

export function promptHash(system: string, prompt: string): string {
  return createHash('sha256').update(system).update('\n---\n').update(prompt).digest('hex');
}

export interface Reconciled {
  choice: Strategy;
  source: AgentSource;
  confidence: Confidence;
  narrative: string;
  /** Set when the model's choice was refused and the engine's used instead. */
  rejectedReason: string | null;
  /** What the model said before reconciliation, for the audit row. */
  proposed: Strategy | null;
}

/**
 * Where the model's opinion meets the arithmetic.
 *
 * - No proposal (provider off, no key, timeout, off-schema, transport error)
 *   ⇒ the strategy engine's argmax and a templated narrative, `fallback`.
 * - A proposal whose option is unavailable, or whose EV ≤ 0, is overridden to
 *   the engine's choice and the reason recorded — the model may pick among
 *   the options that make money, never one that loses it.
 * - Otherwise the model's choice stands, with its narrative.
 */
export function reconcile(proposal: Proposal | null, ctx: CaseContext): Reconciled {
  const engine = ctx.decision.chosen.strategy;
  if (!proposal) {
    return { choice: engine, source: 'fallback', confidence: 'medium', narrative: templateCaseNarrative(ctx), rejectedReason: null, proposed: null };
  }
  const option = ctx.decision.options.find((o) => o.strategy === proposal.choice);
  if (!option) {
    return { choice: engine, source: 'fallback', confidence: 'medium', narrative: templateCaseNarrative(ctx), rejectedReason: `choice ${proposal.choice} is not an option on this case`, proposed: proposal.choice };
  }
  if (proposal.choice !== 'do_nothing' && !option.available) {
    return { choice: engine, source: 'fallback', confidence: 'medium', narrative: templateCaseNarrative(ctx), rejectedReason: `${proposal.choice} is not available: ${option.rationale}`, proposed: proposal.choice };
  }
  if (proposal.choice !== 'do_nothing' && option.expectedValuePaise <= 0) {
    return { choice: engine, source: 'fallback', confidence: 'medium', narrative: templateCaseNarrative(ctx), rejectedReason: `${proposal.choice} has expected value ${option.expectedValuePaise} paise — never act at a loss`, proposed: proposal.choice };
  }
  if (proposal.choice === 'do_nothing' && ctx.decision.chosen.expectedValuePaise > 0) {
    // The model may decline to act only when the arithmetic agrees nothing is
    // worth it. Leaving money on the table on a hunch is an override too.
    return { choice: engine, source: 'fallback', confidence: 'medium', narrative: templateCaseNarrative(ctx), rejectedReason: `do_nothing proposed while ${engine} clears ${ctx.decision.chosen.expectedValuePaise} paise`, proposed: proposal.choice };
  }
  return { choice: proposal.choice, source: 'llm', confidence: proposal.confidence, narrative: proposal.narrative, rejectedReason: null, proposed: proposal.choice };
}

const STRATEGY_PHRASE: Record<Strategy, string> = {
  retry: 'retry the payment on the same route',
  alternate_gateway: 'send the same card through the secondary processor',
  payment_link: 'send the customer a payment link',
  alternate_method: 'ask the customer for another payment method',
  do_nothing: 'leave this payment alone',
};

/** The deterministic narrative. Every figure in it is one the engine computed. */
export function templateCaseNarrative(ctx: CaseContext): string {
  const chosen = ctx.decision.chosen;
  const runnerUp = ctx.decision.options
    .filter((o) => o.strategy !== chosen.strategy && o.available)
    .sort((a, b) => b.expectedValuePaise - a.expectedValuePaise)[0];
  const head = `${rupees(ctx.amountPaise)} ${ctx.method}${ctx.isInternational ? ' international' : ''} payment failed with ${ctx.failureCode} on attempt ${ctx.attemptIndex}; recovery probability ${pct(ctx.probability)}${ctx.probabilitySource ? ` (${ctx.probabilitySource})` : ''}.`;
  if (chosen.strategy === 'do_nothing') {
    return `${head} No intervention clears zero after cost and friction${runnerUp ? ` — the best, ${runnerUp.strategy}, comes to ${rupees(runnerUp.expectedValuePaise)}` : ''}, so the recommendation is to ${STRATEGY_PHRASE.do_nothing}.`;
  }
  return `${head} Recommendation: ${STRATEGY_PHRASE[chosen.strategy]}, expected value ${rupees(chosen.expectedValuePaise)} at ${pct(chosen.probability)}${runnerUp ? `, ahead of ${runnerUp.strategy} at ${rupees(runnerUp.expectedValuePaise)}` : ''}.${ctx.incident ? ` A live incident on ${ctx.incident.dimension}=${ctx.incident.dimensionValue} was taken into account.` : ''}`;
}

export function templateIncidentNarrative(ctx: IncidentContext): string {
  const top = ctx.hypotheses[0];
  const second = ctx.hypotheses[1];
  const lift = ctx.baselineRate > 0 ? ` — ${(ctx.currentRate / ctx.baselineRate).toFixed(1)}× baseline` : '';
  return [
    `Failure rate on ${ctx.dimension}=${ctx.dimensionValue} reached ${pct(ctx.currentRate)} against a baseline of ${pct(ctx.baselineRate)}${lift} (z=${ctx.zScore.toFixed(1)}), affecting ${ctx.affectedPayments} payments with ${rupees(ctx.revenueAtRiskPaise)} at risk.`,
    top
      ? `The most likely cause is ${top.label}, carrying ${Math.round(top.excessShare * 100)}% of the excess failures (observed ${pct(top.observedRate)} vs expected ${pct(top.expectedRate)}, confidence ${Math.round(top.confidence * 100)}%)${second ? `; ${second.label} is next at ${Math.round(second.excessShare * 100)}%` : ''}.`
      : 'No single slice explains the excess; the degradation is spread across the dimension.',
    ctx.status === 'RESOLVED' ? 'The incident has since resolved.' : 'The incident is still open.',
  ].join(' ');
}
