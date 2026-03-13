const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const journalPosting = require("../../interfaces/journalPosting.interface");
const {
  normalizeCode,
  normalizeStatus,
  assertUuid,
  assertMoneyAmount,
} = require("../_util");
const { validateDimensionJson } = require("../dimensions/dimensions.validator");

const STATUS = ["active", "inactive", "archived"]; // bases/rules

async function fetchAccountNormalBalances({ orgId, accountIds }) {
  if (!Array.isArray(accountIds) || !accountIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT a.id, at.normal_balance
       FROM chart_of_accounts a
       JOIN account_types at ON at.id = a.account_type_id
      WHERE a.organization_id = $1 AND a.id = ANY($2::uuid[])`,
    [orgId, accountIds]
  );
  const map = new Map();
  for (const r of rows) map.set(r.id, r.normal_balance);
  return map;
}

function normalizeSignedByNormalBalance({ normalBalance, signedAmount }) {
  // For management reporting, treat "DEBIT" normal as +debits, "CREDIT" normal as +credits.
  // signedAmount here is (debit_total - credit_total).
  const nb = (normalBalance || "DEBIT").toUpperCase();
  return nb === "CREDIT" ? -signedAmount : signedAmount;
}

function assertName(name, field = "name") {
  if (!name || typeof name !== "string" || !name.trim()) throw new AppError(400, `${field} is required`);
}

function assertTargetDimension(value) {
  if (!value || typeof value !== "string" || !value.trim()) throw new AppError(400, "targetDimension is required");
  // keep permissive, but canonicalise casing
  return value.trim().toLowerCase();
}

function assertTargets(payloadJson) {
  const targets = payloadJson?.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new AppError(400, "payloadJson.targets must be a non-empty array");
  }
  for (const t of targets) {
    if (!t || typeof t !== "object") throw new AppError(400, "Each target must be an object");
    if (!t.toAccountId) throw new AppError(400, "Each target requires toAccountId");
    assertUuid(t.toAccountId, "toAccountId");
    const w = Number(t.weight);
    if (Number.isNaN(w) || w <= 0) throw new AppError(400, "Each target requires weight > 0");
  }
  return targets;
}

async function listBases({ orgId }) {
  const { rows } = await pool.query(
    `SELECT id, code, name, payload_json AS "payloadJson", status, created_at, updated_at
       FROM allocation_bases
      WHERE organization_id=$1 AND status <> 'archived'
      ORDER BY code ASC`,
    [orgId]
  );
  return rows;
}

async function createBase({ orgId, code, name,basis_type, payloadJson, status, actorUserId, req }) {
  const c = normalizeCode(code);
  const organizationId = orgId
  assertName(name);
  const st = normalizeStatus(status || "active", STATUS, "status");
  const pj = payloadJson && typeof payloadJson === "object" ? payloadJson : {};

  const { rows } = await pool.query(
    `INSERT INTO allocation_bases(organization_id, code, name, basis_type,payload_json, status)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, code, name,basis_type, payload_json AS "payloadJson", status, created_at, updated_at`,
    [orgId, c, name.trim(),basis_type, pj, st]
  );

  await writeAudit({
    organizationId,
    actorUserId,
    action: "reporting.allocation_base.create",
    entityType: "allocation_base",
    entityId: rows[0].id,
    before: null,
    after: rows[0],
    req,
  });

  return rows[0];
}

async function listRules({ orgId }) {
  const { rows } = await pool.query(
    `SELECT r.id, r.code, r.name,
            r.allocation_base_id AS "baseId",
            b.code AS "baseCode",
            r.source_account_id AS "sourceAccountId",
            r.target_dimension AS "targetDimension",
            r.payload_json AS "payloadJson",
            r.status, r.created_at, r.updated_at
       FROM allocation_rules r
       JOIN allocation_bases b ON b.id = r.allocation_base_id
      WHERE r.organization_id=$1 AND r.status <> 'archived'
      ORDER BY r.code ASC`,
    [orgId]
  );
  return rows;
}

async function createRule({
  orgId,
  code,
  name,
  baseId,
  sourceAccountId,
  targetDimension,
  payloadJson,
  status,
  actorUserId,
  req,
}) {
  const c = normalizeCode(code);
    const organizationId = orgId

  assertName(name);
  assertUuid(baseId, "baseId");
  assertUuid(sourceAccountId, "sourceAccountId");
  const td = assertTargetDimension(targetDimension);
  const st = normalizeStatus(status || "active", STATUS, "status");

  const pj = payloadJson && typeof payloadJson === "object" ? payloadJson : {};
  const targets = assertTargets(pj);
  // validate any provided dimensionJson shapes
  for (const t of targets) {
    if (t.dimensionJson) {
      // will throw on invalid keys/ids
      // eslint-disable-next-line no-await-in-loop
      t.dimensionJson = await validateDimensionJson({ orgId, dimensionJson: t.dimensionJson });
    }
  }

  // Ensure base exists and is active-ish
  const base = await pool.query(`SELECT id, status FROM allocation_bases WHERE organization_id=$1 AND id=$2`, [orgId, baseId]);
  if (!base.rows.length) throw new AppError(404, "Allocation base not found");
  if (base.rows[0].status === "archived") throw new AppError(409, "Allocation base is archived");

  const { rows } = await pool.query(
    `INSERT INTO allocation_rules(
        organization_id, code, name, allocation_base_id,
        source_account_id, target_dimension, payload_json, status
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, code, name,
       allocation_base_id AS "baseId",
       source_account_id AS "sourceAccountId",
       target_dimension AS "targetDimension",
       payload_json AS "payloadJson",
       status, created_at, updated_at`,
    [orgId, c, name.trim(), baseId, sourceAccountId, td, pj, st]
  );

  await writeAudit({
    organizationId,
    actorUserId,
    action: "reporting.allocation_rule.create",
    entityType: "allocation_rule",
    entityId: rows[0].id,
    before: null,
    after: rows[0],
    req,
  });

  return rows[0];
}

async function computeAndPersist({ orgId, periodId, ruleIds, memo, replace, actorUserId, req }) {
  assertUuid(periodId, "periodId");
    const organizationId = orgId

  if (!Array.isArray(ruleIds) || ruleIds.length === 0) throw new AppError(400, "ruleIds must be a non-empty array");
  for (const id of ruleIds) assertUuid(id, "ruleId");

  // validate period exists
  const period = await pool.query(`SELECT id, status FROM accounting_periods WHERE organization_id=$1 AND id=$2`, [orgId, periodId]);
  if (!period.rows.length) throw new AppError(404, "Period not found");

  const created = [];
  for (const ruleId of ruleIds) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await pool.query(
      `SELECT id, status FROM cost_allocations
        WHERE organization_id=$1 AND rule_id=$2 AND period_id=$3 AND status IN ('computed','posted')
        ORDER BY computed_at DESC LIMIT 1`,
      [orgId, ruleId, periodId]
    );
    if (existing.rows.length && !replace) {
      created.push({ id: existing.rows[0].id, status: existing.rows[0].status, reused: true });
      continue;
    }
    if (existing.rows.length && replace) {
      // archive existing (soft)
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`UPDATE cost_allocations SET status='archived', updated_at=now() WHERE organization_id=$1 AND id=$2`, [orgId, existing.rows[0].id]);
    }

    // eslint-disable-next-line no-await-in-loop
    const ruleRes = await pool.query(
      `SELECT id, code, name, source_account_id AS "sourceAccountId", payload_json AS "payloadJson", status
         FROM allocation_rules
        WHERE organization_id=$1 AND id=$2`,
      [orgId, ruleId]
    );
    if (!ruleRes.rows.length) throw new AppError(404, `Allocation rule not found: ${ruleId}`);
    const rule = ruleRes.rows[0];
    if (rule.status === "archived") throw new AppError(409, `Allocation rule is archived: ${rule.code}`);

    const targets = assertTargets(rule.payloadJson || {});

    // Pull source balance for period from GL balances
    // eslint-disable-next-line no-await-in-loop
    const gl = await pool.query(
      `SELECT debit_total, credit_total
         FROM general_ledger_balances
        WHERE organization_id=$1 AND period_id=$2 AND account_id=$3`,
      [orgId, periodId, rule.sourceAccountId]
    );
    const debit = Number(gl.rows[0]?.debit_total || 0);
    const credit = Number(gl.rows[0]?.credit_total || 0);
    const signedNet = debit - credit;

    // normalise to management-reporting sign (positive = "natural" direction)
    // eslint-disable-next-line no-await-in-loop
    const nb = await fetchAccountNormalBalances({ orgId, accountIds: [rule.sourceAccountId] });
    const normalised = normalizeSignedByNormalBalance({ signedAmount: signedNet, normalBalance: nb.get(rule.sourceAccountId) });
    const baseAmount = Math.abs(normalised);

    const totalWeight = targets.reduce((s, t) => s + Number(t.weight), 0);
    if (totalWeight <= 0) throw new AppError(400, "Total target weight must be > 0");

    // Begin transaction for allocation header + lines
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const payloadJson = {
        memo: memo || null,
        source_account_id: rule.sourceAccountId,
        signed_net: signedNet,
        normalised_net: normalised,
        base_amount: baseAmount,
        total_weight: totalWeight,
        targets: targets.map((t) => ({
          toAccountId: t.toAccountId,
          weight: Number(t.weight),
          dimensionJson: t.dimensionJson || null,
          notes: t.notes || null,
        })),
      };

      const header = await client.query(
        `INSERT INTO cost_allocations(organization_id, rule_id, period_id, computed_at, status, payload_json)
         VALUES ($1,$2,$3,now(),'computed',$4)
         RETURNING id, rule_id AS "ruleId", period_id AS "periodId", computed_at AS "computedAt", status, payload_json AS "payloadJson"`,
        [orgId, ruleId, periodId, payloadJson]
      );
      const allocation = header.rows[0];

      // Compute line amounts (rounded to cents by default, but keep JS number)
      const lineRows = [];
      let lineNo = 1;
      let allocatedSum = 0;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const w = Number(t.weight);
        let amt = (baseAmount * w) / totalWeight;
        // last line residual to ensure sums match baseAmount
        if (i === targets.length - 1) {
          amt = baseAmount - allocatedSum;
        }
        allocatedSum += amt;
        lineRows.push({
          orgId,
          allocationId: allocation.id,
          ruleId,
          periodId,
          lineNo,
          toAccountId: t.toAccountId,
          amount: amt,
          weight: w,
          notes: t.notes || null,
          dimensionJson: t.dimensionJson || null,
        });
        lineNo += 1;
      }

      for (const lr of lineRows) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO cost_allocation_lines(
             organization_id, allocation_id, rule_id, period_id,
             line_no, to_account_id, amount, weight, notes, dimension_json
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            lr.orgId,
            lr.allocationId,
            lr.ruleId,
            lr.periodId,
            lr.lineNo,
            lr.toAccountId,
            lr.amount,
            lr.weight,
            lr.notes,
            lr.dimensionJson || {},
          ]
        );
      }

      await client.query("COMMIT");

      await writeAudit({
        organizationId,
        actorUserId,
        action: "reporting.allocations.compute",
        entityType: "cost_allocation",
        entityId: allocation.id,
        before: null,
        after: allocation,
        req,
      });

      created.push(allocation);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  return created;
}

async function postAllocation({ orgId, allocationId, entryDate, memo, actorUserId, req }) {
  assertUuid(allocationId, "allocationId");
  const organizationId = orgId;
  if (!entryDate || typeof entryDate !== "string") {
    throw new AppError(400, "entryDate is required (YYYY-MM-DD)");
  }
  
  // Get allocation with source account
  const headerRes = await pool.query(
    `SELECT a.id, a.rule_id AS "ruleId", a.period_id AS "periodId", a.status, a.payload_json AS "payloadJson",
            r.source_account_id AS "sourceAccountId"
       FROM cost_allocations a
       JOIN allocation_rules r ON r.id = a.rule_id
      WHERE a.organization_id=$1 AND a.id=$2`,
      [orgId, allocationId]
    );
    
    if (!headerRes.rows.length) throw new AppError(404, "Allocation not found");
    const allocation = headerRes.rows[0];
    
    if (allocation.status === "posted") {
      return { 
        id: allocation.id, 
        status: "posted", 
        reused: true,
        journalEntryId: allocation.payloadJson?.posted_journal_entry_id 
      };
    }
    
    if (allocation.status !== "computed") {
      throw new AppError(409, `Allocation must be computed to post (current: ${allocation.status})`);
    }
    
    // Get allocation lines
    const linesRes = await pool.query(
      `SELECT line_no AS "lineNo", to_account_id AS "toAccountId", amount, weight, notes, dimension_json AS "dimensionJson"
      FROM cost_allocation_lines
      WHERE organization_id=$1 AND allocation_id=$2
      ORDER BY line_no ASC`,
      [orgId, allocationId]
    );
    
    if (!linesRes.rows.length) throw new AppError(409, "Allocation has no lines to post");
    
    const baseAmount = Number(allocation.payloadJson?.base_amount ?? 0);
    if (Number.isNaN(baseAmount)) throw new AppError(500, "Allocation base amount is invalid");

  // If base amount is 0, mark as posted without creating journal
  if (baseAmount === 0) {
    await pool.query(
      `UPDATE cost_allocations 
      SET status='posted', posted_at=now(), posted_by=$3, posted_journal_entry_id=NULL, updated_at=now()
       WHERE organization_id=$1 AND id=$2`,
      [orgId, allocationId, actorUserId]
    );
    
    return { 
      id: allocationId, 
      status: "posted", 
      journalEntryId: null, 
      zeroAmount: true 
    };
  }

  // Create journal lines
  const journalLines = [];

  // Debit lines (target accounts receive the allocation)
  for (const l of linesRes.rows) {
    const amount = assertMoneyAmount(l.amount, "amount");
    journalLines.push({
      accountId: l.toAccountId,
      debit: amount,
      credit: 0,
      description: l.notes || `Allocation to ${l.toAccountId.substring(0, 8)}...`
    });
  }

  // Credit line (source account provides the allocation)
  journalLines.push({
    accountId: allocation.sourceAccountId,
    debit: 0,
    credit: baseAmount,
    description: "Cost allocation source"
  });

  // Verify journal is balanced
  const totalDebit = journalLines.reduce((sum, line) => sum + (line.debit || 0), 0);
  const totalCredit = journalLines.reduce((sum, line) => sum + (line.credit || 0), 0);
  
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new AppError(400, `Journal not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`);
  }

  try {
    // Create and post the journal entry
    const je = await journalPosting.postJournal({
      orgId,
      actorUserId,
      payload: {
        periodId: allocation.periodId,  // REQUIRED: Period from allocation
        entryDate: entryDate,           // Date for the journal entry
        memo: memo || allocation.payloadJson?.memo || "Cost allocation posting",
        lines: journalLines,
        typeCode: "GENERAL"             // Default journal type
        // idempotencyKey is NOT in payload - it's in headers
      },
      req,
    });

    // Get the journal entry ID (handle both possible return formats)
    const journalEntryId = je.journalId || je.id;
    
    if (!journalEntryId) {
      throw new AppError(500, "Journal entry created but no ID returned");
    }

    // Update allocation with journal entry reference
    await pool.query(
      `UPDATE cost_allocations
       SET status = 'posted',
           posted_at = NOW(),
           posted_by = $3,
           posted_journal_entry_id = $4,
           updated_at = NOW(),
           payload_json = jsonb_set(
             COALESCE(payload_json, '{}'::jsonb),
             '{posted_journal_entry_id}',
             to_jsonb($4::text)
           )
       WHERE organization_id = $1 AND id = $2`,
      [orgId, allocationId, actorUserId, journalEntryId]
    );

    // Write audit log
    await writeAudit({
      organizationId,
      actorUserId,
      action: "reporting.allocations.post",
      entityType: "cost_allocation",
      entityId: allocationId,
      before: { 
        id: allocationId,
        status: "computed",
        baseAmount: baseAmount
      },
      after: { 
        id: allocationId,
        status: "posted", 
        journalEntryId: journalEntryId,
        postedAt: new Date().toISOString()
      },
      req,
    });

    return { 
      id: allocationId, 
      status: "posted", 
      journalEntryId: journalEntryId,
      baseAmount: baseAmount
    };
    
  } catch (error) {
    console.error('Failed to post journal for allocation:', {
      allocationId,
      error: error.message,
      stack: error.stack
    });
    
    // Re-throw as AppError if not already
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(500, `Failed to post journal entry: ${error.message}`);
  }
}


async function previewCompute({ orgId, periodId, ruleIds }) {
  assertUuid(periodId, "periodId");
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) throw new AppError(400, "ruleIds must be a non-empty array");
  for (const id of ruleIds) assertUuid(id, "ruleId");

  // validate period exists
  const period = await pool.query(
    `SELECT id, status FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!period.rows.length) throw new AppError(404, "Period not found");

  const previews = [];

  for (const ruleId of ruleIds) {
    // eslint-disable-next-line no-await-in-loop
    const ruleRes = await pool.query(
      `SELECT id, code, name, source_account_id AS "sourceAccountId", payload_json AS "payloadJson", status
         FROM allocation_rules
        WHERE organization_id=$1 AND id=$2`,
      [orgId, ruleId]
    );
    if (!ruleRes.rows.length) throw new AppError(404, `Allocation rule not found: ${ruleId}`);
    const rule = ruleRes.rows[0];
    if (rule.status === "archived") throw new AppError(409, `Allocation rule is archived: ${rule.code}`);

    const targets = assertTargets(rule.payloadJson || {});

    // Pull source balance for period from GL balances
    // eslint-disable-next-line no-await-in-loop
    const gl = await pool.query(
      `SELECT debit_total, credit_total
         FROM general_ledger_balances
        WHERE organization_id=$1 AND period_id=$2 AND account_id=$3`,
      [orgId, periodId, rule.sourceAccountId]
    );
    const debit = Number(gl.rows[0]?.debit_total || 0);
    const credit = Number(gl.rows[0]?.credit_total || 0);
    const signedNet = debit - credit;

    // normalise to management-reporting sign
    // eslint-disable-next-line no-await-in-loop
    const nb = await fetchAccountNormalBalances({ orgId, accountIds: [rule.sourceAccountId] });
    const normalBalance = nb.get(rule.sourceAccountId);
    const normalised = normalizeSignedByNormalBalance({ signedAmount: signedNet, normalBalance });

    const baseAmount = Math.abs(normalised);
    const totalWeight = targets.reduce((s, t) => s + Number(t.weight), 0);
    if (totalWeight <= 0) throw new AppError(400, "Total target weight must be > 0");

    const lines = [];
    let allocatedSum = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const w = Number(t.weight);
      let amt = (baseAmount * w) / totalWeight;
      if (i === targets.length - 1) {
        amt = baseAmount - allocatedSum;
      }
      allocatedSum += amt;
      lines.push({
        lineNo: i + 1,
        toAccountId: t.toAccountId,
        amount: amt,
        weight: w,
        notes: t.notes || null,
        dimensionJson: t.dimensionJson || {},
      });
    }

    previews.push({
      ruleId: rule.id,
      ruleCode: rule.code,
      ruleName: rule.name,
      periodId,
      sourceAccountId: rule.sourceAccountId,
      signedNet,
      normalisedNet: normalised,
      baseAmount,
      totalWeight,
      lines,
    });
  }

  return previews;
}


async function previewCompute({ orgId, periodId, ruleIds }) {
  assertUuid(periodId, "periodId");
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) throw new AppError(400, "ruleIds must be a non-empty array");
  for (const id of ruleIds) assertUuid(id, "ruleId");

  // validate period exists
  const period = await pool.query(
    `SELECT id, status FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!period.rows.length) throw new AppError(404, "Period not found");

  const previews = [];

  for (const ruleId of ruleIds) {
    // eslint-disable-next-line no-await-in-loop
    const ruleRes = await pool.query(
      `SELECT id, code, name, source_account_id AS "sourceAccountId", payload_json AS "payloadJson", status
         FROM allocation_rules
        WHERE organization_id=$1 AND id=$2`,
      [orgId, ruleId]
    );
    if (!ruleRes.rows.length) throw new AppError(404, `Allocation rule not found: ${ruleId}`);
    const rule = ruleRes.rows[0];
    if (rule.status === "archived") throw new AppError(409, `Allocation rule is archived: ${rule.code}`);

    const targets = assertTargets(rule.payloadJson || {});

    // Pull source balance for period from GL balances
    // eslint-disable-next-line no-await-in-loop
    const gl = await pool.query(
      `SELECT debit_total, credit_total
         FROM general_ledger_balances
        WHERE organization_id=$1 AND period_id=$2 AND account_id=$3`,
      [orgId, periodId, rule.sourceAccountId]
    );
    const debit = Number(gl.rows[0]?.debit_total || 0);
    const credit = Number(gl.rows[0]?.credit_total || 0);
    const signedNet = debit - credit;

    // normalise to management-reporting sign
    // eslint-disable-next-line no-await-in-loop
    const nb = await fetchAccountNormalBalances({ orgId, accountIds: [rule.sourceAccountId] });
    const normalBalance = nb.get(rule.sourceAccountId);
    const normalised = normalizeSignedByNormalBalance({ signedAmount: signedNet, normalBalance });

    const baseAmount = Math.abs(normalised);
    const totalWeight = targets.reduce((s, t) => s + Number(t.weight), 0);
    if (totalWeight <= 0) throw new AppError(400, "Total target weight must be > 0");

    const lines = [];
    let allocatedSum = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const w = Number(t.weight);
      let amt = (baseAmount * w) / totalWeight;
      if (i === targets.length - 1) {
        amt = baseAmount - allocatedSum;
      }
      allocatedSum += amt;
      lines.push({
        lineNo: i + 1,
        toAccountId: t.toAccountId,
        amount: amt,
        weight: w,
        notes: t.notes || null,
        dimensionJson: t.dimensionJson || {},
      });
    }

    previews.push({
      ruleId: rule.id,
      ruleCode: rule.code,
      ruleName: rule.name,
      periodId,
      sourceAccountId: rule.sourceAccountId,
      signedNet,
      normalisedNet: normalised,
      baseAmount,
      totalWeight,
      lines,
    });
  }

  return previews;
}
module.exports = {
  listBases,
  createBase,
  listRules,
  createRule,
  computeAndPersist,
  postAllocation,
  previewCompute
};
