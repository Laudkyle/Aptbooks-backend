const { pool } = require("../../../db/pool"); 
const { AppError } = require("../../../shared/errors/AppError"); 

async function reconcilePeriod({ orgId, periodId }) {
  if (!periodId) throw new AppError(400, "periodId is required"); 

  // GL balances (authoritative in this kernel)
  const gl = await pool.query(
    `
    SELECT account_id, COALESCE(debit_total,0) AS debit_total, COALESCE(credit_total,0) AS credit_total
    FROM general_ledger_balances
    WHERE organization_id=$1 AND period_id=$2
    `,
    [orgId, periodId]
  ); 

  // Recompute from posted journals as a verification layer
  const jl = await pool.query(
    `
    SELECT
      jel.account_id,
      SUM(CASE WHEN COALESCE(jel.debit,0) > 0 THEN jel.amount_base ELSE 0 END) AS debit_total,
      SUM(CASE WHEN COALESCE(jel.credit,0) > 0 THEN jel.amount_base ELSE 0 END) AS credit_total
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id=$1
      AND je.period_id=$2
      AND je.status='posted'
    GROUP BY jel.account_id
    `,
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
  for (const id of Array.from(accountIds).sort()) {
    const a = glMap.get(id) || { debit_total: 0, credit_total: 0 }; 
    const b = jlMap.get(id) || { debit_total: 0, credit_total: 0 }; 
    const dd = Number(a.debit_total) - Number(b.debit_total); 
    const cd = Number(a.credit_total) - Number(b.credit_total); 
    const isMatch = Math.abs(dd) < 0.005 && Math.abs(cd) < 0.005; 
    if (!isMatch) ok = false; 
    diffs.push({
      accountId: id,
      glDebit: a.debit_total,
      glCredit: a.credit_total,
      recomputedDebit: b.debit_total,
      recomputedCredit: b.credit_total,
      diffDebit: dd,
      diffCredit: cd,
      isMatch,
    }); 
  }

  return {
    periodId,
    ok,
    summary: {
      accountsCompared: diffs.length,
      mismatches: diffs.filter((d) => !d.isMatch).length,
    },
    diffs,
  }; 
}

module.exports = { reconcilePeriod }; 
