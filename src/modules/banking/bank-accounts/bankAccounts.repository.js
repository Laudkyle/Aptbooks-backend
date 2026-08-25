const { pool } = require('../../../db/pool');
function db(client){ return client || pool; }

const SELECT = `ba.id, ba.organization_id, ba.code, ba.name, ba.currency_code, ba.gl_account_id, ba.is_active,
  ba.bank_name, ba.branch_name, ba.account_number_masked, ba.swift_bic, ba.account_type,
  ba.minimum_balance, ba.overdraft_limit, ba.reconciliation_tolerance, ba.created_at, ba.updated_at,
  coa.code AS gl_account_code, coa.name AS gl_account_name`;

async function create(orgId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO bank_accounts(
       organization_id, code, name, currency_code, gl_account_id, is_active,
       bank_name, branch_name, account_number_masked, swift_bic, account_type,
       minimum_balance, overdraft_limit, reconciliation_tolerance, updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
     RETURNING *`,
    [orgId, payload.code, payload.name, payload.currencyCode, payload.glAccountId, payload.isActive !== false,
      payload.bankName || null, payload.branchName || null, payload.accountNumberMasked || null,
      payload.swiftBic || null, payload.accountType || 'current', payload.minimumBalance || '0.00',
      payload.overdraftLimit || '0.00', payload.reconciliationTolerance || '0.01']
  );
  return rows[0];
}

async function list(orgId, client = null) {
  const { rows } = await db(client).query(
    `SELECT ${SELECT}
       FROM bank_accounts ba
       LEFT JOIN chart_of_accounts coa ON coa.id=ba.gl_account_id AND coa.organization_id=ba.organization_id
      WHERE ba.organization_id=$1 ORDER BY ba.code`, [orgId]
  );
  return rows;
}

async function get(orgId, id, client = null, forUpdate = false) {
  const q = forUpdate
    ? `SELECT id, organization_id, code, name, currency_code, gl_account_id, is_active, bank_name, branch_name, account_number_masked, swift_bic, account_type, minimum_balance, overdraft_limit, reconciliation_tolerance, created_at, updated_at FROM bank_accounts WHERE organization_id=$1 AND id=$2 FOR UPDATE`
    : `SELECT ${SELECT} FROM bank_accounts ba LEFT JOIN chart_of_accounts coa ON coa.id=ba.gl_account_id AND coa.organization_id=ba.organization_id WHERE ba.organization_id=$1 AND ba.id=$2`;
  const { rows } = await db(client).query(q, [orgId, id]);
  return rows[0] || null;
}

async function update(orgId, id, patch, client = null) {
  const mapping = {
    code:'code', name:'name', currencyCode:'currency_code', glAccountId:'gl_account_id', isActive:'is_active',
    bankName:'bank_name', branchName:'branch_name', accountNumberMasked:'account_number_masked', swiftBic:'swift_bic',
    accountType:'account_type', minimumBalance:'minimum_balance', overdraftLimit:'overdraft_limit', reconciliationTolerance:'reconciliation_tolerance'
  };
  const params=[orgId,id]; const sets=[];
  for(const [key,col] of Object.entries(mapping)){ if(patch[key] !== undefined){ params.push(patch[key]); sets.push(`${col}=$${params.length}`); } }
  if(!sets.length) return get(orgId,id,client);
  sets.push('updated_at=NOW()');
  const { rows } = await db(client).query(`UPDATE bank_accounts SET ${sets.join(', ')} WHERE organization_id=$1 AND id=$2 RETURNING *`, params);
  return rows[0] || null;
}

async function getBlockingUsage(orgId, id, client = null) {
  const { rows } = await db(client).query(
    `SELECT
       (SELECT COUNT(*) FROM payment_runs WHERE organization_id=$1 AND bank_account_id=$2 AND status IN ('draft','submitted','approved'))::int AS payment_runs,
       (SELECT COUNT(*) FROM bank_transfers WHERE organization_id=$1 AND (from_bank_account_id=$2 OR to_bank_account_id=$2) AND status IN ('draft','submitted','approved'))::int AS transfers,
       (SELECT COUNT(*) FROM cheques WHERE organization_id=$1 AND bank_account_id=$2 AND status='issued')::int AS issued_cheques,
       (SELECT COUNT(*) FROM bank_statements WHERE organization_id=$1 AND bank_account_id=$2 AND status <> 'locked')::int AS open_statements`, [orgId,id]
  );
  return rows[0] || {payment_runs:0,transfers:0,issued_cheques:0,open_statements:0};
}

module.exports={create,list,get,update,getBlockingUsage};
