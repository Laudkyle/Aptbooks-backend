const { AppError } = require('../errors/AppError');
const { normalizeMoney } = require('./taxMath');

// Compatibility boundary only; tax calculations use taxMath fixed-point helpers.
function round2(n) {
  return Number(normalizeMoney(n));
}

async function getPartnerTaxProfile({ client, orgId, partnerId }) {
  if (!partnerId) return null;
  const { rows } = await client.query(
    `SELECT tpp.*, bp.type AS partner_type, bp.tax_registered AS partner_tax_registered,
            bp.tax_exempt AS partner_tax_exempt, bp.tax_country_code, bp.tax_id AS partner_tax_id
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

async function getCatalogTaxProfile({ client, orgId, line = {}, docDate = null }) {
  const date = docDate || new Date().toISOString().slice(0, 10);
  if (line.taxProfileId) {
    const { rows } = await client.query(
      `SELECT tcp.*
         FROM tax_catalog_profiles tcp
        WHERE tcp.organization_id=$1 AND tcp.id=$2 AND tcp.status='active'
          AND tcp.effective_from <= $3::date AND (tcp.effective_to IS NULL OR tcp.effective_to >= $3::date)
        LIMIT 1`,
      [orgId, line.taxProfileId, date]
    );
    return rows[0] || null;
  }

  if (line.itemId) {
    const { rows } = await client.query(
      `SELECT tcp.*
         FROM inventory_items i
         JOIN tax_catalog_profiles tcp ON tcp.id=i.tax_profile_id AND tcp.organization_id=i.organization_id
        WHERE i.organization_id=$1 AND i.id=$2 AND tcp.status='active'
          AND tcp.effective_from <= $3::date AND (tcp.effective_to IS NULL OR tcp.effective_to >= $3::date)
        LIMIT 1`,
      [orgId, line.itemId, date]
    );
    return rows[0] || null;
  }
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function buildFacts({ context = {}, line = {}, partnerProfile = null, catalogProfile = null }) {
  const partnerMetadata = partnerProfile?.metadata || {};
  const catalogMetadata = catalogProfile?.metadata || {};
  const contextMetadata = context.metadata || {};
  const lineMetadata = line.metadata || {};

  return {
    ...partnerMetadata,
    ...catalogMetadata,
    ...contextMetadata,
    ...lineMetadata,
    documentType: context.documentType || null,
    partnerType: context.partnerType || partnerProfile?.partner_type || null,
    transactionScope: context.transactionScope || null,
    jurisdictionId: context.jurisdictionId || partnerProfile?.jurisdiction_id || null,
    supplyType: firstDefined(line.supplyType, context.supplyType, catalogProfile?.supply_type),
    taxCategory: firstDefined(line.itemTaxCategory, line.taxCategory, line.taxTreatment, catalogProfile?.tax_category, (partnerProfile?.is_tax_exempt || partnerProfile?.partner_tax_exempt) ? 'exempt' : null),
    category: firstDefined(line.category, line.itemTaxCategory, catalogProfile?.tax_category, catalogMetadata.category),
    industry: firstDefined(line.industry, context.industry, catalogMetadata.industry, partnerMetadata.industry),
    residency: firstDefined(line.residency, context.residency, partnerProfile?.residency_status, partnerMetadata.residency),
    placeOfSupply: firstDefined(line.placeOfSupply, context.placeOfSupply, partnerProfile?.place_of_supply),
    placeOfSupplyCountryCode: firstDefined(line.placeOfSupplyCountryCode, context.placeOfSupplyCountryCode),
    shipToCountryCode: firstDefined(line.shipToCountryCode, context.shipToCountryCode),
    servicePerformanceCountryCode: firstDefined(line.servicePerformanceCountryCode, context.servicePerformanceCountryCode),
    customerCountryCode: firstDefined(context.customerCountryCode, context.partnerCountryCode, partnerProfile?.tax_country_code),
    supplierCountryCode: firstDefined(context.supplierCountryCode, context.partnerCountryCode, partnerProfile?.tax_country_code),
    partnerTaxRegistered: partnerProfile?.is_tax_registered ?? partnerProfile?.partner_tax_registered ?? null,
    partnerTaxExempt: partnerProfile?.is_tax_exempt ?? partnerProfile?.partner_tax_exempt ?? null,
    fiscalClassificationCode: catalogProfile?.fiscal_classification_code || null,
    hsCode: catalogProfile?.hs_code || null,
  };
}

function getFact(facts, key) {
  if (!key.includes('.')) return facts[key];
  return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), facts);
}

function primitiveEquals(actual, expected) {
  if (actual == null || expected == null) return actual == expected; // eslint-disable-line eqeqeq
  if (typeof expected === 'boolean') return Boolean(actual) === expected;
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

function conditionMatches(actual, expected) {
  if (Array.isArray(expected)) return expected.some((value) => primitiveEquals(actual, value));
  if (expected && typeof expected === 'object') {
    if (Object.prototype.hasOwnProperty.call(expected, 'exists')) return expected.exists ? actual != null : actual == null;
    if (Array.isArray(expected.in)) return expected.in.some((value) => primitiveEquals(actual, value));
    if (Array.isArray(expected.notIn)) return !expected.notIn.some((value) => primitiveEquals(actual, value));
    if (Object.prototype.hasOwnProperty.call(expected, 'eq')) return primitiveEquals(actual, expected.eq);
    if (Object.prototype.hasOwnProperty.call(expected, 'neq')) return !primitiveEquals(actual, expected.neq);
    if (Object.prototype.hasOwnProperty.call(expected, 'gte') && Number(actual) < Number(expected.gte)) return false;
    if (Object.prototype.hasOwnProperty.call(expected, 'lte') && Number(actual) > Number(expected.lte)) return false;
    return true;
  }
  return primitiveEquals(actual, expected);
}

function conditionsMatch(conditions = {}, facts = {}) {
  return Object.entries(conditions || {}).every(([key, expected]) => conditionMatches(getFact(facts, key), expected));
}

function placeOfSupplyMatches(rule, facts) {
  if (!rule.place_of_supply_basis || !rule.jurisdiction_country_code) return true;
  const actual = {
    customer_location: facts.customerCountryCode || facts.placeOfSupplyCountryCode,
    supplier_location: facts.supplierCountryCode || facts.placeOfSupplyCountryCode,
    ship_to: facts.shipToCountryCode || facts.placeOfSupplyCountryCode,
    service_performance: facts.servicePerformanceCountryCode || facts.placeOfSupplyCountryCode,
  }[rule.place_of_supply_basis];
  if (!actual) return false;
  return String(actual).toUpperCase() === String(rule.jurisdiction_country_code).toUpperCase();
}

function ruleSpecificity(rule) {
  return [
    rule.document_type,
    rule.partner_type,
    rule.supply_type,
    rule.jurisdiction_id,
    rule.place_of_supply_basis,
  ].filter(Boolean).length + Object.keys(rule.conditions || {}).length;
}

function taxRuleGroup(rule = {}) {
  if (rule.rule_group) return String(rule.rule_group).toUpperCase();
  const type = String(rule.rule_tax_type || '').toUpperCase();
  if (['VAT', 'GST', 'SALES', 'SALES_TAX'].includes(type)) return type === 'SALES_TAX' ? 'SALES' : type;
  if (type === 'WITHHOLDING' || type === 'WHT') return 'WITHHOLDING';
  if (type === 'IMPORT') return 'IMPORT';
  return String(rule.rule_reporting_group || type || 'DEFAULT').toUpperCase();
}

async function getTaxCodeGroup({ client, orgId, taxCodeId }) {
  if (!taxCodeId) return null;
  const { rows } = await client.query(
    `SELECT tax_type, reporting_group FROM tax_codes WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, taxCodeId]
  );
  if (!rows.length) return null;
  return taxRuleGroup({ rule_tax_type: rows[0].tax_type, rule_reporting_group: rows[0].reporting_group });
}

async function findMatchingRules({ client, orgId, context = {}, partnerProfile = null, catalogProfile = null, line = {}, docDate = null }) {
  const params = [orgId];
  const where = [`tr.organization_id=$1`, `tr.status='active'`];
  let i = 2;

  if (docDate) {
    where.push(`tr.effective_from <= $${i}::date AND (tr.effective_to IS NULL OR tr.effective_to >= $${i}::date)`);
    params.push(docDate);
    i += 1;
  }

  const { rows } = await client.query(
    `SELECT tr.*, tj.country_code AS jurisdiction_country_code,
            tc.tax_type AS rule_tax_type, tc.reporting_group AS rule_reporting_group
       FROM tax_rules tr
       JOIN tax_codes tc ON tc.id=tr.tax_code_id AND tc.organization_id=tr.organization_id
       LEFT JOIN tax_jurisdictions tj ON tj.id=tr.jurisdiction_id
      WHERE ${where.join(' AND ')}
      ORDER BY tr.priority ASC, tr.effective_from DESC, tr.created_at DESC`,
    params
  );

  const facts = buildFacts({ context, line, partnerProfile, catalogProfile });
  const matches = rows.filter((rule) => {
    if (rule.document_type && rule.document_type !== facts.documentType) return false;
    if (rule.partner_type && rule.partner_type !== facts.partnerType) return false;
    if (rule.transaction_scope && rule.transaction_scope !== 'both' && rule.transaction_scope !== facts.transactionScope) return false;
    if (rule.jurisdiction_id && facts.jurisdictionId && rule.jurisdiction_id !== facts.jurisdictionId) return false;
    if (rule.jurisdiction_id && !facts.jurisdictionId && !placeOfSupplyMatches(rule, facts)) return false;
    if (rule.supply_type && rule.supply_type !== facts.supplyType) return false;
    if (!placeOfSupplyMatches(rule, facts)) return false;
    return conditionsMatch(rule.conditions || {}, facts);
  });

  matches.sort((a, b) => {
    const priority = Number(a.priority || 100) - Number(b.priority || 100);
    if (priority !== 0) return priority;
    const specificity = ruleSpecificity(b) - ruleSpecificity(a);
    if (specificity !== 0) return specificity;
    return String(a.code || a.id).localeCompare(String(b.code || b.id));
  });

  const selectedByGroup = new Map();
  for (const rule of matches) {
    const group = taxRuleGroup(rule);
    if (!selectedByGroup.has(group)) selectedByGroup.set(group, rule);
  }
  return [...selectedByGroup.values()];
}

async function findMatchingRule(args) {
  const rules = await findMatchingRules(args);
  return rules[0] || null;
}

function normalizeRecoveryBasis({ line = {}, catalogProfile = null }) {
  if (line.recoveryBasis) return String(line.recoveryBasis);
  if (line.inputTaxRecoveryMode) return String(line.inputTaxRecoveryMode);
  if (line.nonRecoverable === true || line.taxTreatment === 'non_recoverable') return 'direct_exempt';
  return catalogProfile?.purchase_recovery_mode || null;
}

function normalizeRecoverablePercent({ line = {}, partnerProfile = null, catalogProfile = null, settings = null, context = {} }) {
  if (line.recoverablePercentOverride != null) return String(line.recoverablePercentOverride);
  if (line.nonRecoverable === true || line.taxTreatment === 'non_recoverable') return '0';
  if (context.transactionScope !== 'purchases') return null;
  const basis = normalizeRecoveryBasis({ line, catalogProfile });
  // Directly exempt/not-applicable inputs cannot become recoverable merely because
  // a supplier profile carries a generic recovery override.
  if (basis === 'direct_exempt' || basis === 'not_applicable') return '0';
  if (partnerProfile?.recoverable_percent_override != null) return String(partnerProfile.recoverable_percent_override);
  if (catalogProfile?.default_recoverable_percent != null) return String(catalogProfile.default_recoverable_percent);
  if (basis === 'direct_taxable') return '1';
  if (basis === 'mixed') return String(settings?.mixed_input_provisional_percent ?? 0);
  return null;
}

function normalizeWithholdingRate({ line = {}, partnerProfile = null }) {
  if (line.withholdingRateOverride != null) return String(line.withholdingRateOverride);
  if (partnerProfile?.withholding_rate_override != null) return String(partnerProfile.withholding_rate_override);
  return null;
}

function catalogSelection({ catalogProfile, transactionScope }) {
  if (!catalogProfile) return null;
  const sales = transactionScope === 'sales';
  const taxCodeId = sales ? catalogProfile.sales_tax_code_id : catalogProfile.purchase_tax_code_id;
  const taxScope = sales ? catalogProfile.sales_tax_scope : catalogProfile.purchase_tax_scope;
  return { taxCodeId, taxScope };
}

async function determineTaxSelections({ client, orgId, line = {}, context = {} }) {
  if (Array.isArray(line.taxes) && line.taxes.length) return line.taxes.map((t) => ({ ...t }));

  const settings = await getTaxSettings({ client, orgId });
  const partnerProfile = await getPartnerTaxProfile({ client, orgId, partnerId: context.partnerId || null });
  const catalogProfile = await getCatalogTaxProfile({ client, orgId, line, docDate: context.documentDate || null });
  const recoveryBasis = normalizeRecoveryBasis({ line, catalogProfile });
  const recoverablePercent = normalizeRecoverablePercent({ line, partnerProfile, catalogProfile, settings, context });
  const withholdingRateOverride = normalizeWithholdingRate({ line, partnerProfile });
  const selections = [];

  const pushRuleSelection = (rule) => {
    if (!rule?.tax_code_id) return;
    selections.push({
      taxCodeId: rule.tax_code_id,
      sourceRuleId: rule.id || null,
      recoverablePercent,
      exemptionReasonCode: line.exemptionReasonCode || catalogProfile?.exemption_reason_code || partnerProfile?.exemption_reason_code || null,
      exemptionReason: line.exemptionReason || catalogProfile?.exemption_reason || partnerProfile?.exemption_reason || null,
      reverseCharge: line.reverseCharge === true || partnerProfile?.reverse_charge_applicable === true,
      metadata: {
        partnerTaxProfileId: partnerProfile?.id || null,
        taxProfileId: catalogProfile?.id || null,
        matchedRuleCode: rule.code || null,
        matchedRuleGroup: taxRuleGroup(rule),
        itemTaxCategory: line.itemTaxCategory || line.taxTreatment || catalogProfile?.tax_category || null,
        supplyType: line.supplyType || context.supplyType || catalogProfile?.supply_type || null,
        placeOfSupply: line.placeOfSupply || context.placeOfSupply || partnerProfile?.place_of_supply || null,
        recoveryBasis: context.transactionScope === 'purchases' ? (recoveryBasis || 'direct_taxable') : 'not_applicable'
      }
    });
  };

  if (line.taxCodeId) {
    selections.push({
      taxCodeId: line.taxCodeId,
      taxAmount: line.taxAmount,
      taxableAmount: line.taxableAmount,
      recoverablePercent: line.recoverablePercentOverride ?? recoverablePercent,
      reverseCharge: line.reverseCharge === true,
      exemptionReasonCode: line.exemptionReasonCode || null,
      exemptionReason: line.exemptionReason || null,
      metadata: {
        explicit: true,
        itemTaxCategory: line.itemTaxCategory || null,
        taxProfileId: catalogProfile?.id || line.taxProfileId || null,
        supplyType: line.supplyType || context.supplyType || catalogProfile?.supply_type || null,
        recoveryBasis: context.transactionScope === 'purchases' ? (recoveryBasis || 'direct_taxable') : 'not_applicable'
      }
    });
  } else {
    const catalog = catalogSelection({ catalogProfile, transactionScope: context.transactionScope });
    const explicitExempt = partnerProfile?.is_tax_exempt || partnerProfile?.partner_tax_exempt || line.taxTreatment === 'exempt';
    const matchingRules = await findMatchingRules({ client, orgId, context, partnerProfile, catalogProfile, line, docDate: context.documentDate || null });

    if (catalog?.taxCodeId) {
      const catalogGroup = await getTaxCodeGroup({ client, orgId, taxCodeId: catalog.taxCodeId });
      selections.push({
        taxCodeId: catalog.taxCodeId,
        recoverablePercent,
        exemptionReasonCode: line.exemptionReasonCode || catalogProfile?.exemption_reason_code || partnerProfile?.exemption_reason_code || null,
        exemptionReason: line.exemptionReason || catalogProfile?.exemption_reason || partnerProfile?.exemption_reason || null,
        reverseCharge: line.reverseCharge === true || partnerProfile?.reverse_charge_applicable === true,
        metadata: {
          taxProfileId: catalogProfile.id,
          taxProfileCode: catalogProfile.code,
          supplyType: line.supplyType || context.supplyType || catalogProfile.supply_type || null,
          taxCategory: catalogProfile.tax_category || null,
          taxScope: catalog.taxScope,
          fiscalClassificationCode: catalogProfile.fiscal_classification_code || null,
          hsCode: catalogProfile.hs_code || null,
          recoveryBasis: context.transactionScope === 'purchases' ? (recoveryBasis || 'direct_taxable') : 'not_applicable',
        }
      });
      // Catalog profiles choose the base treatment for their tax family. Other
      // matching statutory groups (for example a sector levy) can still stack.
      for (const rule of matchingRules) {
        if (taxRuleGroup(rule) !== catalogGroup) pushRuleSelection(rule);
      }
    } else if (matchingRules.length) {
      for (const rule of matchingRules) pushRuleSelection(rule);
    } else if (!explicitExempt) {
      const defaultTaxCodeId = context.transactionScope === 'sales'
        ? (line.salesTaxCodeId || partnerProfile?.sales_tax_code_id || partnerProfile?.default_tax_code_id || settings?.default_tax_code_id)
        : (line.purchaseTaxCodeId || partnerProfile?.purchase_tax_code_id || partnerProfile?.default_tax_code_id || settings?.default_tax_code_id);

      if (!defaultTaxCodeId) {
        if (settings?.enforce_partner_tax_profile) {
          throw new AppError(409, 'Tax profile is required to determine the applicable tax code for this partner/document');
        }
      } else {
        selections.push({
          taxCodeId: defaultTaxCodeId,
          sourceRuleId: null,
          recoverablePercent,
          exemptionReasonCode: line.exemptionReasonCode || partnerProfile?.exemption_reason_code || null,
          exemptionReason: line.exemptionReason || partnerProfile?.exemption_reason || null,
          reverseCharge: line.reverseCharge === true || partnerProfile?.reverse_charge_applicable === true,
          metadata: {
            partnerTaxProfileId: partnerProfile?.id || null,
            taxProfileId: catalogProfile?.id || null,
            itemTaxCategory: line.itemTaxCategory || line.taxTreatment || catalogProfile?.tax_category || null,
            supplyType: line.supplyType || context.supplyType || catalogProfile?.supply_type || null,
            placeOfSupply: line.placeOfSupply || context.placeOfSupply || partnerProfile?.place_of_supply || null,
            recoveryBasis: context.transactionScope === 'purchases' ? (recoveryBasis || 'direct_taxable') : 'not_applicable'
          }
        });
      }
    }
  }

  const shouldApplyWithholding =
    (context.transactionScope === 'purchases' || context.transactionScope === 'sales') &&
    (
      line.withholdingApplicable === true ||
      !!line.withholdingTaxCodeId ||
      partnerProfile?.withholding_applicable === true ||
      !!partnerProfile?.withholding_tax_code_id
    ) &&
    (line.withholdingTaxCodeId || partnerProfile?.withholding_tax_code_id);

  if (shouldApplyWithholding) {
    selections.push({
      taxCodeId: line.withholdingTaxCodeId || partnerProfile?.withholding_tax_code_id,
      sourceRuleId: null,
      recoverablePercent: 0,
      rateOverride: withholdingRateOverride,
      isWithholdingOverlay: true,
      metadata: {
        overlay: 'withholding',
        partnerTaxProfileId: partnerProfile?.id || null
      }
    });
  }

  const finalSelections = [];
  const byTaxCode = new Map();
  for (const selection of selections) {
    const existingIndex = byTaxCode.get(selection.taxCodeId);
    if (existingIndex === undefined) {
      byTaxCode.set(selection.taxCodeId, finalSelections.length);
      finalSelections.push(selection);
      continue;
    }
    const existing = finalSelections[existingIndex];
    if (selection.isWithholdingOverlay && !existing.isWithholdingOverlay) {
      finalSelections[existingIndex] = selection;
    }
  }
  return finalSelections;
}

module.exports = {
  round2,
  getPartnerTaxProfile,
  getTaxSettings,
  getCatalogTaxProfile,
  buildFacts,
  conditionsMatch,
  determineTaxSelections,
  findMatchingRule,
  findMatchingRules,
  taxRuleGroup
};
