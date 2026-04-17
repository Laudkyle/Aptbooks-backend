const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

function normalizeQ(q) {
  const s = String(q || "").trim();
  if (s.length < 2) throw new AppError(400, "q must be at least 2 characters");
  if (s.length > 100) throw new AppError(400, "q too long");
  return s;
}

function clampLimit(limitPerType) {
  const n = Number(limitPerType || 10);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(n, 25);
}

async function safeQuery(sql, params) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch (error) {
    if (error?.code === '42P01') return [];
    throw error;
  }
}

function item(type, id, label, meta = {}) {
  return { type, id, label, meta };
}

function cleanResults(results) {
  return Object.fromEntries(Object.entries(results).filter(([, items]) => Array.isArray(items) && items.length));
}

async function globalSearch({ orgId, q, limitPerType = 10 }) {
  const query = normalizeQ(q);
  const like = `%${query}%`;
  const lim = clampLimit(limitPerType);

  const section = async (sql, mapper) => {
    const rows = await safeQuery(sql, [orgId, like]);
    return rows.map(mapper);
  };

  const results = {};

  results.partners = await section(
    `SELECT id, type, code, name, status
       FROM business_partners
      WHERE organization_id=$1
        AND (name ILIKE $2 OR code ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)
      ORDER BY name
      LIMIT ${lim}`,
    (r) => item('partner', r.id, r.name, { partnerType: r.type, code: r.code, status: r.status })
  );

  results.accounts = await section(
    `SELECT id, code, name, status
       FROM chart_of_accounts
      WHERE organization_id=$1
        AND (code ILIKE $2 OR name ILIKE $2)
      ORDER BY code
      LIMIT ${lim}`,
    (r) => item('account', r.id, `${r.code} - ${r.name}`, { code: r.code, status: r.status })
  );

  results.journals = await section(
    `SELECT id, entry_no, entry_date, status, memo
       FROM journal_entries
      WHERE organization_id=$1
        AND (CAST(entry_no AS TEXT) ILIKE $2 OR COALESCE(memo,'') ILIKE $2)
      ORDER BY entry_date DESC, entry_no DESC
      LIMIT ${lim}`,
    (r) => item('journal', r.id, `JE #${r.entry_no}`, { status: r.status, entryDate: r.entry_date, memo: r.memo })
  );

  results.invoices = await section(
    `SELECT i.id, i.invoice_no, i.invoice_date, i.status, i.total, bp.name AS partner_name
       FROM invoices i
       LEFT JOIN business_partners bp ON bp.id = i.customer_id
      WHERE i.organization_id=$1
        AND (i.invoice_no ILIKE $2 OR COALESCE(i.memo,'') ILIKE $2 OR COALESCE(bp.name,'') ILIKE $2)
      ORDER BY i.invoice_date DESC, i.created_at DESC
      LIMIT ${lim}`,
    (r) => item('invoice', r.id, `Invoice ${r.invoice_no}`, { customer: r.partner_name, status: r.status, date: r.invoice_date, total: r.total })
  );

  results.bills = await section(
    `SELECT b.id, b.bill_no, b.bill_date, b.status, b.total, bp.name AS partner_name
       FROM bills b
       LEFT JOIN business_partners bp ON bp.id = b.vendor_id
      WHERE b.organization_id=$1
        AND (b.bill_no ILIKE $2 OR COALESCE(b.memo,'') ILIKE $2 OR COALESCE(bp.name,'') ILIKE $2)
      ORDER BY b.bill_date DESC, b.created_at DESC
      LIMIT ${lim}`,
    (r) => item('bill', r.id, `Bill ${r.bill_no}`, { vendor: r.partner_name, status: r.status, date: r.bill_date, total: r.total })
  );

  results.customerReceipts = await section(
    `SELECT cr.id, cr.receipt_no, cr.receipt_date, cr.status, cr.amount_total, bp.name AS partner_name
       FROM customer_receipts cr
       LEFT JOIN business_partners bp ON bp.id = cr.customer_id
      WHERE cr.organization_id=$1
        AND (cr.receipt_no ILIKE $2 OR COALESCE(cr.memo,'') ILIKE $2 OR COALESCE(bp.name,'') ILIKE $2)
      ORDER BY cr.receipt_date DESC, cr.created_at DESC
      LIMIT ${lim}`,
    (r) => item('customer_receipt', r.id, `Receipt ${r.receipt_no}`, { customer: r.partner_name, status: r.status, date: r.receipt_date, total: r.amount_total })
  );

  results.vendorPayments = await section(
    `SELECT vp.id, vp.payment_no, vp.payment_date, vp.status, vp.amount_total, bp.name AS partner_name
       FROM vendor_payments vp
       LEFT JOIN business_partners bp ON bp.id = vp.vendor_id
      WHERE vp.organization_id=$1
        AND (vp.payment_no ILIKE $2 OR COALESCE(bp.name,'') ILIKE $2)
      ORDER BY vp.payment_date DESC, vp.created_at DESC
      LIMIT ${lim}`,
    (r) => item('vendor_payment', r.id, `Vendor Payment ${r.payment_no}`, { vendor: r.partner_name, status: r.status, date: r.payment_date, total: r.amount_total })
  );

  results.creditNotes = await section(
    `SELECT cn.id, cn.credit_note_no, cn.credit_note_date, cn.status, cn.total, bp.name AS partner_name
       FROM credit_notes cn
       LEFT JOIN business_partners bp ON bp.id = cn.customer_id
      WHERE cn.organization_id=$1
        AND (cn.credit_note_no ILIKE $2 OR COALESCE(cn.memo,'') ILIKE $2 OR COALESCE(bp.name,'') ILIKE $2)
      ORDER BY cn.credit_note_date DESC, cn.created_at DESC
      LIMIT ${lim}`,
    (r) => item('credit_note', r.id, `Credit Note ${r.credit_note_no}`, { customer: r.partner_name, status: r.status, date: r.credit_note_date, total: r.total })
  );

  results.debitNotes = await section(
    `SELECT dn.id, dn.debit_note_no, dn.debit_note_date, dn.status, dn.total, bp.name AS partner_name
       FROM debit_notes dn
       LEFT JOIN business_partners bp ON bp.id = dn.vendor_id
      WHERE dn.organization_id=$1
        AND (dn.debit_note_no ILIKE $2 OR COALESCE(dn.memo,'') ILIKE $2 OR COALESCE(bp.name,'') ILIKE $2)
      ORDER BY dn.debit_note_date DESC, dn.created_at DESC
      LIMIT ${lim}`,
    (r) => item('debit_note', r.id, `Debit Note ${r.debit_note_no}`, { vendor: r.partner_name, status: r.status, date: r.debit_note_date, total: r.total })
  );

  results.operationalDocuments = await section(
    `SELECT d.id, d.module_code, d.document_no, d.document_date, d.status, d.amount_total, d.reference, d.memo, bp.name AS partner_name
       FROM operational_documents d
       LEFT JOIN business_partners bp ON bp.id = d.counterparty_partner_id
      WHERE d.organization_id=$1
        AND (
          d.document_no ILIKE $2
          OR COALESCE(d.reference,'') ILIKE $2
          OR COALESCE(d.memo,'') ILIKE $2
          OR COALESCE(bp.name,'') ILIKE $2
        )
      ORDER BY d.document_date DESC, d.created_at DESC
      LIMIT ${lim}`,
    (r) => item(r.module_code, r.id, `${r.module_code.replace(/_/g, ' ')} ${r.document_no}`, {
      moduleCode: r.module_code,
      partner: r.partner_name,
      status: r.status,
      date: r.document_date,
      total: r.amount_total,
      reference: r.reference
    })
  );

  results.assets = await section(
    `SELECT id, asset_no, name, status, acquisition_date
       FROM fixed_assets
      WHERE organization_id=$1
        AND (asset_no ILIKE $2 OR name ILIKE $2 OR COALESCE(serial_no,'') ILIKE $2)
      ORDER BY acquisition_date DESC NULLS LAST, created_at DESC
      LIMIT ${lim}`,
    (r) => item('asset', r.id, `${r.asset_no} - ${r.name}`, { status: r.status, acquisitionDate: r.acquisition_date })
  );

  results.inventoryItems = await section(
    `SELECT id, sku, name, is_active
       FROM inventory_items
      WHERE organization_id=$1
        AND (sku ILIKE $2 OR name ILIKE $2)
      ORDER BY name
      LIMIT ${lim}`,
    (r) => item('inventory_item', r.id, `${r.sku || 'ITEM'} - ${r.name}`, { sku: r.sku, active: r.is_active })
  );

  results.inventoryTransactions = await section(
    `SELECT id, txn_date, txn_type, reference, status2, status
       FROM inventory_transactions
      WHERE organization_id=$1
        AND (COALESCE(reference,'') ILIKE $2 OR txn_type ILIKE $2)
      ORDER BY txn_date DESC, created_at DESC
      LIMIT ${lim}`,
    (r) => item('inventory_transaction', r.id, `${r.txn_type} ${r.reference || r.id}`, { date: r.txn_date, status: r.status2 || r.status })
  );

  results.stockCounts = await section(
    `SELECT sc.id, sc.reference, sc.count_date, sc.status, w.code AS warehouse_code
       FROM inventory_stock_counts sc
       JOIN warehouses w ON w.id = sc.warehouse_id
      WHERE sc.organization_id=$1
        AND (COALESCE(sc.reference,'') ILIKE $2 OR COALESCE(sc.memo,'') ILIKE $2 OR COALESCE(w.code,'') ILIKE $2)
      ORDER BY sc.count_date DESC, sc.created_at DESC
      LIMIT ${lim}`,
    (r) => item('stock_count', r.id, `Stock Count ${r.reference || r.id}`, { warehouse: r.warehouse_code, status: r.status, date: r.count_date })
  );

  results.transfers = await section(
    `SELECT tr.id, tr.reference, tr.request_date, tr.status, sw.code AS source_code, dw.code AS dest_code
       FROM inventory_transfer_requests tr
       JOIN warehouses sw ON sw.id = tr.source_warehouse_id
       JOIN warehouses dw ON dw.id = tr.dest_warehouse_id
      WHERE tr.organization_id=$1
        AND (COALESCE(tr.reference,'') ILIKE $2 OR COALESCE(tr.memo,'') ILIKE $2 OR COALESCE(sw.code,'') ILIKE $2 OR COALESCE(dw.code,'') ILIKE $2)
      ORDER BY tr.request_date DESC, tr.created_at DESC
      LIMIT ${lim}`,
    (r) => item('inventory_transfer', r.id, `Transfer ${r.reference || r.id}`, { from: r.source_code, to: r.dest_code, status: r.status, date: r.request_date })
  );

  results.projects = await section(
    `SELECT id, code, name, status
       FROM projects
      WHERE organization_id=$1
        AND (code ILIKE $2 OR name ILIKE $2 OR COALESCE(description,'') ILIKE $2)
      ORDER BY updated_at DESC, name
      LIMIT ${lim}`,
    (r) => item('project', r.id, `${r.code} - ${r.name}`, { code: r.code, status: r.status })
  );

  results.budgets = await section(
    `SELECT bv.id, COALESCE(bv.name, b.name) AS version_name, bv.version_no, bv.status, b.name AS budget_name
       FROM budget_versions bv
       JOIN budgets b ON b.id = bv.budget_id
      WHERE bv.organization_id=$1
        AND (COALESCE(bv.name,'') ILIKE $2 OR COALESCE(b.name,'') ILIKE $2 OR CAST(bv.version_no AS TEXT) ILIKE $2)
      ORDER BY bv.updated_at DESC, bv.created_at DESC
      LIMIT ${lim}`,
    (r) => item('budget', r.id, `${r.budget_name} v${r.version_no}`, { name: r.version_name, status: r.status, version: r.version_no })
  );

  results.forecasts = await section(
    `SELECT fv.id, fv.name AS version_name, fv.version_no, fv.status, f.name AS forecast_name
       FROM forecast_versions fv
       JOIN forecasts f ON f.id = fv.forecast_id
      WHERE fv.organization_id=$1
        AND (COALESCE(fv.name,'') ILIKE $2 OR COALESCE(f.name,'') ILIKE $2 OR CAST(fv.version_no AS TEXT) ILIKE $2)
      ORDER BY fv.updated_at DESC, fv.created_at DESC
      LIMIT ${lim}`,
    (r) => item('forecast', r.id, `${r.forecast_name} v${r.version_no}`, { name: r.version_name, status: r.status, version: r.version_no })
  );

  results.bankAccounts = await section(
    `SELECT id, code, name, currency_code, is_active
       FROM bank_accounts
      WHERE organization_id=$1
        AND (code ILIKE $2 OR name ILIKE $2 OR currency_code ILIKE $2)
      ORDER BY name
      LIMIT ${lim}`,
    (r) => item('bank_account', r.id, `${r.code} - ${r.name}`, { currency: r.currency_code, active: r.is_active })
  );

  results.bankStatements = await section(
    `SELECT bs.id, bs.statement_date, ba.code AS bank_code, ba.name AS bank_name
       FROM bank_statements bs
       JOIN bank_accounts ba ON ba.id = bs.bank_account_id
      WHERE bs.organization_id=$1
        AND (COALESCE(ba.code,'') ILIKE $2 OR COALESCE(ba.name,'') ILIKE $2 OR CAST(bs.statement_date AS TEXT) ILIKE $2)
      ORDER BY bs.statement_date DESC, bs.created_at DESC
      LIMIT ${lim}`,
    (r) => item('bank_statement', r.id, `${r.bank_code} statement ${r.statement_date}`, { bankAccount: r.bank_name, date: r.statement_date })
  );

  results.bankReconciliations = await section(
    `SELECT br.id, br.status, br.reconciled_at, ba.code AS bank_code, ba.name AS bank_name
       FROM bank_reconciliations br
       JOIN bank_accounts ba ON ba.id = br.bank_account_id
      WHERE br.organization_id=$1
        AND (COALESCE(ba.code,'') ILIKE $2 OR COALESCE(ba.name,'') ILIKE $2 OR br.status ILIKE $2)
      ORDER BY br.reconciled_at DESC
      LIMIT ${lim}`,
    (r) => item('bank_reconciliation', r.id, `${r.bank_code} reconciliation`, { bankAccount: r.bank_name, status: r.status, reconciledAt: r.reconciled_at })
  );

  results.paymentRuns = await section(
    `SELECT pr.id, pr.code, pr.execution_date, pr.status, ba.code AS bank_code
       FROM payment_runs pr
       JOIN bank_accounts ba ON ba.id = pr.bank_account_id
      WHERE pr.organization_id=$1
        AND (pr.code ILIKE $2 OR COALESCE(pr.memo,'') ILIKE $2 OR COALESCE(ba.code,'') ILIKE $2)
      ORDER BY pr.execution_date DESC, pr.created_at DESC
      LIMIT ${lim}`,
    (r) => item('payment_run', r.id, `Payment Run ${r.code}`, { bankAccount: r.bank_code, status: r.status, date: r.execution_date })
  );

  results.bankTransfers = await section(
    `SELECT bt.id, bt.code, bt.transfer_date, bt.status, fba.code AS from_code, tba.code AS to_code
       FROM bank_transfers bt
       JOIN bank_accounts fba ON fba.id = bt.from_bank_account_id
       JOIN bank_accounts tba ON tba.id = bt.to_bank_account_id
      WHERE bt.organization_id=$1
        AND (bt.code ILIKE $2 OR COALESCE(bt.reference,'') ILIKE $2 OR COALESCE(bt.memo,'') ILIKE $2)
      ORDER BY bt.transfer_date DESC, bt.created_at DESC
      LIMIT ${lim}`,
    (r) => item('bank_transfer', r.id, `Bank Transfer ${r.code}`, { from: r.from_code, to: r.to_code, status: r.status, date: r.transfer_date })
  );

  results.approvalBatches = await section(
    `SELECT id, batch_no, name, scheduled_date, status
       FROM payment_approval_batches
      WHERE organization_id=$1
        AND (batch_no ILIKE $2 OR name ILIKE $2 OR COALESCE(notes,'') ILIKE $2)
      ORDER BY created_at DESC
      LIMIT ${lim}`,
    (r) => item('payment_approval_batch', r.id, `Approval Batch ${r.batch_no}`, { name: r.name, status: r.status, scheduledDate: r.scheduled_date })
  );

  results.leases = await section(
    `SELECT id, code, name, status, commencement_date
       FROM leases
      WHERE organization_id=$1
        AND (code ILIKE $2 OR name ILIKE $2)
      ORDER BY updated_at DESC
      LIMIT ${lim}`,
    (r) => item('lease', r.id, `${r.code} - ${r.name}`, { status: r.status, commencementDate: r.commencement_date })
  );

  results.contracts = await section(
    `SELECT id, code, contract_date, status, memo
       FROM ifrs15_contracts
      WHERE organization_id=$1
        AND (code ILIKE $2 OR COALESCE(memo,'') ILIKE $2)
      ORDER BY updated_at DESC
      LIMIT ${lim}`,
    (r) => item('contract', r.id, `Contract ${r.code}`, { status: r.status, contractDate: r.contract_date })
  );


  results.withholdingRemittances = await section(
    `SELECT id, remittance_no, remittance_date, status, total_amount, reference
       FROM withholding_remittances
      WHERE organization_id=$1
        AND (remittance_no ILIKE $2 OR COALESCE(reference,'') ILIKE $2 OR COALESCE(memo,'') ILIKE $2)
      ORDER BY remittance_date DESC, created_at DESC
      LIMIT ${lim}`,
    (r) => item('withholding_remittance', r.id, `Withholding Remittance ${r.remittance_no}`, { status: r.status, date: r.remittance_date, total: r.total_amount, reference: r.reference })
  );

  results.withholdingCertificates = await section(
    `SELECT id, certificate_no, certificate_date, status, total_amount, reference
       FROM withholding_certificates
      WHERE organization_id=$1
        AND (certificate_no ILIKE $2 OR COALESCE(reference,'') ILIKE $2 OR COALESCE(memo,'') ILIKE $2)
      ORDER BY certificate_date DESC, created_at DESC
      LIMIT ${lim}`,
    (r) => item('withholding_certificate', r.id, `Withholding Certificate ${r.certificate_no}`, { status: r.status, date: r.certificate_date, total: r.total_amount, reference: r.reference })
  );

  results.documents = await section(
    `SELECT d.id, d.title, d.entity_type, d.entity_id, d.entity_ref, d.workflow_state_code, d.updated_at
       FROM documents d
      WHERE d.organization_id=$1
        AND (d.title ILIKE $2 OR COALESCE(d.entity_ref,'') ILIKE $2 OR d.entity_type ILIKE $2)
      ORDER BY d.updated_at DESC
      LIMIT ${lim}`,
    (r) => item('document', r.id, r.title, {
      entityType: r.entity_type,
      entityId: r.entity_id,
      entityRef: r.entity_ref,
      workflowState: r.workflow_state_code,
      updatedAt: r.updated_at
    })
  );

  return { query, results: cleanResults(results) };
}

module.exports = { globalSearch };
