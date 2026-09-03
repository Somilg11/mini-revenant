import { sql } from '../db/client.ts';
import { groundTruthIncidents, listIncidents, type IncidentRow } from '../db/queries.ts';
import { log } from '../lib/logger.ts';

/**
 * Scoring detection against the answer key (§8.4).
 *
 * "We detected all six incidents" means nothing on its own — a detector that
 * fires on everything detects all six too. Precision against the **unlabelled**
 * noise windows is the half of the claim that costs something, so both are
 * computed and both are shown.
 */

export interface DetectionMatch {
  groundTruthId: string;
  kind: string;
  startedAt: string;
  endedAt: string;
  dimensions: Record<string, string>;
  affectedPayments: number;
  detected: boolean;
  detectedIncidentId: string | null;
  detectedAt: string | null;
  /** Whether it was found on the dimension the generator actually degraded. */
  onCorrectDimension: boolean;
  detectedDimension: string | null;
  /** How many slices lit up for this one degradation. */
  corroboratingDetections: number;
  allDimensions: string[];
  /** Why it was missed, when it was. A bare recall figure explains nothing. */
  missReason: string | null;
}

export interface DetectionScore {
  matches: DetectionMatch[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  totalIncidentsOpened: number;
  /** Detected incidents that overlap no labelled window at all. */
  unmatched: { id: string; dimension: string; dimensionValue: string; openedAt: string }[];
}

/**
 * Why a labelled incident went undetected, where the reason is structural
 * rather than a detector fault.
 *
 * Reporting recall without these is misleading in both directions: it makes the
 * detector look worse than it is, and it hides that the dataset — not the
 * algorithm — is what would have to change.
 */
const MISS_REASONS: Record<string, string> = {
  HIGH_VALUE_FAILURES:
    'below the volume floor: the ₹10k–50k band carries about 10 attempts per 15-minute window, ' +
    'and §7.3 requires 20. The degradation is real and large (≈60% against an 11.5% baseline) ' +
    'but six failures in ten attempts is not statistical evidence — this is the volume gate ' +
    'working, not failing. It would need roughly four times the dataset volume to clear.',
  ABANDONMENT_SPIKE:
    'below the statistical-power floor: the spike is clearly present on method=card ' +
    '(27.3% against an 11.3% baseline — 16 points, 2.4×, and four of five gates pass) but the ' +
    'slice carries only ~55 attempts per 15-minute window, giving z = 3.7 against the required ' +
    '5.0. Fifteen failures where six were expected is suggestive, not conclusive, and §7.3 is ' +
    'deliberately set to refuse suggestive. Roughly twice the dataset volume would clear it.',
  CUSTOMER_COHORT:
    'not a detector dimension: rollups cover all, method, bank, amount_band, is_international, ' +
    'card_network and card_country. `customer_cohort` is an RCA dimension (§7.4), not one the ' +
    'detector sweeps, so the degradation only shows on the aggregate — where it is a 5.2-point ' +
    'wobble that every gate correctly refuses.',
};

/** An incident counts as detected if it opens inside the window, or shortly after it. */
const GRACE_MINUTES = 90;

function overlaps(incident: IncidentRow, startedAt: string, endedAt: string): boolean {
  const opened = Date.parse(incident.opened_at);
  return (
    opened >= Date.parse(startedAt) &&
    opened <= Date.parse(endedAt) + GRACE_MINUTES * 60_000
  );
}

/**
 * Does a detected slice match the tuple the generator degraded?
 *
 * The centrepiece incident degrades `is_international × card × THREEDS_FAILED`,
 * and the claim being made is that it is visible on the `is_international`
 * series specifically. Matching on *any* of the labelled dimensions is the
 * honest test: the detector is per-dimension, so finding it on one of the
 * degraded dimensions is a hit.
 */
function matchesDimensions(incident: IncidentRow, dimensions: Record<string, string>): boolean {
  const value = dimensions[incident.dimension];
  return value !== undefined && value === incident.dimension_value;
}

export async function scoreDetection(): Promise<DetectionScore> {
  const [truth, detected] = await Promise.all([
    groundTruthIncidents(),
    listIncidents('ALL', 500),
  ]);

  /**
   * The definition, stated because it is the whole claim:
   *
   *  - **Recall** — labelled incidents with at least one detection overlapping
   *    their window, over all labelled incidents.
   *  - **Precision** — detections that overlap some labelled window, over all
   *    detections.
   *
   * Attribution is by **window**, not one-to-one. A real degradation shows up
   * on several slices at once — a UPI outage moves the banks that carry UPI —
   * and scoring those as false positives would punish the detector for being
   * right more than once. Which slice is the *cause* is a different question,
   * and it is what RCA answers in P8; `onCorrectDimension` reports it here as a
   * quality signal without letting it distort precision.
   */
  const attributed = new Set<string>();
  const matches: DetectionMatch[] = truth.map((gt) => {
    const overlapping = detected.filter((d) => overlaps(d, gt.started_at, gt.ended_at));
    for (const d of overlapping) attributed.add(d.id);

    // Prefer reporting a hit on a dimension the generator actually degraded.
    const onDimension = overlapping.find((d) => matchesDimensions(d, gt.dimensions));
    const hit = onDimension ?? overlapping[0] ?? null;

    return {
      groundTruthId: gt.id,
      kind: gt.kind,
      startedAt: gt.started_at,
      endedAt: gt.ended_at,
      dimensions: gt.dimensions,
      affectedPayments: gt.affected_payments,
      detected: hit !== null,
      detectedIncidentId: hit?.id ?? null,
      detectedAt: hit?.opened_at ?? null,
      onCorrectDimension: onDimension !== undefined,
      detectedDimension: hit ? `${hit.dimension}=${hit.dimension_value}` : null,
      corroboratingDetections: overlapping.length,
      allDimensions: overlapping.map((d) => `${d.dimension}=${d.dimension_value}`),
      missReason: hit ? null : (MISS_REASONS[gt.kind] ?? null),
    };
  });

  const unmatched = detected
    .filter((d) => !attributed.has(d.id))
    .map((d) => ({
      id: d.id,
      dimension: d.dimension,
      dimensionValue: d.dimension_value,
      openedAt: d.opened_at,
    }));

  const truePositives = matches.filter((m) => m.detected).length;
  const falseNegatives = matches.length - truePositives;
  const falsePositives = unmatched.length;
  const attributedDetections = detected.length - unmatched.length;

  return {
    matches,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: detected.length === 0 ? null : attributedDetections / detected.length,
    recall: matches.length === 0 ? null : truePositives / matches.length,
    totalIncidentsOpened: detected.length,
    unmatched,
  };
}

/** Records which detected incident answered which labelled one — never the reverse. */
export async function linkGroundTruth(score: DetectionScore): Promise<void> {
  for (const m of score.matches) {
    await sql`
      UPDATE ground_truth_incidents
      SET detected_incident_id = ${m.detectedIncidentId}
      WHERE id = ${m.groundTruthId}`;
  }
  log.debug('ground truth linked', { matched: score.truePositives });
}

export interface NoiseScore {
  windows: { startedAt: string; endedAt: string; firedIncidents: number }[];
  clean: boolean;
}

/**
 * The precision test (§8.4).
 *
 * Two windows carry mild fluctuation and are deliberately never labelled. A
 * detector that fires on them is wrong, and without them "we detected all six"
 * would be an unfalsifiable claim.
 */
export async function scoreNoiseWindows(
  windows: readonly { startedAt: string; endedAt: string }[],
): Promise<NoiseScore> {
  const scored = [] as NoiseScore['windows'];
  for (const w of windows) {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM incidents
      WHERE opened_at >= ${w.startedAt} AND opened_at < ${w.endedAt}`;
    scored.push({ startedAt: w.startedAt, endedAt: w.endedAt, firedIncidents: row?.n ?? 0 });
  }
  return { windows: scored, clean: scored.every((w) => w.firedIncidents === 0) };
}

// ── RCA scoring (§8.4) ───────────────────────────────────────────────────────

export interface RcaScore {
  scored: number;
  top1Correct: number;
  top3Correct: number;
  top1Accuracy: number | null;
  results: {
    kind: string;
    labelled: Record<string, string>;
    incidentId: string | null;
    top1: string | null;
    top1Confidence: number | null;
    top1ExcessShare: number | null;
    top1Correct: boolean;
    top3: string[];
    top3Correct: boolean;
  }[];
}

/**
 * Does a hypothesis name the tuple the generator actually degraded?
 *
 * A hit means every dimension the hypothesis names agrees with the labelled
 * tuple. It need not name all of them: `is_international=true × method=card` is
 * a correct diagnosis of `is_international × card × THREEDS_FAILED`, just a less
 * sharp one. Naming a dimension the label contradicts is a miss.
 */
function hypothesisMatches(
  tuple: Record<string, string>,
  labelled: Record<string, string>,
): boolean {
  const named = Object.keys(tuple);
  if (named.length === 0) return false;
  let overlap = 0;
  for (const [k, v] of Object.entries(tuple)) {
    const expected = labelled[k];
    if (expected === undefined) continue;
    if (expected !== v) return false;
    overlap += 1;
  }
  // It has to actually intersect the labelled tuple, not merely avoid
  // contradicting it.
  return overlap > 0;
}

export async function scoreRca(): Promise<RcaScore> {
  const truth = await groundTruthIncidents();
  const detected = await listIncidents('ALL', 500);

  const results: RcaScore['results'] = [];

  for (const gt of truth) {
    const overlapping = detected.filter((d) => overlaps(d, gt.started_at, gt.ended_at));
    // Score the diagnosis of the incident that best identified the slice.
    const withCause = overlapping.filter(
      (d) => d.root_cause !== null && d.root_cause !== undefined,
    );
    if (withCause.length === 0) continue;

    const onDimension = withCause.find((d) => {
      const v = gt.dimensions[d.dimension];
      return v !== undefined && v === d.dimension_value;
    });
    const chosen = onDimension ?? withCause[0]!;
    const rc = chosen.root_cause as { hypotheses?: { label: string; tuple: Record<string, string>; confidence: number; excessShare: number }[] };
    const hypotheses = rc.hypotheses ?? [];
    if (hypotheses.length === 0) continue;

    const top = hypotheses[0]!;
    const top1Correct = hypothesisMatches(top.tuple, gt.dimensions);
    const top3Correct = hypotheses.slice(0, 3).some((h) => hypothesisMatches(h.tuple, gt.dimensions));

    results.push({
      kind: gt.kind,
      labelled: gt.dimensions,
      incidentId: chosen.id,
      top1: top.label,
      top1Confidence: top.confidence,
      top1ExcessShare: top.excessShare,
      top1Correct,
      top3: hypotheses.slice(0, 3).map((h) => h.label),
      top3Correct,
    });
  }

  const top1Correct = results.filter((r) => r.top1Correct).length;
  return {
    scored: results.length,
    top1Correct,
    top3Correct: results.filter((r) => r.top3Correct).length,
    top1Accuracy: results.length === 0 ? null : top1Correct / results.length,
    results,
  };
}
