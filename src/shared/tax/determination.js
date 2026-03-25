const { AppError } = require("../errors/AppError");

function round2(n) {
  return Number(Number(n || 0).toFixed(2));
}

async function getPartnerTaxProfile({ client, orgId, partnerId }) {
  if (!partnerId) return null;
  const { rows } = await client.query(
    `SELECT tpp.*, bp.type AS partner_type, bp.tax_registered AS partner_tax_registered, bp.tax_exempt AS partner_tax_exempt, bp.tax_country_code, bp.tax_id AS partner_tax_id
       FROM tax_partner_profiles tpp
       JOIN business_partners bp ON bp.id = tpp.partner_id
      WHERE tpp.organization_id=$1 AND tpp.partner_id=$2
      LIMIT 1`,
    [orgId, partnerId]
  );
  return rows[0] || null;
}

async function getTaxSettings({ client, orgId }) {
  const { rows } = await client.query(`SELECT * FROM tax_settings WHERE organization_id=$1`, [orgId]);
  return rows[0] || null;
}

async function findMatchingRule({ client, orgId, context = {}, partnerProfile = null, docDate = null }) {
  const params = [orgId];
  const where = [`organization_id=$1`, `status='active'`];
  let i = 2;

  if (context.documentType) {
    where.push(`(document_type IS NULL OR document_type=$${i++})`);
    params.push(context.documentType);
  }
  if (context.partnerType || partnerProfile?.partner_type) {
    where.push(`(partner_type IS NULL OR partner_type=$${i++})`);
    params.push(context.partnerType || partnerProfile?.partner_type);
  }
  if (context.transactionScope) {
    where.push(`(transaction_scope='both' OR transaction_scope=$${i++})`);
    params.push(context.transactionScope);
  }
  if (context.jurisdictionId || partnerProfile?.jurisdiction_id) {
    where.push(`(jurisdiction_id IS NULL OR jurisdiction_id=$${i++})`);
    params.push(context.jurisdictionId || partnerProfile?.jurisdiction_id);
  }
  if (docDate) {
    where.push(`effective_from <= $${i++}::date AND (effective_to IS NULL OR effective_to >= $${i++}::date)`);
    params.push(docDate, docDate);
  }

  const { rows } = await client.query(
    `SELECT *
       FROM tax_rules
      WHERE ${where.join(" AND ")}
      ORDER BY priority ASC, effective_from DESC, created_at DESC
      LIMIT 1`,
    params
  );
  return rows[0] || null;
}

function normalizeRecoverablePercent({ line = {}, partnerProfile = null }) {
  if (line.recoverablePercentOverride != null) return Number(line.recoverablePercentOverride);
  if (line.nonRecoverable === true) return 0;
  if (line.taxTreatment === 'non_recoverable') return 0;
  if (partnerProfile?.recoverable_percent_override != null) return Number(partnerProfile.recoverable_percent_override);
  return null;
}

async function determineTaxSelections({ client, orgId, line = {}, context = {} }) {
  if (Array.isArray(line.taxes) && line.taxes.length) return line.taxes.map((t) => ({ ...t }));
  if (line.taxCodeId) {
    return [{
      taxCodeId: line.taxCodeId,
      taxAmount: line.taxAmount,
      taxableAmount: line.taxableAmount,
      recoverablePercent: line.recoverablePercentOverride ?? null,
      reverseCharge: line.reverseCharge === true,
      exemptionReasonCode: line.exemptionReasonCode || null,
      exemptionReason: line.exemptionReason || null,
      metadata: { explicit: true, itemTaxCategory: line.itemTaxCategory || null }
    }];
  }

  const settings = await getTaxSettings({ client, orgId });
  const partnerProfile = await getPartnerTaxProfile({ client, orgId, partnerId: context.partnerId || null });
  const recoverablePercent = normalizeRecoverablePercent({ line, partnerProfile });

  if (partnerProfile?.is_tax_exempt || partnerProfile?.partner_tax_exempt || line.taxTreatment === 'exempt') {
    return [];
  }

  const rule = await findMatchingRule({ client, orgId, context, partnerProfile, docDate: context.documentDate || null });

  const selections = [];
  const defaultTaxCodeId = rule?.tax_code_id || (
    context.transactionScope === 'sales'
      ? (line.salesTaxCodeId || partnerProfile?.sales_tax_code_id || partnerProfile?.default_tax_code_id || settings?.default_tax_code_id)
      : (line.purchaseTaxCodeId || partnerProfile?.purchase_tax_code_id || partnerProfile?.default_tax_code_id || settings?.default_tax_code_id)
  );

  if (!defaultTaxCodeId) {
    if (settings?.enforce_partner_tax_profile) {
      throw new AppError(409, 'Tax profile is required to determine the applicable tax code for this partner/document');
    }
  } else {
    selections.push({
      taxCodeId: defaultTaxCodeId,
      sourceRuleId: rule?.id || null,
      recoverablePercent,
      exemptionReasonCode: line.exemptionReasonCode || partnerProfile?.exemption_reason_code || null,
      exemptionReason: line.exemptionReason || partnerProfile?.exemption_reason || null,
      reverseCharge: line.reverseCharge === true || partnerProfile?.reverse_charge_applicable === true,
      metadata: {
        partnerTaxProfileId: partnerProfile?.id || null,
        itemTaxCategory: line.itemTaxCategory || null,
        placeOfSupply: line.placeOfSupply || context.placeOfSupply || partnerProfile?.place_of_supply || null
      }
    });
  }

  const shouldApplyWithholding =
    context.transactionScope === 'purchases' &&
    (line.withholdingApplicable === true || partnerProfile?.withholding_applicable === true) &&
    (line.withholdingTaxCodeId || partnerProfile?.withholding_tax_code_id);

  if (shouldApplyWithholding) {
    selections.push({
      taxCodeId: line.withholdingTaxCodeId || partnerProfile?.withholding_tax_code_id,
      sourceRuleId: null,
      recoverablePercent: 0,
      isWithholdingOverlay: true,
      metadata: {
        overlay: 'withholding',
        partnerTaxProfileId: partnerProfile?.id || null
      }
    });
  }

  return selections;
}

module.exports = {
  round2,
  getPartnerTaxProfile,
  getTaxSettings,
  determineTaxSelections,
  findMatchingRule
};
