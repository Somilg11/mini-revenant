-- 002_seed_merchants.sql
-- Five synthetic merchants (§8.1 default: SIM_MERCHANTS=5).
-- Budgets are the schema defaults, stated explicitly so the policy engine's
-- rules 7 and 8 have visible inputs on the /policy page.

INSERT INTO merchants (id, name, is_synthetic, is_paused,
                       daily_action_budget_paise, daily_action_budget_count)
VALUES
  ('mch_kavir',    'Kaviri Labs',      TRUE, FALSE, 5000000, 200),
  ('mch_nilgiri',  'Nilgiri Commerce', TRUE, FALSE, 5000000, 200),
  ('mch_tamarai',  'Tamarai SaaS',     TRUE, FALSE, 5000000, 200),
  ('mch_orbital',  'Orbital Studio',   TRUE, FALSE, 5000000, 200),
  ('mch_sarayu',   'Sarayu Retail',    TRUE, FALSE, 5000000, 200)
ON CONFLICT (id) DO NOTHING;
