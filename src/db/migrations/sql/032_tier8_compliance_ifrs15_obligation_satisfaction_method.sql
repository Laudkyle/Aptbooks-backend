BEGIN;

-- IFRS 15: allow INPUT satisfaction method (Stage 2 / advanced use cases).
-- Stage 1 schema constrained satisfaction_method to ('TIME','OUTPUT') but the API/validators allow 'INPUT'.
-- This migration relaxes the check constraint.

ALTER TABLE ifrs15_performance_obligations
  DROP CONSTRAINT IF EXISTS ifrs15_performance_obligations_satisfaction_method_check;

ALTER TABLE ifrs15_performance_obligations
  ADD CONSTRAINT ifrs15_performance_obligations_satisfaction_method_check
  CHECK (satisfaction_method IN ('TIME','OUTPUT','INPUT'));

COMMIT;
