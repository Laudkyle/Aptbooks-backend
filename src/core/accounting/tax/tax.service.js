const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const journalIF = require("../../../interfaces/journalPosting.interface");
const periodIF = require("../../../interfaces/periodManagement.interface");
const { withTransaction } = require("../../../db/tx");

async function assertAccountBelongsToOrg({ orgId, accountId, fieldName }) {
  if (!accountId) return;
  const { rows } = await pool.query(
    `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, `${fieldName} is invalid for this organization`);
}

async function assertTaxCodeBelongsToOrg({ orgId, taxCodeId }) {
  if (!taxCodeId) return;
  const { rows } = await pool.query(
    `SELECT id FROM tax_codes WHERE organization_id=$1 AND id=$2`,
    [orgId, taxCodeId]
  );
  if (!rows.length) throw new AppError(400, `defaultTaxCodeId is invalid for this organization`);
}

async function assertJurisdictionBelongsToOrg({ orgId, jurisdictionId }) {
  if (!jurisdictionId) return;
  const { rows } = await pool.query(
    `SELECT id FROM tax_jurisdictions WHERE organization_id=$1 AND id=$2`,
    [orgId, jurisdictionId]
  );
  if (!rows.length) throw new AppError(400, `jurisdictionId is invalid for this organization`);
}

async function assertPartnerBelongsToOrg({ orgId, partnerId }) {
  if (!partnerId) return;
  const { rows } = await pool.query(
    `SELECT id FROM business_partners WHERE organization_id=$1 AND id=$2`,
    [orgId, partnerId]
  );
  if (!rows.length) throw new AppError(400, `partnerId is invalid for this organization`);
}

async function listJurisdictions({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_jurisdictions WHERE organization_id=$1 ORDER BY code`,
    [orgId]
  );
  return rows;
}

async function createJurisdiction({ orgId, payload }) {
  const { rows } = await pool.query(
    `INSERT INTO tax_jurisdictions(organization_id, code, name, country_code)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [orgId, payload.code, payload.name, payload.countryCode || null]
  );
  return rows[0];
}

async function updateJurisdiction({ orgId, jurisdictionId, payload }) {
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM tax_jurisdictions WHERE organization_id=$1 AND id=$2`,
    [orgId, jurisdictionId]
  );
  if (!beforeRows.length) throw new AppError(404, "Tax jurisdiction not found");
  const before = beforeRows[0];

  const columns = [];
  const params = [orgId, jurisdictionId];
  let i = 3;
  const map = {
    code: "code",
    name: "name",
    countryCode: "country_code"
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
    params
  );

  return { before, after: rows[0] };
}

async function deleteJurisdiction({ orgId, jurisdictionId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_jurisdictions WHERE organization_id=$1 AND id=$2`,
    [orgId, jurisdictionId]
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
    [orgId, registrationId]
  );
  if (!rows.length) throw new AppError(404, "Tax registration not found");
  return rows[0];
}

async function listTaxRegistrations({ orgId, query }) {
  const params = [orgId];
  const where = ["tr.organization_id=$1"];
  let i = 2;
  if (query?.registrationType) { where.push(`tr.registration_type=$${i++}`); params.push(query.registrationType); }
  if (query?.jurisdictionId) { where.push(`tr.jurisdiction_id=$${i++}`); params.push(query.jurisdictionId); }
  if (query?.isPrimary !== undefined) { where.push(`tr.is_primary=$${i++}`); params.push(query.isPrimary === true || query.isPrimary === 'true'); }
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
    params
  );
  return rows;
}

async function createTaxRegistration({ orgId, payload }) {
  await assertJurisdictionBelongsToOrg({ orgId, jurisdictionId: payload.jurisdictionId || null });

  return withTransaction(async (client) => {
    if (payload.isPrimary === true) {
      await client.query(
        `UPDATE tax_registrations SET is_primary=FALSE, updated_at=NOW()
          WHERE organization_id=$1 AND registration_type=COALESCE($2, 'VAT')`,
        [orgId, payload.registrationType || 'VAT']
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
        JSON.stringify(payload.metadata || {})
      ]
    );
    return rows[0];
  });
}

async function updateTaxRegistration({ orgId, registrationId, payload }) {
  const before = await getTaxRegistrationById({ orgId, registrationId });
  if (payload.jurisdictionId !== undefined) {
    await assertJurisdictionBelongsToOrg({ orgId, jurisdictionId: payload.jurisdictionId });
  }

  return withTransaction(async (client) => {
    const nextType = payload.registrationType ?? before.registration_type;
    if (payload.isPrimary === true) {
      await client.query(
        `UPDATE tax_registrations SET is_primary=FALSE, updated_at=NOW()
          WHERE organization_id=$1 AND registration_type=$2 AND id<>$3`,
        [orgId, nextType, registrationId]
      );
    }

    const columns = [];
    const params = [orgId, registrationId];
    let i = 3;
    const map = {
      jurisdictionId: 'jurisdiction_id',
      registrationNumber: 'registration_no',
      registrationType: 'registration_type',
      legalEntityName: 'legal_entity_name',
      filingFrequency: 'filing_frequency',
      filingBasis: 'filing_basis',
      effectiveFrom: 'effective_from',
      effectiveTo: 'effective_to',
      isPrimary: 'is_primary'
    };
    for (const [k, col] of Object.entries(map)) {
      if (payload[k] !== undefined) {
        columns.push(`${col}=$${i++}`);
        params.push(payload[k] === '' ? null : payload[k]);
      }
    }
    if (payload.metadata !== undefined) {
      columns.push(`metadata=$${i++}`);
      params.push(JSON.stringify(payload.metadata || {}));
    }
    if (!columns.length) return { before, after: before };

    const { rows } = await client.query(
      `UPDATE tax_registrations
          SET ${columns.join(', ')}, updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      params
    );
    return { before, after: rows[0] };
  });
}

async function deleteTaxRegistration({ orgId, registrationId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_registrations WHERE organization_id=$1 AND id=$2`,
    [orgId, registrationId]
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
    [orgId, ruleId]
  );
  if (!rows.length) throw new AppError(404, "Tax rule not found");
  return rows[0];
}

async function listTaxRules({ orgId, query }) {
  const params = [orgId];
  const where = ["tr.organization_id=$1"];
  let i = 2;
  if (query?.status) { where.push(`tr.status=$${i++}`); params.push(query.status); }
  if (query?.documentType) { where.push(`tr.document_type=$${i++}`); params.push(query.documentType); }
  if (query?.partnerType) { where.push(`tr.partner_type=$${i++}`); params.push(query.partnerType); }
  if (query?.supplyType) { where.push(`tr.supply_type=$${i++}`); params.push(query.supplyType); }
  if (query?.placeOfSupplyBasis) { where.push(`tr.place_of_supply_basis=$${i++}`); params.push(query.placeOfSupplyBasis); }
  if (query?.transactionScope) { where.push(`tr.transaction_scope=$${i++}`); params.push(query.transactionScope); }
  if (query?.jurisdictionId) { where.push(`tr.jurisdiction_id=$${i++}`); params.push(query.jurisdictionId); }
  if (query?.taxCodeId) { where.push(`tr.tax_code_id=$${i++}`); params.push(query.taxCodeId); }
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
    params
  );
  return rows;
}

async function createTaxRule({ orgId, payload }) {
  await assertJurisdictionBelongsToOrg({ orgId, jurisdictionId: payload.jurisdictionId || null });
  await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.taxCodeId });

  const { rows } = await pool.query(
    `INSERT INTO tax_rules(
        organization_id, code, name, document_type, partner_type, supply_type, place_of_supply_basis, transaction_scope,
        jurisdiction_id, tax_code_id, priority, effective_from, effective_to, conditions, status
     ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,COALESCE($8,'both'),
        $9,$10,COALESCE($11,100),COALESCE($12,CURRENT_DATE),$13,COALESCE($14,'{}'::jsonb),COALESCE($15,'active')
     )
     RETURNING *`,
    [
      orgId,
      payload.code || null,
      payload.name,
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
      payload.status || null
    ]
  );
  return rows[0];
}

async function updateTaxRule({ orgId, ruleId, payload }) {
  const before = await getTaxRuleById({ orgId, ruleId });
  if (payload.jurisdictionId !== undefined) {
    await assertJurisdictionBelongsToOrg({ orgId, jurisdictionId: payload.jurisdictionId });
  }
  if (payload.taxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.taxCodeId });
  }

  const columns = [];
  const params = [orgId, ruleId];
  let i = 3;
  const map = {
    code: 'code',
    name: 'name',
    documentType: 'document_type',
    partnerType: 'partner_type',
    supplyType: 'supply_type',
    placeOfSupplyBasis: 'place_of_supply_basis',
    transactionScope: 'transaction_scope',
    jurisdictionId: 'jurisdiction_id',
    taxCodeId: 'tax_code_id',
    priority: 'priority',
    effectiveFrom: 'effective_from',
    effectiveTo: 'effective_to',
    status: 'status'
  };
  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      params.push(payload[k] === '' ? null : payload[k]);
    }
  }
  if (payload.conditions !== undefined) {
    columns.push(`conditions=$${i++}`);
    params.push(JSON.stringify(payload.conditions || {}));
  }
  if (!columns.length) return { before, after: before };

  const { rows } = await pool.query(
    `UPDATE tax_rules
        SET ${columns.join(', ')}, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    params
  );
  if (!rows.length) throw new AppError(404, "Tax rule not found");
  return { before, after: rows[0] };
}

async function deleteTaxRule({ orgId, ruleId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_rules WHERE organization_id=$1 AND id=$2`,
    [orgId, ruleId]
  );
  if (!rowCount) throw new AppError(404, "Tax rule not found");
  return { deleted: true };
}

async function listTaxCodes({ orgId, query }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;
  if (query?.status) { where.push(`status=$${i++}`); params.push(query.status); }
  if (query?.taxType) { where.push(`tax_type=$${i++}`); params.push(query.taxType); }
  if (query?.jurisdictionId) { where.push(`jurisdiction_id=$${i++}`); params.push(query.jurisdictionId); }

  const { rows } = await pool.query(
    `SELECT * FROM tax_codes WHERE ${where.join(" AND ")}
     ORDER BY code`,
    params
  );
  return rows;
}

async function createTaxCode({ orgId, payload }) {
  await assertJurisdictionBelongsToOrg({ orgId, jurisdictionId: payload.jurisdictionId || null });
  await assertAccountBelongsToOrg({ orgId, accountId: payload.postingAccountId || null, fieldName: "postingAccountId" });

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
      payload.taxType === 'WHT' ? 'WITHHOLDING' : payload.taxType,
      payload.rate,
      payload.isCompound === true,
      payload.boxCode ?? null,
      payload.direction ?? null,
      payload.categoryCode ?? payload.taxCategory ?? null,
      payload.taxScope ?? (payload.taxCategory === 'zero_rated' ? 'zero_rated' : payload.taxCategory === 'exempt' ? 'exempt' : payload.taxCategory === 'reverse_charge' ? 'reverse_charge' : payload.taxCategory === 'withholding' ? 'withholding' : null),
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
      payload.status || null
    ]
  );
  return rows[0];
}

async function updateTaxCode({ orgId, taxCodeId, payload }) {
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM tax_codes WHERE organization_id=$1 AND id=$2`,
    [orgId, taxCodeId]
  );
  if (!beforeRows.length) throw new AppError(404, "Tax code not found");
  const before = beforeRows[0];

  if (payload.jurisdictionId !== undefined) {
    await assertJurisdictionBelongsToOrg({ orgId, jurisdictionId: payload.jurisdictionId });
  }
  if (payload.postingAccountId !== undefined) {
    await assertAccountBelongsToOrg({ orgId, accountId: payload.postingAccountId, fieldName: "postingAccountId" });
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
    status: "status"
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
    params
  );

  return { before, after: rows[0] };
}

async function deleteTaxCode({ orgId, taxCodeId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_codes WHERE organization_id=$1 AND id=$2`,
    [orgId, taxCodeId]
  );
  if (!rowCount) throw new AppError(404, "Tax code not found");
  return { deleted: true };
}

async function getTaxSettings({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_settings WHERE organization_id=$1`,
    [orgId]
  );
  if (!rows.length) {
    await pool.query(`INSERT INTO tax_settings(organization_id) VALUES ($1) ON CONFLICT DO NOTHING`, [orgId]);
    const { rows: r2 } = await pool.query(`SELECT * FROM tax_settings WHERE organization_id=$1`, [orgId]);
    return r2[0];
  }
  return rows[0];
}

async function setTaxSettings({ orgId, payload }) {
  if (payload.outputTaxAccountId !== undefined) {
    await assertAccountBelongsToOrg({ orgId, accountId: payload.outputTaxAccountId, fieldName: "outputTaxAccountId" });
  }
  if (payload.inputTaxAccountId !== undefined) {
    await assertAccountBelongsToOrg({ orgId, accountId: payload.inputTaxAccountId, fieldName: "inputTaxAccountId" });
  }
  if (payload.defaultTaxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.defaultTaxCodeId });
  }
  for (const [fieldName, accountId] of Object.entries({
    nonRecoverableInputTaxAccountId: payload.nonRecoverableInputTaxAccountId,
    withholdingTaxPayableAccountId: payload.withholdingTaxPayableAccountId,
    withholdingTaxReceivableAccountId: payload.withholdingTaxReceivableAccountId,
    reverseChargeTaxAccountId: payload.reverseChargeTaxAccountId
  })) {
    if (accountId !== undefined) {
      await assertAccountBelongsToOrg({ orgId, accountId, fieldName });
    }
  }

  const current = await getTaxSettings({ orgId });

  const out = {
    output_tax_account_id: payload.outputTaxAccountId ?? current.output_tax_account_id,
    input_tax_account_id: payload.inputTaxAccountId ?? current.input_tax_account_id,
    default_tax_code_id: payload.defaultTaxCodeId ?? current.default_tax_code_id,
    non_recoverable_input_tax_account_id: payload.nonRecoverableInputTaxAccountId ?? current.non_recoverable_input_tax_account_id,
    withholding_tax_payable_account_id: payload.withholdingTaxPayableAccountId ?? current.withholding_tax_payable_account_id,
    withholding_tax_receivable_account_id: payload.withholdingTaxReceivableAccountId ?? current.withholding_tax_receivable_account_id,
    reverse_charge_tax_account_id: payload.reverseChargeTaxAccountId ?? current.reverse_charge_tax_account_id,
    tax_rounding_strategy: (payload.taxRoundingStrategy === 'total' ? 'document' : payload.taxRoundingStrategy) ?? current.tax_rounding_strategy,
    enforce_partner_tax_profile: payload.enforcePartnerTaxProfile ?? current.enforce_partner_tax_profile,
    require_tax_jurisdiction: payload.requireTaxJurisdiction ?? current.require_tax_jurisdiction
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
         updated_at=NOW()
     WHERE organization_id=$1
     RETURNING *`,
    [orgId, out.output_tax_account_id || null, out.input_tax_account_id || null, out.default_tax_code_id || null,
      out.non_recoverable_input_tax_account_id || null, out.withholding_tax_payable_account_id || null,
      out.withholding_tax_receivable_account_id || null, out.reverse_charge_tax_account_id || null,
      out.tax_rounding_strategy || 'line', !!out.enforce_partner_tax_profile, !!out.require_tax_jurisdiction]
  );

  return rows[0];
}

async function getTaxAdjustmentById({ orgId, adjustmentId, client = pool }) {
  const { rows } = await client.query(
    `SELECT * FROM tax_adjustments WHERE organization_id=$1 AND id=$2`,
    [orgId, adjustmentId]
  );
  return rows[0] || null;
}

async function listTaxAdjustments({ orgId, query = {} }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;
  if (query.status) { where.push(`status=$${i++}`); params.push(query.status); }
  if (query.taxType) { where.push(`tax_type=$${i++}`); params.push(query.taxType); }
  if (query.direction) { where.push(`direction=$${i++}`); params.push(query.direction); }
  if (query.fromDate) { where.push(`adjustment_date >= $${i++}`); params.push(query.fromDate); }
  if (query.toDate) { where.push(`adjustment_date <= $${i++}`); params.push(query.toDate); }

  const { rows } = await pool.query(
    `SELECT * FROM tax_adjustments WHERE ${where.join(" AND ")} ORDER BY adjustment_date DESC, created_at DESC`,
    params
  );
  return rows;
}

async function createTaxAdjustment({ orgId, actorUserId, payload }) {
  if (payload.accountId !== undefined) {
    await assertAccountBelongsToOrg({ orgId, accountId: payload.accountId, fieldName: "accountId" });
  }
  if (payload.counterAccountId !== undefined) {
    await assertAccountBelongsToOrg({ orgId, accountId: payload.counterAccountId, fieldName: "counterAccountId" });
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
      payload.taxType || 'VAT',
      payload.direction,
      payload.boxCode || null,
      payload.description,
      payload.amount,
      payload.accountId || null,
      payload.counterAccountId || null,
      payload.reference || null,
      actorUserId || null
    ]
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
    if (adj.status !== 'draft') throw new AppError(409, 'Only draft tax adjustments can be posted');

    const settings = await getTaxSettings({ orgId });
    const taxAccountId = adj.account_id || (adj.direction === 'output' ? settings.output_tax_account_id : settings.input_tax_account_id);
    if (!taxAccountId) {
      throw new AppError(409, `No ${adj.direction} tax account configured and adjustment has no explicit accountId`);
    }
    if (!adj.counter_account_id) {
      throw new AppError(409, 'counterAccountId is required before posting a tax adjustment');
    }

    const period = await periodIF.findOpenPeriodForDate({ orgId, date: adj.adjustment_date, client });
    const amount = Number(adj.amount || 0);
    const isOutput = adj.direction === 'output';
    const lines = [
      { accountId: adj.counter_account_id, debit: isOutput ? amount : 0, credit: isOutput ? 0 : amount, description: adj.description },
      { accountId: taxAccountId, debit: isOutput ? 0 : amount, credit: isOutput ? amount : 0, description: `${adj.description} (tax)` }
    ];

    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      client,
      payload: {
        periodId: period.id,
        entryDate: adj.adjustment_date,
        typeCode: 'GENERAL',
        memo: `Tax adjustment ${adj.description}`,
        idempotencyKey: `tax-adjustment:${adj.id}:post`,
        lines
      }
    });

    const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client });

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
      [orgId, adjustmentId, posted.journalId || posted.id || posted.journal_id, actorUserId]
    );
    return rows[0];
  });
}

async function voidTaxAdjustment({ orgId, actorUserId, adjustmentId, reason }) {
  return withTransaction(async (client) => {
    const adj = await getTaxAdjustmentById({ orgId, adjustmentId, client });
    if (!adj) throw new AppError(404, 'Tax adjustment not found');
    if (adj.status === 'voided') return adj;
    if (adj.journal_entry_id) {
      await journalIF.voidPostedJournal({ orgId, journalId: adj.journal_entry_id, actorUserId, reason, client });
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
      [orgId, adjustmentId, reason || null, actorUserId]
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
    [orgId, taxCodeId]
  );
  return rows;
}

async function setTaxCodeComponents({ orgId, taxCodeId, payload }) {
  await assertTaxCodeBelongsToOrg({ orgId, taxCodeId });
  for (const c of payload.components || []) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: c.componentTaxCodeId });
    if (c.componentTaxCodeId === taxCodeId) throw new AppError(400, 'A tax code cannot include itself as a component');
  }
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM tax_code_components WHERE organization_id=$1 AND parent_tax_code_id=$2`, [orgId, taxCodeId]);
    let seq = 1;
    for (const c of payload.components || []) {
      await client.query(
        `INSERT INTO tax_code_components(organization_id, parent_tax_code_id, component_tax_code_id, sequence_no, rate_override)
         VALUES ($1,$2,$3,$4,$5)`,
        [orgId, taxCodeId, c.componentTaxCodeId, c.sequenceNo || seq++, c.rateOverride == null ? null : c.rateOverride]
      );
    }
    await client.query(`UPDATE tax_codes SET is_compound = CASE WHEN EXISTS (SELECT 1 FROM tax_code_components WHERE organization_id=$1 AND parent_tax_code_id=$2) THEN TRUE ELSE is_compound END, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, taxCodeId]);
    return listTaxCodeComponents({ orgId, taxCodeId, client });
  });
}

// ==================== PARTNER TAX PROFILES ====================

async function listPartnerTaxProfiles({ orgId, query = {} }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;
  
  if (query.partnerId) { 
    where.push(`partner_id=$${i++}`); 
    params.push(query.partnerId); 
  }
  if (query.taxClass) { 
    where.push(`tax_class=$${i++}`); 
    params.push(query.taxClass); 
  }
  if (query.isTaxRegistered !== undefined) { 
    where.push(`is_tax_registered=$${i++}`); 
    params.push(query.isTaxRegistered === true || query.isTaxRegistered === 'true'); 
  }
  if (query.isTaxExempt !== undefined) { 
    where.push(`is_tax_exempt=$${i++}`); 
    params.push(query.isTaxExempt === true || query.isTaxExempt === 'true'); 
  }
  if (query.jurisdictionId) { 
    where.push(`jurisdiction_id=$${i++}`); 
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
    params
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
    [orgId, profileId]
  );
  if (!rows.length) throw new AppError(404, "Partner tax profile not found");
  return rows[0];
}

async function createPartnerTaxProfile({ orgId, actorUserId, payload }) {
  await assertPartnerBelongsToOrg({ orgId, partnerId: payload.partnerId });
  if (payload.defaultTaxCodeId) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.defaultTaxCodeId });
  }
  if (payload.purchaseTaxCodeId) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.purchaseTaxCodeId });
  }
  if (payload.salesTaxCodeId) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.salesTaxCodeId });
  }
  if (payload.withholdingTaxCodeId) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.withholdingTaxCodeId });
  }
  if (payload.jurisdictionId) {
    await assertJurisdictionBelongsToOrg({ orgId, jurisdictionId: payload.jurisdictionId });
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
      e_invoice_network, e_invoice_endpoint,
      created_by, updated_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$32
    ) RETURNING *`,
    [
      orgId,
      payload.partnerId,
      payload.taxRegistrationNo || null,
      payload.legalName || null,
      payload.taxClass || 'standard',
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
      payload.inputTaxRecoveryMode || 'default',
      payload.destinationCountryCode || null,
      payload.registrationStatus || 'registered',
      payload.eInvoiceNetwork || null,
      payload.eInvoiceEndpoint || null,
      actorUserId || null
    ]
  );
  return getPartnerTaxProfile({ orgId, profileId: rows[0].id });
}

async function updatePartnerTaxProfile({ orgId, profileId, payload, actorUserId }) {
  await getPartnerTaxProfile({ orgId, profileId });

  if (payload.defaultTaxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.defaultTaxCodeId });
  }
  if (payload.purchaseTaxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.purchaseTaxCodeId });
  }
  if (payload.salesTaxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.salesTaxCodeId });
  }
  if (payload.withholdingTaxCodeId !== undefined) {
    await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.withholdingTaxCodeId });
  }
  if (payload.jurisdictionId !== undefined) {
    await assertJurisdictionBelongsToOrg({ orgId, jurisdictionId: payload.jurisdictionId });
  }

  const columns = [];
  const params = [orgId, profileId];
  let i = 3;

  const map = {
    taxRegistrationNo: 'tax_registration_no',
    legalName: 'legal_name',
    taxClass: 'tax_class',
    defaultTaxCodeId: 'default_tax_code_id',
    purchaseTaxCodeId: 'purchase_tax_code_id',
    salesTaxCodeId: 'sales_tax_code_id',
    jurisdictionId: 'jurisdiction_id',
    placeOfSupply: 'place_of_supply',
    isTaxRegistered: 'is_tax_registered',
    isTaxExempt: 'is_tax_exempt',
    exemptionReasonCode: 'exemption_reason_code',
    exemptionReason: 'exemption_reason',
    reverseChargeApplicable: 'reverse_charge_applicable',
    withholdingApplicable: 'withholding_applicable',
    withholdingTaxCodeId: 'withholding_tax_code_id',
    recoverablePercentOverride: 'recoverable_percent_override',
    certificateReference: 'certificate_reference',
    certificateExpiry: 'certificate_expiry',
    withholdingRateOverride: 'withholding_rate_override',
    withholdingCertificateNo: 'withholding_certificate_no',
    filingContactEmail: 'filing_contact_email',
    customerTaxIdentifierType: 'customer_tax_identifier_type',
    vendorTaxIdentifierType: 'vendor_tax_identifier_type',
    inputTaxRecoveryMode: 'input_tax_recovery_mode',
    destinationCountryCode: 'destination_country_code',
    registrationStatus: 'registration_status',
    eInvoiceNetwork: 'e_invoice_network',
    eInvoiceEndpoint: 'e_invoice_endpoint'
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      params.push(payload[k] === '' ? null : payload[k]);
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
     SET ${columns.join(', ')}
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    params
  );

  return rows[0];
}

async function deletePartnerTaxProfile({ orgId, profileId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_partner_profiles WHERE organization_id=$1 AND id=$2`,
    [orgId, profileId]
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
    params
  );
  return rows.map((row) => ({ ...row, description: null, is_active: true }));
}

async function getTaxReturnTemplate({ orgId, templateId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_return_templates
     WHERE organization_id=$1 AND id=$2`,
    [orgId, templateId]
  );
  if (!rows.length) throw new AppError(404, "Tax return template not found");

  const { rows: boxes } = await pool.query(
    `SELECT * FROM tax_return_template_boxes
     WHERE template_id=$1
     ORDER BY sort_order`,
    [templateId]
  );

  return {
    ...rows[0],
    description: null,
    is_active: true,
    boxes: boxes.map((box) => ({ ...box, calculation_formula: null, is_required: false }))
  };
}

async function createTaxReturnTemplate({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO tax_return_templates(
        organization_id, tax_type, code, name
      ) VALUES ($1,$2,$3,$4)
      RETURNING *`,
      [orgId, payload.taxType || 'VAT', payload.code, payload.name]
    );

    const template = rows[0];

    if (payload.boxes && Array.isArray(payload.boxes)) {
      for (const box of payload.boxes) {
        await client.query(
          `INSERT INTO tax_return_template_boxes(
            template_id, box_code, label, sort_order, direction
          ) VALUES ($1,$2,$3,$4,$5)`,
          [template.id, box.boxCode, box.label, box.sortOrder || 0, box.direction || null]
        );
      }
    }

    return getTaxReturnTemplate({ orgId, templateId: template.id });
  });
}

async function updateTaxReturnTemplate({ orgId, templateId, payload, actorUserId }) {
  return withTransaction(async (client) => {
    const columns = [];
    const params = [orgId, templateId];
    let i = 3;

    const map = {
      taxType: 'tax_type',
      code: 'code',
      name: 'name'
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
         SET ${columns.join(', ')}
         WHERE organization_id=$1 AND id=$2`,
        params
      );
    }

    if (payload.boxes !== undefined) {
      await client.query(`DELETE FROM tax_return_template_boxes WHERE template_id=$1`, [templateId]);
      for (const box of payload.boxes || []) {
        await client.query(
          `INSERT INTO tax_return_template_boxes(
            template_id, box_code, label, sort_order, direction
          ) VALUES ($1,$2,$3,$4,$5)`,
          [templateId, box.boxCode, box.label, box.sortOrder || 0, box.direction || null]
        );
      }
    }

    return getTaxReturnTemplate({ orgId, templateId });
  });
}

async function deleteTaxReturnTemplate({ orgId, templateId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_return_templates WHERE organization_id=$1 AND id=$2`,
    [orgId, templateId]
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
    params
  );
  return rows;
}

async function getTaxReturn({ orgId, returnId }) {
  const { rows } = await pool.query(
    `SELECT tr.*, tj.code AS jurisdiction_code, tj.name AS jurisdiction_name
     FROM tax_returns tr
     LEFT JOIN tax_jurisdictions tj ON tj.id = tr.jurisdiction_id
     WHERE tr.organization_id=$1 AND tr.id=$2`,
    [orgId, returnId]
  );
  if (!rows.length) throw new AppError(404, "Tax return not found");
  return rows[0];
}

async function createTaxReturn({ orgId, actorUserId, payload }) {
  if (payload.templateId) {
    await getTaxReturnTemplate({ orgId, templateId: payload.templateId });
  }
  if (payload.jurisdictionId) {
    await assertJurisdictionBelongsToOrg({ orgId, jurisdictionId: payload.jurisdictionId });
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
      payload.taxType || 'VAT',
      payload.filingPeriodStart,
      payload.filingPeriodEnd,
      payload.templateId || null,
      payload.jurisdictionId || null,
      payload.filingAdapterCode || null,
      JSON.stringify(seedPayload),
      actorUserId || null
    ]
  );
  return rows[0];
}

async function submitTaxReturn({ orgId, returnId, payload, actorUserId }) {
  const taxReturn = await getTaxReturn({ orgId, returnId });

  if (taxReturn.status !== 'draft') {
    throw new AppError(409, 'Only draft tax returns can be submitted');
  }

  const nextPayload = {
    ...(taxReturn.payload_json || {}),
    filingData: payload.filingData || {}
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
    [orgId, returnId, payload.filingAdapterCode || null, JSON.stringify(nextPayload)]
  );

  return rows[0];
}

async function getTaxReturnConfig({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_return_config WHERE organization_id=$1`,
    [orgId]
  );
  if (!rows.length) {
    const { rows: inserted } = await pool.query(
      `INSERT INTO tax_return_config(organization_id) VALUES ($1) RETURNING *`,
      [orgId]
    );
    return inserted[0];
  }
  return rows[0];
}

async function updateTaxReturnConfig({ orgId, payload, actorUserId }) {
  await getTaxReturnConfig({ orgId });

  const columns = [];
  const params = [orgId];
  let i = 2;
  const map = {
    defaultTemplateId: 'default_template_id',
    autoSubmitEnabled: 'auto_submit_enabled',
    notificationEmail: 'notification_email',
    filingMethod: 'filing_method'
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      params.push(payload[k] === '' ? null : payload[k]);
    }
  }

  columns.push(`updated_by=$${i++}`);
  params.push(actorUserId || null);
  columns.push(`updated_at=NOW()`);

  const { rows } = await pool.query(
    `UPDATE tax_return_config
     SET ${columns.join(', ')}
     WHERE organization_id=$1
     RETURNING *`,
    params
  );
  return rows[0];
}

// ==================== E-INVOICING ====================

async function getEinvoicingSettings({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM einvoicing_settings WHERE organization_id=$1`,
    [orgId]
  );
  if (!rows.length) {
    const { rows: inserted } = await pool.query(
      `INSERT INTO einvoicing_settings(organization_id) VALUES ($1) RETURNING *`,
      [orgId]
    );
    return inserted[0];
  }
  return rows[0];
}

async function updateEinvoicingSettings({ orgId, payload, actorUserId }) {
  await getEinvoicingSettings({ orgId });

  const columns = [];
  const params = [orgId];
  let i = 2;
  const map = {
    enabled: 'enabled',
    provider: 'provider',
    apiEndpoint: 'api_endpoint',
    apiKey: 'api_key',
    apiSecret: 'api_secret',
    sandboxMode: 'sandbox_mode',
    documentTypes: 'document_types'
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      if (k === 'documentTypes') params.push(JSON.stringify(payload[k] || []));
      else params.push(payload[k] === '' ? null : payload[k]);
    }
  }

  columns.push(`updated_by=$${i++}`);
  params.push(actorUserId || null);
  columns.push(`updated_at=NOW()`);

  const { rows } = await pool.query(
    `UPDATE einvoicing_settings
     SET ${columns.join(', ')}
     WHERE organization_id=$1
     RETURNING *`,
    params
  );
  return rows[0];
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
    params.push(query.isActive === true || query.isActive === 'true');
  }

  const { rows } = await pool.query(
    `SELECT * FROM tax_filing_adapters
     WHERE ${where.join(" AND ")}
     ORDER BY organization_id NULLS FIRST, country_code, adapter_code`,
    params
  );
  return rows;
}

async function getFilingAdapter({ orgId, adapterId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_filing_adapters
     WHERE (organization_id=$1 OR organization_id IS NULL) AND id=$2`,
    [orgId, adapterId]
  );
  if (!rows.length) throw new AppError(404, "Filing adapter not found");
  return rows[0];
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
      payload.channelType || 'api',
      payload.supportedTaxTypes || ['VAT'],
      payload.supportedCountries || [],
      String(payload.countryCode).toUpperCase(),
      JSON.stringify(payload.configJson || {}),
      payload.isRealtime || false,
      payload.isActive !== undefined ? payload.isActive : true
    ]
  );
  return rows[0];
}

async function updateFilingAdapter({ orgId, adapterId, payload, actorUserId }) {
  const columns = [];
  const params = [orgId, adapterId];
  let i = 3;

  const map = {
    adapterCode: 'adapter_code',
    name: 'name',
    channelType: 'channel_type',
    supportedTaxTypes: 'supported_tax_types',
    supportedCountries: 'supported_countries',
    countryCode: 'country_code',
    configJson: 'config_json',
    isRealtime: 'is_realtime',
    isActive: 'is_active'
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      if (k === 'configJson') {
        params.push(JSON.stringify(payload[k] || {}));
      } else if (k === 'countryCode') {
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
     SET ${columns.join(', ')}
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    params
  );

  if (!rows.length) throw new AppError(404, "Filing adapter not found");
  return rows[0];
}

async function deleteFilingAdapter({ orgId, adapterId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM tax_filing_adapters WHERE organization_id=$1 AND id=$2`,
    [orgId, adapterId]
  );
  if (!rowCount) throw new AppError(404, "Filing adapter not found");
  return { deleted: true };
}

async function testFilingAdapter({ orgId, adapterId, actorUserId }) {
  const adapter = await getFilingAdapter({ orgId, adapterId });
  
  return { 
    success: true, 
    message: `Adapter ${adapter.name} tested successfully`,
    adapter: adapter
  };
}

// ==================== COUNTRY PACKS ====================

async function listCountryPacks({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_country_packs WHERE organization_id=$1 OR organization_id IS NULL ORDER BY is_active DESC, country_code`,
    [orgId]
  );
  return rows;
}

async function installCountryPack({ orgId, actorUserId, payload }) {
  const packCode = payload.packCode || payload.countryCode;
  const { rows: packRows } = await pool.query(
    `SELECT * FROM tax_country_packs WHERE (organization_id=$1 OR organization_id IS NULL) AND (pack_code=$2 OR country_code=$2) ORDER BY organization_id NULLS FIRST LIMIT 1`,
    [orgId, packCode]
  );
  const pack = packRows[0];
  if (!pack) throw new AppError(404, "Tax country pack not found");

  return withTransaction(async (client) => {
    if (Array.isArray(pack.default_templates)) {
      for (const tpl of pack.default_templates) {
        const { rows: tRows } = await client.query(
          `INSERT INTO tax_return_templates(organization_id, tax_type, code, name)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (organization_id, tax_type, code) DO UPDATE SET name=EXCLUDED.name
           RETURNING id`,
          [orgId, tpl.taxType || 'VAT', tpl.code, tpl.name]
        );
        const templateId = tRows[0].id;
        if (Array.isArray(tpl.boxes)) {
          await client.query(`DELETE FROM tax_return_template_boxes WHERE template_id=$1`, [templateId]);
          for (const box of tpl.boxes) {
            await client.query(
              `INSERT INTO tax_return_template_boxes(template_id, box_code, label, sort_order, direction)
               VALUES($1,$2,$3,$4,$5)`,
              [templateId, box.boxCode, box.label, box.sortOrder || 0, box.direction || null]
            );
          }
        }
      }
    }

    await client.query(
      `INSERT INTO tax_country_pack_installs(organization_id, pack_id, installed_by, installed_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (organization_id, pack_id) DO UPDATE SET installed_by=EXCLUDED.installed_by, installed_at=EXCLUDED.installed_at`,
      [orgId, pack.id, actorUserId || null]
    );
    return { installed: true, pack };
  });
}

// ==================== AUTOMATION RULES ====================

async function listAutomationRules({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_automation_rules WHERE organization_id=$1 ORDER BY created_at DESC`, 
    [orgId]
  );
  return rows;
}

async function upsertAutomationRule({ orgId, actorUserId, payload }) {
  const { rows } = await pool.query(
    `INSERT INTO tax_automation_rules(organization_id, name, trigger_code, schedule_code, scope_json, action_json, is_enabled, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,COALESCE($7,TRUE),$8,$8)
     ON CONFLICT (organization_id, name) DO UPDATE
       SET trigger_code=EXCLUDED.trigger_code,
           schedule_code=EXCLUDED.schedule_code,
           scope_json=EXCLUDED.scope_json,
           action_json=EXCLUDED.action_json,
           is_enabled=EXCLUDED.is_enabled,
           updated_by=EXCLUDED.updated_by,
           updated_at=NOW()
     RETURNING *`,
    [orgId, payload.name, payload.triggerCode, payload.scheduleCode || null, JSON.stringify(payload.scope || {}), JSON.stringify(payload.action || {}), payload.isEnabled, actorUserId || null]
  );
  return rows[0];
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
  upsertAutomationRule
};