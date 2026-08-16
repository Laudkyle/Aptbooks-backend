-- GRA Release 5: Certified-invoicing / E-VAT fiscalization foundation.
-- IMPORTANT: the live GRA API contract is intentionally not hard-coded here.
-- GRA provides production API documentation during taxpayer onboarding and signs off
-- the taxpayer integration before go-live. This migration creates the durable model
-- needed for that certified adapter.

BEGIN;

CREATE TABLE IF NOT EXISTS fiscalization_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  country_code CHAR(2) NOT NULL DEFAULT 'GH',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  adapter_code TEXT NOT NULL DEFAULT 'GRA_EVAT_SIM',
  adapter_mode TEXT NOT NULL DEFAULT 'simulation'
    CHECK (adapter_mode IN ('simulation','pending_gra_contract','live')),
  onboarding_status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (onboarding_status IN ('not_requested','requested','integration','testing','signed_off','live','suspended')),
  gra_go_live_date DATE,
  api_endpoint TEXT,
  api_key_encrypted TEXT,
  api_secret_encrypted TEXT,
  api_contract_version TEXT,
  auto_prepare_invoices BOOLEAN NOT NULL DEFAULT TRUE,
  auto_prepare_pos BOOLEAN NOT NULL DEFAULT TRUE,
  auto_queue BOOLEAN NOT NULL DEFAULT FALSE,
  offline_window_hours INTEGER NOT NULL DEFAULT 24 CHECK (offline_window_hours BETWEEN 1 AND 24),
  require_customer_tax_id_for_input_credit BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fiscal_locations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  store_id UUID REFERENCES pos_stores(id) ON DELETE SET NULL,
  address_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  gra_branch_reference TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, code)
);

CREATE TABLE IF NOT EXISTS fiscal_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fiscal_location_id UUID REFERENCES fiscal_locations(id) ON DELETE SET NULL,
  store_id UUID REFERENCES pos_stores(id) ON DELETE SET NULL,
  register_id UUID REFERENCES pos_registers(id) ON DELETE SET NULL,
  pos_device_id UUID REFERENCES pos_devices(id) ON DELETE SET NULL,
  device_code TEXT NOT NULL,
  device_name TEXT,
  machine_registration_code TEXT,
  verification_engine_id TEXT,
  device_serial_number TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','testing','certified','active','offline','suspended','revoked','inactive')),
  certified_at TIMESTAMPTZ,
  last_online_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, device_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fiscal_devices_org_register
  ON fiscal_devices(organization_id, register_id)
  WHERE register_id IS NOT NULL AND status NOT IN ('revoked','inactive');

CREATE TABLE IF NOT EXISTS fiscal_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('invoice','pos_sale','credit_note','debit_note','pos_return')),
  source_id UUID NOT NULL,
  document_type TEXT NOT NULL
    CHECK (document_type IN ('tax_invoice','sales_receipt','credit_note','debit_note','refund_receipt')),
  transaction_type TEXT NOT NULL DEFAULT 'sale'
    CHECK (transaction_type IN ('sale','hire_purchase','hire','lease','rental','exchange','own_supply')),
  source_number TEXT NOT NULL,
  consecutive_number TEXT,
  supply_at TIMESTAMPTZ NOT NULL,
  invoice_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  fiscal_location_id UUID REFERENCES fiscal_locations(id) ON DELETE SET NULL,
  fiscal_device_id UUID REFERENCES fiscal_devices(id) ON DELETE SET NULL,
  original_fiscal_document_id UUID REFERENCES fiscal_documents(id) ON DELETE RESTRICT,
  original_source_number TEXT,
  seller_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  buyer_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  lines_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  tax_summary_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  totals_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('draft','ready','queued','offline_pending','submitting','submitted','simulated','certified','rejected','failed','cancelled','superseded')),
  fiscal_status_reason TEXT,
  is_simulation BOOLEAN NOT NULL DEFAULT FALSE,
  commissioner_general_signature TEXT,
  qr_code TEXT,
  receipt_signature TEXT,
  invoice_signature TEXT,
  verification_engine_id TEXT,
  encrypted_data TEXT,
  fiscal_timestamp TIMESTAMPTZ,
  serial_number TEXT,
  receipt_number TEXT,
  machine_registration_code TEXT,
  gra_reference TEXT,
  certified_at TIMESTAMPTZ,
  offline_recorded_at TIMESTAMPTZ,
  offline_deadline_at TIMESTAMPTZ,
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '6 years')::date,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_documents_org_status
  ON fiscal_documents(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fiscal_documents_org_supply
  ON fiscal_documents(organization_id, supply_at DESC);
CREATE INDEX IF NOT EXISTS idx_fiscal_documents_org_receipt
  ON fiscal_documents(organization_id, receipt_number)
  WHERE receipt_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS fiscal_transmission_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fiscal_document_id UUID NOT NULL REFERENCES fiscal_documents(id) ON DELETE CASCADE,
  adapter_code TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','claimed','retry','submitted','simulated','certified','rejected','failed','dead_letter','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 12 CHECK (max_attempts BETWEEN 1 AND 50),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  claimed_by TEXT,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_http_status INTEGER,
  last_error TEXT,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_queue_claim
  ON fiscal_transmission_queue(status, next_attempt_at, created_at)
  WHERE status IN ('queued','retry');
CREATE INDEX IF NOT EXISTS idx_fiscal_queue_org_doc
  ON fiscal_transmission_queue(organization_id, fiscal_document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fiscal_system_logs (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fiscal_document_id UUID REFERENCES fiscal_documents(id) ON DELETE SET NULL,
  queue_id UUID REFERENCES fiscal_transmission_queue(id) ON DELETE SET NULL,
  event_code TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('debug','info','warning','error','critical')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id UUID REFERENCES fiscal_devices(id) ON DELETE SET NULL,
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_fiscal_logs_org_event
  ON fiscal_system_logs(organization_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_fiscal_logs_doc
  ON fiscal_system_logs(fiscal_document_id, event_at DESC)
  WHERE fiscal_document_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_fiscal_system_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'fiscal_system_logs are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fiscal_system_logs_no_update ON fiscal_system_logs;
CREATE TRIGGER trg_fiscal_system_logs_no_update
BEFORE UPDATE OR DELETE ON fiscal_system_logs
FOR EACH ROW EXECUTE FUNCTION prevent_fiscal_system_log_mutation();


-- Defense-in-depth tenant integrity for fiscal/POS references. UUID foreign keys alone
-- cannot prove that both sides belong to the same organization.
CREATE OR REPLACE FUNCTION enforce_fiscal_tenant_integrity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'fiscal_locations' THEN
    IF NEW.store_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pos_stores s WHERE s.id=NEW.store_id AND s.organization_id=NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'Fiscal location store must belong to the same organization';
    END IF;
  ELSIF TG_TABLE_NAME = 'fiscal_devices' THEN
    IF NEW.fiscal_location_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM fiscal_locations l WHERE l.id=NEW.fiscal_location_id AND l.organization_id=NEW.organization_id
    ) THEN RAISE EXCEPTION 'Fiscal device location must belong to the same organization'; END IF;
    IF NEW.store_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pos_stores s WHERE s.id=NEW.store_id AND s.organization_id=NEW.organization_id
    ) THEN RAISE EXCEPTION 'Fiscal device store must belong to the same organization'; END IF;
    IF NEW.register_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pos_registers r WHERE r.id=NEW.register_id AND r.organization_id=NEW.organization_id
    ) THEN RAISE EXCEPTION 'Fiscal device register must belong to the same organization'; END IF;
    IF NEW.pos_device_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pos_devices d WHERE d.id=NEW.pos_device_id AND d.organization_id=NEW.organization_id
    ) THEN RAISE EXCEPTION 'POS device must belong to the same organization'; END IF;
  ELSIF TG_TABLE_NAME = 'fiscal_documents' THEN
    IF NEW.fiscal_location_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM fiscal_locations l WHERE l.id=NEW.fiscal_location_id AND l.organization_id=NEW.organization_id
    ) THEN RAISE EXCEPTION 'Fiscal document location must belong to the same organization'; END IF;
    IF NEW.fiscal_device_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM fiscal_devices d WHERE d.id=NEW.fiscal_device_id AND d.organization_id=NEW.organization_id
    ) THEN RAISE EXCEPTION 'Fiscal document device must belong to the same organization'; END IF;
  ELSIF TG_TABLE_NAME = 'fiscal_transmission_queue' THEN
    IF NOT EXISTS (
      SELECT 1 FROM fiscal_documents d WHERE d.id=NEW.fiscal_document_id AND d.organization_id=NEW.organization_id
    ) THEN RAISE EXCEPTION 'Fiscal queue document must belong to the same organization'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fiscal_locations_tenant ON fiscal_locations;
CREATE TRIGGER trg_fiscal_locations_tenant BEFORE INSERT OR UPDATE ON fiscal_locations
FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_tenant_integrity();
DROP TRIGGER IF EXISTS trg_fiscal_devices_tenant ON fiscal_devices;
CREATE TRIGGER trg_fiscal_devices_tenant BEFORE INSERT OR UPDATE ON fiscal_devices
FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_tenant_integrity();
DROP TRIGGER IF EXISTS trg_fiscal_documents_tenant ON fiscal_documents;
CREATE TRIGGER trg_fiscal_documents_tenant BEFORE INSERT OR UPDATE ON fiscal_documents
FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_tenant_integrity();
DROP TRIGGER IF EXISTS trg_fiscal_queue_tenant ON fiscal_transmission_queue;
CREATE TRIGGER trg_fiscal_queue_tenant BEFORE INSERT OR UPDATE ON fiscal_transmission_queue
FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_tenant_integrity();

INSERT INTO permissions(code, description) VALUES
  ('fiscalization.read', 'Read fiscal/E-VAT documents, devices and transmission status'),
  ('fiscalization.operate', 'Prepare and queue fiscal/E-VAT documents'),
  ('fiscalization.manage', 'Manage Ghana E-VAT settings, locations and fiscal devices'),
  ('fiscalization.retry', 'Retry or process failed/queued fiscal transmissions')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('fiscalization.read','fiscalization.operate','fiscalization.manage','fiscalization.retry')
WHERE lower(r.name) IN ('admin','administrator','super admin','owner')
ON CONFLICT DO NOTHING;

COMMIT;
