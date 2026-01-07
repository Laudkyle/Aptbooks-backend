-- 044_reporting_operational_reports_stage4.sql
-- Stage 4: Operational reporting read models (AR/AP open items, banking status, inventory valuation)

BEGIN;

-- AR open items (net outstanding per invoice) using posted customer receipt allocations.
CREATE OR REPLACE VIEW reporting_ar_open_items AS
WITH alloc AS (
  SELECT
    cra.invoice_id,
    SUM(cra.amount_applied) AS allocated
  FROM customer_receipt_allocations cra
  JOIN customer_receipts cr ON cr.id = cra.customer_receipt_id
  WHERE cr.status='posted'
  GROUP BY cra.invoice_id
)
SELECT
  i.organization_id,
  i.id AS invoice_id,
  i.customer_id,
  i.invoice_no,
  i.invoice_date,
  i.due_date,
  i.currency_code,
  i.total,
  COALESCE(a.allocated,0) AS allocated,
  (i.total - COALESCE(a.allocated,0)) AS outstanding
FROM invoices i
LEFT JOIN alloc a ON a.invoice_id = i.id;

-- AP open items (net outstanding per bill) using posted vendor payment allocations.
CREATE OR REPLACE VIEW reporting_ap_open_items AS
WITH alloc AS (
  SELECT
    vpa.bill_id,
    SUM(vpa.amount_applied) AS allocated
  FROM vendor_payment_allocations vpa
  JOIN vendor_payments vp ON vp.id = vpa.vendor_payment_id
  WHERE vp.status='posted'
  GROUP BY vpa.bill_id
)
SELECT
  b.organization_id,
  b.id AS bill_id,
  b.vendor_id,
  b.bill_no,
  b.bill_date,
  b.due_date,
  b.currency_code,
  b.total,
  COALESCE(a.allocated,0) AS allocated,
  (b.total - COALESCE(a.allocated,0)) AS outstanding
FROM bills b
LEFT JOIN alloc a ON a.bill_id = b.id;

-- Bank statement status summary.
CREATE OR REPLACE VIEW reporting_bank_statement_status AS
SELECT
  bs.organization_id,
  bs.id AS statement_id,
  bs.bank_account_id,
  bs.statement_date,
  bs.opening_balance,
  bs.closing_balance,
  COUNT(bsl.id) AS line_count,
  SUM(CASE WHEN bsl.matched THEN 1 ELSE 0 END) AS matched_count,
  SUM(CASE WHEN NOT bsl.matched THEN 1 ELSE 0 END) AS unmatched_count,
  COALESCE(SUM(CASE WHEN bsl.matched THEN bsl.amount ELSE 0 END),0) AS matched_amount,
  COALESCE(SUM(CASE WHEN NOT bsl.matched THEN bsl.amount ELSE 0 END),0) AS unmatched_amount
FROM bank_statements bs
LEFT JOIN bank_statement_lines bsl ON bsl.statement_id = bs.id
GROUP BY bs.organization_id, bs.id;

-- Inventory valuation current (by warehouse + item).
CREATE OR REPLACE VIEW reporting_inventory_valuation_current AS
SELECT
  ib.organization_id,
  ib.warehouse_id,
  ib.item_id,
  ib.qty_on_hand,
  ib.avg_unit_cost,
  (ib.qty_on_hand * ib.avg_unit_cost) AS extended_value,
  ib.updated_at
FROM inventory_balances ib;

COMMIT;
