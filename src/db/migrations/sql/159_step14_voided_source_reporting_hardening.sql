BEGIN;

-- A voided source remains in the database for audit, but it is no longer an
-- open receivable/payable. Only legally live AR/AP documents belong in the
-- open-item views.
CREATE OR REPLACE VIEW reporting_ar_open_items AS
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
  COALESCE(i.withholding_total,0) AS withholding_total,
  COALESCE(i.net_settlement_total, i.total) AS settlement_total,
  COALESCE(r.allocated,0) AS allocated,
  COALESCE(cn.applied,0) AS notes_applied,
  COALESCE(w.written_off,0) AS written_off,
  (COALESCE(i.net_settlement_total, i.total) - COALESCE(r.allocated,0) - COALESCE(cn.applied,0) - COALESCE(w.written_off,0)) AS outstanding
FROM invoices i
LEFT JOIN ralloc r ON r.invoice_id=i.id
LEFT JOIN cnalloc cn ON cn.invoice_id=i.id
LEFT JOIN woff w ON w.invoice_id=i.id
WHERE i.status IN ('issued','paid');

-- Preserve the latest WHVAT settlement semantics from migration 150 while
-- excluding voided/cancelled bills from AP open items.
CREATE OR REPLACE VIEW reporting_ap_open_items AS
WITH palloc AS (
  SELECT vpa.bill_id,
         SUM(vpa.amount_applied + COALESCE(vpa.discount_taken,0) + COALESCE(vpa.vat_withholding_applied,0)) AS allocated
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
  COALESCE(b.withholding_total,0) AS withholding_total,
  COALESCE(b.net_settlement_total, b.total) AS settlement_total,
  COALESCE(p.allocated,0) AS allocated,
  COALESCE(dn.applied,0) AS notes_applied,
  COALESCE(w.written_off,0) AS written_off,
  (COALESCE(b.net_settlement_total, b.total) - COALESCE(p.allocated,0) - COALESCE(dn.applied,0) - COALESCE(w.written_off,0)) AS outstanding
FROM bills b
LEFT JOIN palloc p ON p.bill_id=b.id
LEFT JOIN dnalloc dn ON dn.bill_id=b.id
LEFT JOIN woff w ON w.bill_id=b.id
WHERE b.status IN ('issued','paid');

COMMENT ON VIEW reporting_ar_open_items IS
  'Live AR open items only. Voided invoices remain auditable in invoices/journals but have no AR-aging/open-item effect.';
COMMENT ON VIEW reporting_ap_open_items IS
  'Live AP open items only. Voided bills remain auditable in bills/journals but have no AP-aging/open-item effect.';

COMMIT;
