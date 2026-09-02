import type { Gate } from '@/lib/api';

const LABELS: Record<string, string> = {
  volume: 'Volume floor',
  absolute_lift: 'Absolute lift',
  relative_lift: 'Relative lift',
  z_score: 'z-score',
  sustained: 'Sustained',
};

/**
 * The five gates with pass/fail and their numbers (§11.2).
 *
 * Shown in full, including the gates that passed. "One threshold fires on
 * everything; five gates is why it ignored the two unlabelled noise windows" is
 * the claim being made, and it is only checkable if all five are on screen with
 * the figures they were compared against.
 */
export function GateChecklist({ gates }: { gates: Gate[] }) {
  if (!gates?.length) return null;
  return (
    <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
      {gates.map((g) => (
        <li
          key={g.gate}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            padding: '7px 0',
            borderBottom: '1px solid var(--border)',
            fontSize: 12,
          }}
        >
          <span
            style={{ color: g.passed ? 'var(--success)' : 'var(--danger)', width: 12 }}
            aria-label={g.passed ? 'passed' : 'failed'}
          >
            {g.passed ? '✓' : '✗'}
          </span>
          <span style={{ width: 110, color: 'var(--text-secondary)' }}>
            {LABELS[g.gate] ?? g.gate}
          </span>
          <span style={{ color: 'var(--text)' }}>{g.detail}</span>
        </li>
      ))}
    </ol>
  );
}
