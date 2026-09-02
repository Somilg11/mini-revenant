const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8090';

export interface ClockState {
  now: string;
  running: boolean;
  speed: number;
  startsAt: string;
  endsAt: string;
  progress: number;
  etaSeconds: number | null;
}

export interface SimIncident {
  id: string;
  kind: string;
  startedAt: string;
  endedAt: string;
  affectedPayments: number;
}

export interface SimState {
  clock: ClockState;
  dataset: { seed: number; payments: number; events: number; checksum: string } | null;
  emitted: number;
  incidents: SimIncident[];
}

async function call(path: string, method: 'GET' | 'POST' = 'GET'): Promise<SimState> {
  const res = await fetch(`${BASE}${path}`, { method, cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json() as Promise<SimState>;
}

export const simApi = {
  state: () => call('/api/v1/sim/state'),
  start: () => call('/api/v1/sim/start', 'POST'),
  pause: () => call('/api/v1/sim/pause', 'POST'),
  reset: () => call('/api/v1/sim/reset', 'POST'),
  speed: (n: number) => call(`/api/v1/sim/speed?speed=${n}`, 'POST'),
  jump: (id: string) => call(`/api/v1/sim/jump-to-incident?id=${encodeURIComponent(id)}`, 'POST'),
};

/** IST in the browser only — code is UTC everywhere (invariant 7). */
export function formatIst(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
