import { z } from 'zod';
import { EVENT_KINDS } from '../domain/payment-state.ts';

/**
 * The gateway webhook payload (§9, §10).
 *
 * One envelope for every event kind, with the kind-specific fields in `data`.
 * `payment.created` carries the whole payment because it is the only event that
 * brings a payment into existence; every later event carries only what changes.
 */

export const PaymentMethod = z.enum(['upi', 'card', 'netbanking', 'wallet']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

/** The attributes of a payment, all present on `payment.created`. */
export const PaymentCreatedData = z.object({
  merchant_id: z.string().min(1),
  customer_id: z.string().min(1),
  amount_paise: z.number().int().positive(),
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

export const WebhookEvent = z.object({
  event_id: z.string().min(1).max(128),
  payment_id: z.string().min(1).max(128),
  kind: z.enum(EVENT_KINDS),
  occurred_at: z.string().datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

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
