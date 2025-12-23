-- Account typing
CREATE TABLE account_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE, -- ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE
  name TEXT NOT NULL,
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit'))
);

CREATE TABLE account_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE (organization_id, name)
);

-- Chart of accounts
CREATE TABLE chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type_id UUID NOT NULL REFERENCES account_types(id),
  category_id UUID REFERENCES account_categories(id),
  parent_account_id UUID REFERENCES chart_of_accounts(id),
  is_postable BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE INDEX idx_coa_org_code ON chart_of_accounts(organization_id, code);

-- Flexible accounting periods (non-overlapping per org)
CREATE TABLE accounting_periods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','locked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date),
  UNIQUE (organization_id, code)
);

-- Prevent overlaps within an organization (requires btree_gist)
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE accounting_periods
  ADD CONSTRAINT no_period_overlap
  EXCLUDE USING gist (
    organization_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

-- Journal entry types
CREATE TABLE journal_entry_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,  -- e.g., GENERAL, ADJUSTMENT, CLOSING
  name TEXT NOT NULL
);

-- Journals
CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entry_no BIGSERIAL, -- per DB; we also enforce per-org unique by unique index below
  journal_entry_type_id UUID NOT NULL REFERENCES journal_entry_types(id),
  period_id UUID NOT NULL REFERENCES accounting_periods(id),
  entry_date DATE NOT NULL,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','voided')),
  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id),
  void_reason TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure idempotency unique per org when provided
CREATE UNIQUE INDEX uq_journal_idempotency_per_org
  ON journal_entries(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Ensure entry_no unique per org (best-effort; entry_no is global sequence)
CREATE UNIQUE INDEX uq_journal_entry_no_per_org ON journal_entries(organization_id, entry_no);

CREATE TABLE journal_entry_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  description TEXT,
  debit NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  fx_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  amount_base NUMERIC(18,2) NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  UNIQUE (journal_entry_id, line_no)
);

CREATE INDEX idx_journal_lines_journal ON journal_entry_lines(journal_entry_id);

-- GL balances (fast inquiries)
CREATE TABLE general_ledger_balances (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
  debit_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, period_id, account_id)
);

-- Closing entries (Phase 1 keeps structure; logic can be minimal)
CREATE TABLE closing_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT
);

-- FX scaffolding (base currency is GHS; keep types/history for later even if unused now)
CREATE TABLE exchange_rate_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE exchange_rates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rate_type_id UUID NOT NULL REFERENCES exchange_rate_types(id),
  from_currency CHAR(3) NOT NULL REFERENCES currencies(code),
  to_currency CHAR(3) NOT NULL REFERENCES currencies(code),
  rate NUMERIC(18,6) NOT NULL,
  effective_date DATE NOT NULL,
  UNIQUE (organization_id, rate_type_id, from_currency, to_currency, effective_date)
);

CREATE TABLE exchange_rate_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exchange_rate_id UUID NOT NULL REFERENCES exchange_rates(id) ON DELETE CASCADE,
  old_rate NUMERIC(18,6) NOT NULL,
  new_rate NUMERIC(18,6) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by UUID REFERENCES users(id)
);
