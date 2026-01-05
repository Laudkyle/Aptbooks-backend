BEGIN;

-- Capture modification decision inputs and outcomes for IFRS 15.20-21.

ALTER TABLE ifrs15_contract_modifications
  ADD COLUMN IF NOT EXISTS adds_distinct_goods_services BOOLEAN,
  ADD COLUMN IF NOT EXISTS price_increase_commensurate_with_ssp BOOLEAN,
  ADD COLUMN IF NOT EXISTS remaining_goods_services_distinct BOOLEAN,
  ADD COLUMN IF NOT EXISTS decision_outcome TEXT,
  ADD COLUMN IF NOT EXISTS decision_basis TEXT,
  ADD COLUMN IF NOT EXISTS separate_contract_id UUID REFERENCES ifrs15_contracts(id);

ALTER TABLE ifrs15_contract_modifications
  DROP CONSTRAINT IF EXISTS ifrs15_contract_modifications_decision_outcome_check;

ALTER TABLE ifrs15_contract_modifications
  ADD CONSTRAINT ifrs15_contract_modifications_decision_outcome_check
    CHECK (decision_outcome IS NULL OR decision_outcome IN ('SEPARATE_CONTRACT','PROSPECTIVE','CUMULATIVE'));

-- Link separate-contract outcome to a child contract when applicable.
ALTER TABLE ifrs15_contracts
  ADD COLUMN IF NOT EXISTS parent_contract_id UUID REFERENCES ifrs15_contracts(id),
  ADD COLUMN IF NOT EXISTS source_modification_id UUID REFERENCES ifrs15_contract_modifications(id);

CREATE INDEX IF NOT EXISTS idx_ifrs15_contracts_parent ON ifrs15_contracts(parent_contract_id);

COMMIT;
