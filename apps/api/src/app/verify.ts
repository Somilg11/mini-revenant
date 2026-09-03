import { randomUUID } from 'node:crypto';
import { sql } from '../db/client.ts';
import { notify } from '../db/notify.ts';
import { capturedCases, lostCases, outboxWatermark, recordVerification, unactedLostCases } from '../db/queries.ts';
import { ASSIST_WINDOW_HOURS, attribute, creditedPaise, type Attribution } from '../domain/attribution.ts';
import { log } from '../lib/logger.ts';

/**
 * Verification (§10 — "Attribution rules", "The feedback loop").
 *
 * Every prediction must eventually meet an outcome. A case closes exactly
 * once, by constraint: `RECOVERED` when its payment is captured — attributed
 * `direct`, `assisted` or `organic`, and only the first two credited — or
 * `LOST` once the assist window has passed with nothing to show. The
 * probability the case was priced with is stored beside what happened, which
 * is what the live calibration curve is drawn from.
 */

const ASSIST_WINDOW = `${ASSIST_WINDOW_HOURS} hours`;

export interface VerifyResult {
  recovered: number;
  lost: number;
  byAttribution: Record<Attribution, number>;
  creditedPaise: number;
  organicPaise: number;
}

export async function verifyOutcomes(now: Date, limit = 500): Promise<VerifyResult> {
  const result: VerifyResult = {
    recovered: 0,
    lost: 0,
    byAttribution: { direct: 0, assisted: 0, organic: 0 },
    creditedPaise: 0,
    organicPaise: 0,
  };
  const at = now.toISOString();

  for (const c of await capturedCases(limit)) {
    const attribution = attribute(
      { capturedAt: c.captured_at, reference: c.capture_reference },
      c.acted_at ? { actedAt: c.acted_at, reference: c.action_reference } : null,
    );
    const credited = creditedPaise(attribution, c.amount_paise);
    // Verified when the capture happened, not when the sweep noticed: the
    // outcome belongs to the moment the money moved.
    const verifiedAt = c.captured_at > at ? at : c.captured_at;
    const id = `ov_${randomUUID().slice(0, 12)}`;
    const fresh = await recordVerification({
      id,
      case_id: c.case_id,
      attribution,
      recovered_amount_paise: c.amount_paise,
      credited_amount_paise: credited,
      predicted_probability: c.recovery_probability,
      actual_recovered: true,
      verified_at: verifiedAt,
      caseStatus: 'RECOVERED',
    });
    if (!fresh) continue;
    result.recovered += 1;
    result.byAttribution[attribution] += 1;
    result.creditedPaise += credited;
    if (attribution === 'organic') result.organicPaise += c.amount_paise;
    await announce({ id, caseId: c.case_id, paymentId: c.payment_id, attribution, recovered: true, amount: c.amount_paise, credited, predicted: c.recovery_probability });
  }

  // A loss is judged against how far the data has got, never against the
  // clock: the capture may be sitting in the outbox behind the relay, and
  // "six hours with nothing" is only true once those six hours of events
  // have been projected. A recovery, by contrast, can be recognised the
  // moment it lands.
  const watermark = await outboxWatermark();
  const judgeAt = watermark !== null && watermark < at ? watermark : at;
  const lost = [...(await lostCases(judgeAt, ASSIST_WINDOW, limit)), ...(await unactedLostCases(judgeAt, ASSIST_WINDOW, limit))];
  for (const c of lost) {
    const id = `ov_${randomUUID().slice(0, 12)}`;
    const fresh = await recordVerification({
      id,
      case_id: c.case_id,
      // A loss has no attribution to speak of; the column is NOT NULL and
      // `organic` is the value that credits nothing.
      attribution: 'organic',
      recovered_amount_paise: 0,
      credited_amount_paise: 0,
      predicted_probability: c.recovery_probability,
      actual_recovered: false,
      verified_at: at,
      caseStatus: 'LOST',
    });
    if (!fresh) continue;
    result.lost += 1;
    await announce({ id, caseId: c.case_id, paymentId: c.payment_id, attribution: null, recovered: false, amount: c.amount_paise, credited: 0, predicted: c.recovery_probability });
  }

  if (result.recovered > 0 || result.lost > 0) {
    log.info('outcomes verified', {
      recovered: result.recovered,
      lost: result.lost,
      ...result.byAttribution,
      creditedPaise: result.creditedPaise,
      organicPaise: result.organicPaise,
    });
  }
  return result;
}

async function announce(o: {
  id: string;
  caseId: string;
  paymentId: string;
  attribution: Attribution | null;
  recovered: boolean;
  amount: number;
  credited: number;
  predicted: number | null;
}): Promise<void> {
  await sql.begin(async (tx) => {
    await notify(tx, 'outcome.verified', {
      verification_id: o.id,
      case_id: o.caseId,
      payment_id: o.paymentId,
      attribution: o.attribution,
      actual_recovered: o.recovered,
      amount_paise: o.amount,
      credited_amount_paise: o.credited,
      predicted_probability: o.predicted,
    });
  });
}
