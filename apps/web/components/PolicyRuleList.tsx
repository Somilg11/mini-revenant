export interface RuleResult {
  rule: number;
  name: string;
  passed: boolean;
  verdict: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  detail: string;
}

/**
 * Twelve rules with pass/fail, reasons and the input hash (§11.2).
 *
 * Failed rules first, so a DENY reads as the worked refusal in §7.7 — then the
 * ones that passed, because a gate that only shows its objections cannot be
 * audited. The hash is the claim that this verdict can be recomputed from what
 * was stored.
 */
export function PolicyRuleList({
  rules,
  verdict,
  version,
  inputHash,
}: {
  rules: RuleResult[];
  verdict: string;
  version: string;
  inputHash: string;
}) {
  const ordered = [...rules].sort((a, b) => Number(a.passed) - Number(b.passed) || a.rule - b.rule);
  const colour = verdict === 'ALLOW' ? 'var(--success)' : verdict === 'DENY' ? 'var(--danger)' : 'var(--warning)';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="mono" style={{ fontSize: 15, fontWeight: 510, color: colour }}>{verdict}</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          policy {version} · input <span className="mono" title={inputHash}>{inputHash.slice(0, 8)}…{inputHash.slice(-4)}</span>
        </span>
      </div>
      <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
        {ordered.map((r) => (
          <li key={r.rule} style={{ display: 'grid', gridTemplateColumns: '14px 56px 210px 1fr', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 12, alignItems: 'baseline' }}>
            <span style={{ color: r.passed ? 'var(--success)' : r.verdict === 'DENY' ? 'var(--danger)' : 'var(--warning)' }}>{r.passed ? '✓' : '✗'}</span>
            <span className="mono" style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>rule {r.rule}</span>
            <span style={{ color: r.passed ? 'var(--text-secondary)' : 'var(--text)' }}>{r.name}</span>
            <span style={{ color: r.passed ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}>{r.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
