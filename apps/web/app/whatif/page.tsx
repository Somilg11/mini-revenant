import Link from 'next/link';
import { fetchWhatIf } from '@/lib/api';
import { formatInrCompact, formatCount, exactPaise } from '@/lib/format';
import { WhatIfTable } from '@/components/WhatIfTable';
import { WhatIfRunButton } from '@/components/WhatIfRunButton';

export const dynamic = 'force-dynamic';

/**
 * `/whatif` — the closing screen (§8.7, §11.2).
 *
 * The incremental revenue as the single large figure, the BASELINE vs AGENT
 * table, a bar pair for recovered revenue, the intervention counts beneath
 * (the agent acting *less* is the point), and the honesty banner: held-out
 * split, pre-decided counterfactuals, simulation not live result.
 */
export default async function WhatIfPage() {
  const run = await fetchWhatIf();

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 24px 64px' }}>
      <header style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
        <div>
          <Link href="/" style={{ color: 'var(--text-tertiary)', fontSize: 11, textDecoration: 'none' }}>← Command Center</Link>
          <h1 className="section-title" style={{ margin: '6px 0 0' }}>What if — the same history under a different policy</h1>
          {run && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }} className="mono">
              held-out test split · {formatCount(run.params.rows)} failed payments · {run.params.window.from.slice(0, 10)} → {run.params.window.to.slice(0, 10)} · scorer {run.params.scorer}{run.params.model_id ? ` (${run.params.model_id})` : ''} · policy {run.params.policy_version} · run {run.run_id} at {run.ran_at.replace('T', ' ').slice(0, 19)} UTC
            </div>
          )}
        </div>
        <WhatIfRunButton label={run ? 'Run again' : 'Run the comparison'} />
      </header>

      <div className="card" style={{ borderColor: 'var(--warning)', marginBottom: 8 }}>
        <div className="label" style={{ color: 'var(--warning)' }}>Read this first</div>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <li>This is a <strong style={{ fontWeight: 510, color: 'var(--text)' }}>simulation over recorded counterfactuals, not a live result</strong>. The arithmetic is real; the data is synthetic.</li>
          <li>Both arms see <strong style={{ fontWeight: 510, color: 'var(--text)' }}>exactly the same failed payments</strong>. The only difference is the decision.</li>
          <li>Outcomes come from labels <strong style={{ fontWeight: 510, color: 'var(--text)' }}>decided before either arm ran</strong> — neither arm can be tuned to its own answer key.</li>
          <li>Measured on the <strong style={{ fontWeight: 510, color: 'var(--text)' }}>held-out test split only</strong>. A lift measured on training data is the oldest way to lie with a model.</li>
        </ul>
      </div>

      {!run ? (
        <div className="card" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Not run yet. Needs a seeded or replayed dataset with labels; a trained model is optional — without one the agent arm prices from the measured baseline and the page says so.
        </div>
      ) : (
        <>
          <section style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: 8 }}>
            <div className="card" style={{ borderColor: run.comparison.incrementalRevenuePaise > 0 ? 'var(--success)' : 'var(--border)' }}>
              <div className="label">Incremental revenue</div>
              <div className="metric" style={{ fontSize: 40, marginTop: 2, color: run.comparison.incrementalRevenuePaise > 0 ? 'var(--success)' : 'var(--text)' }} title={exactPaise(run.comparison.incrementalRevenuePaise)}>
                {formatInrCompact(run.comparison.incrementalRevenuePaise)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>agent <span title={exactPaise(run.comparison.agent.revenueRecoveredPaise)}>{formatInrCompact(run.comparison.agent.revenueRecoveredPaise)}</span> − baseline <span title={exactPaise(run.comparison.baseline.revenueRecoveredPaise)}>{formatInrCompact(run.comparison.baseline.revenueRecoveredPaise)}</span></div>
            </div>
            <Tile label="Interventions" value={`${formatCount(run.comparison.agent.attempted)} vs ${formatCount(run.comparison.baseline.attempted)}`} note={`the agent acts on ${run.comparison.baseline.attempted > 0 ? Math.round((run.comparison.interventionsAvoided / run.comparison.baseline.attempted) * 100) : 0}% fewer — acting less is the point`} />
            <Tile label="Recovered" value={`${formatCount(run.comparison.agent.recovered)} vs ${formatCount(run.comparison.baseline.recovered)}`} note={`${formatCount(run.comparison.agent.declined.doNothing)} left alone · ${formatCount(run.comparison.agent.declined.denied)} denied · ${formatCount(run.comparison.agent.declined.deferred)} deferred on capacity`} />
            <Tile label="Would need a signature" value={formatCount(run.comparison.agent.requiredApproval)} note="attempts above ₹25,000 — the simulation counts them as signed and says so" />
          </section>

          <section style={{ marginTop: 8 }}>
            <WhatIfTable run={run} />
          </section>

          <section className="card" style={{ marginTop: 8 }}>
            <div className="label">Revenue recovered</div>
            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              {(['baseline', 'agent'] as const).map((arm) => {
                const v = run.comparison[arm].revenueRecoveredPaise;
                const max = Math.max(run.comparison.baseline.revenueRecoveredPaise, run.comparison.agent.revenueRecoveredPaise, 1);
                return (
                  <div key={arm} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 90px', alignItems: 'center', gap: 12, fontSize: 12 }}>
                    <span className="mono" style={{ color: arm === 'agent' ? 'var(--text)' : 'var(--text-secondary)' }}>{arm.toUpperCase()}</span>
                    <div style={{ height: 10, background: 'var(--bg-hover)', borderRadius: 5, overflow: 'hidden' }}>
                      <div style={{ width: `${(v / max) * 100}%`, height: '100%', background: arm === 'agent' ? 'var(--success)' : 'var(--border-strong)' }} />
                    </div>
                    <span className="num mono" style={{ textAlign: 'right' }} title={exactPaise(v)}>{formatInrCompact(v)}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 14 }}>
              {(['retry', 'alternate_gateway', 'payment_link', 'alternate_method'] as const).map((s) => (
                <div key={s} style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  <div className="mono" style={{ color: 'var(--text-secondary)' }}>{s}</div>
                  <div>{formatCount(run.comparison.agent.byStrategy[s].attempted)} attempted · {formatCount(run.comparison.agent.byStrategy[s].recovered)} recovered · <span title={exactPaise(run.comparison.agent.byStrategy[s].revenuePaise)}>{formatInrCompact(run.comparison.agent.byStrategy[s].revenuePaise)}</span></div>
                </div>
              ))}
            </div>
          </section>

          <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '14px 0 0' }}>
            The international row is the answer to the question in §1.1 — <em>should I switch processors?</em> The honest form of the answer is: not entirely, and not on a hunch.
            The agent sends the route failures through a second route and leaves the real declines alone; acceptance moves from {run.comparison.acceptance.international.baseline === null ? '—' : `${(run.comparison.acceptance.international.baseline * 100).toFixed(1)}%`} to {run.comparison.acceptance.international.agent === null ? '—' : `${(run.comparison.acceptance.international.agent * 100).toFixed(1)}%`} without a migration.
          </p>
        </>
      )}
    </main>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="metric" style={{ marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 }}>{note}</div>
    </div>
  );
}
