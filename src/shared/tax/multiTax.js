const { AppError } = require('../errors/AppError');
const { determineTaxSelections } = require('./determination');
const {
  normalizeMoney,
  normalizeRate,
  addMoney,
  computeTaxMoney,
} = require('./taxMath');
const { syncLineTaxDetailToLedger } = require('./taxLedger');

const ALLOWED_DETAIL_TABLES = new Set([
  'invoice_line_tax_details',
  'bill_line_tax_details',
  'credit_note_line_tax_details',
  'debit_note_line_tax_details',
  'operational_doc_line_tax_details',
]);

// Legacy compatibility for callers that still expect a JS number. Tax calculations
// themselves never use this helper; they use fixed-point strings/BigInt in taxMath.
function round2(n) {
  return Number(normalizeMoney(n));
}

async function fetchTaxCodeBundle({ client, orgId, taxCodeId }) {
  const { rows } = await client.query(
    `SELECT id, organization_id, code, name, tax_type, rate, is_compound, direction, box_code, status, effective_from, effective_to,
            category_code, tax_scope, application_scope, calculation_method, exemption_reason_code, exemption_reason,
            reverse_charge, recoverable_percent, reporting_group, posting_account_id, metadata
       FROM tax_codes
      WHERE organization_id=$1 AND id=$2`,
    [orgId, taxCodeId]
  );
  if (!rows.length) throw new AppError(400, `Invalid tax code: ${taxCodeId}`);
  const code = rows[0];
  if (code.status !== 'active') throw new AppError(400, `Inactive tax code used: ${code.code}`);

  const { rows: comps } = await client.query(
    `SELECT tcc.id, tcc.parent_tax_code_id, tcc.component_tax_code_id, tcc.sequence_no, tcc.rate_override,
            tc.id AS tax_code_id, tc.code, tc.name, tc.tax_type, tc.rate, tc.direction, tc.box_code, tc.status,
            tc.category_code, tc.tax_scope, tc.application_scope, tc.calculation_method, tc.exemption_reason_code, tc.exemption_reason,
            tc.reverse_charge, tc.recoverable_percent, tc.reporting_group, tc.posting_account_id, tc.metadata
       FROM tax_code_components tcc
       JOIN tax_codes tc ON tc.id = tcc.component_tax_code_id
      WHERE tcc.organization_id=$1 AND tcc.parent_tax_code_id=$2
      ORDER BY tcc.sequence_no, tc.code`,
    [orgId, taxCodeId]
  );
  return { code, components: comps };
}

function computeTaxAmount({ taxableAmount, rate, calculationMethod = 'standard', explicitTaxAmount = null }) {
  return computeTaxMoney({ taxableAmount, rate, calculationMethod, explicitTaxAmount });
}

async function expandTaxSelection({ client, orgId, selection, defaultTaxableAmount = '0.00', context = {} }) {
  const bundle = await fetchTaxCodeBundle({ client, orgId, taxCodeId: selection.taxCodeId });
  const taxableAmount = normalizeMoney(selection.taxableAmount == null ? defaultTaxableAmount : selection.taxableAmount);

  const shape = (taxCode, rate) => ({
    selectedTaxCodeId: bundle.code.id,
    sourceTaxCodeId: bundle.code.id,
    sourceRuleId: selection.sourceRuleId || null,
    taxCodeId: taxCode.id || taxCode.tax_code_id,
    taxCode: taxCode.code,
    taxCodeName: taxCode.name,
    taxType: taxCode.tax_type,
    direction: taxCode.direction === 'both'
      ? (context.transactionScope === 'purchases' ? 'input' : 'output')
      : taxCode.direction,
    boxCode: taxCode.box_code,
    rate: normalizeRate(rate),
    taxableAmount,
    taxScope: taxCode.tax_scope || null,
    categoryCode: taxCode.category_code || null,
    recoverablePercent: selection.recoverablePercent == null ? String(taxCode.recoverable_percent ?? 1) : String(selection.recoverablePercent),
    exemptionReasonCode: selection.exemptionReasonCode || taxCode.exemption_reason_code || null,
    exemptionReason: selection.exemptionReason || taxCode.exemption_reason || null,
    reverseCharge: selection.reverseCharge == null ? (taxCode.reverse_charge === true) : selection.reverseCharge === true,
    postingAccountId: selection.postingAccountId || taxCode.posting_account_id || null,
    metadata: { ...(taxCode.metadata || {}), ...(selection.metadata || {}) }
  });

  if (!bundle.code.is_compound || !bundle.components.length) {
    const rate = selection.rateOverride == null ? bundle.code.rate || '0' : selection.rateOverride || '0';
    const component = shape(bundle.code, rate);
    component.taxAmount = computeTaxAmount({ taxableAmount, rate: component.rate, calculationMethod: bundle.code.calculation_method, explicitTaxAmount: selection.taxAmount });
    component.calculationMethod = bundle.code.calculation_method;
    return [component];
  }

  if (selection.taxAmount != null) {
    throw new AppError(400, `Compound tax code ${bundle.code.code} cannot be submitted with a single taxAmount override; submit component taxes or let the system calculate them`);
  }

  return bundle.components.map((componentTax) => {
    const componentBaseRate = componentTax.rate_override == null ? componentTax.rate : componentTax.rate_override;
    const rate = selection.rateOverride == null ? componentBaseRate || '0' : selection.rateOverride || '0';
    const component = shape(componentTax, rate);
    component.taxAmount = computeTaxAmount({ taxableAmount, rate: component.rate, calculationMethod: componentTax.calculation_method });
    component.calculationMethod = componentTax.calculation_method;
    return component;
  });
}

async function resolveLineTaxes({ client, orgId, line, defaultTaxableAmount = '0.00', context = {} }) {
  const selections = await determineTaxSelections({ client, orgId, line, context });

  const components = [];
  for (const selection of selections) {
    if (!selection?.taxCodeId) throw new AppError(400, 'Each tax selection must include taxCodeId');
    const expanded = await expandTaxSelection({ client, orgId, selection, defaultTaxableAmount, context });
    components.push(...expanded);
  }

  const nonWithholding = components.filter((item) => item.taxType !== 'WITHHOLDING').map((item) => item.taxAmount || '0.00');
  const withholding = components.filter((item) => item.taxType === 'WITHHOLDING').map((item) => item.taxAmount || '0.00');
  const all = components.map((item) => item.taxAmount || '0.00');

  const taxAmount = addMoney(nonWithholding);
  const withholdingTaxAmount = addMoney(withholding);
  const grossComputedTaxAmount = addMoney(all);
  const taxableAmount = normalizeMoney(defaultTaxableAmount);

  return {
    selectedTaxCodeId: line.taxCodeId || (selections.length === 1 ? selections[0].taxCodeId : null),
    taxAmount,
    withholdingTaxAmount,
    grossComputedTaxAmount,
    taxableAmount,
    components,
    snapshot: {
      context,
      selectedTaxCodeId: line.taxCodeId || (selections.length === 1 ? selections[0].taxCodeId : null),
      taxAmount,
      withholdingTaxAmount,
      grossComputedTaxAmount,
      taxableAmount,
      rateSemantics: 'percentage_points',
      classification: {
        supplyType: line.supplyType || context.supplyType || null,
        taxCategory: line.itemTaxCategory || line.taxCategory || line.taxTreatment || null,
        taxProfileId: line.taxProfileId || null
      },
      components
    }
  };
}

function summarizeResolvedTaxes(components = []) {
  const buckets = {
    inclusiveNonWithholdingTax: [],
    exclusiveNonWithholdingTax: [],
    withholdingTax: [],
    totalNonWithholdingTax: [],
    totalTax: [],
  };

  for (const component of components || []) {
    const amount = normalizeMoney(component.taxAmount || 0);
    const taxType = component.taxType || component.tax_type || null;
    const calculationMethod = component.calculationMethod || component.calculation_method || 'standard';

    buckets.totalTax.push(amount);
    if (taxType === 'WITHHOLDING') {
      buckets.withholdingTax.push(amount);
      continue;
    }

    buckets.totalNonWithholdingTax.push(amount);
    if (calculationMethod === 'inclusive') buckets.inclusiveNonWithholdingTax.push(amount);
    else buckets.exclusiveNonWithholdingTax.push(amount);
  }

  return {
    inclusiveNonWithholdingTax: addMoney(buckets.inclusiveNonWithholdingTax),
    exclusiveNonWithholdingTax: addMoney(buckets.exclusiveNonWithholdingTax),
    withholdingTax: addMoney(buckets.withholdingTax),
    totalNonWithholdingTax: addMoney(buckets.totalNonWithholdingTax),
    totalTax: addMoney(buckets.totalTax),
  };
}

async function insertLineTaxDetails({ client, tableName, lineId, details = [] }) {
  if (!details.length) return [];
  if (!ALLOWED_DETAIL_TABLES.has(tableName)) throw new AppError(500, `Unsupported tax detail table: ${tableName}`);

  const inserted = [];
  for (let i = 0; i < details.length; i++) {
    const d = details[i];
    const { rows } = await client.query(
      `INSERT INTO ${tableName}
         (line_id, sequence_no, source_tax_code_id, tax_code_id, taxable_amount, tax_rate, tax_amount, tax_type, direction, box_code,
          tax_scope, category_code, recoverable_percent, exemption_reason_code, reverse_charge, posting_account_id, source_rule_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
       RETURNING *`,
      [
        lineId,
        i + 1,
        d.sourceTaxCodeId || d.selectedTaxCodeId || d.taxCodeId || null,
        d.taxCodeId,
        normalizeMoney(d.taxableAmount),
        normalizeRate(d.rate),
        normalizeMoney(d.taxAmount),
        d.taxType || null,
        d.direction || null,
        d.boxCode || null,
        d.taxScope || null,
        d.categoryCode || null,
        d.recoverablePercent == null ? 1 : d.recoverablePercent,
        d.exemptionReasonCode || null,
        d.reverseCharge === true,
        d.postingAccountId || null,
        d.sourceRuleId || null,
        JSON.stringify(d.metadata || {})
      ]
    );
    inserted.push(rows[0]);
    await syncLineTaxDetailToLedger({ client, tableName, lineId, detail: rows[0] });
  }
  return inserted;
}

async function loadLineTaxDetails({ client, tableName, lineIds = [] }) {
  if (!lineIds.length) return new Map();
  if (!ALLOWED_DETAIL_TABLES.has(tableName)) throw new AppError(500, `Unsupported tax detail table: ${tableName}`);
  const { rows } = await client.query(
    `SELECT * FROM ${tableName} WHERE line_id = ANY($1::uuid[]) ORDER BY line_id, sequence_no`,
    [lineIds]
  );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.line_id)) map.set(row.line_id, []);
    map.get(row.line_id).push(row);
  }
  return map;
}

async function upsertDocumentTaxSnapshot({ client, orgId, sourceType, sourceId, journalEntryId = null, snapshot = {} }) {
  const { rows } = await client.query(
    `INSERT INTO tax_document_snapshots (organization_id, source_type, source_id, journal_entry_id, snapshot_json)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (organization_id, source_type, source_id)
     DO UPDATE SET journal_entry_id=EXCLUDED.journal_entry_id, snapshot_json=EXCLUDED.snapshot_json, updated_at=NOW()
     RETURNING *`,
    [orgId, sourceType, sourceId, journalEntryId, JSON.stringify(snapshot || {})]
  );
  return rows[0];
}

module.exports = {
  round2,
  computeTaxAmount,
  resolveLineTaxes,
  insertLineTaxDetails,
  loadLineTaxDetails,
  fetchTaxCodeBundle,
  upsertDocumentTaxSnapshot,
  summarizeResolvedTaxes
};
