const { AppError } = require('../errors/AppError');

function round2(n) {
  return Number(Number(n || 0).toFixed(2));
}

async function fetchTaxCodeBundle({ client, orgId, taxCodeId }) {
  const { rows } = await client.query(
    `SELECT id, organization_id, code, name, tax_type, rate, is_compound, direction, box_code, status, effective_from, effective_to
       FROM tax_codes
      WHERE organization_id=$1 AND id=$2`,
    [orgId, taxCodeId]
  );
  if (!rows.length) throw new AppError(400, `Invalid tax code: ${taxCodeId}`);
  const code = rows[0];
  if (code.status !== 'active') throw new AppError(400, `Inactive tax code used: ${code.code}`);

  const { rows: comps } = await client.query(
    `SELECT tcc.id, tcc.parent_tax_code_id, tcc.component_tax_code_id, tcc.sequence_no, tcc.rate_override,
            tc.code, tc.name, tc.tax_type, tc.rate, tc.direction, tc.box_code, tc.status
       FROM tax_code_components tcc
       JOIN tax_codes tc ON tc.id = tcc.component_tax_code_id
      WHERE tcc.organization_id=$1 AND tcc.parent_tax_code_id=$2
      ORDER BY tcc.sequence_no, tc.code`,
    [orgId, taxCodeId]
  );
  return { code, components: comps };
}

async function expandTaxSelection({ client, orgId, selection, defaultTaxableAmount = 0 }) {
  const bundle = await fetchTaxCodeBundle({ client, orgId, taxCodeId: selection.taxCodeId });
  const taxableAmount = round2(selection.taxableAmount == null ? defaultTaxableAmount : selection.taxableAmount);

  if (!bundle.code.is_compound || !bundle.components.length) {
    const rate = Number(bundle.code.rate || 0);
    const taxAmount = selection.taxAmount == null ? round2(taxableAmount * rate) : round2(selection.taxAmount);
    return [{
      selectedTaxCodeId: bundle.code.id,
      sourceTaxCodeId: bundle.code.id,
      taxCodeId: bundle.code.id,
      taxCode: bundle.code.code,
      taxCodeName: bundle.code.name,
      taxType: bundle.code.tax_type,
      direction: bundle.code.direction,
      boxCode: bundle.code.box_code,
      rate,
      taxableAmount,
      taxAmount
    }];
  }

  if (selection.taxAmount != null) {
    throw new AppError(400, `Compound tax code ${bundle.code.code} cannot be submitted with a single taxAmount override; submit component taxes or let the system calculate them`);
  }

  return bundle.components.map((component) => {
    const rate = Number(component.rate_override == null ? component.rate : component.rate_override) || 0;
    return {
      selectedTaxCodeId: bundle.code.id,
      sourceTaxCodeId: bundle.code.id,
      taxCodeId: component.component_tax_code_id,
      taxCode: component.code,
      taxCodeName: component.name,
      taxType: component.tax_type,
      direction: component.direction,
      boxCode: component.box_code,
      rate,
      taxableAmount,
      taxAmount: round2(taxableAmount * rate)
    };
  });
}

async function resolveLineTaxes({ client, orgId, line, defaultTaxableAmount = 0 }) {
  const selections = Array.isArray(line.taxes) && line.taxes.length
    ? line.taxes.map((t) => ({ ...t }))
    : (line.taxCodeId ? [{ taxCodeId: line.taxCodeId, taxAmount: line.taxAmount, taxableAmount: line.taxableAmount }] : []);

  const components = [];
  for (const selection of selections) {
    if (!selection?.taxCodeId) throw new AppError(400, 'Each tax selection must include taxCodeId');
    const expanded = await expandTaxSelection({ client, orgId, selection, defaultTaxableAmount });
    components.push(...expanded);
  }

  const aggregate = components.reduce((sum, item) => sum + Number(item.taxAmount || 0), 0);
  return {
    selectedTaxCodeId: line.taxCodeId || (selections.length === 1 ? selections[0].taxCodeId : null),
    taxAmount: round2(aggregate),
    components
  };
}

async function insertLineTaxDetails({ client, tableName, lineId, details = [] }) {
  if (!details.length) return [];
  const inserted = [];
  for (let i = 0; i < details.length; i++) {
    const d = details[i];
    const { rows } = await client.query(
      `INSERT INTO ${tableName}
         (line_id, sequence_no, source_tax_code_id, tax_code_id, taxable_amount, tax_rate, tax_amount, tax_type, direction, box_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        lineId,
        i + 1,
        d.sourceTaxCodeId || d.selectedTaxCodeId || d.taxCodeId || null,
        d.taxCodeId,
        d.taxableAmount,
        d.rate,
        d.taxAmount,
        d.taxType || null,
        d.direction || null,
        d.boxCode || null
      ]
    );
    inserted.push(rows[0]);
  }
  return inserted;
}

async function loadLineTaxDetails({ client, tableName, lineIds = [] }) {
  if (!lineIds.length) return new Map();
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

module.exports = {
  round2,
  resolveLineTaxes,
  insertLineTaxDetails,
  loadLineTaxDetails,
  fetchTaxCodeBundle
};
