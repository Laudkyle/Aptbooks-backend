BEGIN;

-- Align credit/debit note tax detail tables with the multi-tax writer used across transactions.
-- Migration 114 added these compatibility columns for invoice/bill/operational tax detail tables,
-- but omitted credit_note_line_tax_details and debit_note_line_tax_details.
-- The shared insertLineTaxDetails() helper writes these columns for all transaction line-tax tables.

ALTER TABLE credit_note_line_tax_details
  ADD COLUMN IF NOT EXISTS tax_scope TEXT,
  ADD COLUMN IF NOT EXISTS category_code TEXT,
  ADD COLUMN IF NOT EXISTS recoverable_percent NUMERIC(7,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS exemption_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS posting_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_rule_id UUID REFERENCES tax_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE debit_note_line_tax_details
  ADD COLUMN IF NOT EXISTS tax_scope TEXT,
  ADD COLUMN IF NOT EXISTS category_code TEXT,
  ADD COLUMN IF NOT EXISTS recoverable_percent NUMERIC(7,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS exemption_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS posting_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_rule_id UUID REFERENCES tax_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
