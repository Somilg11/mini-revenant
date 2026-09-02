import { Hono } from 'hono';
import { subscribe, subscriberCount } from '../db/notify.ts';
import { log } from '../lib/logger.ts';
import type { AppEnv } from './app.ts';

export const stream = new Hono<AppEnv>();

/**
 * Server-Sent Events (§10).
 *
 * Fed by `LISTEN revenant_events`, which handlers emit **inside the transaction
 * that writes**. The dashboard therefore shows an event only after it has
 * committed: nothing appears on screen that a rollback later un-happens, and
 * there is no polling loop asking "anything yet?" sixty times a minute.
 *
 * SSE rather than WebSockets because the traffic is one-directional — the
 * dashboard never sends anything back over this channel — and SSE reconnects on
 * its own, which matters when a demo laptop sleeps mid-run.
 */
const HEARTBEAT_MS = 15_000;

stream.get('/api/v1/stream', (c) => {
  const requestId = c.get('requestId');

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client vanished between the check and the write.
          closed = true;
        }
      };

      send(`retry: 2000\n\n`);
      send(`event: connected\ndata: ${JSON.stringify({ requestId })}\n\n`);

      const unsubscribe = subscribe((event) => {
        send(`event: ${event.topic}\ndata: ${JSON.stringify(event.data)}\n\n`);
      });

      // Comment frames keep proxies and load balancers from treating a quiet
      // stream as a dead one.
      const heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
        log.debug('sse client disconnected', { requestId, remaining: subscriberCount() });
      };

      // Fires when the client navigates away or the connection drops. Without
      // it, every refresh leaks a subscriber and a timer for the life of the
      // process.
      c.req.raw.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops nginx and friends buffering the stream into uselessness.
      'X-Accel-Buffering': 'no',
    },
  });
});
