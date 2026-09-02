'use client';

import { useEffect, useRef, useState } from 'react';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8090';

export interface FeedEvent {
  id: number;
  topic: string;
  data: Record<string, unknown>;
  at: number;
}

/**
 * Subscribes to `/api/v1/stream` (§10).
 *
 * The server pushes only after a transaction commits, so nothing shown here
 * can be un-happened by a rollback. `EventSource` reconnects on its own, which
 * matters when a demo laptop sleeps mid-run.
 *
 * Events are capped in memory: a 75,000-payment replay emits hundreds of
 * thousands of them, and an unbounded array would take the tab down long
 * before the run finished.
 */
export function useEventStream(max = 60): {
  events: FeedEvent[];
  connected: boolean;
  received: number;
} {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const received = useRef(0);
  const seq = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const source = new EventSource(`${BASE}/api/v1/stream`);
    const pending: FeedEvent[] = [];

    const push = (topic: string) => (e: MessageEvent<string>) => {
      received.current += 1;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        return;
      }
      seq.current += 1;
      pending.push({ id: seq.current, topic, data, at: Date.now() });
      if (pending.length > max) pending.splice(0, pending.length - max);
    };

    for (const topic of [
      'payment',
      'incident.opened',
      'incident.resolved',
      'case.opened',
      'policy.decided',
      'action.executed',
      'outcome.verified',
    ]) {
      source.addEventListener(topic, push(topic) as EventListener);
    }
    source.addEventListener('connected', () => setConnected(true));
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    // Batched into animation-rate updates. Re-rendering per event would mean
    // thousands of React commits a second during a fast replay.
    const flush = setInterval(() => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      setEvents((prev) => [...batch.reverse(), ...prev].slice(0, max));
      setTick((t) => t + 1);
    }, 250);

    return () => {
      clearInterval(flush);
      source.close();
    };
  }, [max]);

  void tick;
  return { events, connected, received: received.current };
}
