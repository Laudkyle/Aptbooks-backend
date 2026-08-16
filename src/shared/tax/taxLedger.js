const { AppError } = require('../errors/AppError');
const { applyRecoverablePercent, normalizeMoney, normalizeRate } = require('./taxMath');

const DETAIL_CONTEXT_SQL = {
  invoice_line_tax_details: `
    SELECT i.organization_id, 'invoice'::text AS source_type, i.id AS source_id,
           il.id AS source_line_id, i.invoice_no AS document_no, i.invoice_date AS document_date,
           i.customer_id AS partner_id, il.line_no, il.description, 1::numeric AS sign_factor
      FROM invoice_lines il
      JOIN invoices i ON i.id=il.invoice_id
     WHERE il.id=$1`,
  bill_line_tax_details: `
    SELECT b.organization_id, 'bill'::text AS source_type, b.id AS source_id,
           bl.id AS source_line_id, b.bill_no AS document_no, b.bill_date AS document_date,
           b.vendor_id AS partner_id, bl.line_no, bl.description, 1::numeric AS sign_factor
      FROM bill_lines bl
      JOIN bills b ON b.id=bl.bill_id
     WHERE bl.id=$1`,
  credit_note_line_tax_details: `
    SELECT cn.organization_id, 'credit_note'::text AS source_type, cn.id AS source_id,
           cnl.id AS source_line_id, cn.credit_note_no AS document_no, cn.credit_note_date AS document_date,
           cn.customer_id AS partner_id, cnl.line_no, cnl.description, -1::numeric AS sign_factor
      FROM credit_note_lines cnl
      JOIN credit_notes cn ON cn.id=cnl.credit_note_id
     WHERE cnl.id=$1`,
  debit_note_line_tax_details: `
    SELECT dn.organization_id, 'debit_note'::text AS source_type, dn.id AS source_id,
           dnl.id AS source_line_id, dn.debit_note_no AS document_no, dn.debit_note_date AS document_date,
           dn.vendor_id AS partner_id, dnl.line_no, dnl.description, -1::numeric AS sign_factor
      FROM debit_note_lines dnl
      JOIN debit_notes dn ON dn.id=dnl.debit_note_id
     WHERE dnl.id=$1`,
  operational_doc_line_tax_details: `
    SELECT od.organization_id, od.module_code::text AS source_type, od.id AS source_id,
           odl.id AS source_line_id, od.document_no, od.document_date,
           od.counterparty_partner_id AS partner_id, odl.line_no, odl.description,
           CASE WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','') IN ('sales_return','purchase_return')
                THEN -1::numeric ELSE 1::numeric END AS sign_factor
      FROM operational_document_lines odl
      JOIN operational_documents od ON od.id=odl.document_id
     WHERE odl.id=$1`,
};

async function getLineContext({ client, tableName, lineId }) {
  const sql = DETAIL_CONTEXT_SQL[tableName];
  if (!sql) throw new AppError(500, `Unsupported tax detail table: ${tableName}`);
  const { rows } = await client.query(sql, [lineId]);
  if (!rows.length) throw new AppError(500, `Unable to resolve tax ledger context for ${tableName}:${lineId}`);
  return rows[0];
}

async function upsertTaxLedgerEntry({ client, context, detail }) {
  const direction = detail.direction || null;
  const isRecoverableInput = direction === 'input' || direction === 'reverse_charge';
  const recoverability = isRecoverableInput
    ? applyRecoverablePercent(detail.tax_amount ?? detail.taxAmount ?? 0, detail.recoverable_percent ?? detail.recoverablePercent ?? 1)
    : { recoverableAmount: '0.00', nonRecoverableAmount: '0.00' };
  const recoveryBasis = isRecoverableInput
    ? (detail.recovery_basis || detail.recoveryBasis || detail.metadata?.recoveryBasis || 'direct_taxable')
    : 'not_applicable';
  const recoveryReason = detail.recovery_reason || detail.recoveryReason || detail.metadata?.recoveryReason || null;
  const { rows } = await client.query(
    `INSERT INTO tax_ledger_entries(
       organization_id, source_type, source_id, source_line_id, source_tax_detail_id,
       document_no, document_date, partner_id, line_no, description,
       source_tax_code_id, tax_code_id, source_rule_id,
       tax_type, tax_scope, direction, box_code, category_code,
       taxable_amount, tax_rate, tax_amount, recoverable_percent,
       recoverable_amount, nonrecoverable_amount, recovery_basis, recovery_reason, exemption_reason_code,
       reverse_charge, sign_factor, metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
       $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb
     )
     ON CONFLICT (organization_id, source_type, source_tax_detail_id)
     DO UPDATE SET
       source_id=EXCLUDED.source_id,
       source_line_id=EXCLUDED.source_line_id,
       document_no=EXCLUDED.document_no,
       document_date=EXCLUDED.document_date,
       partner_id=EXCLUDED.partner_id,
       line_no=EXCLUDED.line_no,
       description=EXCLUDED.description,
       source_tax_code_id=EXCLUDED.source_tax_code_id,
       tax_code_id=EXCLUDED.tax_code_id,
       source_rule_id=EXCLUDED.source_rule_id,
       tax_type=EXCLUDED.tax_type,
       tax_scope=EXCLUDED.tax_scope,
       direction=EXCLUDED.direction,
       box_code=EXCLUDED.box_code,
       category_code=EXCLUDED.category_code,
       taxable_amount=EXCLUDED.taxable_amount,
       tax_rate=EXCLUDED.tax_rate,
       tax_amount=EXCLUDED.tax_amount,
       recoverable_percent=EXCLUDED.recoverable_percent,
       recoverable_amount=EXCLUDED.recoverable_amount,
       nonrecoverable_amount=EXCLUDED.nonrecoverable_amount,
       recovery_basis=EXCLUDED.recovery_basis,
       recovery_reason=EXCLUDED.recovery_reason,
       exemption_reason_code=EXCLUDED.exemption_reason_code,
       reverse_charge=EXCLUDED.reverse_charge,
       sign_factor=EXCLUDED.sign_factor,
       metadata=EXCLUDED.metadata,
       updated_at=NOW()
     RETURNING *`,
    [
      context.organization_id,
      context.source_type,
      context.source_id,
      context.source_line_id,
      detail.id,
      context.document_no || null,
      context.document_date,
      context.partner_id || null,
      context.line_no || null,
      context.description || null,
      detail.source_tax_code_id || detail.sourceTaxCodeId || null,
      detail.tax_code_id || detail.taxCodeId || null,
      detail.source_rule_id || detail.sourceRuleId || null,
      detail.tax_type || detail.taxType || null,
      detail.tax_scope || detail.taxScope || null,
      detail.direction || null,
      detail.box_code || detail.boxCode || null,
      detail.category_code || detail.categoryCode || null,
      normalizeMoney(detail.taxable_amount ?? detail.taxableAmount ?? 0),
      normalizeRate(detail.tax_rate ?? detail.rate ?? 0),
      normalizeMoney(detail.tax_amount ?? detail.taxAmount ?? 0),
      String(detail.recoverable_percent ?? detail.recoverablePercent ?? 1),
      recoverability.recoverableAmount,
      recoverability.nonRecoverableAmount,
      recoveryBasis,
      recoveryReason,
      detail.exemption_reason_code || detail.exemptionReasonCode || null,
      detail.reverse_charge === true || detail.reverseCharge === true,
      String(context.sign_factor || 1),
      JSON.stringify(detail.metadata || {}),
    ]
  );
  return rows[0];
}

async function syncLineTaxDetailToLedger({ client, tableName, lineId, detail }) {
  const context = await getLineContext({ client, tableName, lineId });
  return upsertTaxLedgerEntry({ client, context, detail });
}

async function syncPosTaxDetailToLedger({ client, orgId, saleId, saleLineId, detail }) {
  const { rows } = await client.query(
    `SELECT s.organization_id, 'pos_sale'::text AS source_type, s.id AS source_id,
            l.id AS source_line_id, s.sale_no AS document_no, s.sale_date AS document_date,
            s.customer_id AS partner_id, l.line_no, l.description, 1::numeric AS sign_factor
       FROM pos_sale_lines l
       JOIN pos_sales s ON s.id=l.sale_id
      WHERE s.organization_id=$1 AND s.id=$2 AND l.id=$3`,
    [orgId, saleId, saleLineId]
  );
  if (!rows.length) throw new AppError(500, 'Unable to resolve POS tax ledger context');
  return upsertTaxLedgerEntry({ client, context: rows[0], detail });
}


async function syncPosReturnTaxDetailToLedger({ client, orgId, returnId, returnLineId, detail }) {
  const { rows } = await client.query(
    `SELECT r.organization_id, 'pos_return'::text AS source_type, r.id AS source_id,
            rl.id AS source_line_id, r.return_no AS document_no,
            COALESCE(r.received_at::date, CURRENT_DATE) AS document_date,
            s.customer_id AS partner_id, sl.line_no, sl.description, -1::numeric AS sign_factor
       FROM pos_return_lines rl
       JOIN pos_return_authorizations r ON r.id=rl.return_id
       JOIN pos_sales s ON s.id=r.sale_id
       LEFT JOIN pos_sale_lines sl ON sl.id=rl.sale_line_id
      WHERE r.organization_id=$1 AND r.id=$2 AND rl.id=$3`,
    [orgId, returnId, returnLineId]
  );
  if (!rows.length) throw new AppError(500, 'Unable to resolve POS return tax ledger context');
  return upsertTaxLedgerEntry({ client, context: rows[0], detail });
}

async function upsertTaxAdjustmentLedgerEntry({ client, adjustment }) {
  const amount = normalizeMoney(adjustment.amount || 0);
  const signFactor = String(String(adjustment.amount ?? '0').trim().startsWith('-') ? -1 : 1);
  const recoverability = applyRecoverablePercent(amount.startsWith('-') ? amount.slice(1) : amount, adjustment.direction === 'input' ? 1 : 0);
  const { rows } = await client.query(
    `INSERT INTO tax_ledger_entries(
       organization_id, source_type, source_id, source_line_id, source_tax_detail_id,
       document_no, document_date, line_no, description,
       tax_type, direction, box_code, taxable_amount, tax_rate, tax_amount,
       recoverable_percent, recoverable_amount, nonrecoverable_amount, recovery_basis, recovery_reason, sign_factor, metadata
     ) VALUES ($1,'tax_adjustment',$2,$2,$2,$3,$4,1,$5,$6,$7,$8,'0.00','0.000000',$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
     ON CONFLICT (organization_id, source_type, source_tax_detail_id)
     DO UPDATE SET document_date=EXCLUDED.document_date, description=EXCLUDED.description,
                   tax_type=EXCLUDED.tax_type, direction=EXCLUDED.direction, box_code=EXCLUDED.box_code,
                   tax_amount=EXCLUDED.tax_amount, recoverable_percent=EXCLUDED.recoverable_percent,
                   recoverable_amount=EXCLUDED.recoverable_amount, nonrecoverable_amount=EXCLUDED.nonrecoverable_amount,
                   recovery_basis=EXCLUDED.recovery_basis, recovery_reason=EXCLUDED.recovery_reason,
                   sign_factor=EXCLUDED.sign_factor, metadata=EXCLUDED.metadata, updated_at=NOW()
     RETURNING *`,
    [
      adjustment.organization_id,
      adjustment.id,
      `TAX-ADJ-${String(adjustment.id).slice(0, 8)}`,
      adjustment.adjustment_date,
      adjustment.description,
      adjustment.tax_type,
      adjustment.direction,
      adjustment.box_code || null,
      amount.startsWith('-') ? amount.slice(1) : amount,
      adjustment.direction === 'input' ? '1' : '0',
      recoverability.recoverableAmount,
      recoverability.nonRecoverableAmount,
      adjustment.direction === 'input' ? 'direct_taxable' : 'not_applicable',
      adjustment.direction === 'input' ? 'Posted input-tax adjustment' : null,
      signFactor,
      JSON.stringify({ reference: adjustment.reference || null }),
    ]
  );
  return rows[0];
}

async function syncImportedServiceTaxDetailToLedger({ client, orgId, importedServiceId, detail }) {
  const { rows } = await client.query(
    `SELECT t.organization_id, 'imported_service'::text AS source_type, t.id AS source_id,
            t.id AS source_line_id, COALESCE(t.document_no, 'IMP-' || LEFT(t.id::text, 8)) AS document_no,
            t.service_date AS document_date, t.supplier_id AS partner_id, 1::int AS line_no,
            t.description, 1::numeric AS sign_factor
       FROM imported_service_transactions t
      WHERE t.organization_id=$1 AND t.id=$2`,
    [orgId, importedServiceId]
  );
  if (!rows.length) throw new AppError(500, 'Unable to resolve imported-service tax ledger context');
  return upsertTaxLedgerEntry({
    client,
    context: rows[0],
    detail: {
      ...detail,
      direction: 'reverse_charge',
      reverse_charge: true,
      recovery_basis: detail.recovery_basis || detail.recoveryBasis || 'direct_taxable',
      metadata: { ...(detail.metadata || {}), importedService: true },
    },
  });
}

async function removeTaxLedgerSource({ client, orgId, sourceType, sourceId }) {
  await client.query(`DELETE FROM tax_ledger_entries WHERE organization_id=$1 AND source_type=$2 AND source_id=$3`, [orgId, sourceType, sourceId]);
}

module.exports = {
  syncLineTaxDetailToLedger,
  syncPosTaxDetailToLedger,
  syncPosReturnTaxDetailToLedger,
  upsertTaxAdjustmentLedgerEntry,
  syncImportedServiceTaxDetailToLedger,
  removeTaxLedgerSource,
};
