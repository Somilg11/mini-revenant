import { Hono } from 'hono';
import { config } from '../../config.ts';
import { ingest } from '../../app/ingest.ts';
import { WebhookEvent } from '../../app/events.ts';
import { verify } from '../../lib/signature.ts';
import { log } from '../../lib/logger.ts';
import type { AppEnv } from '../app.ts';

export const webhooks = new Hono<AppEnv>();

/**
 * The ingest path (§9, §10).
 *
 * Does exactly two things and returns: verify the signature, then write the
 * event and its outbox row in one transaction. **Nothing else is synchronous.**
 * A gateway that has to wait for detection, scoring and policy evaluation
 * before it gets a 200 will time out and redeliver, which is how a spike turns
 * into a stampede.
 */
webhooks.post('/webhooks/gateway', async (c) => {
  // The raw body, not the parsed one: re-serialising JSON changes byte order
  // and the signature would never match.
  const raw = await c.req.text();

  if (!verify(raw, config.WEBHOOK_SECRET, c.req.header('X-Webhook-Signature') ?? null)) {
    log.warn('webhook signature rejected', {
      requestId: c.get('requestId'),
      bytes: raw.length,
    });
    // No detail: a precise reason tells a prober how close they got.
    return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'invalid signature' } }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: { code: 'INVALID_JSON', message: 'body is not JSON' } }, 400);
  }

  const parsed = WebhookEvent.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'INVALID_EVENT',
          message: 'event failed validation',
          detail: {
            issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          },
        },
      },
      400,
    );
  }

  const result = await ingest(parsed.data);

  // A duplicate is a success from the sender's point of view — it delivered the
  // event. Answering 4xx would make a well-behaved gateway retry forever.
  return c.json({ ok: true, outcome: result.outcome, event_id: result.eventId }, 200);
});
