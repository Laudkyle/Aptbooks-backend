const { pool } = require("../../../db/pool");
const { withTransaction } = require("../../../db/tx");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");
const { moneyUnits, moneyStringFromUnits, moneyNumber, absUnits } = require("../../../shared/utils/financialMath");

const POLICY_KEY = "accounting.reconciliation.policy";
const DEFAULT_POLICY = {
  defaultThreshold: 0.01,
  thresholdsByAccountType: {
    ASSET: 0.01,
    LIABILITY: 0.01,
    EQUITY: 0.01,
    REVENUE: 0.01,
    EXPENSE: 0.01,
  },
  exactMatchTolerance: 0,
};

function num(v) {
  return Number(v || 0);
}

function normalisedTypeCode(code) {
  return String(code || "UNKNOWN").trim().toUpperCase();
}

function buildAppJournalPath(journalId) {
  return `/accounting/journals/${journalId}`;
}

function buildApiJournalPath(journalId) {
  return `/core/accounting/journals/${journalId}`;
}

function toCsvGeneric({ header, rows }) {
  const escape = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes("\n") || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(header.map((h) => escape(r[h])).join(","));
  }
  return lines.join("\n");
}

async function getPeriodRecord({ orgId, periodId, client = pool }) {
  const { rows } = await client.query(
    `SELECT id, code, start_date, end_date, status
       FROM accounting_periods
      WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(404, "Accounting period not found");
  return rows[0];
}

async function getPolicy({ orgId, client = pool }) {
  const { rows } = await client.query(
    `SELECT value_json FROM system_settings WHERE organization_id=$1 AND key=$2`,
    [orgId, POLICY_KEY]
  );
  const raw = rows[0]?.value_json || {};
  return {
    defaultThreshold: num(raw.defaultThreshold ?? DEFAULT_POLICY.defaultThreshold),
    thresholdsByAccountType: {
      ...DEFAULT_POLICY.thresholdsByAccountType,
      ...(raw.thresholdsByAccountType || {}),
    },
    exactMatchTolerance: num(raw.exactMatchTolerance ?? DEFAULT_POLICY.exactMatchTolerance),
  };
}

async function upsertPolicy({ orgId, actorUserId, body, audit = {} }) {
  const current = await getPolicy({ orgId });
  const next = {
    defaultThreshold: num(body.defaultThreshold ?? current.defaultThreshold),
    thresholdsByAccountType: {
      ...current.thresholdsByAccountType,
      ...(body.thresholdsByAccountType || {}),
    },
    exactMatchTolerance: num(body.exactMatchTolerance ?? current.exactMatchTolerance),
  };
  if (next.defaultThreshold < 0 || next.exactMatchTolerance < 0) {
    throw new AppError(400, "Threshold values must be zero or greater");
  }
  await pool.query(
    `INSERT INTO system_settings(organization_id, key, value_json)
     VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (organization_id, key)
     DO UPDATE SET value_json=EXCLUDED.value_json`,
    [orgId, POLICY_KEY, JSON.stringify(next)]
  );
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "accounting.reconciliation.policy.updated",
    entityType: "system_settings",
    entityId: null,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before: current,
    after: next,
  });
  return next;
}

function calculateBalanceUnits({ debit, credit, normalBalance }) {
  const debitCents = typeof debit === "bigint" ? debit : moneyUnits(debit || "0");
  const creditCents = typeof credit === "bigint" ? credit : moneyUnits(credit || "0");
  if (String(normalBalance || "debit").toLowerCase() === "credit") {
    return creditCents - debitCents;
  }
  return debitCents - creditCents;
}

async function buildReconciliationData({ orgId, periodId, onlyMismatches = false, client = pool }) {
  if (!periodId) throw new AppError(400, "periodId is required");
  const period = await getPeriodRecord({ orgId, periodId, client });
  const policy = await getPolicy({ orgId, client });

  const gl = await client.query(
    `
    SELECT account_id, COALESCE(debit_total,0) AS debit_total, COALESCE(credit_total,0) AS credit_total
    FROM general_ledger_balances
    WHERE organization_id=$1 AND period_id=$2
    `,
    [orgId, periodId]
  );

  const jl = await client.query(
    `
    SELECT account_id, debit_total, credit_total, line_count
    FROM accounting_posted_ledger_totals
    WHERE organization_id=$1 AND period_id=$2
    `,
    [orgId, periodId]
  );

  const accountIds = [...new Set([
    ...gl.rows.map((r) => String(r.account_id)),
    ...jl.rows.map((r) => String(r.account_id)),
  ])];

  const accountDetailsMap = new Map();
  if (accountIds.length) {
    const accountDetails = await client.query(
      `
      SELECT
        coa.id,
        coa.code,
        coa.name,
        coa.status,
        at.id AS account_type_id,
        at.code AS account_type_code,
        at.name AS account_type_name,
        at.normal_balance
      FROM chart_of_accounts coa
      LEFT JOIN account_types at ON at.id = coa.account_type_id
      WHERE coa.organization_id=$1 AND coa.id = ANY($2::uuid[])
      `,
      [orgId, accountIds]
    );
    accountDetails.rows.forEach((acc) => {
      accountDetailsMap.set(String(acc.id), acc);
    });
  }

  const byId = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(String(r.account_id), r);
    return m;
  };

  const glMap = byId(gl.rows);
  const jlMap = byId(jl.rows);
  const allAccountIds = [...new Set([...glMap.keys(), ...jlMap.keys()])].sort();

  const diffs = [];
  let exactMismatchCount = 0;
  let mismatchCount = 0;
  let totalVarianceCents = 0n;
  let correctableAccounts = 0;

  for (const id of allAccountIds) {
    const a = glMap.get(id) || { debit_total: 0, credit_total: 0 };
    const b = jlMap.get(id) || { debit_total: 0, credit_total: 0, line_count: 0 };
    const acc = accountDetailsMap.get(id) || {
      code: "UNKNOWN",
      name: "Unknown Account",
      account_type_id: null,
      account_type_code: null,
      account_type_name: null,
      normal_balance: "debit",
      status: null,
    };

    const glDebitCents = moneyUnits(a.debit_total || "0");
    const glCreditCents = moneyUnits(a.credit_total || "0");
    const recomputedDebitCents = moneyUnits(b.debit_total || "0");
    const recomputedCreditCents = moneyUnits(b.credit_total || "0");
    const diffDebitCents = glDebitCents - recomputedDebitCents;
    const diffCreditCents = glCreditCents - recomputedCreditCents;

    const glBalanceCents = calculateBalanceUnits({ debit: glDebitCents, credit: glCreditCents, normalBalance: acc.normal_balance });
    const recomputedBalanceCents = calculateBalanceUnits({ debit: recomputedDebitCents, credit: recomputedCreditCents, normalBalance: acc.normal_balance });
    const balanceDifferenceCents = glBalanceCents - recomputedBalanceCents;
    const absoluteVarianceCents = absUnits(balanceDifferenceCents);

    const accountTypeCode = normalisedTypeCode(acc.account_type_code);
    const materialityThreshold = policy.thresholdsByAccountType?.[accountTypeCode] ?? policy.defaultThreshold;
    const materialityThresholdCents = moneyUnits(materialityThreshold || "0");
    // Canonical ledger amounts have a two-decimal boundary, so an exact match is
    // exact minor-unit equality. Floating tolerances are neither needed nor safe.
    const technicalMatch = diffDebitCents === 0n && diffCreditCents === 0n;
    const isMatch = technicalMatch;
    const isCorrectable = !technicalMatch && absoluteVarianceCents <= materialityThresholdCents;

    if (!technicalMatch) exactMismatchCount += 1;
    if (!isMatch) mismatchCount += 1;
    if (absoluteVarianceCents > 0n) totalVarianceCents += absoluteVarianceCents;
    if (isCorrectable) correctableAccounts += 1;

    const glDebit = moneyNumber(moneyStringFromUnits(glDebitCents));
    const glCredit = moneyNumber(moneyStringFromUnits(glCreditCents));
    const recomputedDebit = moneyNumber(moneyStringFromUnits(recomputedDebitCents));
    const recomputedCredit = moneyNumber(moneyStringFromUnits(recomputedCreditCents));
    const diffDebit = moneyNumber(moneyStringFromUnits(diffDebitCents));
    const diffCredit = moneyNumber(moneyStringFromUnits(diffCreditCents));
    const glBalance = moneyNumber(moneyStringFromUnits(glBalanceCents));
    const recomputedBalance = moneyNumber(moneyStringFromUnits(recomputedBalanceCents));
    const balanceDifference = moneyNumber(moneyStringFromUnits(balanceDifferenceCents));
    const absoluteVariance = moneyNumber(moneyStringFromUnits(absoluteVarianceCents));

    diffs.push({
      accountId: id,
      accountCode: acc.code,
      accountName: acc.name,
      accountTypeId: acc.account_type_id,
      accountTypeCode,
      accountTypeName: acc.account_type_name,
      accountType: acc.account_type_name || accountTypeCode.toLowerCase(),
      normalBalance: acc.normal_balance,
      status: acc.status,
      glDebit,
      glCredit,
      recomputedDebit,
      recomputedCredit,
      diffDebit,
      diffCredit,
      glBalance,
      recomputedBalance,
      balanceDifference,
      absoluteVariance,
      materialityThreshold,
      technicalMatch,
      isMatch,
      isCorrectable,
      lineCount: Number(b.line_count || 0),
      investigationUrl: `/core/accounting/reconciliation/discrepancy-details?periodId=${periodId}&accountId=${id}`,
    });
  }

  const filteredDiffs = onlyMismatches ? diffs.filter((d) => !d.isMatch) : diffs;
  const warnings = [];
  if (String(period.status).toLowerCase() !== "closed") {
    warnings.push(`Period ${period.code} is ${period.status}; results may change until the period is closed.`);
  }
  if (exactMismatchCount > 0 && mismatchCount === 0) {
    warnings.push("All differences are within configured materiality thresholds, but exact ledger totals are not identical.");
  }

  return {
    periodId,
    periodCode: period.code,
    periodStatus: period.status,
    periodStartDate: period.start_date,
    periodEndDate: period.end_date,
    ok: mismatchCount === 0,
    warnings,
    policy,
    summary: {
      accountsCompared: diffs.length,
      mismatches: mismatchCount,
      exactMismatches: exactMismatchCount,
      correctableAccounts,
      totalVariance: moneyNumber(moneyStringFromUnits(totalVarianceCents)),
    },
    diffs: filteredDiffs,
  };
}

async function saveHistory({ orgId, actorUserId, periodId, actionType, status, summary, thresholdJson = {}, metaJson = {}, client = pool }) {
  await client.query(
    `INSERT INTO ledger_reconciliation_history
      (organization_id, period_id, action_type, status, accounts_compared, mismatch_count, total_variance, threshold_json, summary_json, meta_json, triggered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
    [
      orgId,
      periodId,
      actionType,
      status,
      Number(summary.accountsCompared || 0),
      Number(summary.mismatches || 0),
      moneyStringFromUnits(moneyUnits(summary.totalVariance || "0")),
      JSON.stringify(thresholdJson || {}),
      JSON.stringify(summary || {}),
      JSON.stringify(metaJson || {}),
      actorUserId || null,
    ]
  );
}

async function reconcilePeriod({ orgId, actorUserId, periodId, onlyMismatches = false, persistHistory = true }) {
  const data = await buildReconciliationData({ orgId, periodId, onlyMismatches });
  if (persistHistory) {
    await saveHistory({
      orgId,
      actorUserId,
      periodId,
      actionType: "scan",
      status: data.ok ? "reconciled" : "issues",
      summary: data.summary,
      thresholdJson: data.policy,
      metaJson: { onlyMismatches },
    });
  }
  return data;
}

async function getDiscrepancyDetails({ orgId, periodId, accountId }) {
  if (!periodId) throw new AppError(400, "periodId is required");
  if (!accountId) throw new AppError(400, "accountId is required");

  const data = await buildReconciliationData({ orgId, periodId, onlyMismatches: false });
  const row = data.diffs.find((d) => d.accountId === String(accountId));
  if (!row) throw new AppError(404, "Account was not found in reconciliation set");

  const txns = await pool.query(
    `
    SELECT
      jel.id AS line_id,
      jel.journal_entry_id,
      je.entry_no,
      je.entry_date,
      je.memo,
      jel.description AS line_description,
      jel.debit,
      jel.credit,
      jel.amount_base,
      je.status
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id=$1
      AND je.period_id=$2
      AND je.status IN ('posted','voided')
      AND jel.account_id=$3
    ORDER BY je.entry_date ASC, je.entry_no ASC, jel.line_no ASC
    `,
    [orgId, periodId, accountId]
  );

  let runningBalanceCents = 0n;
  const transactions = txns.rows.map((txn) => {
    const debitCents = moneyUnits(txn.debit || "0");
    const creditCents = moneyUnits(txn.credit || "0");
    const type = debitCents > 0n ? "debit" : "credit";
    const amountCents = moneyUnits(txn.amount_base || (type === "debit" ? txn.debit : txn.credit) || "0");
    runningBalanceCents += calculateBalanceUnits({
      debit: type === "debit" ? amountCents : 0n,
      credit: type === "credit" ? amountCents : 0n,
      normalBalance: row.normalBalance,
    });
    const amount = moneyNumber(moneyStringFromUnits(amountCents));
    const runningBalance = moneyNumber(moneyStringFromUnits(runningBalanceCents));
    return {
      lineId: txn.line_id,
      journalEntryId: txn.journal_entry_id,
      entryNo: txn.entry_no,
      entryDate: txn.entry_date,
      reference: txn.entry_no ? `JE-${txn.entry_no}` : null,
      memo: txn.memo,
      lineDescription: txn.line_description,
      type,
      amount,
      runningBalance,
      drillThrough: {
        apiPath: buildApiJournalPath(txn.journal_entry_id),
        appPath: buildAppJournalPath(txn.journal_entry_id),
      },
    };
  });

  return {
    account: {
      id: row.accountId,
      code: row.accountCode,
      name: row.accountName,
      type: row.accountType,
      typeCode: row.accountTypeCode,
      normalBalance: row.normalBalance,
    },
    summary: {
      transactionCount: transactions.length,
      glBalance: row.glBalance,
      computedBalance: row.recomputedBalance,
      variance: row.balanceDifference,
      glDebit: row.glDebit,
      glCredit: row.glCredit,
      recomputedDebit: row.recomputedDebit,
      recomputedCredit: row.recomputedCredit,
      materialityThreshold: row.materialityThreshold,
      exactMatch: row.technicalMatch,
    },
    transactions,
  };
}

async function autoCorrect({ orgId, actorUserId, periodId, threshold, dryRun = true, audit = {} }) {
  if (!periodId) throw new AppError(400, "periodId is required");
  const data = await buildReconciliationData({ orgId, periodId, onlyMismatches: false });
  const effectiveThreshold = threshold == null ? data.policy.defaultThreshold : threshold;
  const effectiveThresholdCents = moneyUnits(effectiveThreshold || "0");
  if (effectiveThresholdCents < 0n) throw new AppError(400, "threshold must be zero or greater");

  const corrections = data.diffs
    .filter((d) => !d.technicalMatch && moneyUnits(d.absoluteVariance || "0") <= effectiveThresholdCents)
    .map((d) => ({
      accountId: d.accountId,
      accountCode: d.accountCode,
      accountName: d.accountName,
      variance: d.balanceDifference,
      glDebitBefore: d.glDebit,
      glCreditBefore: d.glCredit,
      glDebitAfter: d.recomputedDebit,
      glCreditAfter: d.recomputedCredit,
    }));

  const result = {
    dryRun,
    periodId,
    threshold: moneyNumber(moneyStringFromUnits(effectiveThresholdCents)),
    summary: {
      totalMismatches: data.summary.exactMismatches,
      correctableAccounts: corrections.length,
      totalVarianceCorrected: moneyNumber(moneyStringFromUnits(corrections.reduce((sum, row) => sum + absUnits(moneyUnits(row.variance || "0")), 0n))),
    },
    corrections,
  };

  if (dryRun) {
    await saveHistory({
      orgId,
      actorUserId,
      periodId,
      actionType: "auto_correct_preview",
      status: "preview",
      summary: {
        accountsCompared: data.summary.accountsCompared,
        mismatches: data.summary.mismatches,
        totalVariance: result.summary.totalVarianceCorrected,
      },
      thresholdJson: { threshold: moneyNumber(moneyStringFromUnits(effectiveThresholdCents)) },
      metaJson: { corrections },
    });
    return result;
  }

  await withTransaction(async (client) => {
    for (const corr of corrections) {
      await client.query(
        `INSERT INTO general_ledger_balances(organization_id, period_id, account_id, debit_total, credit_total, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (organization_id, period_id, account_id)
         DO UPDATE SET debit_total=EXCLUDED.debit_total,
                       credit_total=EXCLUDED.credit_total,
                       updated_at=NOW()`,
        [orgId, periodId, corr.accountId, corr.glDebitAfter, corr.glCreditAfter]
      );
    }

    await saveHistory({
      orgId,
      actorUserId,
      periodId,
      actionType: "auto_correct_apply",
      status: corrections.length ? "corrected" : "reconciled",
      summary: {
        accountsCompared: data.summary.accountsCompared,
        mismatches: Math.max(data.summary.mismatches - corrections.length, 0),
        totalVariance: result.summary.totalVarianceCorrected,
      },
      thresholdJson: { threshold: moneyNumber(moneyStringFromUnits(effectiveThresholdCents)) },
      metaJson: { corrections },
      client,
    });
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "accounting.reconciliation.auto_corrected",
    entityType: "ledger_reconciliation",
    entityId: null,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before: { periodId, threshold: effectiveThreshold },
    after: result,
  });

  return result;
}

async function rebuildBalances({ orgId, actorUserId, periodId, dryRun = true, audit = {} }) {
  if (!periodId) throw new AppError(400, "periodId is required");
  const before = await buildReconciliationData({ orgId, periodId, onlyMismatches: false });

  const recomputed = await pool.query(
    `
    SELECT account_id, debit_total, credit_total
    FROM accounting_posted_ledger_totals
    WHERE organization_id=$1 AND period_id=$2
    `,
    [orgId, periodId]
  );

  const payload = {
    dryRun,
    periodId,
    rowsToRebuild: recomputed.rows.length,
    mismatchesBefore: before.summary.mismatches,
    totalVarianceBefore: before.summary.totalVariance,
  };

  if (!dryRun) {
    await withTransaction(async (client) => {
      await client.query(
        `DELETE FROM general_ledger_balances WHERE organization_id=$1 AND period_id=$2`,
        [orgId, periodId]
      );
      for (const row of recomputed.rows) {
        await client.query(
          `INSERT INTO general_ledger_balances(organization_id, period_id, account_id, debit_total, credit_total)
           VALUES ($1,$2,$3,$4,$5)`,
          [orgId, periodId, row.account_id, row.debit_total, row.credit_total]
        );
      }
      await saveHistory({
        orgId,
        actorUserId,
        periodId,
        actionType: "rebuild",
        status: "rebuilt",
        summary: {
          accountsCompared: before.summary.accountsCompared,
          mismatches: before.summary.mismatches,
          totalVariance: before.summary.totalVariance,
        },
        metaJson: payload,
        client,
      });
    });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "accounting.reconciliation.rebuilt_balances",
      entityType: "general_ledger_balances",
      entityId: null,
      ip: audit.ip,
      userAgent: audit.userAgent,
      before: { periodId, mismatches: before.summary.mismatches, totalVariance: before.summary.totalVariance },
      after: payload,
    });
  }

  const after = dryRun ? null : await buildReconciliationData({ orgId, periodId, onlyMismatches: false });
  return {
    ...payload,
    mismatchesAfter: after?.summary?.mismatches ?? null,
    totalVarianceAfter: after?.summary?.totalVariance ?? null,
  };
}

async function getHistory({ orgId, periodId, limit = 50 }) {
  if (!periodId) throw new AppError(400, "periodId is required");
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const { rows } = await pool.query(
    `
    SELECT h.id, h.action_type, h.status, h.accounts_compared, h.mismatch_count, h.total_variance,
           h.threshold_json, h.summary_json, h.meta_json, h.created_at,
           u.full_name AS triggered_by_name, u.email AS triggered_by_email
      FROM ledger_reconciliation_history h
      LEFT JOIN users u ON u.id = h.triggered_by
     WHERE h.organization_id=$1 AND h.period_id=$2
     ORDER BY h.created_at DESC
     LIMIT $3
    `,
    [orgId, periodId, safeLimit]
  );
  return rows;
}

async function exportReconciliation({ orgId, actorUserId, periodId, format = "csv", onlyMismatches = false, audit = {} }) {
  const data = await buildReconciliationData({ orgId, periodId, onlyMismatches });
  const normalizedFormat = String(format || "csv").toLowerCase();
  let body;
  let contentType;
  let ext;
  if (normalizedFormat === "json") {
    body = JSON.stringify({ data }, null, 2);
    contentType = "application/json";
    ext = "json";
  } else if (normalizedFormat === "csv") {
    const header = [
      "accountCode",
      "accountName",
      "accountType",
      "glBalance",
      "recomputedBalance",
      "balanceDifference",
      "materialityThreshold",
      "technicalMatch",
      "isMatch",
      "glDebit",
      "glCredit",
      "recomputedDebit",
      "recomputedCredit",
    ];
    body = toCsvGeneric({ header, rows: data.diffs });
    contentType = "text/csv; charset=utf-8";
    ext = "csv";
  } else {
    throw new AppError(400, "format must be csv or json");
  }

  await saveHistory({
    orgId,
    actorUserId,
    periodId,
    actionType: "export",
    status: "exported",
    summary: data.summary,
    thresholdJson: data.policy,
    metaJson: { format: normalizedFormat, onlyMismatches },
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "accounting.reconciliation.exported",
    entityType: "ledger_reconciliation",
    entityId: null,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before: null,
    after: { periodId, format: normalizedFormat, onlyMismatches },
  });

  return {
    contentType,
    contentDisposition: `attachment; filename="ledger-reconciliation-${periodId}.${ext}"`,
    body,
  };
}

module.exports = {
  reconcilePeriod,
  getDiscrepancyDetails,
  autoCorrect,
  rebuildBalances,
  getHistory,
  getPolicy,
  upsertPolicy,
  exportReconciliation,
};
