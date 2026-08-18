BEGIN;

-- Depreciation reversals are represented as signed transactions. The original
-- positive-only amount constraint and one-row-per-schedule/period unique index
-- made the existing reversal path impossible to persist. Classify entries so a
-- period can contain one original depreciation row and one exact reversal row.
ALTER TABLE asset_depreciation_transactions
  ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'depreciation';

ALTER TABLE asset_depreciation_transactions
  DROP CONSTRAINT IF EXISTS asset_depreciation_transactions_entry_type_check;
ALTER TABLE asset_depreciation_transactions
  ADD CONSTRAINT asset_depreciation_transactions_entry_type_check
  CHECK (entry_type IN ('depreciation','reversal'));

ALTER TABLE asset_depreciation_transactions
  DROP CONSTRAINT IF EXISTS asset_depreciation_transactions_amount_check;
ALTER TABLE asset_depreciation_transactions
  ADD CONSTRAINT asset_depreciation_transactions_amount_check
  CHECK (
    (entry_type='depreciation' AND amount > 0)
    OR (entry_type='reversal' AND amount < 0)
  );

DROP INDEX IF EXISTS uq_asset_depr_tx_once_per_schedule;
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_depr_tx_once_per_schedule_type
  ON asset_depreciation_transactions(organization_id, schedule_id, period_id, entry_type);

COMMIT;
