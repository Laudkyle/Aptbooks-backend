-- 009_accrual_runs_uniques.sql
-- Production-grade run-once enforcement using partial unique indexes

-- For period-based runs (period_id IS NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_accrual_runs_rule_period_date
ON accrual_runs (organization_id, accrual_rule_id, period_id, as_of_date)
WHERE period_id IS NOT NULL;

-- For date-based runs (period_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_accrual_runs_rule_date
ON accrual_runs (organization_id, accrual_rule_id, as_of_date)
WHERE period_id IS NULL;
