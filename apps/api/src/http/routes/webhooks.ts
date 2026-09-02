import { Hono } from 'hono';
import { config } from '../../config.ts';
import { ingest } from '../../app/ingest.ts';
import { WebhookEvent, validatePayload } from '../../app/events.ts';
import { verify } from '../../lib/signature.ts';
import { log } from '../../lib/logger.ts';
import type { AppEnv } from '../app.ts';

export const webhooks = new Hono<AppEnv>();

/**
 * A gateway event is a few hundred bytes. Anything larger is a mistake or an
 * attempt to make the process buffer memory on our behalf, and either way the
 * cheapest possible answer is the right one — before the body is read, not
 * after.
 */
const MAX_BODY_BYTES = 64 * 1024;

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
  // Reject on the declared length first, so an oversized body is never read
  // into memory at all.
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return c.json(
      { error: { code: 'BODY_TOO_LARGE', message: `body exceeds ${MAX_BODY_BYTES} bytes` } },
      413,
    );
  }

  // The raw body, not the parsed one: re-serialising JSON changes byte order
  // and the signature would never match.
  const raw = await c.req.text();

  // A missing or lying Content-Length gets caught here instead.
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return c.json(
      { error: { code: 'BODY_TOO_LARGE', message: `body exceeds ${MAX_BODY_BYTES} bytes` } },
      413,
    );
  }

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

  // Reject an unprocessable payload here, not silently in the projector.
  const payload = validatePayload(parsed.data);
  if (!payload.ok) {
    return c.json(
      {
        error: {
          code: 'INVALID_PAYLOAD',
          message: `${parsed.data.kind} payload failed validation`,
          detail: { issues: payload.issues },
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
