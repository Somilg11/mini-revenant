import Link from 'next/link';
import { fetchModel, fetchCases } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { CalibrationChart } from '@/components/CalibrationChart';
import { SourceBadge } from '@/components/SourceBadge';

export const dynamic = 'force-dynamic';

/**
 * `/model` — the model card (§11.2): what it is, what it is not, where it
 * breaks.
 *
 * The baseline's numbers on the same test split sit beside the model's, so
 * "the model is better" is a measured claim with a figure next to it. And the
 * count of predictions currently served from the baseline is on the page: when
 * the model is unplugged on stage, that number is what moves.
 */
export default async function ModelPage() {
  const [card, cases] = await Promise.all([fetchModel(), fetchCases(undefined, 1)]);
  const a = card.active;
  const mix = cases.stats.probability_source_mix;
  const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? '—' : v.toFixed(d));

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 24px 64px' }}>
      <header style={{ marginBottom: 20 }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', fontSize: 11, textDecoration: 'none' }}>← Command Center</Link>
        <h1 className="section-title" style={{ margin: '6px 0 0', display: 'flex', gap: 10, alignItems: 'baseline' }}>
          Model card <SourceBadge source={a ? 'model' : 'baseline'} />
        </h1>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
          {a ? <>logistic regression <span className="mono">{a.id}</span> · trained <span className="mono">{a.trained_at.replace('T', ' ').slice(0, 19)}</span> UTC</> : 'no model is active — every prediction comes from the measured §7.5 baseline, and every badge says so'}
        </div>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
        <Tile label="AUC" value={f(a?.metrics.auc)} note={a ? `baseline ${f(a.metrics.baselineAuc)} on the same rows` : 'not measured'} tone={a ? 'accent' : undefined} />
        <Tile label="Brier" value={f(a?.metrics.brier)} note={a ? `baseline ${f(a.metrics.baselineBrier)} · lower is better, 0.25 is a coin` : 'not measured'} />
        <Tile label="Log loss" value={f(a?.metrics.logLoss)} note="on the held-out test split" />
        <Tile label="Served by model" value={formatCount(mix.model)} note="open cases priced by the model" tone={mix.model > 0 ? 'accent' : undefined} />
        <Tile label="Served by baseline" value={formatCount(mix.baseline)} note={mix.baseline > 0 && a ? 'a payment that fails while the model is down is exactly the one worth acting on' : 'the measured fallback'} tone={mix.baseline > 0 && a ? 'warning' : undefined} />
      </section>

      {a && (
        <>
          <section style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 8, marginTop: 8 }}>
            <CalibrationChart buckets={a.metrics.calibration_curve} label="Calibration — held-out test split" />
            <div className="card">
              <div className="label">What it is</div>
              <dl style={dl}>
                <Row k="Kind" v="logistic regression, batch gradient descent" />
                <Row k="Fit" v={`${a.metrics.fit.epochs} epochs · lr ${a.metrics.fit.learningRate} · L2 ${a.metrics.fit.l2}`} />
                <Row k="Split" v={`train ${a.metrics.rows.train} · val ${a.metrics.rows.val} · test ${a.metrics.rows.test}`} />
                <Row k="Split rule" v="chronological by position — never random" />
                <Row k="Train ends" v={a.metrics.split_boundaries.trainEndsAt?.replace('T', ' ').slice(0, 16) ?? '—'} />
                <Row k="Test ends" v={a.metrics.split_boundaries.testEndsAt?.replace('T', ' ').slice(0, 16) ?? '—'} />
                <Row k="Label" v="recoverable — the disjunction of the four counterfactuals" />
                <Row k="Positive rate" v={`${(a.metrics.positiveRate * 100).toFixed(1)}% of test rows`} />
                <Row k="Calibration" v="10 equal-width buckets fitted on val, applied at serve time" />
              </dl>
              <div className="label" style={{ marginTop: 14 }}>What it is not</div>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '6px 0 0' }}>
                A random split would let it learn a customer&apos;s later behaviour and be tested on their
                earlier behaviour — every metric improves and the model collapses. Standardisation comes
                from train only and calibration from val only; nothing is fitted on the rows it is scored
                on. It predicts <em>whether</em> a payment can be recovered, not by which intervention:
                that is the strategy engine&apos;s question.
              </p>
            </div>
          </section>

          <section className="card" style={{ marginTop: 8 }}>
            <div className="label">Coefficients (standardised inputs)</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
              Sign says direction; magnitude says how much one standard deviation of the input moves the log-odds. The intercept is {a.coefficients.intercept.toFixed(3)}.
            </div>
            <div style={{ display: 'grid', gap: 4, marginTop: 10 }}>
              {a.coefficients.weights
                .map((w, i) => ({ w, name: a.coefficients.feature_names[i] ?? `f${i}` }))
                .sort((x, y) => Math.abs(y.w) - Math.abs(x.w))
                .map(({ w, name }) => {
                  const max = Math.max(...a.coefficients.weights.map(Math.abs)) || 1;
                  return (
                    <div key={name} style={{ display: 'grid', gridTemplateColumns: '240px 1fr 64px', alignItems: 'center', gap: 10, fontSize: 12 }}>
                      <span className="mono" style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{name}</span>
                      <div style={{ position: 'relative', height: 6, background: 'var(--bg-hover)', borderRadius: 3 }}>
                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--border-strong)' }} />
                        <div style={{ position: 'absolute', top: 0, bottom: 0, left: w >= 0 ? '50%' : `${50 - (Math.abs(w) / max) * 50}%`, width: `${(Math.abs(w) / max) * 50}%`, background: w >= 0 ? 'var(--success)' : 'var(--danger)', borderRadius: 3 }} />
                      </div>
                      <span className="num mono" style={{ color: w >= 0 ? 'var(--success)' : 'var(--danger)' }}>{w >= 0 ? '+' : ''}{w.toFixed(3)}</span>
                    </div>
                  );
                })}
            </div>
          </section>
        </>
      )}

      {!a && (
        <section className="card" style={{ marginTop: 8 }}>
          <div className="label">Where it breaks</div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '6px 0 0' }}>
            Nothing here is broken — this is the supported fallback. Run <span className="mono">bun train</span> to
            fit a model on the labelled data; every open case is then re-priced and its badge flips
            to <span className="mono">model</span>. Deactivating it flips them back. The fallback is not
            optional and not a constant: a payment that fails while the model is down is exactly the
            payment worth acting on.
          </p>
        </section>
      )}
    </main>
  );
}

const dl: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 16px', margin: '8px 0 0', fontSize: 12 };

function Row({ k, v }: { k: string; v: string }) {
  return (<><dt style={{ color: 'var(--text-tertiary)' }}>{k}</dt><dd style={{ margin: 0, color: 'var(--text-secondary)' }}>{v}</dd></>);
}

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'accent' | 'warning' | undefined }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="metric" style={{ marginTop: 2, color: tone === 'accent' ? 'var(--accent)' : tone === 'warning' ? 'var(--warning)' : 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 }}>{note}</div>
    </div>
  );
}
