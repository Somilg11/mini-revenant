import { fetchDashboard } from '@/lib/api';
import { simApi, type SimState } from '@/lib/sim';
import { SimControlBar } from '@/components/SimControlBar';
import { LiveFeed } from '@/components/LiveFeed';
import { FailureRateChart } from '@/components/FailureRateChart';
import { formatInrCompact, formatPct, formatCount, exactPaise } from '@/lib/format';
import { MetricTile } from '@/components/MetricTile';
import { AcceptanceStrip } from '@/components/AcceptanceStrip';
import { DriftIndicator } from '@/components/DriftIndicator';

export const dynamic = 'force-dynamic';

/**
 * Command Center (§11.2).
 *
 * Four tiles, then the acceptance strip, because the strip is the thing no
 * merchant dashboard shows them today (§1.1). Every figure carries the
 * integers it was computed from, and anything not yet measured renders as an
 * em dash with a label rather than a zero.
 *
 * The live feed, the failure-rate chart and the simulator control bar land in
 * P6, when there is a clock to drive them.
 */
export default async function Home() {
  const [{ ready, summary, acceptance, drift, breakdown, error }, sim] = await Promise.all([
    fetchDashboard(),
    simApi.state().catch((): SimState | null => null),
  ]);

  const dataset = ready?.checks.dataset ?? null;
  const seeded = dataset?.seeded ?? false;
  const dbDown = ready ? !ready.checks.database.up : false;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 24px 64px' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 20,
        }}
      >
        <div>
          <div className="label">Revenant Mini</div>
          <h1 className="section-title" style={{ margin: '4px 0 0' }}>
            Command Center
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <DriftIndicator drift={drift} />
          {summary?.window && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }} className="mono">
              {summary.window.from.slice(0, 10)} → {summary.window.to.slice(0, 10)}
            </span>
          )}
        </div>
      </header>

      <SimControlBar initial={sim} />

      {error && <Banner tone="danger" title="API unreachable" body={error} />}
      {!error && dbDown && (
        <Banner
          tone="danger"
          title="Database unreachable"
          body={ready?.checks.database.error ?? 'the API cannot reach Postgres'}
          hint="Start it with bun db:up."
        />
      )}
      {!error && !dbDown && !seeded && (
        <Banner
          tone="warning"
          title="No dataset"
          body="The database is empty. Metrics stay unmeasured until a dataset exists — never a fake number."
          hint="Generate one with bun seed."
        />
      )}

      {summary && (
        <>
          <section
            style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}
            aria-label="Key metrics"
          >
            <MetricTile
              label="Revenue at Risk"
              value={formatInrCompact(summary.revenue_at_risk_paise)}
              titlePaise={summary.revenue_at_risk_paise}
              tone="danger"
              inputs={`${formatCount(summary.counts.failures + summary.counts.abandoned)} unresolved payments`}
            />
            <MetricTile
              label="Revenue Recovered"
              value={formatInrCompact(summary.revenue_recovered_paise)}
              titlePaise={summary.revenue_recovered_paise}
              tone={summary.revenue_recovered_paise > 0 ? 'success' : undefined}
              inputs={
                summary.attribution.attributed
                  ? `${formatInrCompact(summary.attribution.direct_paise + summary.attribution.assisted_paise)} credited`
                  : 'unattributed — no action has run yet'
              }
            />
            <MetricTile
              label="Recoverable (EV)"
              value={
                summary.recoverable_revenue_paise === null
                  ? '—'
                  : formatInrCompact(summary.recoverable_revenue_paise)
              }
              measured={summary.recoverable_estimated}
              unmeasuredNote="not measured — no model has scored a case"
              titlePaise={summary.recoverable_revenue_paise ?? undefined}
              tone="accent"
              inputs={`expected value over ${summary.recoverable_open_cases} open cases`}
            />
            <MetricTile
              label="Recovery Rate"
              value={formatPct(summary.recovery_rate)}
              measured={summary.recovery_rate !== null}
              inputs={`${formatInrCompact(summary.recovery_rate_inputs.numerator_paise)} / ${formatInrCompact(summary.recovery_rate_inputs.denominator_paise)}`}
              titlePaise={summary.recovery_rate_inputs.denominator_paise}
            />
          </section>

          <AcceptanceStrip acceptance={acceptance} />

          <section style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 8, marginTop: 8 }}>
            <FailureRateChart incidents={sim?.incidents ?? []} running={sim?.clock.running ?? false} />
            <LiveFeed />
          </section>

          <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <div className="card">
              <div className="label">Volume</div>
              <dl style={dlStyle}>
                <Row k="Attempts" v={formatCount(summary.counts.attempts)} />
                <Row k="Captured" v={formatCount(summary.counts.successes)} />
                <Row k="Failed" v={formatCount(summary.counts.failures)} />
                <Row k="Abandoned" v={formatCount(summary.counts.abandoned)} />
                <Row
                  k="Failure rate"
                  v={`${formatPct(summary.failure_rate)}  (${formatCount(summary.failure_rate_inputs.numerator)} / ${formatCount(summary.failure_rate_inputs.denominator)})`}
                />
              </dl>
            </div>

            <div className="card">
              <div className="label">By method</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
                <thead>
                  <tr style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                    <th style={thLeft}>Method</th>
                    <th style={thRight}>Attempts</th>
                    <th style={thRight}>Acceptance</th>
                    <th style={thRight}>At risk</th>
                  </tr>
                </thead>
                <tbody>
                  {(breakdown?.rows ?? []).map((r) => (
                    <tr key={r.dimension_value} style={{ height: 32 }}>
                      <td style={{ fontSize: 13 }}>{r.dimension_value}</td>
                      <td className="num" style={tdNum}>
                        {formatCount(r.attempts)}
                      </td>
                      <td className="num" style={tdNum}>
                        {formatPct(r.acceptance_rate)}
                      </td>
                      <td className="num" style={tdNum} title={exactPaise(r.failed_amount_paise)}>
                        {formatInrCompact(r.failed_amount_paise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 16, lineHeight: 1.7 }}>
            Every figure is computed from <span className="mono">payment_events</span>, the source of
            truth. Hover any amount for its exact value in paise. Rates print the two integers they
            were divided from. The simulated clock is held back whenever the replay cannot keep up,
            so progress always reflects data that exists. Incidents, recovery cases and the policy
            gate arrive in P7–P12.
          </p>
        </>
      )}
    </main>
  );
}

const dlStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '6px 20px',
  margin: '10px 0 0',
  fontSize: 13,
};
const thLeft: React.CSSProperties = {
  textAlign: 'left',
  fontWeight: 510,
  padding: '0 0 6px',
  borderBottom: '1px solid var(--border)',
};
const thRight: React.CSSProperties = { ...thLeft, textAlign: 'right' };
const tdNum: React.CSSProperties = { fontSize: 13, fontVariantNumeric: 'tabular-nums' };

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt style={{ color: 'var(--text-secondary)' }}>{k}</dt>
      <dd className="mono" style={{ margin: 0 }}>
        {v}
      </dd>
    </>
  );
}

function Banner({
  tone,
  title,
  body,
  hint,
}: {
  tone: 'danger' | 'warning';
  title: string;
  body: string;
  hint?: string;
}) {
  const colour = tone === 'danger' ? 'var(--danger)' : 'var(--warning)';
  return (
    <div className="card" style={{ borderColor: colour, marginBottom: 12 }} role="status">
      <div className="label" style={{ color: colour }}>
        {title}
      </div>
      <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{body}</div>
      {hint && (
        <div style={{ marginTop: 4, color: 'var(--text-tertiary)', fontSize: 12 }}>{hint}</div>
      )}
    </div>
  );
}
