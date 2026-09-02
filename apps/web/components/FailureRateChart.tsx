'use client';

import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SimIncident } from '@/lib/sim';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8090';

interface Point {
  bucket_start: string;
  attempts: number;
  failures: number;
  abandoned: number;
  failure_rate: number | null;
}

/**
 * Failure rate over time, with the injected incident windows shaded (§11.2).
 *
 * One accent series and no legend (§11.4). The shading is ground truth — the
 * windows the generator degraded — so from P7 the detector's own markers can be
 * compared against them by eye, not just by a score.
 */
export function FailureRateChart({
  incidents,
  running,
}: {
  incidents: SimIncident[];
  running: boolean;
}) {
  const [points, setPoints] = useState<Point[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${BASE}/api/v1/metrics/timeseries?granularity=hour`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error();
        const body = (await res.json()) as { points: Point[] };
        if (!cancelled) {
          setPoints(body.points ?? []);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void load();
    // While the replay runs the chart fills; when paused there is nothing new.
    const id = setInterval(load, running ? 3000 : 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running]);

  const data = points.map((p) => ({
    t: Date.parse(p.bucket_start),
    label: p.bucket_start,
    rate: p.failure_rate === null ? null : p.failure_rate * 100,
    attempts: p.attempts,
    failures: p.failures + p.abandoned,
  }));

  return (
    <div className="card" style={{ minHeight: 320 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="label">Failure rate</div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          shaded = injected incident windows (ground truth)
        </div>
      </div>

      {data.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', paddingTop: 12 }}>
          {error ? 'Cannot reach the API.' : 'No data yet — press Play.'}
        </div>
      ) : (
        <div style={{ height: 268, marginTop: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="fr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--danger)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--danger)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t: number) =>
                  new Date(t).toLocaleDateString('en-IN', {
                    timeZone: 'Asia/Kolkata',
                    day: '2-digit',
                    month: 'short',
                  })
                }
                stroke="var(--text-tertiary)"
                tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                tickLine={false}
                axisLine={false}
                minTickGap={40}
              />
              <YAxis
                unit="%"
                stroke="var(--text-tertiary)"
                tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                tickLine={false}
                axisLine={false}
                width={46}
              />
              {incidents.map((i) => (
                <ReferenceArea
                  key={i.id}
                  x1={Date.parse(i.startedAt)}
                  x2={Date.parse(i.endedAt)}
                  fill="var(--warning)"
                  fillOpacity={0.1}
                  stroke="var(--warning)"
                  strokeOpacity={0.35}
                />
              ))}
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelFormatter={(t) =>
                  new Date(Number(t)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                }
                formatter={(v: number, _n, item) => [
                  `${v?.toFixed(1)}%  (${item.payload.failures} of ${item.payload.attempts})`,
                  'failure rate',
                ]}
              />
              <Area
                type="monotone"
                dataKey="rate"
                stroke="var(--danger)"
                strokeWidth={1.5}
                fill="url(#fr)"
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
