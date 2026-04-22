BEGIN;

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS recognition_model text NOT NULL DEFAULT 'on_balance_sheet',
  ADD COLUMN IF NOT EXISTS is_short_term_lease boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_low_value_lease boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS practical_expedient_non_lease_components boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ownership_transfers boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS purchase_option_reasonably_certain boolean NOT NULL DEFAULT FALSE;

ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_recognition_model_check;
ALTER TABLE leases
  ADD CONSTRAINT leases_recognition_model_check
  CHECK (recognition_model IN ('on_balance_sheet','short_term_exempt','low_value_exempt'));

ALTER TABLE lease_contracts
  ADD COLUMN IF NOT EXISTS prepaid_lease_payments numeric(18,6),
  ADD COLUMN IF NOT EXISTS accrued_lease_payments numeric(18,6),
  ADD COLUMN IF NOT EXISTS purchase_option_amount numeric(18,6);

CREATE TABLE IF NOT EXISTS lease_measurement_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  modification_id uuid NULL REFERENCES lease_modifications(id) ON DELETE SET NULL,
  snapshot_type text NOT NULL CHECK (snapshot_type IN ('initial','modification','remeasurement','termination')),
  effective_date date NOT NULL,
  payment_timing text NOT NULL DEFAULT 'arrears' CHECK (payment_timing IN ('arrears','advance')),
  term_months integer,
  payments_per_year integer,
  annual_discount_rate numeric(18,6),
  payment_amount numeric(18,6),
  lease_liability_amount numeric(18,6) NOT NULL DEFAULT 0,
  rou_asset_amount numeric(18,6) NOT NULL DEFAULT 0,
  depreciation_basis_amount numeric(18,6) NOT NULL DEFAULT 0,
  depreciation_months integer,
  initial_direct_costs numeric(18,6),
  lease_incentives numeric(18,6),
  restoration_provision numeric(18,6),
  residual_value_guarantee numeric(18,6),
  prepaid_lease_payments numeric(18,6),
  accrued_lease_payments numeric(18,6),
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  created_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_measurement_snapshots_lease_effective
  ON lease_measurement_snapshots(organization_id, lease_id, effective_date DESC, created_at DESC);

COMMIT;
