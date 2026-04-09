BEGIN;

ALTER TABLE customer_receipt_allocations
  ALTER COLUMN amount_applied TYPE NUMERIC(18,2) USING amount_applied::NUMERIC(18,2),
  ALTER COLUMN discount_taken TYPE NUMERIC(18,2) USING COALESCE(discount_taken, 0)::NUMERIC(18,2);

ALTER TABLE vendor_payment_allocations
  ALTER COLUMN amount_applied TYPE NUMERIC(18,2) USING amount_applied::NUMERIC(18,2),
  ALTER COLUMN discount_taken TYPE NUMERIC(18,2) USING COALESCE(discount_taken, 0)::NUMERIC(18,2);

ALTER TABLE credit_note_applications
  ALTER COLUMN amount_applied TYPE NUMERIC(18,2) USING amount_applied::NUMERIC(18,2);

ALTER TABLE debit_note_applications
  ALTER COLUMN amount_applied TYPE NUMERIC(18,2) USING amount_applied::NUMERIC(18,2);

COMMIT;
