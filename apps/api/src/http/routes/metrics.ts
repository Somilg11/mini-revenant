import { Hono } from 'hono';
import { z } from 'zod';
import { cachedDrift } from '../../app/analytics.ts';
import {
  acceptanceRows,
  attributionRow,
  breakdown,
  dataWindow,
  listMerchants,
  setMerchantPaused,
  probabilitySourceMix,
  recoverableRevenue,
  summaryRow,
  timeseries,
  type Window,
} from '../../db/queries.ts';
import { NotFoundError } from '../../lib/errors.ts';
import { rate } from '../../domain/money.ts';
import { ValidationError } from '../../lib/errors.ts';
import type { AppEnv } from '../app.ts';

export const metrics = new Hono<AppEnv>();

const BREAKDOWN_DIMENSIONS = [
  'bank',
  'method',
  'amount_band',
  'is_international',
  'card_country',
  'card_network',
] as const;

/** `all` is the aggregate series the detector rides in P7. */
const SERIES_DIMENSIONS = ['all', ...BREAKDOWN_DIMENSIONS] as const;

const WindowQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  merchant_id: z.string().min(1).optional(),
});

/** Falls back to the full extent of the data when no window is given. */
async function resolveWindow(raw: unknown): Promise<Window | null> {
  const parsed = WindowQuery.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('invalid window', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const extent = await dataWindow();
  if (!extent && (!parsed.data.from || !parsed.data.to)) return null;
  const from = parsed.data.from ?? extent!.from;
  // Inclusive of the last payment: the extent's `to` is a payment's timestamp.
  const to = parsed.data.to ?? new Date(Date.parse(extent!.to) + 1000).toISOString();
  if (Date.parse(from) >= Date.parse(to)) {
    throw new ValidationError('window `from` must be before `to`', { from, to });
  }
  return { from, to, merchantId: parsed.data.merchant_id };
}

metrics.get('/api/v1/merchants', async (c) => c.json({ merchants: await listMerchants() }));

/**
 * The kill switch. A paused merchant gets no actions: policy rule 1 denies
 * every proposal, approvals included, until it is resumed.
 */
for (const [verb, paused] of [['pause', true], ['resume', false]] as const) {
  metrics.post(`/api/v1/merchants/:id/${verb}`, async (c) => {
    const row = await setMerchantPaused(c.req.param('id'), paused);
    if (!row) throw new NotFoundError('merchant', c.req.param('id'));
    return c.json({ merchant: row });
  });
}

/**
 * §10 summary. Every figure carries the window it was computed over **and the
 * two integers the rate came from**, so any number on the dashboard can be
 * checked against its inputs rather than taken on trust.
 */
metrics.get('/api/v1/metrics/summary', async (c) => {
  const w = await resolveWindow(c.req.query());
  if (!w) return c.json(emptySummary());

  const [row, recoverable, attribution, mix] = await Promise.all([
    summaryRow(w),
    recoverableRevenue(w),
    attributionRow(w),
    probabilitySourceMix(w),
  ]);

  const denominator = row.revenue_recovered_paise + row.revenue_at_risk_paise;

  return c.json({
    window: { from: w.from, to: w.to, merchant_id: w.merchantId ?? null },

    revenue_at_risk_paise: row.revenue_at_risk_paise,
    revenue_recovered_paise: row.revenue_recovered_paise,

    // Not measured is null with a label, never 0 (invariant 6). No model has
    // scored anything until P9/P10, and claiming ₹0 recoverable would be a
    // different — and false — statement.
    recoverable_revenue_paise: recoverable?.paise ?? null,
    recoverable_estimated: recoverable !== null,
    recoverable_open_cases: recoverable?.cases ?? 0,

    // The denominator is every rupee that was *ever* at risk. Dividing by
    // revenue_at_risk alone gives rates above 100% once most failures are
    // recovered, which is how a metric becomes a joke.
    recovery_rate: rate(row.revenue_recovered_paise, denominator),
    recovery_rate_inputs: {
      numerator_paise: row.revenue_recovered_paise,
      denominator_paise: denominator,
    },

    counts: {
      attempts: row.attempts,
      successes: row.successes,
      failures: row.failures,
      abandoned: row.abandoned,
    },
    failure_rate: rate(row.failures + row.abandoned, row.attempts),
    failure_rate_inputs: {
      numerator: row.failures + row.abandoned,
      denominator: row.attempts,
    },

    attribution: {
      direct_paise: attribution.direct_paise,
      assisted_paise: attribution.assisted_paise,
      organic_paise: attribution.organic_paise,
      verified: attribution.verified,
      // Where attribution has not run, the UI says `unattributed` rather than
      // implying credit (§10).
      attributed: attribution.verified > 0,
    },
    probability_source_mix: mix,
  });
});

/** §1.1 — the line no merchant dashboard shows them today. */
metrics.get('/api/v1/metrics/acceptance', async (c) => {
  const w = await resolveWindow(c.req.query());
  if (!w) return c.json({ window: null, segments: [], gap: null });

  const rows = await acceptanceRows(w);
  const bySegment = Object.fromEntries(rows.map((r) => [r.segment, r]));
  const dom = bySegment.domestic;
  const intl = bySegment.international;

  const segments = rows.map((r) => ({
    segment: r.segment,
    attempts: r.attempts,
    successes: r.successes,
    acceptance_rate: rate(r.successes, r.attempts),
    gross_amount_paise: r.gross_amount_paise,
    captured_amount_paise: r.captured_amount_paise,
  }));

  const domRate = dom ? rate(dom.successes, dom.attempts) : null;
  const intlRate = intl ? rate(intl.successes, intl.attempts) : null;

  return c.json({
    window: { from: w.from, to: w.to, merchant_id: w.merchantId ?? null },
    segments,
    gap:
      domRate === null || intlRate === null
        ? null
        : {
            points: (domRate - intlRate) * 100,
            // What the gap is worth: international volume that would have been
            // captured at the domestic acceptance rate, and was not.
            value_paise: intl
              ? Math.round(intl.gross_amount_paise * (domRate - intlRate))
              : 0,
          },
  });
});

metrics.get('/api/v1/metrics/timeseries', async (c) => {
  const w = await resolveWindow(c.req.query());
  if (!w) return c.json({ window: null, points: [] });

  const granularity = c.req.query('granularity') === '5m' ? '5m' : 'hour';
  const dimension = c.req.query('dimension') ?? 'all';
  const dimensionValue = c.req.query('value') ?? 'all';

  // An unknown dimension previously returned an empty series, which reads as
  // "no traffic" rather than "you asked for something that does not exist".
  if (!(SERIES_DIMENSIONS as readonly string[]).includes(dimension)) {
    throw new ValidationError(`unknown dimension ${dimension}`, {
      allowed: [...SERIES_DIMENSIONS],
    });
  }

  const points = await timeseries(w, granularity, dimension, dimensionValue);
  return c.json({
    window: { from: w.from, to: w.to, merchant_id: w.merchantId ?? null },
    granularity,
    dimension,
    dimension_value: dimensionValue,
    points: points.map((p) => ({
      ...p,
      failure_rate: rate(p.failures + p.abandoned, p.attempts),
    })),
  });
});

metrics.get('/api/v1/metrics/breakdown', async (c) => {
  const w = await resolveWindow(c.req.query());
  const dimension = c.req.query('dimension') ?? 'method';
  if (!(BREAKDOWN_DIMENSIONS as readonly string[]).includes(dimension)) {
    throw new ValidationError(`unknown dimension ${dimension}`, {
      allowed: [...BREAKDOWN_DIMENSIONS],
    });
  }
  if (!w) return c.json({ window: null, dimension, rows: [] });

  const rows = await breakdown(w, dimension);
  return c.json({
    window: { from: w.from, to: w.to, merchant_id: w.merchantId ?? null },
    dimension,
    rows: rows.map((r) => ({
      ...r,
      failure_rate: rate(r.failures + r.abandoned, r.attempts),
      acceptance_rate: rate(r.successes, r.attempts),
    })),
  });
});

/**
 * Drift between the incrementally maintained rollups and a fresh computation.
 * Displayed, never silently corrected — a rollup that repairs itself hides the
 * bug that caused it (§10).
 */
metrics.get('/api/v1/metrics/drift', async (c) => c.json(await cachedDrift()));

function emptySummary() {
  // An empty database renders an empty dashboard: zeros where zero is the
  // truth, null where nothing has been measured. Never a crash, never a
  // fabricated number.
  return {
    window: null,
    revenue_at_risk_paise: 0,
    revenue_recovered_paise: 0,
    recoverable_revenue_paise: null,
    recoverable_estimated: false,
    recoverable_open_cases: 0,
    recovery_rate: null,
    recovery_rate_inputs: { numerator_paise: 0, denominator_paise: 0 },
    counts: { attempts: 0, successes: 0, failures: 0, abandoned: 0 },
    failure_rate: null,
    failure_rate_inputs: { numerator: 0, denominator: 0 },
    attribution: {
      direct_paise: 0,
      assisted_paise: 0,
      organic_paise: 0,
      verified: 0,
      attributed: false,
    },
    probability_source_mix: { model: 0, baseline: 0 },
  };
}
