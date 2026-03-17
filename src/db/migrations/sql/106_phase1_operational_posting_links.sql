-- Phase 1 operational documents: posting links to Tier 1 journals

ALTER TABLE operational_documents
  ADD COLUMN IF NOT EXISTS period_id UUID NULL REFERENCES accounting_periods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS journal_entry_id UUID NULL REFERENCES journal_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_operational_documents_period
  ON operational_documents(organization_id, period_id)
  WHERE period_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operational_documents_journal
  ON operational_documents(organization_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;
