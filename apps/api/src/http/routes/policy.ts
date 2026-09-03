import { Hono } from 'hono';
import { listPolicyDecisions, policyDecisionCounts } from '../../db/queries.ts';
import {
  APPROVAL_THRESHOLD_PAISE,
  BLAST_RADIUS_PAISE_PER_HOUR,
  COOLDOWN_MINUTES,
  MAX_ATTEMPT_INDEX,
  POLICY_VERSION,
  RULES,
} from '../../domain/policy.ts';
import type { AppEnv } from '../app.ts';

export const policy = new Hono<AppEnv>();

/** The append-only decision log, ALLOWs included (§10). */
policy.get('/api/v1/policy/decisions', async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const [decisions, counts] = await Promise.all([listPolicyDecisions(limit), policyDecisionCounts()]);
  return c.json({
    decisions,
    counts: { ALLOW: counts.ALLOW ?? 0, DENY: counts.DENY ?? 0, REQUIRE_APPROVAL: counts.REQUIRE_APPROVAL ?? 0 },
    policy_version: POLICY_VERSION,
  });
});

/** The twelve rules and the current version. */
policy.get('/api/v1/policy/rules', (c) =>
  c.json({
    policy_version: POLICY_VERSION,
    rules: RULES,
    limits: {
      max_attempt_index: MAX_ATTEMPT_INDEX,
      cooldown_minutes: COOLDOWN_MINUTES,
      blast_radius_paise_per_hour: BLAST_RADIUS_PAISE_PER_HOUR,
      approval_threshold_paise: APPROVAL_THRESHOLD_PAISE,
    },
    // Shown on the page: the guardrail is a compile error, and the type says it
    // faster than prose.
    brand_snippet: [
      "declare const approved: unique symbol;                       // not exported",
      "export interface PolicyApprovedAction { readonly [approved]: true; /* … */ }",
      "export function approve(input, decision): PolicyApprovedAction | null;",
      "// executor.execute(action: PolicyApprovedAction) — nothing else compiles",
    ].join('\n'),
  }),
);
