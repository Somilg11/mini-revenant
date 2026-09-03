--
-- The executor's worklist is "approved decisions with no action yet": a
-- NOT EXISTS against recovery_actions by policy_decision_id. The policy gate
-- counts a merchant's actions today by created_at. Neither had an index.

CREATE INDEX IF NOT EXISTS recovery_actions_decision
  ON recovery_actions (policy_decision_id);

CREATE INDEX IF NOT EXISTS recovery_actions_created
  ON recovery_actions (created_at);
