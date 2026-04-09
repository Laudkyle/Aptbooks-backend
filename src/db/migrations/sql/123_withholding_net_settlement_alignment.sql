BEGIN;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS withholding_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_settlement_total NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS withholding_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_settlement_total NUMERIC(18,2) NOT NULL DEFAULT 0;

WITH invoice_withholding AS (
  SELECT
    il.invoice_id,
    COALESCE(SUM(CASE WHEN d.tax_type = 'WITHHOLDING' AND d.direction = 'output' THEN d.tax_amount ELSE 0 END), 0) AS withholding_total
  FROM invoice_lines il
  LEFT JOIN invoice_line_tax_details d ON d.line_id = il.id
  GROUP BY il.invoice_id
)
UPDATE invoices i
SET withholding_total = COALESCE(w.withholding_total, 0),
    net_settlement_total = GREATEST(0, COALESCE(i.total, 0) - COALESCE(w.withholding_total, 0))
FROM invoice_withholding w
WHERE w.invoice_id = i.id;

UPDATE invoices
SET net_settlement_total = GREATEST(0, COALESCE(total, 0) - COALESCE(withholding_total, 0))
WHERE net_settlement_total IS NULL OR net_settlement_total = 0;

WITH bill_withholding AS (
  SELECT
    bl.bill_id,
    COALESCE(SUM(CASE WHEN d.tax_type = 'WITHHOLDING' AND d.direction = 'input' THEN d.tax_amount ELSE 0 END), 0) AS withholding_total
  FROM bill_lines bl
  LEFT JOIN bill_line_tax_details d ON d.line_id = bl.id
  GROUP BY bl.bill_id
)
UPDATE bills b
SET withholding_total = COALESCE(w.withholding_total, 0),
    net_settlement_total = GREATEST(0, COALESCE(b.total, 0) - COALESCE(w.withholding_total, 0))
FROM bill_withholding w
WHERE w.bill_id = b.id;

UPDATE bills
SET net_settlement_total = GREATEST(0, COALESCE(total, 0) - COALESCE(withholding_total, 0))
WHERE net_settlement_total IS NULL OR net_settlement_total = 0;

DROP VIEW IF EXISTS reporting_ar_open_items;
DROP VIEW IF EXISTS reporting_ap_open_items;

CREATE VIEW reporting_ar_open_items AS
WITH ralloc AS (
  SELECT cra.invoice_id, SUM(cra.amount_applied + COALESCE(cra.discount_taken,0)) AS allocated
  FROM customer_receipt_allocations cra
  JOIN customer_receipts cr ON cr.id = cra.customer_receipt_id
  WHERE cr.status='posted'
  GROUP BY cra.invoice_id
), cnalloc AS (
  SELECT cna.invoice_id, SUM(cna.amount_applied) AS applied
  FROM credit_note_applications cna
  JOIN credit_notes cn ON cn.id = cna.credit_note_id
  WHERE cn.status='issued'
  GROUP BY cna.invoice_id
), woff AS (
  SELECT w.entity_id AS invoice_id, SUM(w.amount) AS written_off
  FROM writeoffs w
  WHERE w.entity_type='invoice' AND w.status='posted'
  GROUP BY w.entity_id
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
  COALESCE(i.withholding_total, 0) AS withholding_total,
  COALESCE(i.net_settlement_total, i.total) AS settlement_basis_total,
  COALESCE(r.allocated,0) AS allocated,
  COALESCE(cn.applied,0) AS notes_applied,
  COALESCE(w.written_off,0) AS written_off,
  (COALESCE(i.net_settlement_total, i.total) - COALESCE(r.allocated,0) - COALESCE(cn.applied,0) - COALESCE(w.written_off,0)) AS outstanding
FROM invoices i
LEFT JOIN ralloc r ON r.invoice_id=i.id
LEFT JOIN cnalloc cn ON cn.invoice_id=i.id
LEFT JOIN woff w ON w.invoice_id=i.id;

CREATE VIEW reporting_ap_open_items AS
WITH palloc AS (
  SELECT vpa.bill_id, SUM(vpa.amount_applied + COALESCE(vpa.discount_taken,0)) AS allocated
  FROM vendor_payment_allocations vpa
  JOIN vendor_payments vp ON vp.id = vpa.vendor_payment_id
  WHERE vp.status='posted'
  GROUP BY vpa.bill_id
), dnalloc AS (
  SELECT dna.bill_id, SUM(dna.amount_applied) AS applied
  FROM debit_note_applications dna
  JOIN debit_notes dn ON dn.id = dna.debit_note_id
  WHERE dn.status='issued'
  GROUP BY dna.bill_id
), woff AS (
  SELECT w.entity_id AS bill_id, SUM(w.amount) AS written_off
  FROM writeoffs w
  WHERE w.entity_type='bill' AND w.status='posted'
  GROUP BY w.entity_id
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
  COALESCE(b.withholding_total, 0) AS withholding_total,
  COALESCE(b.net_settlement_total, b.total) AS settlement_basis_total,
  COALESCE(p.allocated,0) AS allocated,
  COALESCE(dn.applied,0) AS notes_applied,
  COALESCE(w.written_off,0) AS written_off,
  (COALESCE(b.net_settlement_total, b.total) - COALESCE(p.allocated,0) - COALESCE(dn.applied,0) - COALESCE(w.written_off,0)) AS outstanding
FROM bills b
LEFT JOIN palloc p ON p.bill_id=b.id
LEFT JOIN dnalloc dn ON dn.bill_id=b.id
LEFT JOIN woff w ON w.bill_id=b.id;

COMMIT;
