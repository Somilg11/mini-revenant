/**
 * Attribution (§10, "Attribution rules").
 *
 * PURE. Recovery and attribution are separate questions: `revenue_recovered`
 * says the money came back, attribution says whether Revenant brought it
 * back. Only `direct` and `assisted` are credited; `organic` credits **zero**.
 *
 *   direct    captured within 30 simulated minutes of our action, and the
 *             gateway reference on the capture is ours
 *   assisted  captured within 6 simulated hours of our action, different
 *             reference — the customer came back, plausibly because we asked
 *   organic   captured with no action, before our action, or beyond the
 *             assist window
 */

export type Attribution = 'direct' | 'assisted' | 'organic';

export const DIRECT_WINDOW_MINUTES = 30;
export const ASSIST_WINDOW_HOURS = 6;
export const ASSIST_WINDOW_MINUTES = ASSIST_WINDOW_HOURS * 60;

export interface Capture {
  capturedAt: string;
  /** The gateway reference the capture event carried, if any. */
  reference: string | null;
}

export interface OurAction {
  /** When the action was sent, in simulated time. */
  actedAt: string;
  /** The reference the gateway gave us for it. */
  reference: string | null;
}

export function attribute(capture: Capture, action: OurAction | null): Attribution {
  if (!action) return 'organic';
  const minutes = (Date.parse(capture.capturedAt) - Date.parse(action.actedAt)) / 60_000;
  // Captured before we acted: whatever brought it back, it was not us.
  if (minutes < 0) return 'organic';
  const ours = capture.reference !== null && action.reference !== null && capture.reference === action.reference;
  if (ours && minutes <= DIRECT_WINDOW_MINUTES) return 'direct';
  if (minutes <= ASSIST_WINDOW_MINUTES) return 'assisted';
  return 'organic';
}

/** What Revenant may claim for a recovery. Organic is zero, not "most of it". */
export function creditedPaise(attribution: Attribution, amountPaise: number): number {
  return attribution === 'organic' ? 0 : amountPaise;
}

/**
 * A case whose action has had the whole assist window to work and whose
 * payment is still unresolved is lost. Judged against simulated time; an
 * action sent five minutes ago is not lost, it is pending.
 */
export function isLost(actedAt: string, now: string): boolean {
  return Date.parse(now) - Date.parse(actedAt) >= ASSIST_WINDOW_MINUTES * 60_000;
}
