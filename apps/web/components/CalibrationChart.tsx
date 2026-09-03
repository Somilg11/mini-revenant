'use client';

import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { CalibrationBucket } from '@/lib/api';

/**
 * Predicted vs observed, ten buckets, with the diagonal (§11.2).
 *
 * A point on the diagonal means "when the model said 60%, 60% recovered". A
 * curve that bows above it is under-confident, below it over-confident. Dot
 * size is the bucket's count, so a wild point on eight rows is visibly eight
 * rows.
 */
export function CalibrationChart({
  buckets,
  label,
}: {
  buckets: CalibrationBucket[];
  label: string;
}) {
  const data = buckets
    .filter((b) => b.count > 0 && b.meanPredicted !== null && b.observedRate !== null)
    .map((b) => ({
      predicted: (b.meanPredicted ?? 0) * 100,
      observed: (b.observedRate ?? 0) * 100,
      count: b.count,
      range: `${(b.lower * 100).toFixed(0)}–${(b.upper * 100).toFixed(0)}%`,
    }));

  return (
    <div className="card" style={{ minHeight: 300 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="label">{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>dot size = rows in bucket · dashed = perfect</div>
      </div>
      {data.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', paddingTop: 12 }}>No data.</div>
      ) : (
        <div style={{ height: 250, marginTop: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 12, left: -10, bottom: 4 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="predicted"
                type="number"
                domain={[0, 100]}
                unit="%"
                name="predicted"
                stroke="var(--text-tertiary)"
                tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                dataKey="observed"
                type="number"
                domain={[0, 100]}
                unit="%"
                name="observed"
                stroke="var(--text-tertiary)"
                tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                tickLine={false}
                axisLine={false}
                width={46}
              />
              <ZAxis dataKey="count" range={[40, 400]} />
              <ReferenceLine
                segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]}
                stroke="var(--text-tertiary)"
                strokeDasharray="4 4"
              />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12 }}
                formatter={(v: number, name: string) => [`${v.toFixed(1)}%`, name]}
                labelFormatter={() => ''}
                content={({ payload }) => {
                  const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
                  if (!p) return null;
                  return (
                    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 6, padding: '6px 10px', fontSize: 12 }}>
                      <div style={{ color: 'var(--text-secondary)' }}>bucket {p.range}</div>
                      <div>predicted {p.predicted.toFixed(1)}% · observed {p.observed.toFixed(1)}%</div>
                      <div style={{ color: 'var(--text-tertiary)' }}>{p.count} rows</div>
                    </div>
                  );
                }}
              />
              <Scatter data={data} fill="var(--accent)" fillOpacity={0.85} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
