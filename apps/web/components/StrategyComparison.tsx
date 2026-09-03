import { formatInrCompact, formatPct, exactPaise } from '@/lib/format';

export interface StrategyOption {
  strategy: string;
  probability: number;
  grossValuePaise: number;
  costPaise: number;
  frictionPaise: number;
  expectedValuePaise: number;
  available: boolean;
  rationale: string;
}

const LABELS: Record<string, string> = {
  retry: 'Retry',
  payment_link: 'Payment link',
  alternate_method: 'Alternate method',
  alternate_gateway: 'Alternate gateway',
  do_nothing: 'Do nothing',
};

/**
 * All five options as EV bars, the winner highlighted, the losers greyed but
 * visible (§7.6, §11.2).
 *
 * That comparison is the demo moment: "a retry is worth 9 paise on the rupee;
 * routing the same card through a second processor is worth 58, and it costs
 * ₹9 to find out." Hiding the losers would turn a decision into an assertion.
 */
export function StrategyComparison({
  options,
  chosen,
  multiplier,
}: {
  options: StrategyOption[];
  chosen: string;
  multiplier: number;
}) {
  const max = Math.max(1, ...options.map((o) => Math.abs(o.expectedValuePaise)));
  const ordered = [...options].sort((a, b) => b.expectedValuePaise - a.expectedValuePaise);

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="label">Expected value, all five options</div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          gross − cost − friction · customer multiplier {multiplier.toFixed(2)}×
        </div>
      </div>

      <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        {ordered.map((o) => {
          const win = o.strategy === chosen;
          const width = o.available ? (Math.abs(o.expectedValuePaise) / max) * 100 : 0;
          const positive = o.expectedValuePaise >= 0;
          const colour = !o.available
            ? 'var(--border)'
            : win
              ? 'var(--accent)'
              : positive
                ? 'var(--border-strong)'
                : 'var(--danger)';
          return (
            <div key={o.strategy} style={{ opacity: o.available ? 1 : 0.55 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 90px', alignItems: 'center', gap: 12, fontSize: 12 }}>
                <span style={{ color: win ? 'var(--accent)' : 'var(--text)', fontWeight: win ? 510 : 400, display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  {win && <span aria-label="chosen">▸</span>}
                  {LABELS[o.strategy] ?? o.strategy}
                </span>
                <div style={{ position: 'relative', height: 8, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${width}%`, background: colour, borderRadius: 4 }} />
                </div>
                <span
                  className="num mono"
                  title={exactPaise(o.expectedValuePaise)}
                  style={{ color: !o.available ? 'var(--text-tertiary)' : win ? 'var(--accent)' : positive ? 'var(--text)' : 'var(--danger)' }}
                >
                  {o.available ? `${o.expectedValuePaise < 0 ? '−' : ''}${formatInrCompact(Math.abs(o.expectedValuePaise))}` : '—'}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 12, fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                <span className="mono">
                  {o.strategy === 'do_nothing' || !o.available
                    ? ' '
                    : `${formatPct(o.probability, 0)} · ₹${(o.costPaise / 100).toFixed(0)} + ${formatInrCompact(o.frictionPaise)}`}
                </span>
                <span style={{ lineHeight: 1.5 }}>{o.rationale}</span>
              </div>
            </div>
          );
        })}
      </div>

      {chosen === 'do_nothing' && (
        <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          No option clears zero, so the system declines to act. A system that always acts is a
          retry bot; the restraint is the product.
        </p>
      )}
    </div>
  );
}
