import { randomUUID } from 'node:crypto';
import { sql } from '../db/client.ts';
import { activeModelVersion, insertSimulation, latestSimulation, segmentTotals, whatIfRows } from '../db/queries.ts';
import { failureFamily } from '../domain/failure-codes.ts';
import { POLICY_VERSION } from '../domain/policy.ts';
import { predict } from '../domain/recovery-model.ts';
import { compare, type WhatIfComparison, type WhatIfRow } from '../domain/whatif.ts';
import { featuresOf, loadActiveModel } from '../app/recovery.ts';
import { log } from '../lib/logger.ts';

/**
 * BASELINE vs AGENT on the held-out split (§8.7) — the closing number.
 *
 * No gateway calls, no clock: both arms are folds over the same rows against
 * the labels decided at generation time. The result is stored as two
 * `simulations` rows sharing a `run_id`, and printed as the table the spec
 * shows when run as `bun whatif`.
 */

export interface WhatIfRun {
  run_id: string;
  ran_at: string;
  params: {
    split: 'test';
    rows: number;
    window: { from: string; to: string };
    model_id: string | null;
    scorer: 'model' | 'baseline';
    policy_version: string;
  };
  comparison: WhatIfComparison;
}

export async function runWhatIf(): Promise<WhatIfRun> {
  const source = await whatIfRows();
  if (source.length === 0) throw new Error('no held-out rows — run bun seed or a replay, then bun train');

  const model = await loadActiveModel();
  const active = await activeModelVersion();
  const rows: WhatIfRow[] = source.map((r) => {
    const f = featuresOf(r);
    return {
      id: r.id,
      merchantId: r.merchant_id,
      createdAt: new Date(r.created_at).toISOString(),
      isInternational: r.is_international,
      amountPaise: r.amount_paise,
      attemptIndex: r.attempt_index,
      failureCode: f.failureCode,
      failureFamily: failureFamily(f.failureCode),
      optedOut: r.opted_out,
      lifetimeValuePaise: r.lifetime_value_paise,
      features: f,
      labels: { retry: r.recoverable_by_retry, link: r.recoverable_by_link, alternate: r.recoverable_by_alternate, gateway: r.recoverable_by_gateway },
      merchant: { isPaused: r.is_paused, dailyActionBudgetPaise: r.daily_action_budget_paise, dailyActionBudgetCount: r.daily_action_budget_count },
    };
  });

  const window = { from: rows[0]!.createdAt, to: rows[rows.length - 1]!.createdAt };
  const totals = await segmentTotals(window.from, window.to);
  const comparison = compare(rows, (f) => predict(f, model), totals);

  const run: WhatIfRun = {
    run_id: `wi_${randomUUID().slice(0, 12)}`,
    ran_at: new Date().toISOString(),
    params: { split: 'test', rows: rows.length, window, model_id: active?.id ?? null, scorer: model ? 'model' : 'baseline', policy_version: POLICY_VERSION },
    comparison,
  };

  await sql.begin(async (tx) => {
    const params = { run_id: run.run_id, ran_at: run.ran_at, ...run.params };
    await insertSimulation({ id: `${run.run_id}_baseline`, kind: 'baseline', params, results: comparison.baseline }, tx);
    await insertSimulation({ id: `${run.run_id}_agent`, kind: 'agent', params, results: { ...comparison.agent, incremental_revenue_paise: comparison.incrementalRevenuePaise, interventions_avoided: comparison.interventionsAvoided, acceptance: comparison.acceptance } }, tx);
  });

  log.info('what-if complete', {
    runId: run.run_id,
    rows: rows.length,
    baselineRecovered: comparison.baseline.recovered,
    agentRecovered: comparison.agent.recovered,
    incrementalPaise: comparison.incrementalRevenuePaise,
  });
  return run;
}

/** Rebuilds the last stored run from its two rows. */
export async function lastWhatIf(): Promise<WhatIfRun | null> {
  const pair = await latestSimulation();
  if (!pair) return null;
  const params = pair.agent.params as { run_id: string; ran_at: string } & WhatIfRun['params'];
  const agent = pair.agent.results as WhatIfComparison['agent'] & { incremental_revenue_paise: number; interventions_avoided: number; acceptance: WhatIfComparison['acceptance'] };
  const baseline = pair.baseline.results as WhatIfComparison['baseline'];
  return {
    run_id: params.run_id,
    ran_at: params.ran_at,
    params: { split: params.split, rows: params.rows, window: params.window, model_id: params.model_id, scorer: params.scorer, policy_version: params.policy_version },
    comparison: {
      rows: params.rows,
      baseline,
      agent,
      incrementalRevenuePaise: agent.incremental_revenue_paise,
      interventionsAvoided: agent.interventions_avoided,
      acceptance: agent.acceptance,
    },
  };
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

export function renderTable(run: WhatIfRun): string {
  const c = run.comparison;
  const b = c.baseline;
  const a = c.agent;
  const line = (label: string, x: string, y: string) => `${label.padEnd(28)}${x.padStart(12)}${y.padStart(12)}`;
  const out = [
    `What-if on the held-out test split — ${c.rows} failed payments, ${run.params.window.from.slice(0, 10)} → ${run.params.window.to.slice(0, 10)}`,
    `scorer ${run.params.scorer}${run.params.model_id ? ` (${run.params.model_id})` : ''} · policy ${run.params.policy_version} · run ${run.run_id}`,
    '',
    line('', 'BASELINE', 'AGENT'),
    line('Failed payments', String(b.failed), String(a.failed)),
    line('Interventions attempted', String(b.attempted), String(a.attempted)),
    line('Recovered', String(b.recovered), String(a.recovered)),
    line('Recovery rate', pct(b.recoveryRate), pct(a.recoveryRate)),
    line('Intervention cost', rupees(b.costPaise), rupees(a.costPaise)),
    line('Revenue recovered', rupees(b.revenueRecoveredPaise), rupees(a.revenueRecoveredPaise)),
    '─'.repeat(52),
    line('Incremental revenue', '', rupees(c.incrementalRevenuePaise)),
    line('Interventions avoided', '', `${c.interventionsAvoided} (${b.attempted > 0 ? ((c.interventionsAvoided / b.attempted) * 100).toFixed(0) : '0'}%)`),
    '',
    line('INTERNATIONAL ONLY', 'BASELINE', 'AGENT'),
    line('Failed payments', String(b.international.failed), String(a.international.failed)),
    line('Recovered', String(b.international.recovered), String(a.international.recovered)),
    line('Acceptance after recovery', pct(c.acceptance.international.baseline), pct(c.acceptance.international.agent)),
    line('Revenue recovered', rupees(b.international.revenueRecoveredPaise), rupees(a.international.revenueRecoveredPaise)),
    '',
    `Agent declined: ${a.declined.doNothing} do_nothing · ${a.declined.denied} denied · ${a.declined.deferred} deferred (capacity) · ${a.requiredApproval} of its attempts would need a human's signature`,
    `By strategy (attempted/recovered): ${(['retry', 'alternate_gateway', 'payment_link', 'alternate_method'] as const).map((s) => `${s} ${a.byStrategy[s].attempted}/${a.byStrategy[s].recovered}`).join(' · ')}`,
    '',
    'Simulation over recorded counterfactuals, not a live result. Both arms saw the same rows;',
    'outcomes come from labels decided before either arm ran; held-out split only.',
  ];
  return out.join('\n');
}

if (import.meta.main) {
  try {
    const run = await runWhatIf();
    console.log(renderTable(run));
  } catch (err) {
    log.error('what-if failed', { err });
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
