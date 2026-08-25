BEGIN;

-- =========================================================
-- Fixed assets: production depreciation and lifecycle controls
-- =========================================================

ALTER TABLE asset_categories
  ADD COLUMN IF NOT EXISTS default_depreciation_method TEXT NOT NULL DEFAULT 'straight_line',
  ADD COLUMN IF NOT EXISTS default_useful_life_months INT,
  ADD COLUMN IF NOT EXISTS default_depreciation_convention TEXT NOT NULL DEFAULT 'full_month',
  ADD COLUMN IF NOT EXISTS default_declining_rate_percent NUMERIC(9,6);

ALTER TABLE asset_categories DROP CONSTRAINT IF EXISTS asset_categories_default_depr_method_chk;
ALTER TABLE asset_categories ADD CONSTRAINT asset_categories_default_depr_method_chk
  CHECK (default_depreciation_method IN ('straight_line','reducing_balance'));
ALTER TABLE asset_categories DROP CONSTRAINT IF EXISTS asset_categories_default_useful_life_chk;
ALTER TABLE asset_categories ADD CONSTRAINT asset_categories_default_useful_life_chk
  CHECK (default_useful_life_months IS NULL OR default_useful_life_months > 0);
ALTER TABLE asset_categories DROP CONSTRAINT IF EXISTS asset_categories_default_depr_convention_chk;
ALTER TABLE asset_categories ADD CONSTRAINT asset_categories_default_depr_convention_chk
  CHECK (default_depreciation_convention IN ('full_month','daily_prorata'));
ALTER TABLE asset_categories DROP CONSTRAINT IF EXISTS asset_categories_default_declining_rate_chk;
ALTER TABLE asset_categories ADD CONSTRAINT asset_categories_default_declining_rate_chk
  CHECK (default_declining_rate_percent IS NULL OR (default_declining_rate_percent > 0 AND default_declining_rate_percent <= 100));

ALTER TABLE fixed_assets
  ADD COLUMN IF NOT EXISTS in_service_date DATE,
  ADD COLUMN IF NOT EXISTS asset_tag TEXT,
  ADD COLUMN IF NOT EXISTS serial_number TEXT,
  ADD COLUMN IF NOT EXISTS manufacturer TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS retirement_reason TEXT;

UPDATE fixed_assets
   SET in_service_date = acquisition_date
 WHERE in_service_date IS NULL AND status IN ('active','retired','disposed');

CREATE UNIQUE INDEX IF NOT EXISTS uq_fixed_assets_org_asset_tag
  ON fixed_assets(organization_id, asset_tag)
  WHERE asset_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fixed_assets_org_serial
  ON fixed_assets(organization_id, serial_number)
  WHERE serial_number IS NOT NULL;

ALTER TABLE asset_depreciation_schedules
  ADD COLUMN IF NOT EXISTS basis_amount NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS residual_value NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS depreciation_convention TEXT NOT NULL DEFAULT 'full_month',
  ADD COLUMN IF NOT EXISTS declining_rate_percent NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Existing installations may have used component_code while every schedule still implicitly
-- depreciated the full asset cost. Refuse to guess how that cost should be allocated across
-- multiple schedules: silent backfill here could materially overstate depreciation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM asset_depreciation_schedules s
     WHERE s.basis_amount IS NULL
     GROUP BY s.organization_id, s.asset_id
    HAVING COUNT(*) FILTER (WHERE s.status='active') > 1
  ) THEN
    RAISE EXCEPTION 'Asset depreciation migration requires manual basis allocation for assets with multiple active legacy schedules';
  END IF;
END $$;

UPDATE asset_depreciation_schedules s
   SET basis_amount = a.cost,
       residual_value = a.salvage_value
  FROM fixed_assets a
 WHERE a.id=s.asset_id
   AND (s.basis_amount IS NULL OR s.residual_value IS NULL);

ALTER TABLE asset_depreciation_schedules
  ALTER COLUMN basis_amount SET NOT NULL,
  ALTER COLUMN residual_value SET NOT NULL;

ALTER TABLE asset_depreciation_schedules DROP CONSTRAINT IF EXISTS asset_depreciation_schedules_method_check;
ALTER TABLE asset_depreciation_schedules ADD CONSTRAINT asset_depreciation_schedules_method_check
  CHECK (method IN ('straight_line','reducing_balance'));
ALTER TABLE asset_depreciation_schedules DROP CONSTRAINT IF EXISTS asset_depreciation_schedules_basis_chk;
ALTER TABLE asset_depreciation_schedules ADD CONSTRAINT asset_depreciation_schedules_basis_chk
  CHECK (basis_amount > 0);
ALTER TABLE asset_depreciation_schedules DROP CONSTRAINT IF EXISTS asset_depreciation_schedules_residual_chk;
ALTER TABLE asset_depreciation_schedules ADD CONSTRAINT asset_depreciation_schedules_residual_chk
  CHECK (residual_value >= 0 AND residual_value <= basis_amount);
ALTER TABLE asset_depreciation_schedules DROP CONSTRAINT IF EXISTS asset_depreciation_schedules_convention_chk;
ALTER TABLE asset_depreciation_schedules ADD CONSTRAINT asset_depreciation_schedules_convention_chk
  CHECK (depreciation_convention IN ('full_month','daily_prorata'));
ALTER TABLE asset_depreciation_schedules DROP CONSTRAINT IF EXISTS asset_depreciation_schedules_declining_rate_chk;
ALTER TABLE asset_depreciation_schedules ADD CONSTRAINT asset_depreciation_schedules_declining_rate_chk
  CHECK (
    (method='straight_line' AND declining_rate_percent IS NULL)
    OR
    (method='reducing_balance' AND declining_rate_percent IS NOT NULL AND declining_rate_percent > 0 AND declining_rate_percent <= 100)
  );

CREATE INDEX IF NOT EXISTS idx_asset_depr_sched_asset_component_effective
  ON asset_depreciation_schedules(organization_id, asset_id, COALESCE(component_code,'__MAIN__'), effective_start_date, effective_end_date);

ALTER TABLE asset_depreciation_transactions
  ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS method TEXT,
  ADD COLUMN IF NOT EXISTS basis_amount NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS residual_value NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS calculation_json JSONB;

CREATE INDEX IF NOT EXISTS idx_asset_depr_tx_org_journal
  ON asset_depreciation_transactions(organization_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

ALTER TABLE asset_depreciation_runs DROP CONSTRAINT IF EXISTS asset_depreciation_runs_status_check;
ALTER TABLE asset_depreciation_runs ADD CONSTRAINT asset_depreciation_runs_status_check
  CHECK (status IN ('running','posted','failed','skipped','reversed'));
ALTER TABLE asset_depreciation_runs
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS control_total NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE asset_events DROP CONSTRAINT IF EXISTS asset_events_event_type_check;
ALTER TABLE asset_events ADD CONSTRAINT asset_events_event_type_check CHECK (event_type IN (
  'acquisition','transfer','reclass','revaluation','impairment','partial_disposal',
  'retirement','disposal','depreciation_run','depreciation_reversal','maintenance','attachment'
));

-- =========================================================
-- Inventory: master-data and valuation controls
-- =========================================================

ALTER TABLE item_units
  ADD COLUMN IF NOT EXISTS symbol TEXT,
  ADD COLUMN IF NOT EXISTS decimal_places SMALLINT NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE item_units DROP CONSTRAINT IF EXISTS item_units_decimal_places_chk;
ALTER TABLE item_units ADD CONSTRAINT item_units_decimal_places_chk CHECK (decimal_places BETWEEN 0 AND 6);
ALTER TABLE item_units DROP CONSTRAINT IF EXISTS item_units_status_chk;
ALTER TABLE item_units ADD CONSTRAINT item_units_status_chk CHECK (status IN ('active','inactive'));

ALTER TABLE item_categories
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE item_categories DROP CONSTRAINT IF EXISTS item_categories_status_chk;
ALTER TABLE item_categories ADD CONSTRAINT item_categories_status_chk CHECK (status IN ('active','inactive'));

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
UPDATE warehouses SET status=CASE WHEN is_active THEN 'active' ELSE 'inactive' END WHERE status IS NULL OR status NOT IN ('active','inactive');
ALTER TABLE warehouses DROP CONSTRAINT IF EXISTS warehouses_status_chk;
ALTER TABLE warehouses ADD CONSTRAINT warehouses_status_chk CHECK (status IN ('active','inactive'));

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS tracking_method TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS preferred_warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_tracking_method_chk;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_tracking_method_chk
  CHECK (tracking_method IN ('none','batch','serial'));

ALTER TABLE inventory_transactions
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_by UUID REFERENCES users(id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE inventory_balances
    ADD CONSTRAINT inventory_balances_qty_nonnegative_chk CHECK (qty_on_hand >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE inventory_balances
    ADD CONSTRAINT inventory_balances_avg_cost_nonnegative_chk CHECK (avg_unit_cost >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_items_org_tracking
  ON inventory_items(organization_id, tracking_method, status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_org_preferred_warehouse
  ON inventory_items(organization_id, preferred_warehouse_id)
  WHERE preferred_warehouse_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_txn_org_posted_at
  ON inventory_transactions(organization_id, posted_at DESC)
  WHERE posted_at IS NOT NULL;

COMMIT;
