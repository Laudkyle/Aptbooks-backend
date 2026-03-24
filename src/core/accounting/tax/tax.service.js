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

  const { rows } = await pool.query(
    `INSERT INTO tax_codes(
        organization_id, jurisdiction_id, code, name, tax_type, rate, is_compound,
        box_code, direction,
        effective_from, effective_to, status
     ) VALUES (
        $1,$2,$3,$4,$5,$6,COALESCE($7,false),
        $8,$9,
        COALESCE($10,CURRENT_DATE),$11,COALESCE($12,'active')
     )
     RETURNING *`,
    [
      orgId,
      payload.jurisdictionId || null,
      payload.code,
      payload.name,
      payload.taxType,
      payload.rate,
      payload.isCompound === true,
      payload.boxCode ?? null,
      payload.direction ?? null,
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

  const columns = [];
  const params = [orgId, taxCodeId];
  let i = 3;

  const map = {
    jurisdictionId: "jurisdiction_id",
    code: "code",
    name: "name",
    taxType: "tax_type",
    rate: "rate",
    isCompound: "is_compound",
    boxCode: "box_code",
    direction: "direction",
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

  const current = await getTaxSettings({ orgId });

  const out = {
    output_tax_account_id: payload.outputTaxAccountId ?? current.output_tax_account_id,
    input_tax_account_id: payload.inputTaxAccountId ?? current.input_tax_account_id,
    default_tax_code_id: payload.defaultTaxCodeId ?? current.default_tax_code_id
  };

  const { rows } = await pool.query(
    `UPDATE tax_settings
     SET output_tax_account_id=$2,
         input_tax_account_id=$3,
         default_tax_code_id=$4,
         updated_at=NOW()
     WHERE organization_id=$1
     RETURNING *`,
    [orgId, out.output_tax_account_id || null, out.input_tax_account_id || null, out.default_tax_code_id || null]
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

module.exports = {
  listJurisdictions,
  createJurisdiction,
  updateJurisdiction,
  deleteJurisdiction,
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
  voidTaxAdjustment
};
