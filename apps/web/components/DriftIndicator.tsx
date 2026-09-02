import type { Drift } from '@/lib/api';

/**
 * Rollup drift: the difference between the incrementally maintained rollups
 * and a fresh recomputation.
 *
 * Displayed, never silently corrected (§10). A rollup that repairs itself
 * hides the bug that caused it, and on a money dashboard that bug is a wrong
 * number somebody has already acted on. Green at zero is a claim being made,
 * not decoration.
 */
export function DriftIndicator({ drift }: { drift: Drift | null }) {
  if (!drift) return null;
  const clean = drift.rows === 0;

  return (
    <span
      title={
        clean
          ? 'Incremental rollups match a fresh recomputation exactly'
          : `${drift.rows} rollup rows disagree with a fresh recomputation — displayed, not corrected`
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        color: clean ? 'var(--text-secondary)' : 'var(--danger)',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: clean ? 'var(--success)' : 'var(--danger)',
        }}
      />
      {clean ? 'rollup drift 0' : `rollup drift ${drift.rows} rows`}
    </span>
  );
}
