import { fetchReady, type Ready } from '@/lib/api';

export const dynamic = 'force-dynamic';

const TILES = [
  { label: 'Revenue at Risk', note: 'Σ amount of unresolved failures in the window' },
  { label: 'Revenue Recovered', note: 'captured now, failed earlier' },
  { label: 'Recoverable (EV)', note: 'Σ amount × P(recovery) over open cases' },
  { label: 'Recovery Rate', note: 'recovered / (recovered + at risk)' },
] as const;

/**
 * P0 shell. The four tiles and the acceptance strip land in P5.
 *
 * Two invariants are already visible here, and both are load-bearing:
 *  - Not-yet-measured is `—` with a label, never `0` (invariant 6).
 *  - An empty database renders an empty dashboard with a banner, never a crash
 *    and never a fake number (§15.3).
 */
export default async function Home() {
  const result = await fetchReady();
  const unavailable = 'unavailable' in result ? result.unavailable : null;
  const ready = unavailable ? null : (result as Ready);

  const dataset = ready?.checks.dataset ?? null;
  const seeded = dataset?.seeded ?? false;
  const dbDown = ready ? !ready.checks.database.up : true;

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '48px 24px' }}>
      <header style={{ marginBottom: 24 }}>
        <div className="label">Revenant Mini</div>
        <h1 className="section-title" style={{ margin: '6px 0 0' }}>
          Command Center
        </h1>
      </header>

      {unavailable && <Banner tone="danger" title="API unreachable" body={unavailable} hint="Start it with bun dev." />}

      {!unavailable && dbDown && (
        <Banner
          tone="danger"
          title="Database unreachable"
          body={ready?.checks.database.error ?? 'the API cannot reach Postgres'}
          hint="Start it with bun db:up."
        />
      )}

      {!unavailable && !dbDown && !seeded && (
        <Banner
          tone="warning"
          title="No dataset"
          body="The database is empty. Metrics stay unmeasured until a dataset exists — never a fake number."
          hint="Generate 5,000 payments with bun seed."
        />
      )}

      <section
        style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}
        aria-label="Key metrics"
      >
        {TILES.map((t) => (
          <div key={t.label} className="card">
            <div className="label">{t.label}</div>
            <div className="metric" style={{ color: 'var(--text-tertiary)' }}>
              —
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>not measured</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
              {t.note}
            </div>
          </div>
        ))}
      </section>

      {ready && (
        <section className="card" style={{ marginTop: 16 }} aria-label="System status">
          <div className="label">System</div>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '6px 20px',
              margin: '10px 0 0',
              fontSize: 12,
            }}
          >
            <Row
              k="Database"
              v={
                ready.checks.database.up
                  ? `up · ${ready.checks.database.latency_ms} ms`
                  : (ready.checks.database.error ?? 'down')
              }
              ok={ready.checks.database.up}
            />
            <Row
              k="Migrations"
              v={
                ready.checks.migrations
                  ? `${ready.checks.migrations.applied} applied · ${ready.checks.migrations.tables} tables`
                  : 'unknown'
              }
              ok={(ready.checks.migrations?.applied ?? 0) > 0}
            />
            <Row
              k="Dataset"
              v={
                dataset
                  ? seeded
                    ? `${dataset.payments.toLocaleString('en-IN')} payments · seed ${dataset.seed ?? '—'} · ${dataset.checksum?.slice(0, 12) ?? 'no checksum'}`
                    : 'empty — run bun seed'
                  : 'unknown'
              }
              ok={seeded}
            />
            <Row
              k="LLM"
              v={
                ready.checks.llm.enabled
                  ? `${ready.checks.llm.provider} · ${ready.checks.llm.model}`
                  : `off — ${ready.checks.llm.reason ?? 'not configured'} · narratives will read template`
              }
              ok
            />
          </dl>
        </section>
      )}
    </main>
  );
}

function Row({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  return (
    <>
      <dt style={{ color: 'var(--text-secondary)' }}>{k}</dt>
      <dd className="mono" style={{ margin: 0, color: ok ? 'var(--text)' : 'var(--danger)' }}>
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
  hint: string;
}) {
  const colour = tone === 'danger' ? 'var(--danger)' : 'var(--warning)';
  return (
    <div className="card" style={{ borderColor: colour, marginBottom: 16 }} role="status">
      <div className="label" style={{ color: colour }}>
        {title}
      </div>
      <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{body}</div>
      <div style={{ marginTop: 4, color: 'var(--text-tertiary)', fontSize: 12 }}>{hint}</div>
    </div>
  );
}
