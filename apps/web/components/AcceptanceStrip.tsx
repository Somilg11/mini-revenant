import type { Acceptance } from '@/lib/api';
import { formatInrCompact, formatPct, formatCount, exactPaise } from '@/lib/format';

/**
 * Domestic vs international acceptance, side by side (§1.1).
 *
 * Sits directly under the money because it is the line no merchant dashboard
 * shows them today — an Indian founder selling globally can see his overall
 * acceptance, but not that the international half of it is twelve points
 * worse. The gap, in points and in rupees, is the whole wedge of the product.
 */
export function AcceptanceStrip({ acceptance }: { acceptance: Acceptance | null }) {
  if (!acceptance || acceptance.segments.length === 0) return null;

  const bySegment = Object.fromEntries(acceptance.segments.map((s) => [s.segment, s]));
  const dom = bySegment.domestic;
  const intl = bySegment.international;

  return (
    <section
      className="card"
      style={{ marginTop: 8, display: 'flex', alignItems: 'stretch', gap: 0, padding: 0 }}
      aria-label="Domestic versus international acceptance"
    >
      <Segment
        label="Domestic acceptance"
        rate={dom?.acceptance_rate ?? null}
        attempts={dom?.attempts ?? 0}
        successes={dom?.successes ?? 0}
      />
      <Divider />
      <Segment
        label="International acceptance"
        rate={intl?.acceptance_rate ?? null}
        attempts={intl?.attempts ?? 0}
        successes={intl?.successes ?? 0}
        tone="danger"
      />
      <Divider />
      <div style={{ padding: 14, flex: 1 }}>
        <div className="label">Gap</div>
        <div className="metric" style={{ color: 'var(--danger)', marginTop: 2 }}>
          {acceptance.gap ? `${acceptance.gap.points.toFixed(1)} pts` : '—'}
        </div>
        <div
          style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}
          title={acceptance.gap ? exactPaise(acceptance.gap.value_paise) : undefined}
        >
          {acceptance.gap
            ? `${formatInrCompact(acceptance.gap.value_paise)} of international volume, at the domestic rate`
            : 'not measured'}
        </div>
      </div>
    </section>
  );
}

function Divider() {
  return <div style={{ width: 1, background: 'var(--border)' }} />;
}

function Segment({
  label,
  rate,
  attempts,
  successes,
  tone,
}: {
  label: string;
  rate: number | null;
  attempts: number;
  successes: number;
  tone?: 'danger';
}) {
  return (
    <div style={{ padding: 14, flex: 1 }}>
      <div className="label">{label}</div>
      <div
        className="metric"
        style={{ color: tone === 'danger' ? 'var(--warning)' : 'var(--text)', marginTop: 2 }}
      >
        {formatPct(rate)}
      </div>
      {/* The two integers the rate came from, printed beside it. */}
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
        {formatCount(successes)} / {formatCount(attempts)} captured
      </div>
    </div>
  );
}
