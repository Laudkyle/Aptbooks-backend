BEGIN;

-- GRA-2: Ghana VAT compliance layer for Act 1151 (effective 2026-01-01).
-- Builds on the canonical GRA-1 tax subledger.

-- ---------------------------------------------------------------------------
-- Organization VAT settings / registration monitoring
-- ---------------------------------------------------------------------------
ALTER TABLE tax_settings
  ADD COLUMN IF NOT EXISTS mixed_input_provisional_percent NUMERIC(7,6) NOT NULL DEFAULT 0
    CHECK (mixed_input_provisional_percent >= 0 AND mixed_input_provisional_percent <= 1),
  ADD COLUMN IF NOT EXISTS gh_vat_goods_registration_threshold NUMERIC(18,2) NOT NULL DEFAULT 750000.00
    CHECK (gh_vat_goods_registration_threshold > 0),
  ADD COLUMN IF NOT EXISTS gh_vat_monitor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS gh_vat_manual_goods_turnover NUMERIC(18,2) CHECK (gh_vat_manual_goods_turnover IS NULL OR gh_vat_manual_goods_turnover >= 0),
  ADD COLUMN IF NOT EXISTS gh_vat_turnover_basis TEXT NOT NULL DEFAULT 'taxable_goods_rolling_12m'
    CHECK (gh_vat_turnover_basis IN ('taxable_goods_rolling_12m','manual'));

COMMENT ON COLUMN tax_settings.mixed_input_provisional_percent IS
  'Conservative provisional recovery fraction for mixed-use input tax before statutory period apportionment. 0 = claim none until apportioned.';
COMMENT ON COLUMN tax_settings.gh_vat_goods_registration_threshold IS
  'Ghana VAT registration monitoring threshold for businesses dealing in goods. Default GH¢750,000 from 2026 reforms; effective-dated law changes should update settings/pack, not historical transactions.';

CREATE TABLE IF NOT EXISTS tax_vat_registration_monitor_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  as_of_date DATE NOT NULL,
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  turnover_basis TEXT NOT NULL,
  taxable_goods_turnover NUMERIC(18,2) NOT NULL DEFAULT 0,
  threshold_amount NUMERIC(18,2) NOT NULL,
  threshold_progress NUMERIC(9,6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('registered','below_threshold','approaching_threshold','threshold_met','manual_review')),
  registration_required_by_monitor BOOLEAN NOT NULL DEFAULT FALSE,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, as_of_date, turnover_basis)
);

CREATE INDEX IF NOT EXISTS idx_vat_registration_monitor_org_date
  ON tax_vat_registration_monitor_snapshots(organization_id, as_of_date DESC);

-- ---------------------------------------------------------------------------
-- Catalog-level input recovery classification
-- ---------------------------------------------------------------------------
ALTER TABLE tax_catalog_profiles
  ADD COLUMN IF NOT EXISTS purchase_recovery_mode TEXT NOT NULL DEFAULT 'direct_taxable'
    CHECK (purchase_recovery_mode IN ('direct_taxable','direct_exempt','mixed','not_applicable')),
  ADD COLUMN IF NOT EXISTS default_recoverable_percent NUMERIC(7,6)
    CHECK (default_recoverable_percent IS NULL OR (default_recoverable_percent >= 0 AND default_recoverable_percent <= 1)),
  ADD COLUMN IF NOT EXISTS legal_reference TEXT;

COMMENT ON COLUMN tax_catalog_profiles.purchase_recovery_mode IS
  'Input VAT attribution: direct_taxable=fully attributable to taxable supplies; direct_exempt=attributable to exempt supplies; mixed=requires period apportionment; not_applicable=no input recovery.';

-- Upgrade the GRA-1 default profiles to explicit recovery semantics.
UPDATE tax_catalog_profiles
SET purchase_recovery_mode='direct_taxable', default_recoverable_percent=1,
    legal_reference=COALESCE(legal_reference,'Ghana VAT Act 1151 input-tax direct attribution'),
    updated_at=NOW()
WHERE code IN ('GH_STANDARD_GOODS','GH_STANDARD_SERVICES','GH_ZERO_RATED_EXPORT');

UPDATE tax_catalog_profiles
SET purchase_recovery_mode='direct_exempt', default_recoverable_percent=0,
    legal_reference=COALESCE(legal_reference,'Ghana VAT Act 1151 exempt-supply input tax'),
    updated_at=NOW()
WHERE code='GH_EXEMPT_SUPPLY';

-- Optional reusable profile for overheads/resources used by both taxable and exempt activities.
INSERT INTO tax_catalog_profiles(
  organization_id,code,name,supply_type,tax_category,sales_tax_scope,purchase_tax_scope,
  sales_tax_code_id,purchase_tax_code_id,purchase_recovery_mode,default_recoverable_percent,
  legal_reference,effective_from,status,metadata
)
SELECT o.id,'GH_MIXED_INPUT','Ghana Mixed-use Input','mixed','mixed_input','out_of_scope','taxable',
       NULL,(SELECT id FROM tax_codes tc WHERE tc.organization_id=o.id AND tc.code='GH_VAT_EFFECTIVE_20' LIMIT 1),
       'mixed',NULL,'Act 1151 section 52 / Fifth Schedule',DATE '2026-01-01','active',
       '{"purpose":"Input purchases used for both taxable and exempt supplies; period apportionment required"}'::jsonb
FROM organizations o
WHERE EXISTS (SELECT 1 FROM tax_codes tc WHERE tc.organization_id=o.id AND tc.code='GH_VAT_EFFECTIVE_20')
ON CONFLICT (organization_id,code) DO UPDATE SET
  purchase_recovery_mode='mixed',default_recoverable_percent=NULL,legal_reference=EXCLUDED.legal_reference,
  metadata=tax_catalog_profiles.metadata || EXCLUDED.metadata,updated_at=NOW();

-- Permit relief classification without forcing a new tax engine.
ALTER TABLE tax_catalog_profiles DROP CONSTRAINT IF EXISTS tax_catalog_profiles_sales_tax_scope_check;
ALTER TABLE tax_catalog_profiles ADD CONSTRAINT tax_catalog_profiles_sales_tax_scope_check
  CHECK (sales_tax_scope IN ('taxable','zero_rated','exempt','relieved','out_of_scope','reverse_charge','import','export','non_recoverable'));
ALTER TABLE tax_catalog_profiles DROP CONSTRAINT IF EXISTS tax_catalog_profiles_purchase_tax_scope_check;
ALTER TABLE tax_catalog_profiles ADD CONSTRAINT tax_catalog_profiles_purchase_tax_scope_check
  CHECK (purchase_tax_scope IN ('taxable','zero_rated','exempt','relieved','out_of_scope','reverse_charge','import','export','non_recoverable'));

-- ---------------------------------------------------------------------------
-- Canonical tax-ledger recovery semantics
-- ---------------------------------------------------------------------------
ALTER TABLE tax_ledger_entries
  ALTER COLUMN recoverable_percent TYPE NUMERIC(7,6) USING recoverable_percent::numeric(7,6);

ALTER TABLE tax_ledger_entries
  ADD COLUMN IF NOT EXISTS recovery_basis TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (recovery_basis IN ('direct_taxable','direct_exempt','mixed','not_applicable')),
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT;

UPDATE tax_ledger_entries
SET recovery_basis = CASE
  WHEN direction NOT IN ('input','reverse_charge') THEN 'not_applicable'
  WHEN recoverable_percent >= 1 THEN 'direct_taxable'
  WHEN recoverable_percent <= 0 THEN 'direct_exempt'
  ELSE 'mixed'
END
WHERE recovery_basis='not_applicable';

CREATE INDEX IF NOT EXISTS idx_tax_ledger_recovery
  ON tax_ledger_entries(organization_id, recovery_basis, document_date)
  WHERE direction IN ('input','reverse_charge');

-- ---------------------------------------------------------------------------
-- Statutory mixed-supply input-tax apportionment (Act 1151 s52/Fifth Schedule)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_input_apportionment_periods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  method TEXT NOT NULL DEFAULT 'ghana_act1151_turnover'
    CHECK (method IN ('ghana_act1151_turnover','manual_approved')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','calculated','posted','voided')),
  taxable_supplies NUMERIC(18,2) NOT NULL DEFAULT 0,
  exempt_supplies NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_supplies NUMERIC(18,2) NOT NULL DEFAULT 0,
  raw_recovery_ratio NUMERIC(9,6) NOT NULL DEFAULT 0,
  allowed_recovery_ratio NUMERIC(9,6) NOT NULL DEFAULT 0,
  threshold_applied TEXT,
  direct_taxable_input_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  direct_exempt_input_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  mixed_input_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  recoverable_mixed_input_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  nonrecoverable_mixed_input_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_recoverable_input_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_nonrecoverable_input_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  prior_mixed_recoverable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  adjustment_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  calculation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at TIMESTAMPTZ,
  calculated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, period_start, period_end),
  CHECK (period_end >= period_start),
  CHECK (raw_recovery_ratio >= 0 AND raw_recovery_ratio <= 1),
  CHECK (allowed_recovery_ratio >= 0 AND allowed_recovery_ratio <= 1)
);

CREATE INDEX IF NOT EXISTS idx_tax_input_apportionment_org_period
  ON tax_input_apportionment_periods(organization_id, period_start, period_end, status);

ALTER TABLE tax_ledger_entries
  ADD COLUMN IF NOT EXISTS apportionment_period_id UUID REFERENCES tax_input_apportionment_periods(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Imported-services VAT declaration / reverse-charge workflow
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imported_service_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES business_partners(id) ON DELETE SET NULL,
  document_no TEXT,
  service_date DATE NOT NULL,
  tax_period_start DATE NOT NULL,
  tax_period_end DATE NOT NULL,
  description TEXT NOT NULL,
  supplier_country_code CHAR(2),
  currency_code CHAR(3) NOT NULL DEFAULT 'GHS',
  foreign_amount NUMERIC(18,2),
  exchange_rate NUMERIC(18,6),
  taxable_amount NUMERIC(18,2) NOT NULL CHECK (taxable_amount >= 0),
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE RESTRICT,
  recovery_basis TEXT NOT NULL DEFAULT 'direct_taxable'
    CHECK (recovery_basis IN ('direct_taxable','direct_exempt','mixed','not_applicable')),
  recoverable_percent NUMERIC(7,6) NOT NULL DEFAULT 1
    CHECK (recoverable_percent >= 0 AND recoverable_percent <= 1),
  total_tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  recoverable_tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  nonrecoverable_tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  declaration_due_date DATE,
  reference TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','voided')),
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  posted_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (tax_period_end >= tax_period_start)
);

CREATE INDEX IF NOT EXISTS idx_imported_services_org_period
  ON imported_service_transactions(organization_id, tax_period_start, tax_period_end, status);

CREATE TABLE IF NOT EXISTS imported_service_tax_details (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  imported_service_id UUID NOT NULL REFERENCES imported_service_transactions(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  source_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE RESTRICT,
  tax_code TEXT,
  tax_name TEXT,
  tax_type TEXT,
  tax_scope TEXT NOT NULL DEFAULT 'import',
  direction TEXT NOT NULL DEFAULT 'reverse_charge',
  box_code TEXT,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  recoverable_percent NUMERIC(7,6) NOT NULL DEFAULT 1,
  recoverable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  nonrecoverable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  recovery_basis TEXT NOT NULL DEFAULT 'direct_taxable'
    CHECK (recovery_basis IN ('direct_taxable','direct_exempt','mixed','not_applicable')),
  reverse_charge BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, imported_service_id, tax_code_id)
);

CREATE INDEX IF NOT EXISTS idx_imported_service_tax_details_txn
  ON imported_service_tax_details(organization_id, imported_service_id, sequence_no);


-- Tenant-integrity defense in depth for the new Ghana VAT entities.
CREATE OR REPLACE FUNCTION enforce_gra2_tax_tenant_integrity()
RETURNS TRIGGER AS $$
DECLARE
  related_org UUID;
BEGIN
  IF TG_TABLE_NAME='imported_service_transactions' THEN
    IF NEW.supplier_id IS NOT NULL THEN
      SELECT organization_id INTO related_org FROM business_partners WHERE id=NEW.supplier_id;
      IF related_org IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Imported-service supplier must belong to the same organization'; END IF;
    END IF;
    IF NEW.tax_code_id IS NOT NULL THEN
      SELECT organization_id INTO related_org FROM tax_codes WHERE id=NEW.tax_code_id;
      IF related_org IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Imported-service tax code must belong to the same organization'; END IF;
    END IF;
    IF NEW.journal_entry_id IS NOT NULL THEN
      SELECT organization_id INTO related_org FROM journal_entries WHERE id=NEW.journal_entry_id;
      IF related_org IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Imported-service journal must belong to the same organization'; END IF;
    END IF;
    IF NEW.reversal_journal_entry_id IS NOT NULL THEN
      SELECT organization_id INTO related_org FROM journal_entries WHERE id=NEW.reversal_journal_entry_id;
      IF related_org IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Imported-service reversal journal must belong to the same organization'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='imported_service_tax_details' THEN
    SELECT organization_id INTO related_org FROM imported_service_transactions WHERE id=NEW.imported_service_id;
    IF related_org IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Imported-service tax detail must belong to the same organization as its transaction'; END IF;
    IF NEW.tax_code_id IS NOT NULL THEN
      SELECT organization_id INTO related_org FROM tax_codes WHERE id=NEW.tax_code_id;
      IF related_org IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Imported-service detail tax code must belong to the same organization'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='tax_input_apportionment_periods' THEN
    IF NEW.journal_entry_id IS NOT NULL THEN
      SELECT organization_id INTO related_org FROM journal_entries WHERE id=NEW.journal_entry_id;
      IF related_org IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Apportionment journal must belong to the same organization'; END IF;
    END IF;
    IF NEW.reversal_journal_entry_id IS NOT NULL THEN
      SELECT organization_id INTO related_org FROM journal_entries WHERE id=NEW.reversal_journal_entry_id;
      IF related_org IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Apportionment reversal journal must belong to the same organization'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imported_service_tenant_integrity ON imported_service_transactions;
CREATE TRIGGER trg_imported_service_tenant_integrity
BEFORE INSERT OR UPDATE ON imported_service_transactions
FOR EACH ROW EXECUTE FUNCTION enforce_gra2_tax_tenant_integrity();

DROP TRIGGER IF EXISTS trg_imported_service_detail_tenant_integrity ON imported_service_tax_details;
CREATE TRIGGER trg_imported_service_detail_tenant_integrity
BEFORE INSERT OR UPDATE ON imported_service_tax_details
FOR EACH ROW EXECUTE FUNCTION enforce_gra2_tax_tenant_integrity();

DROP TRIGGER IF EXISTS trg_tax_apportionment_tenant_integrity ON tax_input_apportionment_periods;
CREATE TRIGGER trg_tax_apportionment_tenant_integrity
BEFORE INSERT OR UPDATE ON tax_input_apportionment_periods
FOR EACH ROW EXECUTE FUNCTION enforce_gra2_tax_tenant_integrity();

-- ---------------------------------------------------------------------------
-- Ghana 2026 imported-services composite code (15% VAT + 2.5% NHIL + 2.5% GETFund)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  org RECORD;
  gh_jurisdiction UUID;
  parent_id UUID;
  vat_id UUID;
  nhil_id UUID;
  getfund_id UUID;
BEGIN
  FOR org IN
    SELECT DISTINCT organization_id
    FROM tax_codes
    WHERE code IN ('GH_VAT_STD_15','GH_NHIL_2_5','GH_GETFUND_2_5')
  LOOP
    SELECT id INTO gh_jurisdiction FROM tax_jurisdictions WHERE organization_id=org.organization_id AND code='GH' LIMIT 1;
    SELECT id INTO vat_id FROM tax_codes WHERE organization_id=org.organization_id AND code='GH_VAT_STD_15' LIMIT 1;
    SELECT id INTO nhil_id FROM tax_codes WHERE organization_id=org.organization_id AND code='GH_NHIL_2_5' LIMIT 1;
    SELECT id INTO getfund_id FROM tax_codes WHERE organization_id=org.organization_id AND code='GH_GETFUND_2_5' LIMIT 1;
    IF vat_id IS NOT NULL AND nhil_id IS NOT NULL AND getfund_id IS NOT NULL THEN
      INSERT INTO tax_codes(
        organization_id, jurisdiction_id, code, name, tax_type, rate, is_compound,
        box_code, direction, category_code, tax_scope, application_scope,
        calculation_method, reverse_charge, recoverable_percent, reporting_group,
        effective_from, status, metadata
      ) VALUES (
        org.organization_id, gh_jurisdiction, 'GH_IMPORTED_SERVICES_20',
        'Ghana VAT/NHIL/GETFund on Imported Services 20%', 'IMPORT', 20.000000, TRUE,
        'IMPORTED_SERVICES', 'reverse_charge', 'GH_IMPORTED_SERVICES', 'import', 'purchases',
        'standard', TRUE, 1, 'IMPORTED_SERVICES', DATE '2026-01-01', 'active',
        '{"source":"GRA VAT reforms 2026 / Act 1151","components":"VAT 15%, NHIL 2.5%, GETFund 2.5% on common base"}'::jsonb
      )
      ON CONFLICT (organization_id, code) DO UPDATE SET
        name=EXCLUDED.name, rate=EXCLUDED.rate, is_compound=TRUE, tax_scope='import',
        direction='reverse_charge', application_scope='purchases', reverse_charge=TRUE,
        effective_from=LEAST(tax_codes.effective_from, EXCLUDED.effective_from), status='active',
        metadata=tax_codes.metadata || EXCLUDED.metadata,
        updated_at=NOW()
      RETURNING id INTO parent_id;

      DELETE FROM tax_code_components WHERE organization_id=org.organization_id AND parent_tax_code_id=parent_id;
      INSERT INTO tax_code_components(organization_id, parent_tax_code_id, component_tax_code_id, sequence_no)
      VALUES
        (org.organization_id, parent_id, vat_id, 1),
        (org.organization_id, parent_id, nhil_id, 2),
        (org.organization_id, parent_id, getfund_id, 3)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- Country-pack metadata/version: preserve existing organization installs and add GRA-2 capability descriptors.
UPDATE tax_country_packs
SET version_no='2026.2.0',
    metadata = jsonb_set(
      jsonb_set(
        metadata,
        '{gra2}',
        '{
          "effectiveFrom":"2026-01-01",
          "vatGoodsRegistrationThreshold":"750000.00",
          "mixedSupplyApportionment":"Act 1151 s52 / Fifth Schedule A x B / C; below 5% = none; above 95% = full",
          "importedServices":"VAT/NHIL/GETFund accounted on imported services unless exempt",
          "inputTax":"NHIL and GETFund deductible subject to input-tax qualification/recovery rules"
        }'::jsonb,
        true
      ),
      '{workflows}',
      COALESCE(metadata->'workflows','[]'::jsonb) || '[
        {"code":"GH_VAT_REGISTRATION_MONITOR","title":"Monitor Ghana VAT registration threshold","steps":["Monitor rolling taxable goods turnover","Review threshold alerts","Register or seek GRA advice when applicable"]},
        {"code":"GH_INPUT_APPORTIONMENT","title":"Apportion mixed-use input VAT","steps":["Directly attribute taxable/exempt inputs","Calculate Act 1151 turnover ratio","Review <5%/>95% thresholds","Post period adjustment"]},
        {"code":"GH_IMPORTED_SERVICES","title":"Account for imported services VAT","steps":["Record imported service","Calculate VAT/NHIL/GETFund","Review input recoverability","Post reverse-charge journal","Prepare imported-services return data"]}
      ]'::jsonb,
      true
    )
WHERE pack_code='GH-TAX-2026-COMPLETE' AND organization_id IS NULL;

COMMIT;
