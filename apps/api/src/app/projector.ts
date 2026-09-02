import { sql, type Queryable } from '../db/client.ts';
import { notify } from '../db/notify.ts';
import {
  incrementsAttemptIndex,
  transition,
  type State,
} from '../domain/payment-state.ts';
import { AppError } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';
import { PaymentCreatedData, failureCodeOf, gatewayOf, type WebhookEvent } from './events.ts';

/**
 * Projector — applies the state machine to the payment table (§9).
 *
 * Everything below happens in ONE transaction: the `processed_events` marker,
 * the payment row, the state transition, and the notification. If any part
 * throws, all of it rolls back and the relay retries — and because the marker
 * rolls back with the effect, the retry is not a double-apply. That is the
 * "at-least-once delivery, at-most-once effect" of invariant 2.
 *
 * The payment row is taken `FOR UPDATE`. Two events for one payment arriving at
 * once then serialise on the row rather than racing to overwrite `state`.
 */

export const CONSUMER = 'projector';

export type ProjectionOutcome =
  | 'created'
  | 'applied'
  | 'stale'
  | 'already_processed'
  | 'rejected';

export interface ProjectionResult {
  outcome: ProjectionOutcome;
  paymentId: string;
  from?: State;
  to?: State;
  reason?: string;
}

interface PaymentRow {
  id: string;
  state: State;
  last_event_at: string;
  attempt_index: number;
  version: number;
  amount_paise: number;
  merchant_id: string;
}

export async function project(event: WebhookEvent): Promise<ProjectionResult> {
  return sql.begin(async (tx) => {
    // The at-most-once-effect marker, claimed by constraint before any work.
    // It shares this transaction with the effect, so the two cannot diverge.
    const claimed = await tx<{ event_id: string }[]>`
      INSERT INTO processed_events (consumer, event_id)
      VALUES (${CONSUMER}, ${event.event_id})
      ON CONFLICT DO NOTHING
      RETURNING event_id
    `;
    if (claimed.length === 0) {
      return { outcome: 'already_processed' as const, paymentId: event.payment_id };
    }

    // Row lock: concurrent events for one payment serialise here.
    const [existing] = await tx<PaymentRow[]>`
      SELECT id, state, last_event_at, attempt_index, version, amount_paise, merchant_id
      FROM payments
      WHERE id = ${event.payment_id}
      FOR UPDATE
    `;

    if (!existing) {
      if (event.kind !== 'payment.created') {
        // The creating event has not arrived yet. This is transient under
        // reordering, so let the relay retry — and let it dead-letter if the
        // payment genuinely never appears, rather than looping forever.
        throw new AppError(
          'PAYMENT_NOT_FOUND',
          `no payment ${event.payment_id} for ${event.kind}`,
          { errorClass: 'RETRYABLE', detail: { paymentId: event.payment_id, kind: event.kind } },
        );
      }
      return createPayment(tx, event);
    }

    if (event.kind === 'payment.created') {
      // A second creating event for a payment that exists is malformed input,
      // not a race. Retrying cannot fix it, so it is rejected rather than
      // thrown — throwing would burn five outbox attempts to reach the same
      // conclusion.
      log.warn('duplicate payment.created for an existing payment', {
        paymentId: event.payment_id,
        eventId: event.event_id,
      });
      return {
        outcome: 'rejected' as const,
        paymentId: event.payment_id,
        reason: 'ALREADY_CREATED',
      };
    }

    const result = transition(
      existing.state,
      event.kind,
      event.occurred_at,
      existing.last_event_at,
    );

    if (!result.ok) {
      // TERMINAL_PROTECTED here is the double-charge guard firing, and it is
      // worth seeing in the log rather than silently dropping.
      log.warn('transition refused', {
        paymentId: event.payment_id,
        eventId: event.event_id,
        from: existing.state,
        kind: event.kind,
        reason: result.error,
      });
      return {
        outcome: 'rejected' as const,
        paymentId: event.payment_id,
        from: existing.state,
        reason: result.error,
      };
    }

    // Both stale and live transitions are recorded. §14: an out-of-order event
    // is recorded with `stale = true` and does not move state — recording it is
    // what makes the reordering visible in the audit trail rather than lost.
    await tx`
      INSERT INTO payment_state_transitions
        (payment_id, from_state, to_state, event_id, occurred_at, stale)
      VALUES (
        ${event.payment_id}, ${existing.state}, ${result.next},
        ${event.event_id}, ${event.occurred_at}, ${result.stale}
      )
    `;

    if (result.stale) {
      return {
        outcome: 'stale' as const,
        paymentId: event.payment_id,
        from: existing.state,
        to: existing.state,
      };
    }

    const startsNewAttempt = incrementsAttemptIndex(existing.state, result.next);
    const failureCode = event.kind === 'payment.failed' ? failureCodeOf(event) : null;
    const routedGateway = event.kind === 'payment.attempted' ? gatewayOf(event) : null;

    await tx`
      UPDATE payments SET
        state         = ${result.next},
        last_event_at = ${event.occurred_at},
        attempt_index = attempt_index + ${startsNewAttempt ? 1 : 0},
        -- A new attempt clears the previous verdict: the payment is in flight
        -- again, and a stale failure_code beside an ATTEMPTED state would be
        -- read as the current reason by everything downstream.
        failure_code  = ${failureCode ?? null},
        gateway       = COALESCE(${routedGateway}, gateway),
        abandoned     = FALSE,
        version       = version + 1
      WHERE id = ${event.payment_id}
    `;

    await notify(tx, 'payment', {
      payment_id: event.payment_id,
      merchant_id: existing.merchant_id,
      from: existing.state,
      to: result.next,
      amount_paise: existing.amount_paise,
      ...(failureCode ? { failure_code: failureCode } : {}),
    });

    return {
      outcome: 'applied' as const,
      paymentId: event.payment_id,
      from: existing.state,
      to: result.next,
    };
  });
}

async function createPayment(tx: Queryable, event: WebhookEvent): Promise<ProjectionResult> {
  const parsed = PaymentCreatedData.safeParse(event.data);
  if (!parsed.success) {
    // Malformed input. Retrying cannot fix it.
    log.warn('payment.created payload rejected', {
      paymentId: event.payment_id,
      eventId: event.event_id,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return { outcome: 'rejected', paymentId: event.payment_id, reason: 'INVALID_PAYLOAD' };
  }

  const d = parsed.data;
  await tx`
    INSERT INTO payments (
      id, merchant_id, customer_id, amount_paise, method, bank, currency,
      card_country, card_network, is_international, threeds_required, gateway,
      state, created_at, last_event_at
    ) VALUES (
      ${event.payment_id}, ${d.merchant_id}, ${d.customer_id}, ${d.amount_paise},
      ${d.method}, ${d.bank}, ${d.currency}, ${d.card_country}, ${d.card_network},
      ${d.is_international}, ${d.threeds_required}, ${d.gateway},
      'CREATED', ${event.occurred_at}, ${event.occurred_at}
    )
  `;

  await notify(tx, 'payment', {
    payment_id: event.payment_id,
    merchant_id: d.merchant_id,
    to: 'CREATED',
    amount_paise: d.amount_paise,
  });

  return { outcome: 'created', paymentId: event.payment_id, to: 'CREATED' };
}
