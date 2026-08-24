BEGIN;

-- Phase 2 financial assurance: immutable accounting policy versions, domain
-- idempotency/provenance, and persisted ledger/subledger integrity evidence.

CREATE TABLE IF NOT EXISTS accounting_policy_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
  money_scale SMALLINT NOT NULL DEFAULT 2 CHECK (money_scale = 2),
  exchange_rate_scale SMALLINT NOT NULL DEFAULT 6 CHECK (exchange_rate_scale = 6),
  inventory_value_scale SMALLINT NOT NULL DEFAULT 6 CHECK (inventory_value_scale = 6),
  rounding_mode TEXT NOT NULL DEFAULT 'HALF_UP' CHECK (rounding_mode IN ('HALF_UP')),
  tax_rounding_scope TEXT NOT NULL DEFAULT 'LINE' CHECK (tax_rounding_scope = 'LINE'),
  posting_date_policy TEXT NOT NULL DEFAULT 'DOCUMENT_DATE' CHECK (posting_date_policy IN ('DOCUMENT_DATE')),
  closed_period_adjustment_policy TEXT NOT NULL DEFAULT 'REJECT' CHECK (closed_period_adjustment_policy = 'REJECT'),
  reversal_policy TEXT NOT NULL DEFAULT 'EXPLICIT_REVERSAL' CHECK (reversal_policy IN ('EXPLICIT_REVERSAL')),
  policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, version_no),
  UNIQUE (organization_id, effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

INSERT INTO accounting_policy_versions(
  organization_id, version_no, effective_from, money_scale, exchange_rate_scale,
  inventory_value_scale, rounding_mode, tax_rounding_scope, posting_date_policy,
  closed_period_adjustment_policy, reversal_policy, policy_json
)
SELECT o.id, 1, DATE '1900-01-01', 2, 6, 6, 'HALF_UP', 'LINE', 'DOCUMENT_DATE',
       'REJECT', 'EXPLICIT_REVERSAL',
       '{"moneyScale":2,"exchangeRateScale":6,"inventoryValueScale":6,"roundingMode":"HALF_UP","taxRoundingScope":"LINE","postingDatePolicy":"DOCUMENT_DATE","closedPeriodAdjustmentPolicy":"REJECT","reversalPolicy":"EXPLICIT_REVERSAL"}'::jsonb
FROM organizations o
ON CONFLICT (organization_id, version_no) DO NOTHING;

CREATE OR REPLACE FUNCTION prevent_accounting_policy_version_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Accounting policy versions are immutable; publish a new version'
    USING ERRCODE='55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounting_policy_versions_immutable ON accounting_policy_versions;
CREATE TRIGGER trg_accounting_policy_versions_immutable
BEFORE UPDATE OR DELETE ON accounting_policy_versions
FOR EACH ROW EXECUTE FUNCTION prevent_accounting_policy_version_mutation();

CREATE TABLE IF NOT EXISTS accounting_posting_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  journal_entry_id UUID NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  source_type TEXT NULL,
  source_id TEXT NULL,
  source_action TEXT NOT NULL DEFAULT 'post',
  source_reference TEXT NULL,
  source_module TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION protect_accounting_posting_request()
RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Financial idempotency claims cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_fingerprint <> OLD.request_fingerprint
     OR COALESCE(NEW.source_type,'') <> COALESCE(OLD.source_type,'')
     OR COALESCE(NEW.source_id,'') <> COALESCE(OLD.source_id,'')
     OR COALESCE(NEW.source_action,'') <> COALESCE(OLD.source_action,'')
     OR COALESCE(NEW.source_reference,'') <> COALESCE(OLD.source_reference,'')
     OR COALESCE(NEW.source_module,'') <> COALESCE(OLD.source_module,'')
     OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'Financial idempotency claim identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'Financial idempotency claim cannot be rebound' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounting_posting_requests_protect ON accounting_posting_requests;
CREATE TRIGGER trg_accounting_posting_requests_protect
BEFORE UPDATE OR DELETE ON accounting_posting_requests
FOR EACH ROW EXECUTE FUNCTION protect_accounting_posting_request();

CREATE TABLE IF NOT EXISTS journal_posting_provenance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  accounting_policy_version_id UUID NOT NULL REFERENCES accounting_policy_versions(id) ON DELETE RESTRICT,
  posting_fingerprint CHAR(64) NOT NULL CHECK (posting_fingerprint ~ '^[0-9a-f]{64}$'),
  source_type TEXT NULL,
  source_id TEXT NULL,
  source_action TEXT NOT NULL DEFAULT 'post',
  source_reference TEXT NULL,
  source_module TEXT NULL,
  posted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (journal_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_journal_posting_provenance_org_source
  ON journal_posting_provenance(organization_id, source_type, source_id, source_action);

CREATE OR REPLACE FUNCTION prevent_journal_posting_provenance_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Journal posting provenance is immutable' USING ERRCODE='55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_posting_provenance_immutable ON journal_posting_provenance;
CREATE TRIGGER trg_journal_posting_provenance_immutable
BEFORE UPDATE OR DELETE ON journal_posting_provenance
FOR EACH ROW EXECUTE FUNCTION prevent_journal_posting_provenance_mutation();

CREATE TABLE IF NOT EXISTS financial_integrity_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  as_of_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','passed','warnings','failed')),
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  triggered_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_integrity_runs_org_created
  ON financial_integrity_runs(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS financial_integrity_findings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES financial_integrity_runs(id) ON DELETE CASCADE,
  check_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  entity_type TEXT NULL,
  entity_id TEXT NULL,
  account_id UUID NULL REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  expected_amount NUMERIC(18,2) NULL,
  actual_amount NUMERIC(18,2) NULL,
  variance_amount NUMERIC(18,2) NULL,
  message TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_integrity_findings_run_severity
  ON financial_integrity_findings(run_id, severity, check_code);

-- Explicit RLS for all new tenant-owned Phase 2 tables. Migration 161 cannot
-- protect tables created later, so every future migration must do this itself.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'accounting_policy_versions','accounting_posting_requests','journal_posting_provenance',
    'financial_integrity_runs','financial_integrity_findings'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS aptbooks_tenant_isolation ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY aptbooks_tenant_isolation ON public.%I USING (organization_id=aptbooks_current_organization_id()) WITH CHECK (organization_id=aptbooks_current_organization_id())',
      tbl
    );
  END LOOP;
END $$;

COMMENT ON TABLE accounting_policy_versions IS
  'Immutable, effective-dated accounting policy snapshots. Posted-journal provenance records the exact policy version used.';
COMMENT ON TABLE accounting_posting_requests IS
  'Domain-level financial idempotency claims binding a key to a stable request fingerprint and, once created, one journal.';
COMMENT ON TABLE journal_posting_provenance IS
  'Immutable evidence identifying source command, policy version, and normalized posting fingerprint for each Phase 2 posted journal.';
COMMENT ON TABLE financial_integrity_runs IS
  'Persisted accounting integrity/reconciliation run evidence suitable for operations and audit review.';

COMMIT;
