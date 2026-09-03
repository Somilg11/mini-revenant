--
-- The agent's audit row (§7.8) records the prompt hash, the raw response, the
-- parsed choice and the source. The prose the operator reads and the model's
-- stated confidence were only recoverable by re-parsing raw_response, and a
-- fallback has no raw response at all — so they get columns.

ALTER TABLE agent_decisions
  ADD COLUMN IF NOT EXISTS narrative  TEXT,
  ADD COLUMN IF NOT EXISTS confidence TEXT CHECK (confidence IN ('low', 'medium', 'high'));

CREATE INDEX IF NOT EXISTS agent_decisions_case     ON agent_decisions (case_id);
CREATE INDEX IF NOT EXISTS agent_decisions_incident ON agent_decisions (incident_id);
CREATE INDEX IF NOT EXISTS agent_decisions_created  ON agent_decisions (created_at DESC);
