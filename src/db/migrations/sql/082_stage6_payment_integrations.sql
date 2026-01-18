-- Stage 6: Payment integrations (Paystack + MTN MoMo sandbox)

BEGIN;

CREATE TABLE IF NOT EXISTS payment_providers (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO payment_providers (code, name, is_enabled)
VALUES
  ('paystack', 'Paystack', true),
  ('mtn_momo', 'MTN MoMo', true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_code TEXT NOT NULL REFERENCES payment_providers(code),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel TEXT NOT NULL DEFAULT 'online',
  reference TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','pending','success','failed','cancelled')),
  customer_email TEXT NULL,
  customer_phone TEXT NULL,
  authorization_url TEXT NULL,
  provider_transaction_id TEXT NULL,
  fees NUMERIC(18,2) NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_last_response JSONB NULL,
  posted_customer_receipt_id UUID NULL REFERENCES customer_receipts(id),
  posted_vendor_payment_id UUID NULL REFERENCES vendor_payments(id),
  created_by UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_intents_org_ref ON payment_intents(organization_id, provider_code, reference);

CREATE TABLE IF NOT EXISTS payment_intent_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_payment_intent_links_intent ON payment_intent_links(payment_intent_id);
CREATE INDEX IF NOT EXISTS ix_payment_intent_links_entity ON payment_intent_links(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_code TEXT NOT NULL REFERENCES payment_providers(code),
  external_event_id TEXT NULL,
  signature TEXT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  processing_error TEXT NULL
);

-- Permissions
INSERT INTO permissions(code, description) VALUES
  ('payments.integrations.read', 'Read payment integrations'),
  ('payments.integrations.manage', 'Manage payment integrations'),
  ('payments.integrations.webhook', 'Receive payment webhooks')
ON CONFLICT (code) DO NOTHING;

COMMIT;
