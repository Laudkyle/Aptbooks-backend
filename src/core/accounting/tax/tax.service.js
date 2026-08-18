const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const journalIF = require("../../../interfaces/journalPosting.interface");
const periodIF = require("../../../interfaces/periodManagement.interface");
const { withTransaction } = require("../../../db/tx");
const documentableSvc = require("../../../workflow/documents/documentable.service");
const { propagateDocumentWorkflowToJournal } = require("../../../modules/transactions/_shared/workflowJournalAudit.service");
const { upsertTaxAdjustmentLedgerEntry } = require("../../../shared/tax/taxLedger");
const {
  FINANCIAL_SCALE,
  applyPercentagePointUnits,
  bigIntToDecimalString,
  parseDecimalRoundedToBigInt,
  parsePercentagePoints,
} = require("../../../shared/utils/money");

function normalizeTaxCodeRow(row) {
  if (!row) return row;
  return {
    ...row,
    taxType: row.tax_type ?? row.taxType ?? null,
    taxScope: row.tax_scope ?? row.taxScope ?? null,
    categoryCode: row.category_code ?? row.categoryCode ?? null,
    taxCategory: row.category_code ?? row.taxCategory ?? null,
    jurisdictionCode: row.jurisdiction_code ?? row.jurisdictionCode ?? null
  };
}

function normalizeTaxReturnConfigRow(row) {
  if (!row) return row;
  return {
    ...row,
    status: row.status ?? (row.is_enabled === false ? "inactive" : "active")
  };
}

function normalizeEinvoicingSettingsRow(row) {
  if (!row) return row;
  return {
    ...row,
    defaultScheme: row.defaultScheme ?? row.provider ?? null,
    sellerEndpointId: row.sellerEndpointId ?? row.api_endpoint ?? null,
    sellerSchemeId: row.sellerSchemeId ?? row.provider ?? null,
    transportProfile: row.transportProfile ?? (row.sandbox_mode ? "sandbox" : "production"),
    realtimeFilingEnabled: row.realtimeFilingEnabled ?? row.enabled ?? false
  };
}

function normalizeFilingAdapterRow(row) {
  if (!row) return row;
  return {
    ...row,
    adapterCode: row.adapter_code ?? row.adapterCode ?? null,
    jurisdictionCode: row.jurisdiction_code ?? row.country_code ?? row.jurisdictionCode ?? null,
    status: row.status ?? (row.is_installed ? "installed" : (row.is_active ? "available" : "inactive"))
  };
}

function normalizeCountryPackRow(row) {
  if (!row) return row;
  const status = row.status ?? (row.is_installed ? "installed" : (row.is_active ? "available" : "inactive"));
  return {
    id: row.id,
    countryCode: row.country_code ?? row.countryCode ?? null,
    jurisdictionCode: row.jurisdictionCode ?? row.country_code ?? null,
    packCode: row.pack_code ?? row.packCode ?? row.code ?? null,
    pack_code: row.pack_code ?? row.packCode ?? row.code ?? null,
    name: row.name ?? null,
    description: row.description ?? null,
    version: row.version_no ?? row.version ?? null,
    version_no: row.version_no ?? row.version ?? null,
    status,
    isActive: row.is_active ?? row.isActive ?? true,
    isInstalled: row.is_installed ?? row.isInstalled ?? false,
    is_installed: row.is_installed ?? row.isInstalled ?? false,
    installedAt: row.installed_at ?? row.installedAt ?? null,
    installedBy: row.installed_by ?? row.installedBy ?? null,
  };
}

function normalizeAutomationRuleRow(row) {
  if (!row) return row;
  return {
    ...row,
    triggerType: row.triggerType ?? row.trigger_code ?? null,
    status: row.status ?? (row.is_enabled ? "active" : "inactive")
  };
}

async function assertAccountBelongsToOrg({ orgId, accountId, fieldName }) {
  if (!accountId) return;
  const { rows } = await pool.query(
    `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId],
  );
  if (!rows.length)
    throw new AppError(400, `${fieldName} is invalid for this organization`);
}

async function assertTaxCodeBelongsToOrg({ orgId, taxCodeId }) {
  if (!taxCodeId) return;
  const { rows } = await pool.query(
    `SELECT id FROM tax_codes WHERE organization_id=$1 AND id=$2`,
    [orgId, taxCodeId],
  );
  if (!rows.length)
    throw new AppError(
      400,
      `defaultTaxCodeId is invalid for this organization`,
    );
}

async function assertJurisdictionBelongsToOrg({ orgId, jurisdictionId }) {
  if (!jurisdictionId) return;
  const { rows } = await pool.query(
    `SELECT id FROM tax_jurisdictions WHERE organization_id=$1 AND id=$2`,
    [orgId, jurisdictionId],
  );
  if (!rows.length)
    throw new AppError(400, `jurisdictionId is invalid for this organization`);
}

async function assertPartnerBelongsToOrg({ orgId, partnerId }) {
  if (!partnerId) return;
  const { rows } = await pool.query(
    `SELECT id FROM business_partners WHERE organization_id=$1 AND id=$2`,
    [orgId, partnerId],
  );
  if (!rows.length)
    throw new AppError(400, `partnerId is invalid for this organization`);
}

async function listJurisdictions({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_jurisdictions WHERE organization_id=$1 ORDER BY code`,
    [orgId],
  );
  return rows;
}

async function createJurisdiction({ orgId, payload }) {
  const { rows } = await pool.query(
    `INSERT INTO tax_jurisdictions(organization_id, code, name, country_code)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [orgId, payload.code, payload.name, payload.countryCode || null],
  );
  return rows[0];
}

async function updateJurisdiction({ orgId, jurisdictionId, payload }) {
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM tax_jurisdictions WHERE organization_id=$1 AND id=$2`,
    [orgId, jurisdictionId],
  );
  if (!beforeRows.length) throw new AppError(404, "Tax jurisdiction not found");
  const before = beforeRows[0];

  const columns = [];
  const params = [orgId, jurisdictionId];
  let i = 3;
  const map = {
    code: "code",
    name: "name",
    countryCode: "country_code",
  };
  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      params.push(payload[k] === "" ? null : payload[k]);
    }
  }
  if (!columns.length) return { before, after: before };

  const { rows } = await pool.query(
    `UPDATE tax_jurisdictions SET ${columns.join(", ")}
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    params,
  );

  return { before, after: rows[0] };
}

async function deleteJurisdiction({ orgId, jurisdictionId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_jurisdictions WHERE organization_id=$1 AND id=$2`,
    [orgId, jurisdictionId],
  );
  if (!rowCount) throw new AppError(404, "Tax jurisdiction not found");
  return { deleted: true };
}

async function getTaxRegistrationById({ orgId, registrationId }) {
  const { rows } = await pool.query(
    `SELECT tr.*, tj.code AS jurisdiction_code, tj.name AS jurisdiction_name
       FROM tax_registrations tr
       LEFT JOIN tax_jurisdictions tj ON tj.id = tr.jurisdiction_id
      WHERE tr.organization_id=$1 AND tr.id=$2`,
    [orgId, registrationId],
  );
  if (!rows.length) throw new AppError(404, "Tax registration not found");
  return rows[0];
}

async function listTaxRegistrations({ orgId, query }) {
  const params = [orgId];
  const where = ["tr.organization_id=$1"];
  let i = 2;
  if (query?.registrationType) {
    where.push(`tr.registration_type=$${i++}`);
    params.push(query.registrationType);
  }
  if (query?.jurisdictionId) {
    where.push(`tr.jurisdiction_id=$${i++}`);
    params.push(query.jurisdictionId);
  }
  if (query?.isPrimary !== undefined) {
    where.push(`tr.is_primary=$${i++}`);
    params.push(query.isPrimary === true || query.isPrimary === "true");
  }
  if (query?.activeOn) {
    where.push(`tr.effective_from <= $${i}`);
    params.push(query.activeOn);
    i += 1;
    where.push(`(tr.effective_to IS NULL OR tr.effective_to >= $${i})`);
    params.push(query.activeOn);
    i += 1;
  }
  const { rows } = await pool.query(
    `SELECT tr.*, tj.code AS jurisdiction_code, tj.name AS jurisdiction_name
       FROM tax_registrations tr
       LEFT JOIN tax_jurisdictions tj ON tj.id = tr.jurisdiction_id
      WHERE ${where.join(" AND ")}
      ORDER BY tr.is_primary DESC, tr.registration_type, tr.registration_no`,
    params,
  );
  return rows;
}

async function createTaxRegistration({ orgId, payload }) {
  await assertJurisdictionBelongsToOrg({
    orgId,
    jurisdictionId: payload.jurisdictionId || null,
  });

  return withTransaction(async (client) => {
    if (payload.isPrimary === true) {
      await client.query(
        `UPDATE tax_registrations SET is_primary=FALSE, updated_at=NOW()
          WHERE organization_id=$1 AND registration_type=COALESCE($2, 'VAT')`,
        [orgId, payload.registrationType || "VAT"],
      );
    }

    const { rows } = await client.query(
      `INSERT INTO tax_registrations(
         organization_id, jurisdiction_id, registration_no, registration_type, legal_entity_name,
         filing_frequency, filing_basis, effective_from, effective_to, is_primary, metadata
       ) VALUES (
         $1,$2,$3,COALESCE($4,'VAT'),$5,
         COALESCE($6,'monthly'),COALESCE($7,'invoice'),COALESCE($8,CURRENT_DATE),$9,COALESCE($10,FALSE),COALESCE($11,'{}'::jsonb)
       ) RETURNING *`,
      [
        orgId,
        payload.jurisdictionId || null,
        payload.registrationNumber,
        payload.registrationType || null,
        payload.legalEntityName ?? null,
        payload.filingFrequency ?? null,
        payload.filingBasis ?? null,
        payload.effectiveFrom || null,
        payload.effectiveTo ?? null,
        payload.isPrimary === true,
        JSON.stringify(payload.metadata || {}),
      ],
    );
    return rows[0];
  });
}

async function updateTaxRegistration({ orgId, registrationId, payload }) {
  const before = await getTaxRegistrationById({ orgId, registrationId });
  if (payload.jurisdictionId !== undefined) {
    await assertJurisdictionBelongsToOrg({
      orgId,
      jurisdictionId: payload.jurisdictionId,
    });
  }

  return withTransaction(async (client) => {
    const nextType = payload.registrationType ?? before.registration_type;
    if (payload.isPrimary === true) {
      await client.query(
        `UPDATE tax_registrations SET is_primary=FALSE, updated_at=NOW()
          WHERE organization_id=$1 AND registration_type=$2 AND id<>$3`,
        [orgId, nextType, registrationId],
      );
    }

    const columns = [];
    const params = [orgId, registrationId];
    let i = 3;
    const map = {
      jurisdictionId: "jurisdiction_id",
      registrationNumber: "registration_no",
      registrationType: "registration_type",
      legalEntityName: "legal_entity_name",
      filingFrequency: "filing_frequency",
      filingBasis: "filing_basis",
      effectiveFrom: "effective_from",
      effectiveTo: "effective_to",
      isPrimary: "is_primary",
    };
    for (const [k, col] of Object.entries(map)) {
      if (payload[k] !== undefined) {
        columns.push(`${col}=$${i++}`);
        params.push(payload[k] === "" ? null : payload[k]);
      }
    }
    if (payload.metadata !== undefined) {
      columns.push(`metadata=$${i++}`);
      params.push(JSON.stringify(payload.metadata || {}));
    }
    if (!columns.length) return { before, after: before };

    const { rows } = await client.query(
      `UPDATE tax_registrations
          SET ${columns.join(", ")}, updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      params,
    );
    return { before, after: rows[0] };
  });
}

async function deleteTaxRegistration({ orgId, registrationId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_registrations WHERE organization_id=$1 AND id=$2`,
    [orgId, registrationId],
  );
  if (!rowCount) throw new AppError(404, "Tax registration not found");
  return { deleted: true };
}

async function getTaxRuleById({ orgId, ruleId, client = pool }) {
  const { rows } = await client.query(
    `SELECT tr.*, tj.code AS jurisdiction_code, tj.name AS jurisdiction_name, tc.code AS tax_code_code, tc.name AS tax_code_name
       FROM tax_rules tr
       LEFT JOIN tax_jurisdictions tj ON tj.id = tr.jurisdiction_id
       JOIN tax_codes tc ON tc.id = tr.tax_code_id
      WHERE tr.organization_id=$1 AND tr.id=$2`,
    [orgId, ruleId],
  );
  if (!rows.length) throw new AppError(404, "Tax rule not found");
  return rows[0];
}

async function listTaxRules({ orgId, query }) {
  const params = [orgId];
  const where = ["tr.organization_id=$1"];
  let i = 2;
  if (query?.status) {
    where.push(`tr.status=$${i++}`);
    params.push(query.status);
  }
  if (query?.documentType) {
    where.push(`tr.document_type=$${i++}`);
    params.push(query.documentType);
  }
  if (query?.partnerType) {
    where.push(`tr.partner_type=$${i++}`);
    params.push(query.partnerType);
  }
  if (query?.supplyType) {
    where.push(`tr.supply_type=$${i++}`);
    params.push(query.supplyType);
  }
  if (query?.placeOfSupplyBasis) {
    where.push(`tr.place_of_supply_basis=$${i++}`);
    params.push(query.placeOfSupplyBasis);
  }
  if (query?.transactionScope) {
    where.push(`tr.transaction_scope=$${i++}`);
    params.push(query.transactionScope);
  }
  if (query?.jurisdictionId) {
    where.push(`tr.jurisdiction_id=$${i++}`);
    params.push(query.jurisdictionId);
  }
  if (query?.taxCodeId) {
    where.push(`tr.tax_code_id=$${i++}`);
    params.push(query.taxCodeId);
  }
  if (query?.activeOn) {
    where.push(`tr.effective_from <= $${i}`);
    params.push(query.activeOn);
    i += 1;
    where.push(`(tr.effective_to IS NULL OR tr.effective_to >= $${i})`);
    params.push(query.activeOn);
    i += 1;
  }

  const { rows } = await pool.query(
    `SELECT tr.*, tj.code AS jurisdiction_code, tj.name AS jurisdiction_name, tc.code AS tax_code_code, tc.name AS tax_code_name,
              COALESCE(tr.code, tr.name) AS rule_code
       FROM tax_rules tr
       LEFT JOIN tax_jurisdictions tj ON tj.id = tr.jurisdiction_id
       JOIN tax_codes tc ON tc.id = tr.tax_code_id
      WHERE ${where.join(" AND ")}
      ORDER BY tr.priority ASC, tr.name ASC, tr.created_at DESC`,
    params,
  );
  return rows;
}

async function createTaxRule({ orgId, payload }) {
  await assertJurisdictionBelongsToOrg({
    orgId,
    jurisdictionId: payload.jurisdictionId || null,
  });
  await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.taxCodeId });

  const { rows } = await pool.query(
    `INSERT INTO tax_rules(
        organization_id, code, name, rule_group, document_type, partner_type, supply_type, place_of_supply_basis, transaction_scope,
        jurisdiction_id, tax_code_id, priority, effective_from, effective_to, conditions, status
     ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'both'),
        $10,$11,COALESCE($12,100),COALESCE($13,CURRENT_DATE),$14,COALESCE($15,'{}'::jsonb),COALESCE($16,'active')
     )
     RETURNING *`,
    [
      orgId,
      payload.code || null,
      payload.name,
      payload.ruleGroup || null,
      payload.documentType || null,
      payload.partnerType || null,
      payload.supplyType || null,
      payload.placeOfSupplyBasis || null,
      payload.transactionScope || null,
      payload.jurisdictionId || null,
      payload.taxCodeId,
      payload.priority ?? null,
      payload.effectiveFrom || null,
      payload.effectiveTo ?? null,
      JSON.stringify(payload.conditions || {}),
      payload.status || null,
    ],
  );
  return rows[0];
}

async function updateTaxRule({ orgId, ruleId, payload }) {
  const before = await getTaxRuleById({ orgId, ruleId });
  if (payload.jurisdictionId !== undefined) {
    await assertJurisdictionBelongsToOrg({
      orgId,
      jurisdictionId: payload.jurisdictionId,
    });
  }
  if (payload.taxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.taxCodeId });
  }

  const columns = [];
  const params = [orgId, ruleId];
  let i = 3;
  const map = {
    code: "code",
    name: "name",
    ruleGroup: "rule_group",
    documentType: "document_type",
    partnerType: "partner_type",
    supplyType: "supply_type",
    placeOfSupplyBasis: "place_of_supply_basis",
    transactionScope: "transaction_scope",
    jurisdictionId: "jurisdiction_id",
    taxCodeId: "tax_code_id",
    priority: "priority",
    effectiveFrom: "effective_from",
    effectiveTo: "effective_to",
    status: "status",
  };
  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      params.push(payload[k] === "" ? null : payload[k]);
    }
  }
  if (payload.conditions !== undefined) {
    columns.push(`conditions=$${i++}`);
    params.push(JSON.stringify(payload.conditions || {}));
  }
  if (!columns.length) return { before, after: before };

  const { rows } = await pool.query(
    `UPDATE tax_rules
        SET ${columns.join(", ")}, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    params,
  );
  if (!rows.length) throw new AppError(404, "Tax rule not found");
  return { before, after: rows[0] };
}

async function deleteTaxRule({ orgId, ruleId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_rules WHERE organization_id=$1 AND id=$2`,
    [orgId, ruleId],
  );
  if (!rowCount) throw new AppError(404, "Tax rule not found");
  return { deleted: true };
}

// ==================== TAX CATALOG PROFILES ====================
async function getTaxCatalogProfileById({ orgId, profileId, client = pool }) {
  const { rows } = await client.query(
    `SELECT tcp.*,
            stc.code AS sales_tax_code, stc.name AS sales_tax_code_name,
            ptc.code AS purchase_tax_code, ptc.name AS purchase_tax_code_name
       FROM tax_catalog_profiles tcp
       LEFT JOIN tax_codes stc ON stc.id=tcp.sales_tax_code_id
       LEFT JOIN tax_codes ptc ON ptc.id=tcp.purchase_tax_code_id
      WHERE tcp.organization_id=$1 AND tcp.id=$2`,
    [orgId, profileId]
  );
  if (!rows.length) throw new AppError(404, 'Tax catalog profile not found');
  return rows[0];
}

async function listTaxCatalogProfiles({ orgId, query = {} }) {
  const params = [orgId];
  const where = ['tcp.organization_id=$1'];
  let i = 2;
  if (query.status) { where.push(`tcp.status=$${i++}`); params.push(query.status); }
  if (query.supplyType) { where.push(`tcp.supply_type=$${i++}`); params.push(query.supplyType); }
  if (query.taxCategory) { where.push(`tcp.tax_category=$${i++}`); params.push(query.taxCategory); }
  if (query.activeOn) {
    where.push(`tcp.effective_from <= $${i}::date AND (tcp.effective_to IS NULL OR tcp.effective_to >= $${i}::date)`);
    params.push(query.activeOn); i += 1;
  }
  const { rows } = await pool.query(
    `SELECT tcp.*,
            stc.code AS sales_tax_code, stc.name AS sales_tax_code_name,
            ptc.code AS purchase_tax_code, ptc.name AS purchase_tax_code_name,
            (SELECT COUNT(*)::int FROM inventory_items i WHERE i.organization_id=tcp.organization_id AND i.tax_profile_id=tcp.id) AS item_count
       FROM tax_catalog_profiles tcp
       LEFT JOIN tax_codes stc ON stc.id=tcp.sales_tax_code_id
       LEFT JOIN tax_codes ptc ON ptc.id=tcp.purchase_tax_code_id
      WHERE ${where.join(' AND ')}
      ORDER BY tcp.code`,
    params
  );
  return rows;
}

async function createTaxCatalogProfile({ orgId, payload }) {
  await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.salesTaxCodeId || null });
  await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.purchaseTaxCodeId || null });
  const { rows } = await pool.query(
    `INSERT INTO tax_catalog_profiles(
       organization_id, code, name, supply_type, tax_category,
       sales_tax_scope, purchase_tax_scope, sales_tax_code_id, purchase_tax_code_id,
       exemption_reason_code, exemption_reason, hs_code, fiscal_classification_code,
       purchase_recovery_mode, default_recoverable_percent, legal_reference,
       effective_from, effective_to, status, metadata
     ) VALUES($1,$2,$3,COALESCE($4,'goods'),$5,COALESCE($6,'taxable'),COALESCE($7,'taxable'),$8,$9,$10,$11,$12,$13,COALESCE($14,'direct_taxable'),$15,$16,COALESCE($17,CURRENT_DATE),$18,COALESCE($19,'active'),$20::jsonb)
     RETURNING *`,
    [
      orgId, payload.code, payload.name, payload.supplyType || null, payload.taxCategory || null,
      payload.salesTaxScope || null, payload.purchaseTaxScope || null,
      payload.salesTaxCodeId || null, payload.purchaseTaxCodeId || null,
      payload.exemptionReasonCode || null, payload.exemptionReason || null,
      payload.hsCode || null, payload.fiscalClassificationCode || null,
      payload.purchaseRecoveryMode || null, payload.defaultRecoverablePercent ?? null, payload.legalReference || null,
      payload.effectiveFrom || null, payload.effectiveTo || null, payload.status || null,
      JSON.stringify(payload.metadata || {})
    ]
  );
  return rows[0];
}

async function updateTaxCatalogProfile({ orgId, profileId, payload }) {
  const before = await getTaxCatalogProfileById({ orgId, profileId });
  if (payload.salesTaxCodeId !== undefined) await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.salesTaxCodeId });
  if (payload.purchaseTaxCodeId !== undefined) await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.purchaseTaxCodeId });
  const map = {
    code: 'code', name: 'name', supplyType: 'supply_type', taxCategory: 'tax_category',
    salesTaxScope: 'sales_tax_scope', purchaseTaxScope: 'purchase_tax_scope',
    salesTaxCodeId: 'sales_tax_code_id', purchaseTaxCodeId: 'purchase_tax_code_id',
    exemptionReasonCode: 'exemption_reason_code', exemptionReason: 'exemption_reason',
    hsCode: 'hs_code', fiscalClassificationCode: 'fiscal_classification_code',
    purchaseRecoveryMode: 'purchase_recovery_mode', defaultRecoverablePercent: 'default_recoverable_percent', legalReference: 'legal_reference',
    effectiveFrom: 'effective_from', effectiveTo: 'effective_to', status: 'status'
  };
  const sets = []; const params = [orgId, profileId]; let i = 3;
  for (const [key, col] of Object.entries(map)) {
    if (payload[key] !== undefined) { sets.push(`${col}=$${i++}`); params.push(payload[key] === '' ? null : payload[key]); }
  }
  if (payload.metadata !== undefined) { sets.push(`metadata=$${i++}::jsonb`); params.push(JSON.stringify(payload.metadata || {})); }
  if (!sets.length) return { before, after: before };
  const { rows } = await pool.query(
    `UPDATE tax_catalog_profiles SET ${sets.join(', ')}, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    params
  );
  return { before, after: rows[0] };
}

async function deleteTaxCatalogProfile({ orgId, profileId }) {
  const { rows: used } = await pool.query(`SELECT COUNT(*)::int AS count FROM inventory_items WHERE organization_id=$1 AND tax_profile_id=$2`, [orgId, profileId]);
  if ((used[0]?.count || 0) > 0) {
    const { rows } = await pool.query(`UPDATE tax_catalog_profiles SET status='inactive', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, profileId]);
    if (!rows.length) throw new AppError(404, 'Tax catalog profile not found');
    return { deleted: false, deactivated: true, profile: rows[0] };
  }
  const { rowCount } = await pool.query(`DELETE FROM tax_catalog_profiles WHERE organization_id=$1 AND id=$2`, [orgId, profileId]);
  if (!rowCount) throw new AppError(404, 'Tax catalog profile not found');
  return { deleted: true };
}

async function listTaxLedgerEntries({ orgId, query = {} }) {
  const params = [orgId];
  const where = ['tle.organization_id=$1'];
  let i = 2;
  for (const [key, col] of [['sourceType','source_type'],['taxType','tax_type'],['taxScope','tax_scope'],['direction','direction'],['taxCodeId','tax_code_id']]) {
    if (query[key]) { where.push(`tle.${col}=$${i++}`); params.push(query[key]); }
  }
  if (query.fromDate) { where.push(`tle.document_date >= $${i++}::date`); params.push(query.fromDate); }
  if (query.toDate) { where.push(`tle.document_date <= $${i++}::date`); params.push(query.toDate); }

  if (query.includeDraft !== true && query.includeDraft !== 'true') {
    where.push(`(
      (tle.source_type='invoice' AND EXISTS (SELECT 1 FROM invoices x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status IN ('issued','paid'))) OR
      (tle.source_type='bill' AND EXISTS (SELECT 1 FROM bills x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status IN ('issued','paid'))) OR
      (tle.source_type='credit_note' AND EXISTS (SELECT 1 FROM credit_notes x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status='issued')) OR
      (tle.source_type='debit_note' AND EXISTS (SELECT 1 FROM debit_notes x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status='issued')) OR
      (tle.source_type='pos_sale' AND EXISTS (SELECT 1 FROM pos_sales x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status IN ('completed','posted','partially_returned','returned','partially_refunded','refunded'))) OR
      (tle.source_type='pos_return' AND EXISTS (SELECT 1 FROM pos_return_authorizations x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status='received')) OR
      (tle.source_type IN ('expense','petty_cash','return') AND EXISTS (SELECT 1 FROM operational_documents x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.module_code=tle.source_type AND x.status='posted')) OR
      (tle.source_type='tax_adjustment' AND EXISTS (SELECT 1 FROM tax_adjustments x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status='posted')) OR
      (tle.source_type='imported_service' AND EXISTS (SELECT 1 FROM imported_service_transactions x WHERE x.organization_id=tle.organization_id AND x.id=tle.source_id AND x.status='posted'))
    )`);
  }

  const { rows } = await pool.query(
    `SELECT tle.*, tc.code AS tax_code, tc.name AS tax_code_name, bp.name AS partner_name,
            ROUND(tle.taxable_amount * tle.sign_factor,2)::text AS signed_taxable_amount,
            ROUND(tle.tax_amount * tle.sign_factor,2)::text AS signed_tax_amount,
            ROUND(tle.recoverable_amount * tle.sign_factor,2)::text AS signed_recoverable_amount,
            ROUND(tle.nonrecoverable_amount * tle.sign_factor,2)::text AS signed_nonrecoverable_amount
       FROM tax_ledger_entries tle
       LEFT JOIN tax_codes tc ON tc.id=tle.tax_code_id
       LEFT JOIN business_partners bp ON bp.id=tle.partner_id
      WHERE ${where.join(' AND ')}
      ORDER BY tle.document_date DESC, tle.document_no, tle.line_no, tle.created_at`,
    params
  );
  return rows;
}

async function listTaxCodes({ orgId, query }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;
  if (query?.status) {
    where.push(`status=$${i++}`);
    params.push(query.status);
  }
  if (query?.taxType) {
    where.push(`tax_type=$${i++}`);
    params.push(query.taxType);
  }
  if (query?.jurisdictionId) {
    where.push(`jurisdiction_id=$${i++}`);
    params.push(query.jurisdictionId);
  }

  const { rows } = await pool.query(
    `SELECT * FROM tax_codes WHERE ${where.join(" AND ")}
     ORDER BY code`,
    params,
  );
  return rows.map(normalizeTaxCodeRow);
}

async function createTaxCode({ orgId, payload }) {
  await assertJurisdictionBelongsToOrg({
    orgId,
    jurisdictionId: payload.jurisdictionId || null,
  });
  await assertAccountBelongsToOrg({
    orgId,
    accountId: payload.postingAccountId || null,
    fieldName: "postingAccountId",
  });

  const { rows } = await pool.query(
    `INSERT INTO tax_codes(
        organization_id, jurisdiction_id, code, name, tax_type, rate, is_compound,
        box_code, direction, category_code, tax_scope, application_scope, calculation_method, exemption_reason_code, exemption_reason, reverse_charge, recoverable_percent, reporting_group, posting_account_id,
        effective_from, effective_to, status
     ) VALUES (
        $1,$2,$3,$4,$5,$6,COALESCE($7,false),
        $8,$9,$10,COALESCE($11,'taxable'),COALESCE($12,'both'),COALESCE($13,'standard'),$14,$15,COALESCE($16,false),COALESCE($17,1),$18,$19,
        COALESCE($20,CURRENT_DATE),$21,COALESCE($22,'active')
     )
     RETURNING *`,
    [
      orgId,
      payload.jurisdictionId || null,
      payload.code,
      payload.name,
      payload.taxType === "WHT" ? "WITHHOLDING" : payload.taxType,
      payload.rate,
      payload.isCompound === true,
      payload.boxCode ?? null,
      payload.direction ?? null,
      payload.categoryCode ?? payload.taxCategory ?? null,
      payload.taxScope ??
        (payload.taxCategory === "zero_rated"
          ? "zero_rated"
          : payload.taxCategory === "exempt"
            ? "exempt"
            : payload.taxCategory === "reverse_charge"
              ? "reverse_charge"
              : payload.taxCategory === "withholding"
                ? "withholding"
                : null),
      payload.applicationScope ?? null,
      payload.calculationMethod ?? null,
      payload.exemptionReasonCode ?? null,
      payload.exemptionReason ?? null,
      payload.reverseCharge === true,
      payload.recoverablePercent ?? null,
      payload.reportingGroup ?? null,
      payload.postingAccountId ?? null,
      payload.effectiveFrom || null,
      payload.effectiveTo ?? null,
      payload.status || null,
    ],
  );
  return normalizeTaxCodeRow(rows[0]);
}

async function updateTaxCode({ orgId, taxCodeId, payload }) {
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM tax_codes WHERE organization_id=$1 AND id=$2`,
    [orgId, taxCodeId],
  );
  if (!beforeRows.length) throw new AppError(404, "Tax code not found");
  const before = beforeRows[0];

  if (payload.jurisdictionId !== undefined) {
    await assertJurisdictionBelongsToOrg({
      orgId,
      jurisdictionId: payload.jurisdictionId,
    });
  }
  if (payload.postingAccountId !== undefined) {
    await assertAccountBelongsToOrg({
      orgId,
      accountId: payload.postingAccountId,
      fieldName: "postingAccountId",
    });
  }

  const columns = [];
  const params = [orgId, taxCodeId];
  let i = 3;

  const map = {
    jurisdictionId: "jurisdiction_id",
    code: "code",
    name: "name",
    taxType: "tax_type",
    taxCategory: "category_code",
    rate: "rate",
    isCompound: "is_compound",
    boxCode: "box_code",
    direction: "direction",
    categoryCode: "category_code",
    taxScope: "tax_scope",
    applicationScope: "application_scope",
    calculationMethod: "calculation_method",
    exemptionReasonCode: "exemption_reason_code",
    exemptionReason: "exemption_reason",
    reverseCharge: "reverse_charge",
    recoverablePercent: "recoverable_percent",
    reportingGroup: "reporting_group",
    postingAccountId: "posting_account_id",
    effectiveFrom: "effective_from",
    effectiveTo: "effective_to",
    status: "status",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      params.push(payload[k] === "" ? null : payload[k]);
    }
  }

  if (!columns.length) return { before, after: before };

  const { rows } = await pool.query(
    `UPDATE tax_codes
     SET ${columns.join(", ")}, updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    params,
  );

  return { before, after: normalizeTaxCodeRow(rows[0]) };
}

async function deleteTaxCode({ orgId, taxCodeId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_codes WHERE organization_id=$1 AND id=$2`,
    [orgId, taxCodeId],
  );
  if (!rowCount) throw new AppError(404, "Tax code not found");
  return { deleted: true };
}

async function getTaxSettings({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_settings WHERE organization_id=$1`,
    [orgId],
  );
  if (!rows.length) {
    await pool.query(
      `INSERT INTO tax_settings(organization_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [orgId],
    );
    const { rows: r2 } = await pool.query(
      `SELECT * FROM tax_settings WHERE organization_id=$1`,
      [orgId],
    );
    return r2[0];
  }
  return rows[0];
}

async function setTaxSettings({ orgId, payload }) {
  if (payload.outputTaxAccountId !== undefined) {
    await assertAccountBelongsToOrg({
      orgId,
      accountId: payload.outputTaxAccountId,
      fieldName: "outputTaxAccountId",
    });
  }
  if (payload.inputTaxAccountId !== undefined) {
    await assertAccountBelongsToOrg({
      orgId,
      accountId: payload.inputTaxAccountId,
      fieldName: "inputTaxAccountId",
    });
  }
  if (payload.defaultTaxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.defaultTaxCodeId,
    });
  }
  for (const [fieldName, accountId] of Object.entries({
    nonRecoverableInputTaxAccountId: payload.nonRecoverableInputTaxAccountId,
    withholdingTaxPayableAccountId: payload.withholdingTaxPayableAccountId,
    withholdingTaxReceivableAccountId:
      payload.withholdingTaxReceivableAccountId,
    reverseChargeTaxAccountId: payload.reverseChargeTaxAccountId,
    vatWithholdingPayableAccountId: payload.vatWithholdingPayableAccountId,
    vatWithholdingReceivableAccountId: payload.vatWithholdingReceivableAccountId,
  })) {
    if (accountId !== undefined) {
      await assertAccountBelongsToOrg({ orgId, accountId, fieldName });
    }
  }

  const current = await getTaxSettings({ orgId });

  const out = {
    output_tax_account_id:
      payload.outputTaxAccountId ?? current.output_tax_account_id,
    input_tax_account_id:
      payload.inputTaxAccountId ?? current.input_tax_account_id,
    default_tax_code_id:
      payload.defaultTaxCodeId ?? current.default_tax_code_id,
    non_recoverable_input_tax_account_id:
      payload.nonRecoverableInputTaxAccountId ??
      current.non_recoverable_input_tax_account_id,
    withholding_tax_payable_account_id:
      payload.withholdingTaxPayableAccountId ??
      current.withholding_tax_payable_account_id,
    withholding_tax_receivable_account_id:
      payload.withholdingTaxReceivableAccountId ??
      current.withholding_tax_receivable_account_id,
    reverse_charge_tax_account_id:
      payload.reverseChargeTaxAccountId ??
      current.reverse_charge_tax_account_id,
    tax_rounding_strategy:
      (payload.taxRoundingStrategy === "total"
        ? "document"
        : payload.taxRoundingStrategy) ?? current.tax_rounding_strategy,
    enforce_partner_tax_profile:
      payload.enforcePartnerTaxProfile ?? current.enforce_partner_tax_profile,
    require_tax_jurisdiction:
      payload.requireTaxJurisdiction ?? current.require_tax_jurisdiction,
    mixed_input_provisional_percent:
      payload.mixedInputProvisionalPercent ?? current.mixed_input_provisional_percent ?? 0,
    gh_vat_goods_registration_threshold:
      payload.ghVatGoodsRegistrationThreshold ?? current.gh_vat_goods_registration_threshold ?? '750000.00',
    gh_vat_monitor_enabled:
      payload.ghVatMonitorEnabled ?? current.gh_vat_monitor_enabled ?? true,
    gh_vat_manual_goods_turnover:
      payload.ghVatManualGoodsTurnover ?? current.gh_vat_manual_goods_turnover ?? null,
    gh_vat_turnover_basis:
      payload.ghVatTurnoverBasis ?? current.gh_vat_turnover_basis ?? 'taxable_goods_rolling_12m',
    gh_income_wht_agent_enabled:
      payload.ghIncomeWhtAgentEnabled ?? current.gh_income_wht_agent_enabled ?? false,
    gh_vat_withholding_agent_enabled:
      payload.ghVatWithholdingAgentEnabled ?? current.gh_vat_withholding_agent_enabled ?? false,
    gh_wht_annual_threshold:
      payload.ghWhtAnnualThreshold ?? current.gh_wht_annual_threshold ?? '2000.00',
    gh_vat_withholding_rate:
      payload.ghVatWithholdingRate ?? current.gh_vat_withholding_rate ?? '7.000000',
    vat_withholding_payable_account_id:
      payload.vatWithholdingPayableAccountId ?? current.vat_withholding_payable_account_id ?? null,
    vat_withholding_receivable_account_id:
      payload.vatWithholdingReceivableAccountId ?? current.vat_withholding_receivable_account_id ?? null,
  };

  const { rows } = await pool.query(
    `UPDATE tax_settings
     SET output_tax_account_id=$2,
         input_tax_account_id=$3,
         default_tax_code_id=$4,
         non_recoverable_input_tax_account_id=$5,
         withholding_tax_payable_account_id=$6,
         withholding_tax_receivable_account_id=$7,
         reverse_charge_tax_account_id=$8,
         tax_rounding_strategy=$9,
         enforce_partner_tax_profile=$10,
         require_tax_jurisdiction=$11,
         mixed_input_provisional_percent=$12,
         gh_vat_goods_registration_threshold=$13,
         gh_vat_monitor_enabled=$14,
         gh_vat_manual_goods_turnover=$15,
         gh_vat_turnover_basis=$16,
         gh_income_wht_agent_enabled=$17,
         gh_vat_withholding_agent_enabled=$18,
         gh_wht_annual_threshold=$19,
         gh_vat_withholding_rate=$20,
         vat_withholding_payable_account_id=$21,
         vat_withholding_receivable_account_id=$22,
         updated_at=NOW()
     WHERE organization_id=$1
     RETURNING *`,
    [
      orgId,
      out.output_tax_account_id || null,
      out.input_tax_account_id || null,
      out.default_tax_code_id || null,
      out.non_recoverable_input_tax_account_id || null,
      out.withholding_tax_payable_account_id || null,
      out.withholding_tax_receivable_account_id || null,
      out.reverse_charge_tax_account_id || null,
      out.tax_rounding_strategy || "line",
      !!out.enforce_partner_tax_profile,
      !!out.require_tax_jurisdiction,
      out.mixed_input_provisional_percent,
      out.gh_vat_goods_registration_threshold,
      !!out.gh_vat_monitor_enabled,
      out.gh_vat_manual_goods_turnover,
      out.gh_vat_turnover_basis,
      !!out.gh_income_wht_agent_enabled,
      !!out.gh_vat_withholding_agent_enabled,
      out.gh_wht_annual_threshold,
      out.gh_vat_withholding_rate,
      out.vat_withholding_payable_account_id || null,
      out.vat_withholding_receivable_account_id || null,
    ],
  );

  return rows[0];
}

async function getTaxAdjustmentById({ orgId, adjustmentId, client = pool }) {
  const { rows } = await client.query(
    `SELECT * FROM tax_adjustments WHERE organization_id=$1 AND id=$2`,
    [orgId, adjustmentId],
  );
  return rows[0] || null;
}

async function listTaxAdjustments({ orgId, query = {} }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;
  if (query.status) {
    where.push(`status=$${i++}`);
    params.push(query.status);
  }
  if (query.taxType) {
    where.push(`tax_type=$${i++}`);
    params.push(query.taxType);
  }
  if (query.direction) {
    where.push(`direction=$${i++}`);
    params.push(query.direction);
  }
  if (query.fromDate) {
    where.push(`adjustment_date >= $${i++}`);
    params.push(query.fromDate);
  }
  if (query.toDate) {
    where.push(`adjustment_date <= $${i++}`);
    params.push(query.toDate);
  }

  const { rows } = await pool.query(
    `SELECT * FROM tax_adjustments WHERE ${where.join(" AND ")} ORDER BY adjustment_date DESC, created_at DESC`,
    params,
  );
  return rows;
}

async function createTaxAdjustment({ orgId, actorUserId, payload }) {
  if (payload.accountId !== undefined) {
    await assertAccountBelongsToOrg({
      orgId,
      accountId: payload.accountId,
      fieldName: "accountId",
    });
  }
  if (payload.counterAccountId !== undefined) {
    await assertAccountBelongsToOrg({
      orgId,
      accountId: payload.counterAccountId,
      fieldName: "counterAccountId",
    });
  }

  const { rows } = await pool.query(
    `
    INSERT INTO tax_adjustments(
      organization_id, adjustment_date, tax_type, direction, box_code, description,
      amount, account_id, counter_account_id, reference, created_by, updated_by, status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,'draft')
    RETURNING *
    `,
    [
      orgId,
      payload.adjustmentDate,
      payload.taxType || "VAT",
      payload.direction,
      payload.boxCode || null,
      payload.description,
      payload.amount,
      payload.accountId || null,
      payload.counterAccountId || null,
      payload.reference || null,
      actorUserId || null,
    ],
  );

  const created = rows[0];
  if (payload.autoPost) {
    return postTaxAdjustment({ orgId, actorUserId, adjustmentId: created.id });
  }
  return created;
}

async function postTaxAdjustment({ orgId, actorUserId, adjustmentId }) {
  return withTransaction(async (client) => {
    const adj = await getTaxAdjustmentById({ orgId, adjustmentId, client });
    if (!adj) throw new AppError(404, "Tax adjustment not found");
    if (adj.status !== "draft")
      throw new AppError(409, "Only draft tax adjustments can be posted");

    const settings = await getTaxSettings({ orgId });
    const taxAccountId =
      adj.account_id ||
      (adj.direction === "output"
        ? settings.output_tax_account_id
        : settings.input_tax_account_id);
    if (!taxAccountId) {
      throw new AppError(
        409,
        `No ${adj.direction} tax account configured and adjustment has no explicit accountId`,
      );
    }
    if (!adj.counter_account_id) {
      throw new AppError(
        409,
        "counterAccountId is required before posting a tax adjustment",
      );
    }

    const period = await periodIF.findOpenPeriodForDate({
      orgId,
      date: adj.adjustment_date,
      client,
    });
    const amount = Number(adj.amount || 0);
    const isOutput = adj.direction === "output";
    const lines = [
      {
        accountId: adj.counter_account_id,
        debit: isOutput ? amount : 0,
        credit: isOutput ? 0 : amount,
        description: adj.description,
      },
      {
        accountId: taxAccountId,
        debit: isOutput ? 0 : amount,
        credit: isOutput ? amount : 0,
        description: `${adj.description} (tax)`,
      },
    ];

    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      client,
      payload: {
        periodId: period.id,
        entryDate: adj.adjustment_date,
        typeCode: "GENERAL",
        memo: `Tax adjustment ${adj.description}`,
        idempotencyKey: `tax-adjustment:${adj.id}:post`,
        lines,
      },
    });

    const posted = await journalIF.postDraftJournal({
      orgId,
      journalId: draft.journalId,
      actorUserId,
      client,
    });

    const { rows } = await client.query(
      `
      UPDATE tax_adjustments
         SET status='posted',
             journal_entry_id=$3,
             posted_at=NOW(),
             posted_by=$4,
             updated_by=$4,
             updated_at=NOW()
       WHERE organization_id=$1 AND id=$2
       RETURNING *
      `,
      [
        orgId,
        adjustmentId,
        posted.journalId || posted.id || posted.journal_id,
        actorUserId,
      ],
    );
    await upsertTaxAdjustmentLedgerEntry({ client, adjustment: rows[0] });
    return rows[0];
  });
}

async function voidTaxAdjustment({ orgId, actorUserId, adjustmentId, reason }) {
  return withTransaction(async (client) => {
    const adj = await getTaxAdjustmentById({ orgId, adjustmentId, client });
    if (!adj) throw new AppError(404, "Tax adjustment not found");
    if (adj.status === "voided") return adj;
    if (adj.journal_entry_id) {
      await journalIF.voidPostedJournal({
        orgId,
        journalId: adj.journal_entry_id,
        actorUserId,
        reason,
        client,
      });
    }
    const { rows } = await client.query(
      `
      UPDATE tax_adjustments
         SET status='voided',
             void_reason=$3,
             voided_at=NOW(),
             voided_by=$4,
             updated_by=$4,
             updated_at=NOW()
       WHERE organization_id=$1 AND id=$2
       RETURNING *
      `,
      [orgId, adjustmentId, reason || null, actorUserId],
    );
    return rows[0];
  });
}

async function listTaxCodeComponents({ orgId, taxCodeId, client = pool }) {
  const { rows } = await client.query(
    `SELECT tcc.*, tc.code AS component_code, tc.name AS component_name, tc.tax_type, tc.rate AS component_rate, tc.direction, tc.box_code
       FROM tax_code_components tcc
       JOIN tax_codes tc ON tc.id = tcc.component_tax_code_id
      WHERE tcc.organization_id=$1 AND tcc.parent_tax_code_id=$2
      ORDER BY tcc.sequence_no, tc.code`,
    [orgId, taxCodeId],
  );
  return rows;
}

async function setTaxCodeComponents({ orgId, taxCodeId, payload }) {
  await assertTaxCodeBelongsToOrg({ orgId, taxCodeId });
  for (const c of payload.components || []) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: c.componentTaxCodeId });
    if (c.componentTaxCodeId === taxCodeId)
      throw new AppError(
        400,
        "A tax code cannot include itself as a component",
      );
  }
  return withTransaction(async (client) => {
    await client.query(
      `DELETE FROM tax_code_components WHERE organization_id=$1 AND parent_tax_code_id=$2`,
      [orgId, taxCodeId],
    );
    let seq = 1;
    for (const c of payload.components || []) {
      await client.query(
        `INSERT INTO tax_code_components(organization_id, parent_tax_code_id, component_tax_code_id, sequence_no, rate_override)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          orgId,
          taxCodeId,
          c.componentTaxCodeId,
          c.sequenceNo || seq++,
          c.rateOverride == null ? null : c.rateOverride,
        ],
      );
    }
    await client.query(
      `UPDATE tax_codes SET is_compound = CASE WHEN EXISTS (SELECT 1 FROM tax_code_components WHERE organization_id=$1 AND parent_tax_code_id=$2) THEN TRUE ELSE is_compound END, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, taxCodeId],
    );
    return listTaxCodeComponents({ orgId, taxCodeId, client });
  });
}

// ==================== PARTNER TAX PROFILES ====================

async function listPartnerTaxProfiles({ orgId, query = {} }) {
  const params = [orgId];
  const where = ["tpp.organization_id=$1"];
  let i = 2;

  if (query.partnerId) {
    where.push(`tpp.partner_id=$${i++}`);
    params.push(query.partnerId);
  }
  if (query.taxClass) {
    where.push(`tpp.tax_class=$${i++}`);
    params.push(query.taxClass);
  }
  if (query.isTaxRegistered !== undefined) {
    where.push(`tpp.is_tax_registered=$${i++}`);
    params.push(
      query.isTaxRegistered === true || query.isTaxRegistered === "true",
    );
  }
  if (query.isTaxExempt !== undefined) {
    where.push(`tpp.is_tax_exempt=$${i++}`); // ← Add tpp. prefix
    params.push(query.isTaxExempt === true || query.isTaxExempt === "true");
  }
  if (query.jurisdictionId) {
    where.push(`tpp.jurisdiction_id=$${i++}`); // ← Add tpp. prefix
    params.push(query.jurisdictionId);
  }

  const { rows } = await pool.query(
    `SELECT tpp.*,
            bp.name AS partner_name,
            bp.type AS partner_type,
            bp.code AS partner_code,
            COALESCE(tpp.legal_name, bp.name) AS partner_legal_entity_name,
            json_build_object('id', bp.id, 'name', bp.name, 'type', bp.type, 'code', bp.code, 'legal_entity_name', COALESCE(tpp.legal_name, bp.name)) AS partner
       FROM tax_partner_profiles tpp
       JOIN business_partners bp ON bp.id = tpp.partner_id AND bp.organization_id = tpp.organization_id
     WHERE ${where.join(" AND ")}
     ORDER BY tpp.created_at DESC`,
    params,
  );
  return rows;
}

async function getPartnerTaxProfile({ orgId, profileId }) {
  const { rows } = await pool.query(
    `SELECT tpp.*,
            bp.name AS partner_name,
            bp.type AS partner_type,
            bp.code AS partner_code,
            COALESCE(tpp.legal_name, bp.name) AS partner_legal_entity_name,
            json_build_object('id', bp.id, 'name', bp.name, 'type', bp.type, 'code', bp.code, 'legal_entity_name', COALESCE(tpp.legal_name, bp.name)) AS partner
       FROM tax_partner_profiles tpp
       JOIN business_partners bp ON bp.id = tpp.partner_id AND bp.organization_id = tpp.organization_id
     WHERE tpp.organization_id=$1 AND tpp.id=$2`,
    [orgId, profileId],
  );
  if (!rows.length) throw new AppError(404, "Partner tax profile not found");
  return rows[0];
}

async function createPartnerTaxProfile({ orgId, actorUserId, payload }) {
  await assertPartnerBelongsToOrg({ orgId, partnerId: payload.partnerId });
  if (payload.defaultTaxCodeId) {
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.defaultTaxCodeId,
    });
  }
  if (payload.purchaseTaxCodeId) {
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.purchaseTaxCodeId,
    });
  }
  if (payload.salesTaxCodeId) {
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.salesTaxCodeId,
    });
  }
  if (payload.withholdingTaxCodeId) {
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.withholdingTaxCodeId,
    });
  }
  if (payload.jurisdictionId) {
    await assertJurisdictionBelongsToOrg({
      orgId,
      jurisdictionId: payload.jurisdictionId,
    });
  }

  const { rows } = await pool.query(
    `INSERT INTO tax_partner_profiles(
      organization_id, partner_id, tax_registration_no, legal_name, tax_class,
      default_tax_code_id, purchase_tax_code_id, sales_tax_code_id,
      jurisdiction_id, place_of_supply, is_tax_registered, is_tax_exempt,
      exemption_reason_code, exemption_reason, reverse_charge_applicable,
      withholding_applicable, withholding_tax_code_id, recoverable_percent_override,
      certificate_reference, certificate_expiry, metadata,
      withholding_rate_override, withholding_certificate_no,
      filing_contact_email, customer_tax_identifier_type, vendor_tax_identifier_type,
      input_tax_recovery_mode, destination_country_code, registration_status,
      e_invoice_network, e_invoice_endpoint, residency_status, economic_activity_code,
      created_by, updated_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$34
    ) RETURNING *`,
    [
      orgId,
      payload.partnerId,
      payload.taxRegistrationNo || null,
      payload.legalName || null,
      payload.taxClass || "standard",
      payload.defaultTaxCodeId || null,
      payload.purchaseTaxCodeId || null,
      payload.salesTaxCodeId || null,
      payload.jurisdictionId || null,
      payload.placeOfSupply || null,
      payload.isTaxRegistered === true,
      payload.isTaxExempt === true,
      payload.exemptionReasonCode || null,
      payload.exemptionReason || null,
      payload.reverseChargeApplicable === true,
      payload.withholdingApplicable === true,
      payload.withholdingTaxCodeId || null,
      payload.recoverablePercentOverride ?? null,
      payload.certificateReference || null,
      payload.certificateExpiry || null,
      JSON.stringify(payload.metadata || {}),
      payload.withholdingRateOverride ?? null,
      payload.withholdingCertificateNo || null,
      payload.filingContactEmail || null,
      payload.customerTaxIdentifierType || null,
      payload.vendorTaxIdentifierType || null,
      payload.inputTaxRecoveryMode || "default",
      payload.destinationCountryCode || null,
      payload.registrationStatus || "registered",
      payload.eInvoiceNetwork || null,
      payload.eInvoiceEndpoint || null,
      payload.residencyStatus || null,
      payload.economicActivityCode || null,
      actorUserId || null,
    ],
  );
  await pool.query(
    `UPDATE tax_partner_profiles
        SET withholding_exempt=$3,
            withholding_exemption_reference=$4,
            withholding_exemption_expiry=$5,
            default_withholding_category=$6,
            vat_withholding_eligible=$7,
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2`,
    [
      orgId,
      rows[0].id,
      payload.withholdingExempt === true,
      payload.withholdingExemptionReference || null,
      payload.withholdingExemptionExpiry || null,
      payload.defaultWithholdingCategory || null,
      payload.vatWithholdingEligible !== false,
    ],
  );
  return getPartnerTaxProfile({ orgId, profileId: rows[0].id });
}

async function updatePartnerTaxProfile({
  orgId,
  profileId,
  payload,
  actorUserId,
}) {
  await getPartnerTaxProfile({ orgId, profileId });

  if (payload.defaultTaxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.defaultTaxCodeId,
    });
  }
  if (payload.purchaseTaxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.purchaseTaxCodeId,
    });
  }
  if (payload.salesTaxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.salesTaxCodeId,
    });
  }
  if (payload.withholdingTaxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.withholdingTaxCodeId,
    });
  }
  if (payload.jurisdictionId !== undefined) {
    await assertJurisdictionBelongsToOrg({
      orgId,
      jurisdictionId: payload.jurisdictionId,
    });
  }

  const columns = [];
  const params = [orgId, profileId];
  let i = 3;

  const map = {
    taxRegistrationNo: "tax_registration_no",
    legalName: "legal_name",
    taxClass: "tax_class",
    defaultTaxCodeId: "default_tax_code_id",
    purchaseTaxCodeId: "purchase_tax_code_id",
    salesTaxCodeId: "sales_tax_code_id",
    jurisdictionId: "jurisdiction_id",
    placeOfSupply: "place_of_supply",
    isTaxRegistered: "is_tax_registered",
    isTaxExempt: "is_tax_exempt",
    exemptionReasonCode: "exemption_reason_code",
    exemptionReason: "exemption_reason",
    reverseChargeApplicable: "reverse_charge_applicable",
    withholdingApplicable: "withholding_applicable",
    withholdingTaxCodeId: "withholding_tax_code_id",
    recoverablePercentOverride: "recoverable_percent_override",
    certificateReference: "certificate_reference",
    certificateExpiry: "certificate_expiry",
    withholdingRateOverride: "withholding_rate_override",
    withholdingCertificateNo: "withholding_certificate_no",
    filingContactEmail: "filing_contact_email",
    customerTaxIdentifierType: "customer_tax_identifier_type",
    vendorTaxIdentifierType: "vendor_tax_identifier_type",
    inputTaxRecoveryMode: "input_tax_recovery_mode",
    destinationCountryCode: "destination_country_code",
    registrationStatus: "registration_status",
    eInvoiceNetwork: "e_invoice_network",
    eInvoiceEndpoint: "e_invoice_endpoint",
    residencyStatus: "residency_status",
    economicActivityCode: "economic_activity_code",
    withholdingExempt: "withholding_exempt",
    withholdingExemptionReference: "withholding_exemption_reference",
    withholdingExemptionExpiry: "withholding_exemption_expiry",
    defaultWithholdingCategory: "default_withholding_category",
    vatWithholdingEligible: "vat_withholding_eligible",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      params.push(payload[k] === "" ? null : payload[k]);
    }
  }

  if (payload.metadata !== undefined) {
    columns.push(`metadata=$${i++}`);
    params.push(JSON.stringify(payload.metadata || {}));
  }

  if (!columns.length) {
    return getPartnerTaxProfile({ orgId, profileId });
  }

  columns.push(`updated_by=$${i++}`);
  params.push(actorUserId || null);
  columns.push(`updated_at=NOW()`);

  const { rows } = await pool.query(
    `UPDATE tax_partner_profiles
     SET ${columns.join(", ")}
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    params,
  );

  return rows[0];
}

async function deletePartnerTaxProfile({ orgId, profileId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_partner_profiles WHERE organization_id=$1 AND id=$2`,
    [orgId, profileId],
  );
  if (!rowCount) throw new AppError(404, "Partner tax profile not found");
  return { deleted: true };
}

// ==================== TAX RETURN TEMPLATES ====================

async function listTaxReturnTemplates({ orgId, query = {} }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;

  if (query.taxType) {
    where.push(`tax_type=$${i++}`);
    params.push(query.taxType);
  }

  const { rows } = await pool.query(
    `SELECT * FROM tax_return_templates
     WHERE ${where.join(" AND ")}
     ORDER BY tax_type, code`,
    params,
  );
  return rows.map((row) => ({ ...row, description: null, is_active: true }));
}

async function getTaxReturnTemplate({ orgId, templateId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_return_templates
     WHERE organization_id=$1 AND id=$2`,
    [orgId, templateId],
  );
  if (!rows.length) throw new AppError(404, "Tax return template not found");

  const { rows: boxes } = await pool.query(
    `SELECT * FROM tax_return_template_boxes
     WHERE template_id=$1
     ORDER BY sort_order`,
    [templateId],
  );

  return {
    ...rows[0],
    description: null,
    is_active: true,
    boxes: boxes.map((box) => ({
      ...box,
      calculation_formula: null,
      is_required: false,
    })),
  };
}

async function createTaxReturnTemplate({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO tax_return_templates(
        organization_id, tax_type, code, name
      ) VALUES ($1,$2,$3,$4)
      RETURNING *`,
      [orgId, payload.taxType || "VAT", payload.code, payload.name],
    );

    const template = rows[0];

    if (payload.boxes && Array.isArray(payload.boxes)) {
      for (const box of payload.boxes) {
        await client.query(
          `INSERT INTO tax_return_template_boxes(
            template_id, box_code, label, sort_order, direction
          ) VALUES ($1,$2,$3,$4,$5)`,
          [
            template.id,
            box.boxCode,
            box.label,
            box.sortOrder || 0,
            box.direction || null,
          ],
        );
      }
    }

    return getTaxReturnTemplate({ orgId, templateId: template.id });
  });
}

async function updateTaxReturnTemplate({
  orgId,
  templateId,
  payload,
  actorUserId,
}) {
  return withTransaction(async (client) => {
    const columns = [];
    const params = [orgId, templateId];
    let i = 3;

    const map = {
      taxType: "tax_type",
      code: "code",
      name: "name",
    };

    for (const [k, col] of Object.entries(map)) {
      if (payload[k] !== undefined) {
        columns.push(`${col}=$${i++}`);
        params.push(payload[k]);
      }
    }

    if (columns.length) {
      await client.query(
        `UPDATE tax_return_templates
         SET ${columns.join(", ")}
         WHERE organization_id=$1 AND id=$2`,
        params,
      );
    }

    if (payload.boxes !== undefined) {
      await client.query(
        `DELETE FROM tax_return_template_boxes WHERE template_id=$1`,
        [templateId],
      );
      for (const box of payload.boxes || []) {
        await client.query(
          `INSERT INTO tax_return_template_boxes(
            template_id, box_code, label, sort_order, direction
          ) VALUES ($1,$2,$3,$4,$5)`,
          [
            templateId,
            box.boxCode,
            box.label,
            box.sortOrder || 0,
            box.direction || null,
          ],
        );
      }
    }

    return getTaxReturnTemplate({ orgId, templateId });
  });
}

async function deleteTaxReturnTemplate({ orgId, templateId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_return_templates WHERE organization_id=$1 AND id=$2`,
    [orgId, templateId],
  );
  if (!rowCount) throw new AppError(404, "Tax return template not found");
  return { deleted: true };
}

// ==================== TAX RETURNS ====================

async function listTaxReturns({ orgId, query = {} }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;

  if (query.status) {
    where.push(`status=$${i++}`);
    params.push(query.status);
  }
  if (query.taxType) {
    where.push(`tax_type=$${i++}`);
    params.push(query.taxType);
  }
  if (query.fromDate) {
    where.push(`from_date >= $${i++}`);
    params.push(query.fromDate);
  }
  if (query.toDate) {
    where.push(`to_date <= $${i++}`);
    params.push(query.toDate);
  }
  if (query.jurisdictionId) {
    where.push(`jurisdiction_id=$${i++}`);
    params.push(query.jurisdictionId);
  }

  const { rows } = await pool.query(
    `SELECT * FROM tax_returns
     WHERE ${where.join(" AND ")}
     ORDER BY to_date DESC, created_at DESC`,
    params,
  );
  return rows;
}

async function getTaxReturn({ orgId, returnId }) {
  const { rows } = await pool.query(
    `SELECT tr.*, tj.code AS jurisdiction_code, tj.name AS jurisdiction_name
     FROM tax_returns tr
     LEFT JOIN tax_jurisdictions tj ON tj.id = tr.jurisdiction_id
     WHERE tr.organization_id=$1 AND tr.id=$2`,
    [orgId, returnId],
  );
  if (!rows.length) throw new AppError(404, "Tax return not found");
  return rows[0];
}

async function createTaxReturn({ orgId, actorUserId, payload }) {
  if (payload.templateId) {
    await getTaxReturnTemplate({ orgId, templateId: payload.templateId });
  }
  if (payload.jurisdictionId) {
    await assertJurisdictionBelongsToOrg({
      orgId,
      jurisdictionId: payload.jurisdictionId,
    });
  }

  const seedPayload = {};
  if (payload.dueDate) seedPayload.dueDate = payload.dueDate;

  const { rows } = await pool.query(
    `INSERT INTO tax_returns(
      organization_id, tax_type, from_date, to_date,
      template_id, jurisdiction_id, filing_adapter_code, status,
      payload_json, created_by, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8::jsonb,$9,NOW())
    RETURNING *`,
    [
      orgId,
      payload.taxType || "VAT",
      payload.filingPeriodStart,
      payload.filingPeriodEnd,
      payload.templateId || null,
      payload.jurisdictionId || null,
      payload.filingAdapterCode || null,
      JSON.stringify(seedPayload),
      actorUserId || null,
    ],
  );
  return rows[0];
}

async function submitTaxReturn({ orgId, returnId, payload, actorUserId }) {
  const taxReturn = await getTaxReturn({ orgId, returnId });

  if (taxReturn.status !== "draft") {
    throw new AppError(409, "Only draft tax returns can be submitted");
  }

  const nextPayload = {
    ...(taxReturn.payload_json || {}),
    filingData: payload.filingData || {},
  };

  const { rows } = await pool.query(
    `UPDATE tax_returns
     SET status='submitted',
         submitted_at=NOW(),
         filing_adapter_code=COALESCE($3, filing_adapter_code),
         payload_json=$4::jsonb,
         updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [
      orgId,
      returnId,
      payload.filingAdapterCode || null,
      JSON.stringify(nextPayload),
    ],
  );

  return rows[0];
}

async function getTaxReturnConfig({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_return_config WHERE organization_id=$1`,
    [orgId],
  );
  if (!rows.length) {
    const { rows: inserted } = await pool.query(
      `INSERT INTO tax_return_config(organization_id) VALUES ($1) RETURNING *`,
      [orgId],
    );
    return normalizeTaxReturnConfigRow(inserted[0]);
  }
  return normalizeTaxReturnConfigRow(rows[0]);
}

async function updateTaxReturnConfig({ orgId, payload, actorUserId }) {
  await getTaxReturnConfig({ orgId });

  const columns = [];
  const params = [orgId];
  let i = 2;
  const map = {
    defaultTemplateId: "default_template_id",
    autoSubmitEnabled: "auto_submit_enabled",
    notificationEmail: "notification_email",
    filingMethod: "filing_method",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      params.push(payload[k] === "" ? null : payload[k]);
    }
  }

  columns.push(`updated_by=$${i++}`);
  params.push(actorUserId || null);
  columns.push(`updated_at=NOW()`);

  const { rows } = await pool.query(
    `UPDATE tax_return_config
     SET ${columns.join(", ")}
     WHERE organization_id=$1
     RETURNING *`,
    params,
  );
  return normalizeTaxReturnConfigRow(rows[0]);
}

// ==================== E-INVOICING ====================

async function getEinvoicingSettings({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM einvoicing_settings WHERE organization_id=$1`,
    [orgId],
  );
  if (!rows.length) {
    const { rows: inserted } = await pool.query(
      `INSERT INTO einvoicing_settings(organization_id) VALUES ($1) RETURNING *`,
      [orgId],
    );
    return normalizeEinvoicingSettingsRow(inserted[0]);
  }
  return normalizeEinvoicingSettingsRow(rows[0]);
}

async function updateEinvoicingSettings({ orgId, payload, actorUserId }) {
  await getEinvoicingSettings({ orgId });

  const normalizedPayload = {
    ...payload,
    provider: payload.provider ?? payload.defaultScheme,
    apiEndpoint: payload.apiEndpoint ?? payload.sellerEndpointId,
    sandboxMode: payload.sandboxMode ?? (payload.transportProfile ? payload.transportProfile === "sandbox" : undefined),
    enabled: payload.enabled ?? payload.realtimeFilingEnabled
  };

  const columns = [];
  const params = [orgId];
  let i = 2;
  const map = {
    enabled: "enabled",
    provider: "provider",
    apiEndpoint: "api_endpoint",
    apiKey: "api_key",
    apiSecret: "api_secret",
    sandboxMode: "sandbox_mode",
    documentTypes: "document_types",
  };

  for (const [k, col] of Object.entries(map)) {
    if (normalizedPayload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      if (k === "documentTypes") params.push(JSON.stringify(normalizedPayload[k] || []));
      else params.push(normalizedPayload[k] === "" ? null : normalizedPayload[k]);
    }
  }

  columns.push(`updated_by=$${i++}`);
  params.push(actorUserId || null);
  columns.push(`updated_at=NOW()`);

  const { rows } = await pool.query(
    `UPDATE einvoicing_settings
     SET ${columns.join(", ")}
     WHERE organization_id=$1
     RETURNING *`,
    params,
  );
  return normalizeEinvoicingSettingsRow(rows[0]);
}

// ==================== FILING ADAPTERS ====================

async function listFilingAdapters({ orgId, query = {} }) {
  const params = [orgId];
  const where = ["(organization_id=$1 OR organization_id IS NULL)"];
  let i = 2;

  if (query.countryCode) {
    where.push(`country_code=$${i++}`);
    params.push(String(query.countryCode).toUpperCase());
  }
  if (query.taxType) {
    where.push(`$${i++} = ANY(supported_tax_types)`);
    params.push(query.taxType);
  }
  if (query.isActive !== undefined) {
    where.push(`is_active=$${i++}`);
    params.push(query.isActive === true || query.isActive === "true");
  }

  const { rows } = await pool.query(
    `SELECT * FROM tax_filing_adapters
     WHERE ${where.join(" AND ")}
     ORDER BY organization_id NULLS FIRST, country_code, adapter_code`,
    params,
  );
  return rows.map(normalizeFilingAdapterRow);
}

async function getFilingAdapter({ orgId, adapterId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_filing_adapters
     WHERE (organization_id=$1 OR organization_id IS NULL) AND id=$2`,
    [orgId, adapterId],
  );
  if (!rows.length) throw new AppError(404, "Filing adapter not found");
  return normalizeFilingAdapterRow(rows[0]);
}

async function createFilingAdapter({ orgId, actorUserId, payload }) {
  const { rows } = await pool.query(
    `INSERT INTO tax_filing_adapters(
      organization_id, adapter_code, name, channel_type,
      supported_tax_types, supported_countries, country_code,
      config_json, is_realtime, is_active
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,COALESCE($9,false),COALESCE($10,true))
    RETURNING *`,
    [
      orgId,
      payload.adapterCode,
      payload.name,
      payload.channelType || "api",
      payload.supportedTaxTypes || ["VAT"],
      payload.supportedCountries || [],
      String(payload.countryCode).toUpperCase(),
      JSON.stringify(payload.configJson || {}),
      payload.isRealtime || false,
      payload.isActive !== undefined ? payload.isActive : true,
    ],
  );
  return rows[0];
}

async function updateFilingAdapter({ orgId, adapterId, payload, actorUserId }) {
  const columns = [];
  const params = [orgId, adapterId];
  let i = 3;

  const map = {
    adapterCode: "adapter_code",
    name: "name",
    channelType: "channel_type",
    supportedTaxTypes: "supported_tax_types",
    supportedCountries: "supported_countries",
    countryCode: "country_code",
    configJson: "config_json",
    isRealtime: "is_realtime",
    isActive: "is_active",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      if (k === "configJson") {
        params.push(JSON.stringify(payload[k] || {}));
      } else if (k === "countryCode") {
        params.push(String(payload[k]).toUpperCase());
      } else {
        params.push(payload[k]);
      }
    }
  }

  if (!columns.length) {
    return getFilingAdapter({ orgId, adapterId });
  }

  const { rows } = await pool.query(
    `UPDATE tax_filing_adapters
     SET ${columns.join(", ")}
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    params,
  );

  if (!rows.length) throw new AppError(404, "Filing adapter not found");
  return normalizeFilingAdapterRow(rows[0]);
}

async function deleteFilingAdapter({ orgId, adapterId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_filing_adapters WHERE organization_id=$1 AND id=$2`,
    [orgId, adapterId],
  );
  if (!rowCount) throw new AppError(404, "Filing adapter not found");
  return { deleted: true };
}

async function testFilingAdapter({ orgId, adapterId, actorUserId }) {
  const adapter = await getFilingAdapter({ orgId, adapterId });

  return {
    success: true,
    message: `Adapter ${adapter.name} tested successfully`,
    adapter: adapter,
  };
}

// ==================== COUNTRY PACKS ====================

async function listCountryPacks({ orgId }) {
  const { rows } = await pool.query(
    `SELECT p.*, i.installed_at, i.installed_by,
            CASE WHEN i.pack_id IS NULL THEN FALSE ELSE TRUE END AS is_installed
       FROM tax_country_packs p
       LEFT JOIN tax_country_pack_installs i
         ON i.pack_id = p.id AND i.organization_id = $1
      WHERE p.organization_id=$1 OR p.organization_id IS NULL
      ORDER BY is_installed DESC, p.is_active DESC, p.country_code, p.pack_code`,
    [orgId],
  );
  return rows.map(normalizeCountryPackRow);
}


function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonb(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

function codeFromPackRow(row) {
  return row?.code || row?.taxCode || row?.componentTaxCode || null;
}

async function installCountryPack({ orgId, actorUserId, payload }) {
  const packCode = payload.packCode || payload.countryCode;
  const { rows: packRows } = await pool.query(
    `SELECT * FROM tax_country_packs
      WHERE (organization_id=$1 OR organization_id IS NULL)
        AND (pack_code=$2 OR country_code=$2)
      ORDER BY organization_id NULLS FIRST
      LIMIT 1`,
    [orgId, packCode],
  );
  const pack = packRows[0];
  if (!pack) throw new AppError(404, "Tax country pack not found");

  const metadata = pack.metadata || {};

  return withTransaction(async (client) => {
    const jurisdictionByCode = new Map();

    for (const j of asArray(metadata.jurisdictions)) {
      const code = String(j.code || j.countryCode || pack.country_code || "").trim().toUpperCase();
      if (!code) continue;
      const { rows } = await client.query(
        `INSERT INTO tax_jurisdictions(
            organization_id, code, name, country_code, level_code, region_code, is_default, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,FALSE),$8::jsonb)
         ON CONFLICT (organization_id, code) DO UPDATE SET
            name=EXCLUDED.name,
            country_code=EXCLUDED.country_code,
            level_code=EXCLUDED.level_code,
            region_code=EXCLUDED.region_code,
            is_default=EXCLUDED.is_default,
            metadata=tax_jurisdictions.metadata || EXCLUDED.metadata
         RETURNING id, code`,
        [
          orgId,
          code,
          j.name || pack.name || code,
          (j.countryCode || pack.country_code || code).slice(0, 2).toUpperCase(),
          j.levelCode || "country",
          j.regionCode || null,
          j.isDefault === true,
          jsonb(j.metadata || {}),
        ],
      );
      jurisdictionByCode.set(code, rows[0].id);
    }

    if (!jurisdictionByCode.size && pack.country_code) {
      const code = String(pack.country_code).trim().toUpperCase();
      const { rows } = await client.query(
        `INSERT INTO tax_jurisdictions(organization_id, code, name, country_code, level_code, is_default, metadata)
         VALUES ($1,$2,$3,$4,'country',TRUE,$5::jsonb)
         ON CONFLICT (organization_id, code) DO UPDATE SET
           name=EXCLUDED.name,
           country_code=EXCLUDED.country_code,
           is_default=TRUE
         RETURNING id, code`,
        [orgId, code, pack.name || code, code.slice(0, 2), jsonb({ installedFromPack: pack.pack_code })],
      );
      jurisdictionByCode.set(code, rows[0].id);
    }

    if (Array.isArray(pack.default_templates)) {
      for (const tpl of pack.default_templates) {
        const { rows: tRows } = await client.query(
          `INSERT INTO tax_return_templates(organization_id, tax_type, code, name)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (organization_id, tax_type, code) DO UPDATE SET name=EXCLUDED.name
           RETURNING id`,
          [orgId, tpl.taxType || "VAT", tpl.code, tpl.name],
        );
        const templateId = tRows[0].id;
        if (Array.isArray(tpl.boxes)) {
          await client.query(`DELETE FROM tax_return_template_boxes WHERE template_id=$1`, [templateId]);
          for (const box of tpl.boxes) {
            await client.query(
              `INSERT INTO tax_return_template_boxes(template_id, box_code, label, sort_order, direction)
               VALUES($1,$2,$3,$4,$5)`,
              [templateId, box.boxCode, box.label, box.sortOrder || 0, box.direction || null],
            );
          }
        }
      }
    }

    const taxCodeByCode = new Map();
    for (const tc of asArray(metadata.taxCodes)) {
      const code = codeFromPackRow(tc);
      if (!code) continue;
      const jCode = String(tc.jurisdictionCode || pack.country_code || "").trim().toUpperCase();
      const jurisdictionId = tc.jurisdictionId || jurisdictionByCode.get(jCode) || jurisdictionByCode.values().next().value || null;
      const rowMetadata = { ...(tc.metadata || {}) };
      if (tc.thresholdAmount != null) rowMetadata.thresholdAmount = String(tc.thresholdAmount);
      if (tc.sourceNote) rowMetadata.sourceNote = tc.sourceNote;
      rowMetadata.installedFromPack = pack.pack_code;

      const { rows } = await client.query(
        `INSERT INTO tax_codes(
            organization_id, jurisdiction_id, code, name, tax_type, rate, is_compound,
            box_code, direction, category_code, tax_scope, application_scope, calculation_method,
            exemption_reason_code, exemption_reason, reverse_charge, recoverable_percent, reporting_group,
            effective_from, effective_to, status, metadata,
            withholding_regime, withholding_treatment, threshold_basis, threshold_amount
         ) VALUES (
            $1,$2,$3,$4,$5,$6::numeric,COALESCE($7,false),
            $8,$9,$10,COALESCE($11,'taxable'),COALESCE($12,'both'),COALESCE($13,'standard'),
            $14,$15,COALESCE($16,false),COALESCE($17,1),$18,
            COALESCE($19,CURRENT_DATE),$20,COALESCE($21,'active'),$22::jsonb,
            $23,$24,$25,$26
         )
         ON CONFLICT (organization_id, code) DO UPDATE SET
            jurisdiction_id=EXCLUDED.jurisdiction_id,
            name=EXCLUDED.name,
            tax_type=EXCLUDED.tax_type,
            rate=EXCLUDED.rate,
            is_compound=EXCLUDED.is_compound,
            box_code=EXCLUDED.box_code,
            direction=EXCLUDED.direction,
            category_code=EXCLUDED.category_code,
            tax_scope=EXCLUDED.tax_scope,
            application_scope=EXCLUDED.application_scope,
            calculation_method=EXCLUDED.calculation_method,
            exemption_reason_code=EXCLUDED.exemption_reason_code,
            exemption_reason=EXCLUDED.exemption_reason,
            reverse_charge=EXCLUDED.reverse_charge,
            recoverable_percent=EXCLUDED.recoverable_percent,
            reporting_group=EXCLUDED.reporting_group,
            withholding_regime=EXCLUDED.withholding_regime,
            withholding_treatment=EXCLUDED.withholding_treatment,
            threshold_basis=EXCLUDED.threshold_basis,
            threshold_amount=EXCLUDED.threshold_amount,
            effective_from=EXCLUDED.effective_from,
            effective_to=EXCLUDED.effective_to,
            status=EXCLUDED.status,
            metadata=tax_codes.metadata || EXCLUDED.metadata,
            updated_at=NOW()
         RETURNING id, code`,
        [
          orgId,
          jurisdictionId,
          code,
          tc.name || code,
          tc.taxType === "WHT" ? "WITHHOLDING" : (tc.taxType || "VAT"),
          tc.rate ?? "0",
          tc.isCompound === true,
          tc.boxCode ?? null,
          tc.direction ?? (tc.taxType === "WITHHOLDING" ? "withholding" : null),
          tc.categoryCode ?? tc.taxCategory ?? null,
          tc.taxScope ?? null,
          tc.applicationScope ?? null,
          tc.calculationMethod ?? null,
          tc.exemptionReasonCode ?? null,
          tc.exemptionReason ?? null,
          tc.reverseCharge === true,
          tc.recoverablePercent ?? null,
          tc.reportingGroup ?? null,
          tc.effectiveFrom || null,
          tc.effectiveTo ?? null,
          tc.status || null,
          jsonb(rowMetadata),
          tc.withholdingRegime || null,
          tc.withholdingTreatment || null,
          tc.thresholdBasis || (tc.thresholdAmount != null ? "annual_cumulative" : null),
          tc.thresholdAmount ?? null,
        ],
      );
      taxCodeByCode.set(rows[0].code, rows[0].id);
    }

    for (const tc of asArray(metadata.taxCodes)) {
      const parentCode = codeFromPackRow(tc);
      const components = asArray(tc.components);
      const parentId = taxCodeByCode.get(parentCode);
      if (!parentId || !components.length) continue;
      await client.query(`DELETE FROM tax_code_components WHERE organization_id=$1 AND parent_tax_code_id=$2`, [orgId, parentId]);
      let sequence = 1;
      for (const componentCode of components) {
        const componentId = taxCodeByCode.get(componentCode);
        if (!componentId) continue;
        await client.query(
          `INSERT INTO tax_code_components(organization_id, parent_tax_code_id, component_tax_code_id, sequence_no, rate_override)
           VALUES($1,$2,$3,$4,NULL)`,
          [orgId, parentId, componentId, sequence++],
        );
      }
      await client.query(`UPDATE tax_codes SET is_compound=TRUE, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, parentId]);
    }

    let catalogProfileCount = 0;
    for (const profile of asArray(metadata.catalogProfiles)) {
      const profileCode = String(profile.code || '').trim();
      if (!profileCode) continue;
      const salesTaxCodeId = profile.salesTaxCodeId || taxCodeByCode.get(profile.salesTaxCode || null) || null;
      const purchaseTaxCodeId = profile.purchaseTaxCodeId || taxCodeByCode.get(profile.purchaseTaxCode || null) || null;
      await client.query(
        `INSERT INTO tax_catalog_profiles(
           organization_id, code, name, supply_type, tax_category,
           sales_tax_scope, purchase_tax_scope, sales_tax_code_id, purchase_tax_code_id,
           exemption_reason_code, exemption_reason, hs_code, fiscal_classification_code,
           effective_from, effective_to, status, metadata
         ) VALUES($1,$2,$3,COALESCE($4,'goods'),$5,COALESCE($6,'taxable'),COALESCE($7,'taxable'),$8,$9,$10,$11,$12,$13,COALESCE($14,CURRENT_DATE),$15,COALESCE($16,'active'),$17::jsonb)
         ON CONFLICT (organization_id, code) DO UPDATE SET
           name=EXCLUDED.name,
           supply_type=EXCLUDED.supply_type,
           tax_category=EXCLUDED.tax_category,
           sales_tax_scope=EXCLUDED.sales_tax_scope,
           purchase_tax_scope=EXCLUDED.purchase_tax_scope,
           sales_tax_code_id=EXCLUDED.sales_tax_code_id,
           purchase_tax_code_id=EXCLUDED.purchase_tax_code_id,
           exemption_reason_code=EXCLUDED.exemption_reason_code,
           exemption_reason=EXCLUDED.exemption_reason,
           hs_code=COALESCE(EXCLUDED.hs_code,tax_catalog_profiles.hs_code),
           fiscal_classification_code=COALESCE(EXCLUDED.fiscal_classification_code,tax_catalog_profiles.fiscal_classification_code),
           effective_from=EXCLUDED.effective_from,
           effective_to=EXCLUDED.effective_to,
           status=EXCLUDED.status,
           metadata=tax_catalog_profiles.metadata || EXCLUDED.metadata,
           updated_at=NOW()`,
        [
          orgId, profileCode, profile.name || profileCode, profile.supplyType || null, profile.taxCategory || null,
          profile.salesTaxScope || null, profile.purchaseTaxScope || null, salesTaxCodeId, purchaseTaxCodeId,
          profile.exemptionReasonCode || null, profile.exemptionReason || null, profile.hsCode || null,
          profile.fiscalClassificationCode || null, profile.effectiveFrom || metadata.effectiveFrom || null,
          profile.effectiveTo || null, profile.status || 'active',
          jsonb({ ...(profile.metadata || {}), installedFromPack: pack.pack_code })
        ]
      );
      catalogProfileCount += 1;
    }

    for (const rule of asArray(metadata.taxRules)) {
      const code = rule.taxCode || rule.tax_code || null;
      const taxCodeId = rule.taxCodeId || taxCodeByCode.get(code);
      if (!taxCodeId) continue;
      const jCode = String(rule.jurisdictionCode || pack.country_code || "").trim().toUpperCase();
      const jurisdictionId = rule.jurisdictionId || jurisdictionByCode.get(jCode) || jurisdictionByCode.values().next().value || null;
      const ruleCode = rule.code || String(rule.name || code).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80);
      const ruleParams = [
        orgId,
        ruleCode,
        rule.name || code,
        rule.ruleGroup || null,
        rule.documentType || null,
        rule.partnerType || null,
        rule.supplyType || null,
        rule.placeOfSupplyBasis || null,
        rule.transactionScope || null,
        jurisdictionId,
        taxCodeId,
        rule.priority ?? 100,
        rule.effectiveFrom || metadata.effectiveFrom || null,
        rule.effectiveTo ?? null,
        jsonb(rule.conditions || {}),
        rule.status || "active",
      ];
      const existingRule = await client.query(
        `SELECT id FROM tax_rules WHERE organization_id=$1 AND code=$2 LIMIT 1`,
        [orgId, ruleCode],
      );
      if (existingRule.rows[0]) {
        await client.query(
          `UPDATE tax_rules
              SET name=$3,
                  rule_group=$4,
                  document_type=$5,
                  partner_type=$6,
                  supply_type=$7,
                  place_of_supply_basis=$8,
                  transaction_scope=COALESCE($9,'both'),
                  jurisdiction_id=$10,
                  tax_code_id=$11,
                  priority=COALESCE($12,100),
                  effective_from=COALESCE($13,CURRENT_DATE),
                  effective_to=$14,
                  conditions=COALESCE($15,'{}'::jsonb),
                  status=COALESCE($16,'active'),
                  updated_at=NOW()
            WHERE organization_id=$1 AND code=$2`,
          ruleParams,
        );
      } else {
        await client.query(
          `INSERT INTO tax_rules(
              organization_id, code, name, rule_group, document_type, partner_type, supply_type, place_of_supply_basis,
              transaction_scope, jurisdiction_id, tax_code_id, priority, effective_from, effective_to, conditions, status
           ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'both'),$10,$11,COALESCE($12,100),COALESCE($13,CURRENT_DATE),$14,COALESCE($15,'{}'::jsonb),COALESCE($16,'active')
           )`,
          ruleParams,
        );
      }
    }

    await client.query(
      `INSERT INTO tax_country_pack_installs(organization_id, pack_id, installed_by, installed_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (organization_id, pack_id) DO UPDATE SET installed_by=EXCLUDED.installed_by, installed_at=EXCLUDED.installed_at`,
      [orgId, pack.id, actorUserId || null],
    );
    return {
      installed: true,
      pack: normalizeCountryPackRow(pack),
      installedCounts: {
        jurisdictions: jurisdictionByCode.size,
        taxCodes: taxCodeByCode.size,
        catalogProfiles: catalogProfileCount,
        rules: asArray(metadata.taxRules).length,
      },
    };
  });
}


// ==================== AUTOMATION RULES ====================

async function listAutomationRules({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_automation_rules WHERE organization_id=$1 ORDER BY created_at DESC`,
    [orgId],
  );
  return rows.map(normalizeAutomationRuleRow);
}

function deriveAutomationRuleCode(payload) {
  if (payload.code && String(payload.code).trim()) return String(payload.code).trim();
  return String(payload.name || "tax automation rule")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

async function upsertAutomationRule({ orgId, actorUserId, payload }) {
  const code = deriveAutomationRuleCode(payload);
  const scope = payload.scope || {};
  const action = payload.action || {};
  // Keep the legacy automation columns and the schema-129 compatibility columns
  // in sync. `code` is NOT NULL after migration 129.
  const config = {
    scheduleCode: payload.scheduleCode || null,
    scope,
    action,
  };

  const { rows } = await pool.query(
    `INSERT INTO tax_automation_rules(
       organization_id, code, name, trigger_code, schedule_code, scope_json, action_json,
       is_enabled, created_by, updated_by, trigger_type, config_json
     )
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,COALESCE($8,TRUE),$9,$9,$4,$10::jsonb)
     ON CONFLICT (organization_id, name) DO UPDATE
       SET code=EXCLUDED.code,
           trigger_code=EXCLUDED.trigger_code,
           schedule_code=EXCLUDED.schedule_code,
           scope_json=EXCLUDED.scope_json,
           action_json=EXCLUDED.action_json,
           trigger_type=EXCLUDED.trigger_type,
           config_json=EXCLUDED.config_json,
           is_enabled=EXCLUDED.is_enabled,
           updated_by=EXCLUDED.updated_by,
           updated_at=NOW()
     RETURNING *`,
    [
      orgId,
      code,
      payload.name,
      payload.triggerCode,
      payload.scheduleCode || null,
      JSON.stringify(scope),
      JSON.stringify(action),
      payload.isEnabled,
      actorUserId || null,
      JSON.stringify(config),
    ],
  );
  return rows[0];
}

async function getOrgBaseCurrency({ orgId, client = null }) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1`,
    [orgId],
  );
  if (!rows.length) throw new AppError(404, "Organization not found");
  return rows[0].base_currency_code;
}

async function nextWithholdingRemittanceNo(client, orgId) {
  const prefix = "WTR";
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM withholding_remittances WHERE organization_id=$1`,
    [orgId],
  );
  return `${prefix}-${String((rows[0]?.n || 0) + 1).padStart(6, "0")}`;
}

async function getOpenWithholdingItems({
  orgId,
  direction = "payable",
  query = {},
}) {
  const params = [orgId];
  let filter = "";
  let docDateFilter = "";
  if (query?.partnerId) {
    params.push(query.partnerId);
    filter += ` AND src.partner_id = $${params.length}`;
  }
  if (query?.taxCodeId) {
    params.push(query.taxCodeId);
    filter += ` AND src.tax_code_id = $${params.length}`;
  }
  if (query?.fromDate) {
    params.push(query.fromDate);
    docDateFilter += ` AND src.document_date >= $${params.length}::date`;
  }
  if (query?.toDate) {
    params.push(query.toDate);
    docDateFilter += ` AND src.document_date <= $${params.length}::date`;
  }

  if (direction === "payable") {
    const { rows } = await pool.query(
      `
      WITH src AS (
        SELECT b.id AS source_id, 'bill'::text AS source_type, b.organization_id, b.vendor_id AS partner_id, bp.name AS partner_name,
               b.bill_no AS document_no, b.bill_date AS document_date, b.currency_code,
               COALESCE(b.withholding_total,0)::numeric(18,2) AS withholding_total,
               -- Instead of MIN(uuid) or MAX(uuid), use:
(MIN(d.tax_code_id::text))::uuid AS tax_code_id
        FROM bills b
        LEFT JOIN business_partners bp ON bp.id = b.vendor_id
        LEFT JOIN bill_lines bl ON bl.bill_id = b.id
        LEFT JOIN bill_line_tax_details d ON d.line_id = bl.id AND COALESCE(d.tax_type,'')='WITHHOLDING'
        WHERE b.organization_id = $1
          AND b.status IN ('issued','approved','paid')
          AND COALESCE(b.withholding_total,0) > 0
        GROUP BY b.id, bp.name
      ), applied AS (
        SELECT l.source_id, SUM(CASE WHEN r.status='posted' THEN l.applied_amount ELSE 0 END) AS applied_amount
        FROM withholding_remittance_lines l
        JOIN withholding_remittances r ON r.id = l.remittance_id
        WHERE l.organization_id=$1
        GROUP BY l.source_id
      )
      SELECT src.*,
             COALESCE(applied.applied_amount,0)::numeric(18,2) AS applied_amount,
             GREATEST(COALESCE(src.withholding_total,0) - COALESCE(applied.applied_amount,0), 0)::numeric(18,2) AS outstanding_amount
      FROM src
      LEFT JOIN applied ON applied.source_id = src.source_id
      WHERE GREATEST(COALESCE(src.withholding_total,0) - COALESCE(applied.applied_amount,0), 0) > 0
      ${filter}
      ${docDateFilter}
      ORDER BY src.document_date DESC, src.document_no
      `,
      params,
    );
    return rows;
  }

  const { rows } = await pool.query(
    `
    WITH src AS (
      SELECT i.id AS source_id, 'invoice'::text AS source_type, i.organization_id, i.customer_id AS partner_id, bp.name AS partner_name,
             i.invoice_no AS document_no, i.invoice_date AS document_date, i.currency_code,
             COALESCE(i.withholding_total,0)::numeric(18,2) AS withholding_total,
             -- Instead of MIN(uuid) or MAX(uuid), use:
              (MIN(d.tax_code_id::text))::uuid AS tax_code_id
      FROM invoices i
      LEFT JOIN business_partners bp ON bp.id = i.customer_id
      LEFT JOIN invoice_lines il ON il.invoice_id = i.id
      LEFT JOIN invoice_line_tax_details d ON d.line_id = il.id AND COALESCE(d.tax_type,'')='WITHHOLDING'
      WHERE i.organization_id = $1
        AND i.status IN ('issued','approved','paid')
        AND COALESCE(i.withholding_total,0) > 0
      GROUP BY i.id, bp.name
    ), applied AS (
      SELECT l.source_id, SUM(CASE WHEN c.status='posted' THEN l.applied_amount ELSE 0 END) AS applied_amount
      FROM withholding_certificate_lines l
      JOIN withholding_certificates c ON c.id = l.certificate_id
      WHERE l.organization_id=$1
      GROUP BY l.source_id
    )
    SELECT src.*,
           COALESCE(applied.applied_amount,0)::numeric(18,2) AS applied_amount,
           GREATEST(COALESCE(src.withholding_total,0) - COALESCE(applied.applied_amount,0), 0)::numeric(18,2) AS outstanding_amount
    FROM src
    LEFT JOIN applied ON applied.source_id = src.source_id
    WHERE GREATEST(COALESCE(src.withholding_total,0) - COALESCE(applied.applied_amount,0), 0) > 0
    ${filter}
    ${docDateFilter}
    ORDER BY src.document_date DESC, src.document_no
    `,
    params,
  );
  return rows;
}

async function createWithholdingRemittance({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => {
    await assertPartnerBelongsToOrg({
      orgId,
      partnerId: payload.authorityPartnerId || null,
    });
    await assertJurisdictionBelongsToOrg({
      orgId,
      jurisdictionId: payload.jurisdictionId || null,
    });
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.taxCodeId || null,
    });
    await assertAccountBelongsToOrg({
      orgId,
      accountId: payload.settlementAccountId || null,
      fieldName: "settlementAccountId",
    });

    const baseCurrency =
      payload.currencyCode || (await getOrgBaseCurrency({ orgId, client }));
    const openItems = await getOpenWithholdingItems({
      orgId,
      direction: "payable",
      query: {},
    });
    const itemMap = new Map(openItems.map((item) => [item.source_id, item]));
    let totalAmount = 0;
    const lines = [];
    for (const line of payload.lines || []) {
      const item = itemMap.get(line.sourceId);
      if (!item)
        throw new AppError(
          400,
          `Bill ${line.sourceId} does not have open withholding to remit`,
        );
      if (
        payload.taxCodeId &&
        item.tax_code_id &&
        item.tax_code_id !== payload.taxCodeId
      )
        throw new AppError(
          400,
          "Selected line tax code does not match remittance tax code",
        );
      const appliedAmount = Number(
        line.appliedAmount ?? item.outstanding_amount ?? 0,
      );
      if (appliedAmount <= 0)
        throw new AppError(400, "appliedAmount must be greater than zero");
      if (appliedAmount - Number(item.outstanding_amount || 0) > 0.0001)
        throw new AppError(
          400,
          `Applied amount exceeds outstanding withholding for ${item.document_no}`,
        );
      totalAmount += appliedAmount;
      lines.push({ ...item, appliedAmount: Number(appliedAmount.toFixed(2)) });
    }
    if (!lines.length)
      throw new AppError(400, "At least one remittance line is required");

    const remittanceNo = await nextWithholdingRemittanceNo(client, orgId);
    const { rows } = await client.query(
      `INSERT INTO withholding_remittances (organization_id, remittance_no, direction, status, authority_partner_id, jurisdiction_id, tax_code_id, period_start, period_end, remittance_date, currency_code, settlement_account_id, reference, memo, total_amount, created_by, updated_by)
       VALUES ($1,$2,'payable','draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       RETURNING *`,
      [
        orgId,
        remittanceNo,
        payload.authorityPartnerId || null,
        payload.jurisdictionId || null,
        payload.taxCodeId || null,
        payload.periodStart || null,
        payload.periodEnd || null,
        payload.remittanceDate,
        baseCurrency,
        payload.settlementAccountId || null,
        payload.reference || null,
        payload.memo || null,
        Number(totalAmount.toFixed(2)),
        actorUserId || null,
      ],
    );
    const remittance = rows[0];
    for (const line of lines) {
      await client.query(
        `INSERT INTO withholding_remittance_lines (organization_id, remittance_id, source_type, source_id, partner_id, tax_code_id, source_document_no, source_document_date, original_withholding_amount, available_amount, applied_amount)
         VALUES ($1,$2,'bill',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          orgId,
          remittance.id,
          line.source_id,
          line.partner_id || null,
          line.tax_code_id || null,
          line.document_no,
          line.document_date || null,
          Number(line.withholding_total || 0),
          Number(line.outstanding_amount || 0),
          line.appliedAmount,
        ],
      );
    }
    return getWithholdingRemittance({
      orgId,
      remittanceId: remittance.id,
      client,
    });
  });
}

async function listWithholdingRemittances({ orgId, query = {} }) {
  const params = [orgId];
  const where = ["r.organization_id=$1"];
  if (query?.status) {
    params.push(query.status);
    where.push(`r.status=$${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT r.*, bp.name AS authority_partner_name, tc.code AS tax_code, tj.code AS jurisdiction_code
     FROM withholding_remittances r
     LEFT JOIN business_partners bp ON bp.id = r.authority_partner_id
     LEFT JOIN tax_codes tc ON tc.id = r.tax_code_id
     LEFT JOIN tax_jurisdictions tj ON tj.id = r.jurisdiction_id
     WHERE ${where.join(" AND ")}
     ORDER BY r.remittance_date DESC, r.created_at DESC`,
    params,
  );
  return rows;
}

async function getWithholdingRemittance({
  orgId,
  remittanceId,
  client = null,
}) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT r.*, bp.name AS authority_partner_name, tc.code AS tax_code, tj.code AS jurisdiction_code
     FROM withholding_remittances r
     LEFT JOIN business_partners bp ON bp.id = r.authority_partner_id
     LEFT JOIN tax_codes tc ON tc.id = r.tax_code_id
     LEFT JOIN tax_jurisdictions tj ON tj.id = r.jurisdiction_id
     WHERE r.organization_id=$1 AND r.id=$2`,
    [orgId, remittanceId],
  );
  if (!rows.length) throw new AppError(404, "Withholding remittance not found");
  const remittance = rows[0];
  const { rows: lines } = await db.query(
    `SELECT * FROM withholding_remittance_lines WHERE organization_id=$1 AND remittance_id=$2 ORDER BY source_document_date, source_document_no`,
    [orgId, remittanceId],
  );
  return { ...remittance, lines };
}

async function updateWithholdingRemittance({
  orgId,
  remittanceId,
  payload,
  actorUserId,
}) {
  return withTransaction(async (client) => {
    const current = await getWithholdingRemittance({
      orgId,
      remittanceId,
      client,
    });
    if (current.status !== "draft")
      throw new AppError(409, "Only draft remittances can be updated");
    if (payload.authorityPartnerId !== undefined)
      await assertPartnerBelongsToOrg({
        orgId,
        partnerId: payload.authorityPartnerId || null,
      });
    if (payload.jurisdictionId !== undefined)
      await assertJurisdictionBelongsToOrg({
        orgId,
        jurisdictionId: payload.jurisdictionId || null,
      });
    if (payload.taxCodeId !== undefined)
      await assertTaxCodeBelongsToOrg({
        orgId,
        taxCodeId: payload.taxCodeId || null,
      });
    if (payload.settlementAccountId !== undefined)
      await assertAccountBelongsToOrg({
        orgId,
        accountId: payload.settlementAccountId || null,
        fieldName: "settlementAccountId",
      });

    const merged = { ...current, ...payload };
    if (payload.lines) {
      await client.query(
        `DELETE FROM withholding_remittance_lines WHERE organization_id=$1 AND remittance_id=$2`,
        [orgId, remittanceId],
      );
      const openItems = await getOpenWithholdingItems({
        orgId,
        direction: "payable",
        query: {},
      });
      const itemMap = new Map(openItems.map((item) => [item.source_id, item]));
      let totalAmount = 0;
      for (const line of payload.lines) {
        const item = itemMap.get(line.sourceId);
        if (!item)
          throw new AppError(
            400,
            `Bill ${line.sourceId} does not have open withholding to remit`,
          );
        const appliedAmount = Number(
          line.appliedAmount ?? item.outstanding_amount ?? 0,
        );
        if (
          appliedAmount <= 0 ||
          appliedAmount - Number(item.outstanding_amount || 0) > 0.0001
        )
          throw new AppError(
            400,
            `Invalid applied amount for ${item.document_no}`,
          );
        totalAmount += appliedAmount;
        await client.query(
          `INSERT INTO withholding_remittance_lines (organization_id, remittance_id, source_type, source_id, partner_id, tax_code_id, source_document_no, source_document_date, original_withholding_amount, available_amount, applied_amount) VALUES ($1,$2,'bill',$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            orgId,
            remittanceId,
            item.source_id,
            item.partner_id || null,
            item.tax_code_id || null,
            item.document_no,
            item.document_date || null,
            Number(item.withholding_total || 0),
            Number(item.outstanding_amount || 0),
            Number(appliedAmount.toFixed(2)),
          ],
        );
      }
      merged.total_amount = Number(totalAmount.toFixed(2));
    }

    const { rows } = await client.query(
      `UPDATE withholding_remittances
       SET authority_partner_id=$3, jurisdiction_id=$4, tax_code_id=$5, period_start=$6, period_end=$7, remittance_date=$8, currency_code=$9, settlement_account_id=$10, reference=$11, memo=$12, total_amount=$13, updated_by=$14, updated_at=NOW()
       WHERE organization_id=$1 AND id=$2
       RETURNING *`,
      [
        orgId,
        remittanceId,
        merged.authority_partner_id ?? merged.authorityPartnerId ?? null,
        merged.jurisdiction_id ?? merged.jurisdictionId ?? null,
        merged.tax_code_id ?? merged.taxCodeId ?? null,
        merged.period_start ?? merged.periodStart ?? null,
        merged.period_end ?? merged.periodEnd ?? null,
        merged.remittance_date ?? merged.remittanceDate,
        merged.currency_code ?? merged.currencyCode,
        merged.settlement_account_id ?? merged.settlementAccountId ?? null,
        merged.reference || null,
        merged.memo || null,
        Number(
          merged.total_amount ||
            merged.totalAmount ||
            current.total_amount ||
            0,
        ),
        actorUserId || null,
      ],
    );
    return getWithholdingRemittance({
      orgId,
      remittanceId: rows[0].id,
      client,
    });
  });
}

async function postWithholdingRemittance({
  orgId,
  remittanceId,
  actorUserId,
  payload = {},
}) {
  return withTransaction(async (client) => {
    const remittance = await getWithholdingRemittance({
      orgId,
      remittanceId,
      client,
    });
    if (!["draft", "approved"].includes(remittance.status))
      throw new AppError(
        409,
        "Only draft or approved remittances can be posted",
      );
    if (remittance.workflow_document_id) {
      await documentableSvc.assertEntityApprovedForAction({
        orgId,
        entityType: "withholding_remittance",
        workflowDocumentId: remittance.workflow_document_id,
        client,
        actionLabel: "post",
      });
    }
    const settlementAccountId =
      payload.settlementAccountId || remittance.settlement_account_id;
    if (!settlementAccountId)
      throw new AppError(
        400,
        "settlementAccountId is required to post remittance",
      );
    await assertAccountBelongsToOrg({
      orgId,
      accountId: settlementAccountId,
      fieldName: "settlementAccountId",
    });

    const { rows: settingsRows } = await client.query(
      `SELECT withholding_tax_payable_account_id FROM tax_settings WHERE organization_id=$1`,
      [orgId],
    );
    const withholdingPayableAccountId =
      settingsRows[0]?.withholding_tax_payable_account_id || null;
    if (!withholdingPayableAccountId)
      throw new AppError(
        409,
        "Withholding tax payable account is not configured (tax_settings.withholding_tax_payable_account_id)",
      );

    const period = await periodIF.findOpenPeriodForDate({
      orgId,
      date: payload.remittanceDate || remittance.remittance_date,
      client,
    });
    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      client,
      payload: {
        periodId: period.id,
        entryDate: payload.remittanceDate || remittance.remittance_date,
        typeCode: "GENERAL",
        memo:
          payload.memo ||
          remittance.memo ||
          `Withholding remittance ${remittance.remittance_no}`,
        idempotencyKey: `withholding-remittance:${remittanceId}:post`,
        lines: [
          {
            accountId: withholdingPayableAccountId,
            debit: Number(remittance.total_amount || 0),
            credit: 0,
            description: `Clear withholding payable ${remittance.remittance_no}`,
          },
          {
            accountId: settlementAccountId,
            debit: 0,
            credit: Number(remittance.total_amount || 0),
            description: `Remit withholding ${remittance.remittance_no}`,
          },
        ],
      },
    });

    await propagateDocumentWorkflowToJournal({
      client,
      journalId: draft.journalId,
      source: {
        orgId,
        workflowDocumentId: remittance.workflow_document_id || null,
        createdBy: remittance.created_by || actorUserId || null,
        submittedAt: remittance.submitted_at || null,
        submittedBy: remittance.submitted_by || null,
        approvedAt: remittance.approved_at || null,
        approvedBy: remittance.approved_by || null,
        updatedBy: actorUserId || null,
      },
    });

    const posted = await journalIF.postDraftJournal({
      orgId,
      journalId: draft.journalId,
      actorUserId,
      client,
    });
    await client.query(
      `UPDATE withholding_remittances SET status='posted', settlement_account_id=$3, remittance_date=$4, reference=$5, memo=$6, journal_entry_id=$7, posted_at=NOW(), posted_by=$8, updated_by=$8, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [
        orgId,
        remittanceId,
        settlementAccountId,
        payload.remittanceDate || remittance.remittance_date,
        payload.reference || remittance.reference || null,
        payload.memo || remittance.memo || null,
        posted.journalId,
        actorUserId || null,
      ],
    );
    return getWithholdingRemittance({ orgId, remittanceId, client });
  });
}

async function voidWithholdingRemittance({
  orgId,
  remittanceId,
  actorUserId,
  reason,
}) {
  return withTransaction(async (client) => {
    const remittance = await getWithholdingRemittance({
      orgId,
      remittanceId,
      client,
    });
    if (remittance.status !== "posted")
      throw new AppError(409, "Only posted remittances can be voided");
    if (!remittance.journal_entry_id)
      throw new AppError(409, "Remittance has no posted journal to void");
    const reversal = await journalIF.voidPostedJournal({
      orgId,
      journalId: remittance.journal_entry_id,
      actorUserId,
      reason,
      client,
    });
    await client.query(
      `UPDATE withholding_remittances SET status='voided', reversal_journal_entry_id=$3, voided_at=NOW(), voided_by=$4, updated_by=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [
        orgId,
        remittanceId,
        reversal.journalId || reversal.reversalJournalId || null,
        actorUserId || null,
      ],
    );
    return getWithholdingRemittance({ orgId, remittanceId, client });
  });
}

async function listWithholdingCertificates({ orgId, query = {} }) {
  const params = [orgId];
  const where = ["c.organization_id=$1"];
  if (query?.status) {
    params.push(query.status);
    where.push(`c.status=$${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT c.*, bp.name AS customer_name, tc.code AS tax_code, tj.code AS jurisdiction_code FROM withholding_certificates c LEFT JOIN business_partners bp ON bp.id = c.customer_id LEFT JOIN tax_codes tc ON tc.id = c.tax_code_id LEFT JOIN tax_jurisdictions tj ON tj.id = c.jurisdiction_id WHERE ${where.join(" AND ")} ORDER BY c.certificate_date DESC, c.created_at DESC`,
    params,
  );
  return rows;
}

async function getWithholdingCertificate({
  orgId,
  certificateId,
  client = null,
}) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT c.*, bp.name AS customer_name, tc.code AS tax_code, tj.code AS jurisdiction_code FROM withholding_certificates c LEFT JOIN business_partners bp ON bp.id = c.customer_id LEFT JOIN tax_codes tc ON tc.id = c.tax_code_id LEFT JOIN tax_jurisdictions tj ON tj.id = c.jurisdiction_id WHERE c.organization_id=$1 AND c.id=$2`,
    [orgId, certificateId],
  );
  if (!rows.length)
    throw new AppError(404, "Withholding certificate not found");
  const cert = rows[0];
  const { rows: lines } = await db.query(
    `SELECT * FROM withholding_certificate_lines WHERE organization_id=$1 AND certificate_id=$2 ORDER BY source_document_date, source_document_no`,
    [orgId, certificateId],
  );
  return { ...cert, lines };
}

async function createWithholdingCertificate({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => {
    await assertPartnerBelongsToOrg({
      orgId,
      partnerId: payload.customerId || null,
    });
    await assertJurisdictionBelongsToOrg({
      orgId,
      jurisdictionId: payload.jurisdictionId || null,
    });
    await assertTaxCodeBelongsToOrg({
      orgId,
      taxCodeId: payload.taxCodeId || null,
    });
    await assertAccountBelongsToOrg({
      orgId,
      accountId: payload.counterAccountId || null,
      fieldName: "counterAccountId",
    });

    const openItems = await getOpenWithholdingItems({
      orgId,
      direction: "receivable",
      query: {},
    });
    const itemMap = new Map(openItems.map((item) => [item.source_id, item]));
    let totalAmount = 0;
    for (const line of payload.lines || []) {
      const item = itemMap.get(line.sourceId);
      if (!item)
        throw new AppError(
          400,
          `Invoice ${line.sourceId} does not have open withholding receivable`,
        );
      const appliedAmount = Number(
        line.appliedAmount ?? item.outstanding_amount ?? 0,
      );
      if (
        appliedAmount <= 0 ||
        appliedAmount - Number(item.outstanding_amount || 0) > 0.0001
      )
        throw new AppError(
          400,
          `Invalid applied amount for ${item.document_no}`,
        );
      totalAmount += appliedAmount;
    }
    const { rows } = await client.query(
      `INSERT INTO withholding_certificates (organization_id, certificate_no, status, customer_id, jurisdiction_id, tax_code_id, certificate_date, counter_account_id, issued_by, reference, memo, total_amount, created_by, updated_by) VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
      [
        orgId,
        payload.certificateNo,
        payload.customerId || null,
        payload.jurisdictionId || null,
        payload.taxCodeId || null,
        payload.certificateDate,
        payload.counterAccountId || null,
        payload.issuedBy || null,
        payload.reference || null,
        payload.memo || null,
        Number(totalAmount.toFixed(2)),
        actorUserId || null,
      ],
    );
    const cert = rows[0];
    for (const line of payload.lines || []) {
      const item = itemMap.get(line.sourceId);
      const appliedAmount = Number(
        (line.appliedAmount ?? item.outstanding_amount ?? 0).toFixed(2),
      );
      await client.query(
        `INSERT INTO withholding_certificate_lines (organization_id, certificate_id, source_type, source_id, partner_id, tax_code_id, source_document_no, source_document_date, original_withholding_amount, available_amount, applied_amount) VALUES ($1,$2,'invoice',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          orgId,
          cert.id,
          item.source_id,
          item.partner_id || null,
          item.tax_code_id || null,
          item.document_no,
          item.document_date || null,
          Number(item.withholding_total || 0),
          Number(item.outstanding_amount || 0),
          appliedAmount,
        ],
      );
    }
    return getWithholdingCertificate({ orgId, certificateId: cert.id, client });
  });
}

async function updateWithholdingCertificate({
  orgId,
  certificateId,
  payload,
  actorUserId,
}) {
  return withTransaction(async (client) => {
    const current = await getWithholdingCertificate({
      orgId,
      certificateId,
      client,
    });
    if (current.status !== "draft")
      throw new AppError(409, "Only draft certificates can be updated");
    if (payload.customerId !== undefined)
      await assertPartnerBelongsToOrg({
        orgId,
        partnerId: payload.customerId || null,
      });
    if (payload.jurisdictionId !== undefined)
      await assertJurisdictionBelongsToOrg({
        orgId,
        jurisdictionId: payload.jurisdictionId || null,
      });
    if (payload.taxCodeId !== undefined)
      await assertTaxCodeBelongsToOrg({
        orgId,
        taxCodeId: payload.taxCodeId || null,
      });
    if (payload.counterAccountId !== undefined)
      await assertAccountBelongsToOrg({
        orgId,
        accountId: payload.counterAccountId || null,
        fieldName: "counterAccountId",
      });

    let totalAmount = Number(current.total_amount || 0);
    if (payload.lines) {
      await client.query(
        `DELETE FROM withholding_certificate_lines WHERE organization_id=$1 AND certificate_id=$2`,
        [orgId, certificateId],
      );
      const openItems = await getOpenWithholdingItems({
        orgId,
        direction: "receivable",
        query: {},
      });
      const itemMap = new Map(openItems.map((item) => [item.source_id, item]));
      totalAmount = 0;
      for (const line of payload.lines) {
        const item = itemMap.get(line.sourceId);
        if (!item)
          throw new AppError(
            400,
            `Invoice ${line.sourceId} does not have open withholding receivable`,
          );
        const appliedAmount = Number(
          line.appliedAmount ?? item.outstanding_amount ?? 0,
        );
        if (
          appliedAmount <= 0 ||
          appliedAmount - Number(item.outstanding_amount || 0) > 0.0001
        )
          throw new AppError(
            400,
            `Invalid applied amount for ${item.document_no}`,
          );
        totalAmount += appliedAmount;
        await client.query(
          `INSERT INTO withholding_certificate_lines (organization_id, certificate_id, source_type, source_id, partner_id, tax_code_id, source_document_no, source_document_date, original_withholding_amount, available_amount, applied_amount) VALUES ($1,$2,'invoice',$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            orgId,
            certificateId,
            item.source_id,
            item.partner_id || null,
            item.tax_code_id || null,
            item.document_no,
            item.document_date || null,
            Number(item.withholding_total || 0),
            Number(item.outstanding_amount || 0),
            Number(appliedAmount.toFixed(2)),
          ],
        );
      }
    }
    const merged = { ...current, ...payload, total_amount: totalAmount };
    await client.query(
      `UPDATE withholding_certificates SET customer_id=$3, jurisdiction_id=$4, tax_code_id=$5, certificate_no=$6, certificate_date=$7, counter_account_id=$8, issued_by=$9, reference=$10, memo=$11, total_amount=$12, updated_by=$13, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [
        orgId,
        certificateId,
        merged.customer_id ?? merged.customerId ?? null,
        merged.jurisdiction_id ?? merged.jurisdictionId ?? null,
        merged.tax_code_id ?? merged.taxCodeId ?? null,
        merged.certificate_no ?? merged.certificateNo,
        merged.certificate_date ?? merged.certificateDate,
        merged.counter_account_id ?? merged.counterAccountId ?? null,
        merged.issued_by ?? merged.issuedBy ?? null,
        merged.reference || null,
        merged.memo || null,
        Number(totalAmount.toFixed(2)),
        actorUserId || null,
      ],
    );
    return getWithholdingCertificate({ orgId, certificateId, client });
  });
}

async function postWithholdingCertificate({
  orgId,
  certificateId,
  actorUserId,
  payload = {},
}) {
  return withTransaction(async (client) => {
    const cert = await getWithholdingCertificate({
      orgId,
      certificateId,
      client,
    });
    if (!["draft", "approved"].includes(cert.status))
      throw new AppError(
        409,
        "Only draft or approved certificates can be posted",
      );
    if (cert.workflow_document_id) {
      await documentableSvc.assertEntityApprovedForAction({
        orgId,
        entityType: "withholding_certificate",
        workflowDocumentId: cert.workflow_document_id,
        client,
        actionLabel: "post",
      });
    }
    const counterAccountId =
      payload.counterAccountId || cert.counter_account_id;
    if (!counterAccountId)
      throw new AppError(
        400,
        "counterAccountId is required to post certificate",
      );
    await assertAccountBelongsToOrg({
      orgId,
      accountId: counterAccountId,
      fieldName: "counterAccountId",
    });
    const { rows: settingsRows } = await client.query(
      `SELECT withholding_tax_receivable_account_id FROM tax_settings WHERE organization_id=$1`,
      [orgId],
    );
    const receivableAccountId =
      settingsRows[0]?.withholding_tax_receivable_account_id || null;
    if (!receivableAccountId)
      throw new AppError(
        409,
        "Withholding tax receivable account is not configured (tax_settings.withholding_tax_receivable_account_id)",
      );
    const period = await periodIF.findOpenPeriodForDate({
      orgId,
      date: payload.certificateDate || cert.certificate_date,
      client,
    });
    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      client,
      payload: {
        periodId: period.id,
        entryDate: payload.certificateDate || cert.certificate_date,
        typeCode: "GENERAL",
        memo:
          payload.memo ||
          cert.memo ||
          `Withholding certificate ${cert.certificate_no}`,
        idempotencyKey: `withholding-certificate:${certificateId}:post`,
        lines: [
          {
            accountId: counterAccountId,
            debit: Number(cert.total_amount || 0),
            credit: 0,
            description: `Recognize withholding certificate ${cert.certificate_no}`,
          },
          {
            accountId: receivableAccountId,
            debit: 0,
            credit: Number(cert.total_amount || 0),
            description: `Clear withholding receivable ${cert.certificate_no}`,
          },
        ],
      },
    });
    await propagateDocumentWorkflowToJournal({
      client,
      journalId: draft.journalId,
      source: {
        orgId,
        workflowDocumentId: cert.workflow_document_id || null,
        createdBy: cert.created_by || actorUserId || null,
        submittedAt: cert.submitted_at || null,
        submittedBy: cert.submitted_by || null,
        approvedAt: cert.approved_at || null,
        approvedBy: cert.approved_by || null,
        updatedBy: actorUserId || null,
      },
    });

    const posted = await journalIF.postDraftJournal({
      orgId,
      journalId: draft.journalId,
      actorUserId,
      client,
    });
    await client.query(
      `UPDATE withholding_certificates SET status='posted', counter_account_id=$3, certificate_date=$4, issued_by=$5, reference=$6, memo=$7, journal_entry_id=$8, posted_at=NOW(), posted_by=$9, updated_by=$9, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [
        orgId,
        certificateId,
        counterAccountId,
        payload.certificateDate || cert.certificate_date,
        payload.issuedBy || cert.issued_by || null,
        payload.reference || cert.reference || null,
        payload.memo || cert.memo || null,
        posted.journalId,
        actorUserId || null,
      ],
    );
    return getWithholdingCertificate({ orgId, certificateId, client });
  });
}

async function voidWithholdingCertificate({
  orgId,
  certificateId,
  actorUserId,
  reason,
}) {
  return withTransaction(async (client) => {
    const cert = await getWithholdingCertificate({
      orgId,
      certificateId,
      client,
    });
    if (cert.status !== "posted")
      throw new AppError(409, "Only posted certificates can be voided");
    if (!cert.journal_entry_id)
      throw new AppError(409, "Certificate has no posted journal to void");
    const reversal = await journalIF.voidPostedJournal({
      orgId,
      journalId: cert.journal_entry_id,
      actorUserId,
      reason,
      client,
    });
    await client.query(
      `UPDATE withholding_certificates SET status='voided', reversal_journal_entry_id=$3, voided_at=NOW(), voided_by=$4, updated_by=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [
        orgId,
        certificateId,
        reversal.journalId || reversal.reversalJournalId || null,
        actorUserId || null,
      ],
    );
    return getWithholdingCertificate({ orgId, certificateId, client });
  });
}

async function getWithholdingDashboard({ orgId, query = {} }) {
  const [openItems, remittances, certificates] = await Promise.all([
    listWithholdingOpenItems({ orgId, query }),
    listWithholdingRemittances({
      orgId,
      query: {
        status: query.status,
        periodStart: query.periodStart,
        periodEnd: query.periodEnd,
      },
    }),
    listWithholdingCertificates({
      orgId,
      query: {
        status: query.status,
        periodStart: query.periodStart,
        periodEnd: query.periodEnd,
      },
    }),
  ]);
  const sumOutstanding = (rows) =>
    rows.reduce(
      (acc, row) =>
        acc + Number(row.outstanding_amount || row.available_amount || 0),
      0,
    );
  const payableOpen = openItems.filter(
    (r) => String(r.direction || "").toLowerCase() === "payable",
  );
  const receivableOpen = openItems.filter(
    (r) => String(r.direction || "").toLowerCase() === "receivable",
  );
  return {
    open_payable_count: payableOpen.length,
    open_receivable_count: receivableOpen.length,
    open_payable_amount: Number(sumOutstanding(payableOpen).toFixed(2)),
    open_receivable_amount: Number(sumOutstanding(receivableOpen).toFixed(2)),
    remittance_draft_count: remittances.filter((r) =>
      ["draft", "submitted", "approved", "rejected"].includes(
        String(r.status || "").toLowerCase(),
      ),
    ).length,
    remittance_posted_count: remittances.filter(
      (r) => String(r.status || "").toLowerCase() === "posted",
    ).length,
    certificate_draft_count: certificates.filter((r) =>
      ["draft", "submitted", "approved", "rejected"].includes(
        String(r.status || "").toLowerCase(),
      ),
    ).length,
    certificate_posted_count: certificates.filter(
      (r) => String(r.status || "").toLowerCase() === "posted",
    ).length,
  };
}

async function submitWithholdingRemittanceForApproval({
  orgId,
  remittanceId,
  actorUserId,
}) {
  return withTransaction(async (client) => {
    const remittance = await getWithholdingRemittance({
      orgId,
      remittanceId,
      client,
    });
    if (!["draft", "rejected"].includes(remittance.status))
      throw new AppError(
        409,
        "Only draft or rejected remittances can be submitted",
      );
    const workflowDocument = await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "withholding_remittance",
      entity: remittance,
      workflowDocumentId: remittance.workflow_document_id,
      snapshot: { remittance, lines: remittance.lines || [] },
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await client.query(
          `UPDATE withholding_remittances SET workflow_document_id=$3 WHERE organization_id=$1 AND id=$2`,
          [orgId, remittanceId, workflowDocumentId],
        );
      },
    });
    await client.query(
      `UPDATE withholding_remittances SET status='submitted', submitted_at=NOW(), submitted_by=$3, rejection_reason=NULL, updated_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, remittanceId, actorUserId || null],
    );
    return getWithholdingRemittance({ orgId, remittanceId, client });
  });
}

async function approveWithholdingRemittance({
  orgId,
  remittanceId,
  actorUserId,
  comment,
}) {
  return withTransaction(async (client) => {
    const remittance = await getWithholdingRemittance({
      orgId,
      remittanceId,
      client,
    });
    if (!remittance.workflow_document_id)
      throw new AppError(409, "Remittance has no workflow document");
    await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: "withholding_remittance",
      workflowDocumentId: remittance.workflow_document_id,
      creatorUserId: remittance.created_by || null,
      comment: comment || null,
      client,
    });
    await client.query(
      `UPDATE withholding_remittances SET status='approved', approved_at=NOW(), approved_by=$3, updated_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, remittanceId, actorUserId || null],
    );
    return getWithholdingRemittance({ orgId, remittanceId, client });
  });
}

async function rejectWithholdingRemittance({
  orgId,
  remittanceId,
  actorUserId,
  reason,
}) {
  return withTransaction(async (client) => {
    const remittance = await getWithholdingRemittance({
      orgId,
      remittanceId,
      client,
    });
    if (!remittance.workflow_document_id)
      throw new AppError(409, "Remittance has no workflow document");
    await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: "withholding_remittance",
      workflowDocumentId: remittance.workflow_document_id,
      creatorUserId: remittance.created_by || null,
      comment: reason,
      client,
    });
    await client.query(
      `UPDATE withholding_remittances SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, remittanceId, actorUserId || null, reason || null],
    );
    return getWithholdingRemittance({ orgId, remittanceId, client });
  });
}

async function submitWithholdingCertificateForApproval({
  orgId,
  certificateId,
  actorUserId,
}) {
  return withTransaction(async (client) => {
    const certificate = await getWithholdingCertificate({
      orgId,
      certificateId,
      client,
    });
    if (!["draft", "rejected"].includes(certificate.status))
      throw new AppError(
        409,
        "Only draft or rejected certificates can be submitted",
      );
    await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "withholding_certificate",
      entity: certificate,
      workflowDocumentId: certificate.workflow_document_id,
      snapshot: { certificate, lines: certificate.lines || [] },
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await client.query(
          `UPDATE withholding_certificates SET workflow_document_id=$3 WHERE organization_id=$1 AND id=$2`,
          [orgId, certificateId, workflowDocumentId],
        );
      },
    });
    await client.query(
      `UPDATE withholding_certificates SET status='submitted', submitted_at=NOW(), submitted_by=$3, rejection_reason=NULL, updated_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, certificateId, actorUserId || null],
    );
    return getWithholdingCertificate({ orgId, certificateId, client });
  });
}

async function approveWithholdingCertificate({
  orgId,
  certificateId,
  actorUserId,
  comment,
}) {
  return withTransaction(async (client) => {
    const certificate = await getWithholdingCertificate({
      orgId,
      certificateId,
      client,
    });
    if (!certificate.workflow_document_id)
      throw new AppError(409, "Certificate has no workflow document");
    await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: "withholding_certificate",
      workflowDocumentId: certificate.workflow_document_id,
      creatorUserId: certificate.created_by || null,
      comment: comment || null,
      client,
    });
    await client.query(
      `UPDATE withholding_certificates SET status='approved', approved_at=NOW(), approved_by=$3, updated_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, certificateId, actorUserId || null],
    );
    return getWithholdingCertificate({ orgId, certificateId, client });
  });
}

async function rejectWithholdingCertificate({
  orgId,
  certificateId,
  actorUserId,
  reason,
}) {
  return withTransaction(async (client) => {
    const certificate = await getWithholdingCertificate({
      orgId,
      certificateId,
      client,
    });
    if (!certificate.workflow_document_id)
      throw new AppError(409, "Certificate has no workflow document");
    await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: "withholding_certificate",
      workflowDocumentId: certificate.workflow_document_id,
      creatorUserId: certificate.created_by || null,
      comment: reason,
      client,
    });
    await client.query(
      `UPDATE withholding_certificates SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, certificateId, actorUserId || null, reason || null],
    );
    return getWithholdingCertificate({ orgId, certificateId, client });
  });
}
async function listWithholdingOpenItems({ orgId, query = {} }) {
  const direction = query?.direction || "payable";
  return getOpenWithholdingItems({ orgId, direction, query });
}


// ==================== GHANA TAX WORKSPACE HELPERS ====================
function parseMoneyUnits(value, scale = FINANCIAL_SCALE.money) {
  try {
    const units = parseDecimalRoundedToBigInt(value ?? "0", scale, 6);
    if (units < 0n) throw new Error("negative");
    return units;
  } catch (_) {
    throw new AppError(400, "amount must be a non-negative decimal value");
  }
}

function parseRateMicros(value) {
  try {
    return parsePercentagePoints(value ?? "0", FINANCIAL_SCALE.percentagePoints);
  } catch (_) {
    throw new AppError(400, "rate must be a non-negative decimal value");
  }
}

function formatUnits(units, scale = FINANCIAL_SCALE.money) {
  return bigIntToDecimalString(units, scale);
}

function percentOfUnits(baseUnits, rateMicros) {
  return applyPercentagePointUnits(baseUnits, rateMicros, FINANCIAL_SCALE.percentagePoints);
}

async function getGhanaSetupChecklist({ orgId }) {
  const [packs, jurisdictions, codes, settings, registrations, templates, rules, catalogProfiles] = await Promise.all([
    listCountryPacks({ orgId }),
    listJurisdictions({ orgId }),
    listTaxCodes({ orgId, query: {} }),
    getTaxSettings({ orgId }),
    listTaxRegistrations({ orgId, query: {} }),
    listTaxReturnTemplates({ orgId, query: {} }),
    listTaxRules({ orgId, query: {} }),
    listTaxCatalogProfiles({ orgId, query: { status: "active" } }),
  ]);
  const ghPack = packs.find((p) => String(p.country_code || p.countryCode || "").toUpperCase() === "GH");
  const ghJurisdiction = jurisdictions.find((j) => String(j.code || "").toUpperCase() === "GH");
  const ghCodes = codes.filter((c) => String(c.code || "").startsWith("GH_"));
  const ghVat = ghCodes.find((c) => c.code === "GH_VAT_EFFECTIVE_20");
  const ghWht = ghCodes.filter((c) => String(c.tax_type || c.taxType || "").includes("WITHHOLDING"));
  const importedServicesCode = ghCodes.find((c) => c.code === "GH_IMPORTED_SERVICES_20");
  const ghWhVat = ghCodes.find((c) => c.code === "GH_WHVAT_7");
  const ghCatalogProfiles = catalogProfiles.filter((p) => String(p.code || "").startsWith("GH_"));
  const ghTemplates = templates.filter((t) => String(t.code || t.template_code || "").startsWith("GH_"));
  const requiredSettings = [
    ["Output tax account", settings.output_tax_account_id],
    ["Input tax account", settings.input_tax_account_id],
    ["Withholding payable account", settings.withholding_tax_payable_account_id],
    ["Withholding receivable account", settings.withholding_tax_receivable_account_id],
    ["Non-recoverable input tax account", settings.non_recoverable_input_tax_account_id],
    ["Reverse-charge tax account", settings.reverse_charge_tax_account_id || settings.output_tax_account_id],
    ["VAT withholding payable account", settings.vat_withholding_payable_account_id],
  ];
  const checklist = [
    { key: "ghana_pack", label: "Install Ghana tax country pack", complete: !!ghPack?.is_installed || !!ghPack?.isInstalled, action: "Install Ghana defaults" },
    { key: "ghana_jurisdiction", label: "Create Ghana tax jurisdiction", complete: !!ghJurisdiction, action: "Install workflows or create GH jurisdiction" },
    { key: "ghana_vat", label: "Install Ghana VAT/NHIL/GETFund codes", complete: !!ghVat, action: "Install Ghana defaults" },
    { key: "ghana_wht", label: "Install Ghana withholding tax codes", complete: ghWht.length >= 5, action: "Install Ghana defaults" },
    { key: "ghana_templates", label: "Install Ghana return templates", complete: ghTemplates.length >= 2, action: "Install Ghana defaults" },
    { key: "ghana_catalog_profiles", label: "Configure Ghana taxable/exempt/zero-rated catalog profiles", complete: ghCatalogProfiles.some((p) => p.code === "GH_STANDARD_GOODS") && ghCatalogProfiles.some((p) => p.code === "GH_EXEMPT_SUPPLY") && ghCatalogProfiles.some((p) => p.code === "GH_ZERO_RATED_EXPORT"), action: "Install Ghana defaults and classify products/services" },
    { key: "ghana_mixed_input", label: "Enable mixed-input recovery classification", complete: ghCatalogProfiles.some((p) => p.code === "GH_MIXED_INPUT"), action: "Run migration 149 or add a mixed-use tax profile" },
    { key: "ghana_imported_services", label: "Install Ghana imported-services VAT code", complete: !!importedServicesCode, action: "Run migration 149 / update Ghana tax pack" },
    { key: "ghana_whvat", label: "Install Ghana VAT withholding 7% regime", complete: !!ghWhVat, action: "Run migration 150 / update Ghana tax pack" },
    { key: "ghana_vat_monitor", label: "Enable VAT registration threshold monitoring", complete: settings.gh_vat_monitor_enabled !== false, action: "Enable the Ghana VAT registration monitor in Tax Settings" },
    { key: "tax_registration", label: "Add the organisation's GRA tax registration", complete: registrations.length > 0, action: "Create tax registration" },
    { key: "tax_rules", label: "Enable default tax determination rules", complete: rules.some((r) => String(r.name || "").toLowerCase().includes("ghana")), action: "Install workflows" },
    ...requiredSettings.map(([label, value]) => ({ key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label, complete: !!value, action: "Map tax posting account" })),
  ];
  return { country: "GH", pack: ghPack || null, ready: checklist.every((i) => i.complete), checklist };
}

async function getGhanaTaxDiagnostics({ orgId }) {
  const checklist = await getGhanaSetupChecklist({ orgId });
  const settings = await getTaxSettings({ orgId });
  const codes = await listTaxCodes({ orgId, query: { status: "active" } });
  const issues = [];
  for (const item of checklist.checklist) {
    if (!item.complete) issues.push({ severity: "warning", code: `setup_${item.key}`, message: item.label, recommendation: item.action });
  }
  for (const code of codes.filter((c) => String(c.code || "").startsWith("GH_"))) {
    const type = String(code.tax_type || code.taxType || "");
    if (!code.posting_account_id && ["VAT", "IMPORT", "OTHER", "WITHHOLDING"].includes(type)) {
      issues.push({ severity: "info", code: "tax_code_no_posting_account", message: `${code.code} has no code-specific posting account.`, recommendation: "Use default tax settings or map a posting account on the tax code." });
    }
    const meta = code.metadata || {};
    if (Number(code.rate || 0) === 0 && meta.calculation) {
      issues.push({ severity: "info", code: "configurable_tax_code", message: `${code.code} is configurable.`, recommendation: meta.calculation });
    }
  }
  if (!settings.tax_rounding_strategy) issues.push({ severity: "warning", code: "missing_rounding_strategy", message: "Tax rounding strategy is not configured.", recommendation: "Set line or total rounding in Tax Settings." });
  return { ready: issues.filter((i) => i.severity === "warning" || i.severity === "error").length === 0, issueCount: issues.length, issues, checklist: checklist.checklist };
}

async function calculateGhanaTax({ orgId, payload }) {
  const baseAmount = payload.baseAmount ?? payload.amount;
  const inclusive = payload.inclusive === true || payload.calculationMode === "inclusive";
  const taxCode = payload.taxCode || payload.taxCodeCode || null;
  const taxCodeId = payload.taxCodeId || null;
  if (!taxCode && !taxCodeId) throw new AppError(400, "taxCode or taxCodeId is required");
  const params = [orgId];
  let where = "organization_id=$1";
  if (taxCodeId) { params.push(taxCodeId); where += ` AND id=$${params.length}`; }
  else { params.push(taxCode); where += ` AND code=$${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM tax_codes WHERE ${where} LIMIT 1`, params);
  const parent = rows[0];
  if (!parent) throw new AppError(404, "Tax code not found");

  const baseUnits = parseMoneyUnits(baseAmount);
  let componentRows = [];
  if (parent.is_compound) {
    const { rows: comps } = await pool.query(
      `SELECT c.*, COALESCE(tcc.rate_override, c.rate) AS effective_rate
         FROM tax_code_components tcc
         JOIN tax_codes c ON c.id=tcc.component_tax_code_id
        WHERE tcc.organization_id=$1 AND tcc.parent_tax_code_id=$2
        ORDER BY tcc.sequence_no, c.code`,
      [orgId, parent.id],
    );
    componentRows = comps;
  }
  if (!componentRows.length) componentRows = [{ ...parent, effective_rate: parent.rate }];
  const totalRateMicros = componentRows.reduce((sum, c) => sum + parseRateMicros(c.effective_rate ?? c.rate ?? 0), 0n);
  let taxableUnits = baseUnits;
  if (inclusive && totalRateMicros > 0n) {
    const denom = 100n * 1000000n + totalRateMicros;
    taxableUnits = (baseUnits * 100n * 1000000n + denom / 2n) / denom;
  }
  const components = componentRows.map((c) => {
    const rateMicros = parseRateMicros(c.effective_rate ?? c.rate ?? 0);
    const threshold = c.metadata?.thresholdAmount ?? c.metadata?.threshold_amount ?? c.thresholdAmount ?? null;
    const thresholdUnits = threshold ? parseMoneyUnits(threshold) : null;
    const amountUnits = thresholdUnits && taxableUnits < thresholdUnits ? 0n : percentOfUnits(taxableUnits, rateMicros);
    return { taxCodeId: c.id, code: c.code, name: c.name, rate: String(c.effective_rate ?? c.rate ?? 0), amount: formatUnits(amountUnits), skippedByThreshold: !!(thresholdUnits && taxableUnits < thresholdUnits) };
  });
  const taxUnits = components.reduce((sum, c) => sum + parseMoneyUnits(c.amount), 0n);
  return {
    taxCode: { id: parent.id, code: parent.code, name: parent.name, isCompound: !!parent.is_compound },
    calculationMode: inclusive ? "inclusive" : "exclusive",
    baseAmount: formatUnits(taxableUnits),
    enteredAmount: formatUnits(baseUnits),
    taxAmount: formatUnits(taxUnits),
    grossAmount: formatUnits(inclusive ? baseUnits : baseUnits + taxUnits),
    components,
  };
}

async function installGhanaTaxWorkflows({ orgId, actorUserId }) {
  const packResult = await installCountryPack({ orgId, actorUserId, payload: { packCode: "GH-TAX-2026-COMPLETE" } });
  const { rows: tplRows } = await pool.query(
    `SELECT id, code FROM tax_return_templates WHERE organization_id=$1 AND code IN ('GH_VAT_2026','GH_WHT_2026') ORDER BY code`,
    [orgId],
  );
  const defaultTemplate = tplRows.find((r) => r.code === "GH_VAT_2026") || tplRows[0];
  if (defaultTemplate) {
    await updateTaxReturnConfig({
      orgId,
      actorUserId,
      payload: { defaultTemplateId: defaultTemplate.id, autoSubmitEnabled: false, filingMethod: "manual" },
    });
  }
  await upsertAutomationRule({
    orgId,
    actorUserId,
    payload: {
      code: "gh_vat_monthly_return_reminder",
      name: "Ghana monthly VAT return reminder",
      triggerCode: "return_due",
      scheduleCode: "weekly",
      scope: { countryCode: "GH", taxType: "VAT", cadence: "monthly" },
      action: { type: "notify", message: "Review and prepare Ghana VAT/NHIL/GETFund return." },
      isEnabled: true,
    },
  });
  await upsertAutomationRule({
    orgId,
    actorUserId,
    payload: {
      code: "gh_income_wht_monthly_remittance_reminder",
      name: "Ghana withholding remittance reminder",
      triggerCode: "return_due",
      scheduleCode: "weekly",
      scope: { countryCode: "GH", taxType: "WITHHOLDING", cadence: "monthly" },
      action: { type: "notify", message: "Review withholding open items and prepare remittance." },
      isEnabled: true,
    },
  });
  await upsertAutomationRule({
    orgId,
    actorUserId,
    payload: {
      code: "gh_whvat_monthly_return_reminder",
      name: "Ghana VAT withholding return reminder",
      triggerCode: "return_due",
      scheduleCode: "weekly",
      scope: { countryCode: "GH", taxType: "WITHHOLDING", regime: "vat_withholding", cadence: "monthly", dueDay: 15 },
      action: { type: "notify", message: "Review VAT withholding certificates, WHVAT return and remittance due by the 15th." },
      isEnabled: true,
    },
  });
  return { installed: true, pack: packResult, configuredTemplates: tplRows.length, automationRules: 3, checklist: await getGhanaSetupChecklist({ orgId }) };
}

// ==================== MODULE EXPORTS ====================

module.exports = {
  // Core tax functions
  listTaxRegistrations,
  createTaxRegistration,
  updateTaxRegistration,
  deleteTaxRegistration,
  getTaxRegistrationById,
  listJurisdictions,
  createJurisdiction,
  updateJurisdiction,
  deleteJurisdiction,
  listTaxRules,
  createTaxRule,
  updateTaxRule,
  deleteTaxRule,
  getTaxRuleById,
  listTaxCatalogProfiles,
  getTaxCatalogProfileById,
  createTaxCatalogProfile,
  updateTaxCatalogProfile,
  deleteTaxCatalogProfile,
  listTaxLedgerEntries,
  listTaxCodes,
  createTaxCode,
  updateTaxCode,
  deleteTaxCode,
  getTaxSettings,
  setTaxSettings,
  getTaxAdjustmentById,
  listTaxAdjustments,
  createTaxAdjustment,
  postTaxAdjustment,
  voidTaxAdjustment,
  listTaxCodeComponents,
  setTaxCodeComponents,

  // Partner Tax Profiles
  listPartnerTaxProfiles,
  getPartnerTaxProfile,
  createPartnerTaxProfile,
  updatePartnerTaxProfile,
  deletePartnerTaxProfile,

  // Tax Return Templates
  listTaxReturnTemplates,
  getTaxReturnTemplate,
  createTaxReturnTemplate,
  updateTaxReturnTemplate,
  deleteTaxReturnTemplate,

  // Tax Returns
  listTaxReturns,
  getTaxReturn,
  createTaxReturn,
  submitTaxReturn,
  getTaxReturnConfig,
  updateTaxReturnConfig,

  // E-invoicing
  getEinvoicingSettings,
  updateEinvoicingSettings,

  // Filing Adapters
  listFilingAdapters,
  getFilingAdapter,
  createFilingAdapter,
  updateFilingAdapter,
  deleteFilingAdapter,
  testFilingAdapter,

  // Country Packs
  listCountryPacks,
  installCountryPack,

  // Automation Rules
  listAutomationRules,
  upsertAutomationRule,

  // Ghana tax workspace
  getGhanaSetupChecklist,
  getGhanaTaxDiagnostics,
  calculateGhanaTax,
  installGhanaTaxWorkflows,

  // Withholding lifecycle
  getWithholdingDashboard,
  listWithholdingOpenItems,
  createWithholdingRemittance,
  listWithholdingRemittances,
  getWithholdingRemittance,
  updateWithholdingRemittance,
  submitWithholdingRemittanceForApproval,
  approveWithholdingRemittance,
  rejectWithholdingRemittance,
  postWithholdingRemittance,
  voidWithholdingRemittance,
  createWithholdingCertificate,
  getOpenWithholdingItems,
  listWithholdingCertificates,
  getWithholdingCertificate,
  updateWithholdingCertificate,
  submitWithholdingCertificateForApproval,
  approveWithholdingCertificate,
  rejectWithholdingCertificate,
  postWithholdingCertificate,
  voidWithholdingCertificate,
};
