import { z } from 'zod';
import { EVENT_KINDS } from '../domain/payment-state.ts';

/**
 * The gateway webhook payload (§9, §10).
 *
 * One envelope for every event kind, with the kind-specific fields in `data`.
 * `payment.created` carries the whole payment because it is the only event that
 * brings a payment into existence; every later event carries only what changes.
 */

/**
 * ₹10 crore. Mirrors the `payments_amount_sane` CHECK in migration 003.
 *
 * The bound is not cosmetic: amounts near `MAX_SAFE_INTEGER` sum past it, and
 * the driver then refuses to round a BIGINT it cannot represent exactly, so
 * every aggregate for that window fails permanently. Rejecting at the edge
 * gives the sender a 400 it can act on instead of a 500 nobody can.
 */
export const MAX_AMOUNT_PAISE = 1_000_000_000;

export const PaymentMethod = z.enum(['upi', 'card', 'netbanking', 'wallet']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

/** The attributes of a payment, all present on `payment.created`. */
export const PaymentCreatedData = z.object({
  merchant_id: z.string().min(1),
  customer_id: z.string().min(1),
  amount_paise: z.number().int().positive().max(MAX_AMOUNT_PAISE),
  method: PaymentMethod,
  bank: z.string().min(1).nullable().default(null),
  currency: z.string().length(3).default('INR'),
  card_country: z.string().length(2).nullable().default(null),
  card_network: z.string().min(1).nullable().default(null),
  // §1.1 — a first-class dimension, not a flag.
  is_international: z.boolean().default(false),
  threeds_required: z.boolean().default(false),
  gateway: z.string().min(1).default('primary'),
});
export type PaymentCreatedData = z.infer<typeof PaymentCreatedData>;

/**
 * A timestamp outside this range is not a payment, it is a bug or an attack.
 *
 * `occurred_at` decides a payment's rollup bucket and its window membership, so
 * one event dated 9999 stretches the dashboard's default window across eight
 * millennia and creates rollup rows nothing will ever read. The lower bound
 * predates electronic payments in India; the upper allows a simulated clock to
 * run ahead without allowing nonsense.
 */
const EARLIEST_EVENT_MS = Date.parse('2000-01-01T00:00:00Z');
const FUTURE_TOLERANCE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export const WebhookEvent = z.object({
  event_id: z.string().min(1).max(128),
  payment_id: z.string().min(1).max(128),
  kind: z.enum(EVENT_KINDS),
  occurred_at: z
    .string()
    .datetime({ offset: true })
    .refine(
      (v) => {
        const ms = Date.parse(v);
        return ms >= EARLIEST_EVENT_MS && ms <= Date.now() + FUTURE_TOLERANCE_MS;
      },
      { message: 'occurred_at is outside the plausible range' },
    ),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/**
 * Validates the kind-specific payload at the edge.
 *
 * The projector rejects a malformed `payment.created` too, but by then the
 * sender has already had its 200 and will never learn the event was discarded.
 * A gateway silently dropping payment events is precisely the failure this
 * system exists to make visible, so an unprocessable payload is a 400 the
 * sender can act on rather than a success it cannot.
 */
export function validatePayload(event: WebhookEvent): { ok: true } | { ok: false; issues: string[] } {
  if (event.kind !== 'payment.created') return { ok: true };
  const parsed = PaymentCreatedData.safeParse(event.data);
  if (parsed.success) return { ok: true };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `data.${i.path.join('.')}: ${i.message}`),
  };
}

/** The outbox payload the relay hands to the projector. Same shape, by design. */
export type PaymentEventMessage = WebhookEvent;

export const OUTBOX_TOPIC_PAYMENT_EVENT = 'payment.event';

/** Reads `failure_code` off a `payment.failed` event, tolerating its absence. */
export function failureCodeOf(event: WebhookEvent): string | null {
  const code = event.data.failure_code;
  return typeof code === 'string' && code.length > 0 ? code.toUpperCase() : null;
}

/** Reads the gateway route a `payment.attempted` was sent through, if stated. */
export function gatewayOf(event: WebhookEvent): string | null {
  const g = event.data.gateway;
  return typeof g === 'string' && g.length > 0 ? g : null;
}
