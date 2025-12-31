-- 012_tier4_depreciation_tx_uniques.sql
-- enforce at-most-one depreciation tx per (org, asset, period)
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_depr_tx_once
ON asset_depreciation_transactions(organization_id, asset_id, period_id);
