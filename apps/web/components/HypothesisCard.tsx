import { formatPct } from '@/lib/format';

export interface Hypothesis {
  tuple: Record<string, string>;
  label: string;
  attempts: number;
  failures: number;
  observedRate: number;
  expectedRate: number;
  baselineAttempts: number;
  baselineFailures: number;
  excess: number;
  excessShare: number;
  specificity: number;
  zScore: number;
  volumeScore: number;
  confidence: number;
  restAttempts: number;
  restFailures: number;
  restRate: number;
}

/**
 * One ranked root-cause hypothesis with its evidence (§7.4, §11.2).
 *
 * The four inputs are shown, not just the verdict, because the confidence
 * figure is a weighted sum of them and a reader should be able to see which one
 * carried it. The baseline quoted is the **shrunk** rate — the same arithmetic
 * the excess share came from — so the numbers on screen reconcile with each
 * other rather than coming from two different calculations.
 */
export function HypothesisCard({ h, rank }: { h: Hypothesis; rank: number }) {
  const parts = Object.entries(h.tuple);

  return (
    <div
      className="card"
      style={{
        borderColor: rank === 0 ? 'var(--accent)' : 'var(--border)',
        background: rank === 0 ? 'var(--bg-elevated)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
          {parts.map(([k, v], i) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
              {i > 0 && <span style={{ color: 'var(--text-tertiary)' }}>×</span>}
              <span className="mono" style={{ fontSize: 13 }}>
                <span style={{ color: 'var(--text-tertiary)' }}>{k}=</span>
                <span style={{ color: rank === 0 ? 'var(--accent)' : 'var(--text)' }}>{v}</span>
              </span>
            </span>
          ))}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div className="label" style={{ color: 'var(--text-tertiary)' }}>
            confidence
          </div>
          <div
            style={{
              fontSize: 18,
              fontVariantNumeric: 'tabular-nums',
              color: rank === 0 ? 'var(--accent)' : 'var(--text-secondary)',
            }}
          >
            {h.confidence.toFixed(2)}
          </div>
        </div>
      </div>

      {/* The sentence the founder could not get out of his dashboard. */}
      <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        {formatPct(h.excessShare, 0)} of the excess failures, at{' '}
        <strong style={{ color: 'var(--danger)', fontWeight: 510 }}>{formatPct(h.observedRate)}</strong>{' '}
        against a {formatPct(h.expectedRate)} expectation, while the rest of the window sits at{' '}
        {formatPct(h.restRate)}.
      </p>

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '8px 12px',
          margin: '12px 0 0',
          fontSize: 11,
        }}
      >
        <Evidence
          k="Excess share"
          v={formatPct(h.excessShare, 0)}
          hint={`${h.excess.toFixed(1)} of the window's excess failures`}
        />
        <Evidence
          k="Specificity"
          v={h.specificity.toFixed(2)}
          hint={`rest of the window at ${formatPct(h.restRate)}`}
        />
        <Evidence
          k="Support"
          v={`z ${h.zScore.toFixed(1)}`}
          hint="against the rest of this window, not history"
        />
        <Evidence
          k="Volume"
          v={`${h.attempts}`}
          hint={`${h.failures} failed · baseline ${h.baselineFailures}/${h.baselineAttempts}`}
        />
      </dl>
    </div>
  );
}

function Evidence({ k, v, hint }: { k: string; v: string; hint: string }) {
  return (
    <div>
      <dt className="label" style={{ color: 'var(--text-tertiary)' }}>
        {k}
      </dt>
      <dd
        className="mono"
        style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}
      >
        {v}
      </dd>
      <dd style={{ margin: '1px 0 0', color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{hint}</dd>
    </div>
  );
}
