import { Hono } from 'hono';
import { actionStats, actionsForCase, candidateForPayment, caseStats, getCase, listCases } from '../../db/queries.ts';
import { baselineOdds } from '../../domain/recovery-model.ts';
import { decide, featuresOf } from '../../app/recovery.ts';
import { approveCase, rejectCase } from '../../app/policy.ts';
import { executor } from '../../app/executor.ts';
import { decisionsForCase } from '../../db/queries.ts';
import { runner } from '../../sim/runner.ts';
import { NotFoundError, ValidationError } from '../../lib/errors.ts';
import type { AppEnv } from '../app.ts';

export const cases = new Hono<AppEnv>();

const STATUSES = ['OPEN', 'ACTING', 'RECOVERED', 'LOST', 'ABANDONED_BY_POLICY'];

cases.get('/api/v1/cases', async (c) => {
  const status = c.req.query('status')?.toUpperCase() ?? null;
  if (status && !STATUSES.includes(status)) {
    throw new ValidationError(`unknown status ${status}`, { allowed: STATUSES });
  }
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100)));

  const [rows, stats, actions] = await Promise.all([listCases(status, limit), caseStats(), actionStats()]);

  return c.json({
    cases: rows,
    stats: {
      open: stats.open,
      total: stats.total,
      expected_recoverable_paise: stats.expected_recoverable_paise,
      actions,
      // Every probability carries the scorer that produced it, and the UI shows
      // it (§7.5). A prediction with no source is a number nobody can weigh.
      probability_source_mix: { model: stats.model, baseline: stats.baseline },
    },
  });
});

cases.get('/api/v1/cases/:id', async (c) => {
  const id = c.req.param('id');
  const row = await getCase(id);
  if (!row) throw new NotFoundError('case', id);

  // The odds behind the probability, computed from the same inputs the case was
  // opened with. The expected-value comparison and the choice arrive in P11.
  const candidate = await candidateForPayment(row.payment_id);
  const features = candidate ? featuresOf(candidate) : null;
  // Recomputed live rather than read from the stored JSON, so what the page
  // shows always reflects the current scorer — and the stored copy is there to
  // audit what was decided at the time.
  const decision = candidate ? decide(candidate, row.recovery_probability) : null;

  const [policyDecisions, actions] = await Promise.all([decisionsForCase(id), actionsForCase(id)]);

  return c.json({
    case: row,
    features,
    odds: features ? baselineOdds(features) : null,
    policy: policyDecisions,
    actions,
    decision: decision
      ? {
          chosen: decision.chosen.strategy,
          customer_multiplier: decision.customerMultiplier,
          options: decision.options,
        }
      : null,
    decided_at_open: row.strategy_options,
  });
});

/** Simulated time, so a human approval lands on the clock the budgets use. */
const simNow = () => new Date(runner.state().clock.now);

/** Resolves a REQUIRE_APPROVAL, then executes (§10). */
cases.post('/api/v1/cases/:id/approve', async (c) => {
  const id = c.req.param('id');
  const now = simNow();
  const { action, decisionId } = await approveCase(id, now);
  const r = await executor.execute(action, decisionId, now);
  return c.json({
    approved: true,
    decision_id: decisionId,
    action: {
      id: r.action.id,
      kind: action.kind,
      strategy: action.strategy,
      approved_by: action.approvedBy,
      status: r.action.status,
      attempts: r.action.attempts,
      idempotency_key: r.action.idempotency_key,
      gateway_reference: r.action.gateway_reference,
      error_class: r.action.error_class,
      reconciled: r.reconciled,
      recovered: r.gateway?.recovered ?? null,
    },
  });
});

cases.post('/api/v1/cases/:id/reject', async (c) => {
  const id = c.req.param('id');
  const decisionId = await rejectCase(id, simNow());
  return c.json({ rejected: true, decision_id: decisionId });
});
