const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");

/**
 * Reconcile general ledger balances against recomputed journal entries for a period
 * @param {Object} params
 * @param {string} params.orgId - Organization ID
 * @param {string} params.periodId - Period ID to reconcile
 * @param {boolean} params.onlyMismatches - Return only accounts with discrepancies
 * @param {string} params.actorUserId - User performing reconciliation
 * @param {Object} params.req - Express request object for audit
 * @returns {Promise<Object>} Reconciliation results
 */
async function reconcilePeriod({ orgId, periodId, onlyMismatches = false, actorUserId, req }) {
  // Input validation
  if (!orgId) throw new AppError(400, "orgId is required");
  if (!periodId) throw new AppError(400, "periodId is required");

  // Verify period exists and belongs to org
  const periodCheck = await pool.query(
    `SELECT id, code, status, start_date, end_date 
     FROM accounting_periods 
     WHERE id=$1 AND organization_id=$2`,
    [periodId, orgId]
  );
  
  if (periodCheck.rows.length === 0) {
    throw new AppError(404, "Period not found or does not belong to organization");
  }

  const period = periodCheck.rows[0];
  
  // Log warning if period is not closed
  const warnings = [];
  if (period.status !== 'closed') {
    const warning = `Reconciling open period: ${period.code}. Results may change as transactions are posted.`;
    console.warn(warning);
    warnings.push(warning);
  }

  try {
    // Fetch account metadata for display
 const accounts = await pool.query(
  `SELECT 
     coa.id, 
     coa.code, 
     coa.name,
     coa.account_type_id,
     at.name as account_type,  -- Get the type name
     coa.parent_account_id
   FROM chart_of_accounts coa
   LEFT JOIN account_types at ON coa.account_type_id = at.id
   WHERE coa.organization_id=$1
   ORDER BY coa.code`,
  [orgId]
);
    
    const accountMap = new Map(
      accounts.rows.map(a => [String(a.id), a])
    );

    // GL balances (authoritative in this kernel)
    const gl = await pool.query(
      `SELECT account_id, 
              COALESCE(debit_total, 0) AS debit_total, 
              COALESCE(credit_total, 0) AS credit_total,
              updated_at
       FROM general_ledger_balances
       WHERE organization_id=$1 AND period_id=$2`,
      [orgId, periodId]
    );

    // Recompute from posted journals as a verification layer
    const jl = await pool.query(
      `SELECT
        jel.account_id,
        SUM(CASE WHEN COALESCE(jel.debit, 0) > 0 THEN jel.amount_base ELSE 0 END) AS debit_total,
        SUM(CASE WHEN COALESCE(jel.credit, 0) > 0 THEN jel.amount_base ELSE 0 END) AS credit_total,
        COUNT(*) as transaction_count
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE je.organization_id=$1
         AND je.period_id=$2
         AND je.status='posted'
       GROUP BY jel.account_id`,
      [orgId, periodId]
    );

    const byId = (rows) => {
      const m = new Map();
      for (const r of rows) m.set(String(r.account_id), r);
      return m;
    };

    const glMap = byId(gl.rows);
    const jlMap = byId(jl.rows);
    const accountIds = new Set([...glMap.keys(), ...jlMap.keys()]);

    const diffs = [];
    let ok = true;
    let totalVariance = 0;

    for (const id of Array.from(accountIds).sort()) {
      const glData = glMap.get(id) || { debit_total: 0, credit_total: 0 };
      const jlData = jlMap.get(id) || { debit_total: 0, credit_total: 0, transaction_count: 0 };
      const account = accountMap.get(id);
      
      // Convert to numbers for calculation
      const glDebit = Number(glData.debit_total);
      const glCredit = Number(glData.credit_total);
      const recomputedDebit = Number(jlData.debit_total);
      const recomputedCredit = Number(jlData.credit_total);
      
      // Calculate differences
      const diffDebit = glDebit - recomputedDebit;
      const diffCredit = glCredit - recomputedCredit;
      
      // Calculate net balances
      const glBalance = glDebit - glCredit;
      const recomputedBalance = recomputedDebit - recomputedCredit;
      const balanceDifference = glBalance - recomputedBalance;
      
      // Tolerance check (0.005 for floating-point precision)
      const isMatch = Math.abs(diffDebit) < 0.005 && Math.abs(diffCredit) < 0.005;
      
      if (!isMatch) {
        ok = false;
        totalVariance += Math.abs(balanceDifference);
      }

      diffs.push({
        accountId: id,
        accountCode: account?.code || null,
        accountName: account?.name || null,
        accountType: account?.account_type || null,
        glDebit,
        glCredit,
        glBalance,
        recomputedDebit,
        recomputedCredit,
        recomputedBalance,
        diffDebit,
        diffCredit,
        balanceDifference,
        transactionCount: Number(jlData.transaction_count || 0),
        lastUpdated: glData.updated_at || null,
        isMatch,
      });
    }

    // Sort: mismatches first, then by account code
    diffs.sort((a, b) => {
      if (a.isMatch !== b.isMatch) return a.isMatch ? 1 : -1;
      return (a.accountCode || '').localeCompare(b.accountCode || '');
    });

    // Filter if requested
    let filteredDiffs = diffs;
    if (onlyMismatches) {
      filteredDiffs = diffs.filter(d => !d.isMatch);
    }

    // Log reconciliation event (for audit trail)
    await logReconciliationEvent({
      orgId,
      periodId,
      ok,
      accountsCompared: diffs.length,
      mismatches: diffs.filter(d => !d.isMatch).length,
      totalVariance,
      actorUserId,
      req,
    });

    return {
      periodId,
      periodCode: period.code,
      periodStatus: period.status,
      reconciledAt: new Date().toISOString(),
      ok,
      warnings: warnings.length > 0 ? warnings : null,
      summary: {
        accountsCompared: diffs.length,
        accountsReturned: filteredDiffs.length,
        mismatches: diffs.filter(d => !d.isMatch).length,
        totalVariance: parseFloat(totalVariance.toFixed(2)),
        totalGlBalance: parseFloat(
          diffs.reduce((sum, d) => sum + d.glBalance, 0).toFixed(2)
        ),
        totalRecomputedBalance: parseFloat(
          diffs.reduce((sum, d) => sum + d.recomputedBalance, 0).toFixed(2)
        ),
      },
      diffs: filteredDiffs,
      hasMore: onlyMismatches && filteredDiffs.length < diffs.length,
    };
  } catch (error) {
    console.error("Reconciliation error:", error);
    throw new AppError(
      500, 
      `Reconciliation failed: ${error.message}`,
      { periodId, orgId }
    );
  }
}

/**
 * Get detailed transaction history for a specific account discrepancy
 * @param {Object} params
 * @param {string} params.orgId - Organization ID
 * @param {string} params.periodId - Period ID
 * @param {string} params.accountId - Account ID to investigate
 * @param {string} params.actorUserId - User requesting details
 * @param {Object} params.req - Express request object for audit
 * @returns {Promise<Object>} Detailed transaction breakdown
 */
async function getDiscrepancyDetails({ orgId, periodId, accountId, actorUserId, req }) {
  if (!orgId) throw new AppError(400, "orgId is required");
  if (!periodId) throw new AppError(400, "periodId is required");
  if (!accountId) throw new AppError(400, "accountId is required");

  try {
    // Get account info
    const accountInfo = await pool.query(
      `SELECT id, code, name, account_type
       FROM accounts
       WHERE id=$1 AND organization_id=$2`,
      [accountId, orgId]
    );

    if (accountInfo.rows.length === 0) {
      throw new AppError(404, "Account not found");
    }

    // Get all transactions for this account in the period
    const transactions = await pool.query(
      `SELECT 
        je.id as journal_entry_id,
        je.entry_date,
        je.reference,
        je.memo,
        je.status,
        je.created_at,
        je.posted_at,
        jel.id as line_id,
        jel.debit,
        jel.credit,
        jel.amount_base,
        jel.description as line_description
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE je.organization_id=$1
         AND je.period_id=$2
         AND jel.account_id=$3
         AND je.status='posted'
       ORDER BY je.entry_date, je.created_at, jel.id`,
      [orgId, periodId, accountId]
    );

    // Get GL balance
    const glBalance = await pool.query(
      `SELECT 
        debit_total,
        credit_total,
        updated_at
       FROM general_ledger_balances
       WHERE organization_id=$1 
         AND period_id=$2 
         AND account_id=$3`,
      [orgId, periodId, accountId]
    );

    // Calculate running balance
    let runningBalance = 0;
    const transactionsWithBalance = transactions.rows.map(t => {
      const debit = Number(t.debit || 0);
      const credit = Number(t.credit || 0);
      runningBalance += (debit - credit);
      
      return {
        journalEntryId: t.journal_entry_id,
        lineId: t.line_id,
        entryDate: t.entry_date,
        reference: t.reference,
        memo: t.memo,
        lineDescription: t.line_description,
        status: t.status,
        debit,
        credit,
        amount: debit || credit,
        type: debit > 0 ? 'debit' : 'credit',
        runningBalance: parseFloat(runningBalance.toFixed(2)),
        postedAt: t.posted_at,
        createdAt: t.created_at,
      };
    });

    const glData = glBalance.rows[0] || { debit_total: 0, credit_total: 0 };
    const totalDebits = transactions.rows.reduce((sum, t) => sum + Number(t.debit || 0), 0);
    const totalCredits = transactions.rows.reduce((sum, t) => sum + Number(t.credit || 0), 0);

    const result = {
      account: accountInfo.rows[0],
      periodId,
      summary: {
        transactionCount: transactions.rows.length,
        totalDebits: parseFloat(totalDebits.toFixed(2)),
        totalCredits: parseFloat(totalCredits.toFixed(2)),
        computedBalance: parseFloat((totalDebits - totalCredits).toFixed(2)),
        glDebitTotal: parseFloat(Number(glData.debit_total).toFixed(2)),
        glCreditTotal: parseFloat(Number(glData.credit_total).toFixed(2)),
        glBalance: parseFloat((Number(glData.debit_total) - Number(glData.credit_total)).toFixed(2)),
        variance: parseFloat(
          ((Number(glData.debit_total) - Number(glData.credit_total)) - (totalDebits - totalCredits)).toFixed(2)
        ),
        lastGlUpdate: glData.updated_at,
      },
      transactions: transactionsWithBalance,
    };

    // Log audit trail for discrepancy investigation
    await writeAudit({
      req,
      organizationId: orgId,
      actorUserId,
      action: "reconciliation.discrepancy_details_viewed",
      entityType: "account",
      entityId: accountId,
      metadata: {
        periodId,
        transactionCount: transactions.rows.length,
        variance: result.summary.variance,
      },
    });

    return result;
  } catch (error) {
    console.error("Error fetching discrepancy details:", error);
    throw new AppError(
      500,
      `Failed to fetch discrepancy details: ${error.message}`,
      { accountId, periodId, orgId }
    );
  }
}

/**
 * Auto-correct minor rounding differences in GL balances
 * @param {Object} params
 * @param {string} params.orgId - Organization ID
 * @param {string} params.periodId - Period ID
 * @param {number} params.threshold - Maximum variance to auto-correct (default: 0.01)
 * @param {boolean} params.dryRun - Preview changes without applying (default: true)
 * @param {string} params.actorUserId - User performing correction
 * @param {Object} params.req - Express request object for audit
 * @returns {Promise<Object>} Correction results
 */
async function autoCorrectRoundingDifferences({ 
  orgId, 
  periodId, 
  threshold = 0.01, 
  dryRun = true,
  actorUserId,
  req,
}) {
  if (!orgId) throw new AppError(400, "orgId is required");
  if (!periodId) throw new AppError(400, "periodId is required");

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Get reconciliation data
    const recon = await reconcilePeriod({ orgId, periodId, onlyMismatches: true, actorUserId, req });
    
    // Find accounts with minor differences within threshold
    const correctableAccounts = recon.diffs.filter(d => 
      !d.isMatch && Math.abs(d.balanceDifference) <= threshold
    );

    const corrections = [];

    for (const account of correctableAccounts) {
      const correction = {
        accountId: account.accountId,
        accountCode: account.accountCode,
        accountName: account.accountName,
        variance: account.balanceDifference,
        oldGlDebit: account.glDebit,
        oldGlCredit: account.glCredit,
        newGlDebit: account.recomputedDebit,
        newGlCredit: account.recomputedCredit,
        correctionType: 'rounding',
      };

      if (!dryRun) {
        // Update GL balance to match recomputed values
        await client.query(
          `UPDATE general_ledger_balances
           SET debit_total = $1,
               credit_total = $2,
               updated_at = NOW()
           WHERE organization_id = $3
             AND period_id = $4
             AND account_id = $5`,
          [
            account.recomputedDebit,
            account.recomputedCredit,
            orgId,
            periodId,
            account.accountId,
          ]
        );

        // Log the correction in audit trail
        await writeAudit({
          req,
          organizationId: orgId,
          actorUserId,
          action: "reconciliation.auto_correct_rounding",
          entityType: "general_ledger_balance",
          entityId: account.accountId,
          before: {
            debit_total: account.oldGlDebit,
            credit_total: account.oldGlCredit,
          },
          after: {
            debit_total: account.newGlDebit,
            credit_total: account.newGlCredit,
          },
          metadata: {
            periodId,
            variance: account.variance,
            correctionType: 'auto_rounding',
            threshold,
          },
        });
      }

      corrections.push(correction);
    }

    if (!dryRun) {
      await client.query('COMMIT');
      
      // Log summary audit event for the entire correction batch
      await writeAudit({
        req,
        organizationId: orgId,
        actorUserId,
        action: "reconciliation.auto_correct_batch_completed",
        entityType: "period",
        entityId: periodId,
        metadata: {
          accountsCorrected: corrections.length,
          totalVarianceCorrected: corrections.reduce((sum, c) => sum + Math.abs(c.variance), 0),
          threshold,
        },
      });
    } else {
      await client.query('ROLLBACK');
    }

    return {
      dryRun,
      threshold,
      summary: {
        totalMismatches: recon.summary.mismatches,
        correctableAccounts: corrections.length,
        totalVarianceCorrected: parseFloat(
          corrections.reduce((sum, c) => sum + Math.abs(c.variance), 0).toFixed(2)
        ),
      },
      corrections,
      message: dryRun 
        ? `Preview: ${corrections.length} accounts would be corrected. Set dryRun=false to apply.`
        : `Successfully corrected ${corrections.length} accounts.`,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Auto-correction error:", error);
    throw new AppError(
      500,
      `Auto-correction failed: ${error.message}`,
      { periodId, orgId }
    );
  } finally {
    client.release();
  }
}

/**
 * Log reconciliation event for audit trail
 * @private
 */
async function logReconciliationEvent({ 
  orgId, 
  periodId, 
  ok, 
  accountsCompared, 
  mismatches, 
  totalVariance,
  actorUserId,
  req,
}) {
  try {
    await writeAudit({
      req,
      organizationId: orgId,
      actorUserId,
      action: ok ? "reconciliation.completed_success" : "reconciliation.completed_with_discrepancies",
      entityType: "period",
      entityId: periodId,
      metadata: {
        accountsCompared,
        mismatches,
        totalVariance: parseFloat(totalVariance.toFixed(2)),
        status: ok ? 'success' : 'discrepancies',
      },
    });
  } catch (error) {
    // Don't fail reconciliation if audit logging fails
    console.error("Failed to log reconciliation event:", error);
  }
}

module.exports = { 
  reconcilePeriod,
  getDiscrepancyDetails,
  autoCorrectRoundingDifferences,
};