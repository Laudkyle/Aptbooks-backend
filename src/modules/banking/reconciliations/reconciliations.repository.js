const { pool } = require("../../../db/pool");

function db(client) { return client || pool; }

async function findActive(orgId, bankAccountId, periodId, client = null) {
  const { rows } = await db(client).query(
    `SELECT * FROM bank_reconciliations
     WHERE organization_id=$1 AND bank_account_id=$2 AND period_id=$3 AND status='reconciled'
     ORDER BY reconciled_at DESC
     LIMIT 1`,
    [orgId, bankAccountId, periodId]
  );
  return rows[0] || null;
}


async function create(orgId, userId, { bankAccountId, periodId }, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO bank_reconciliations(organization_id, bank_account_id, period_id, reconciled_by)
     VALUES($1,$2,$3,$4)
     RETURNING *`,
    [orgId, bankAccountId, periodId, userId || null]
  );
  return rows[0];
}

async function list(orgId, query = {}, client = null) {
  const limit = Math.min(Number(query.limit || 50), 200);
  const offset = Math.max(Number(query.offset || 0), 0);
  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (query.bankAccountId) {
    params.push(query.bankAccountId);
    where += ` AND bank_account_id=$${params.length}`;
  }
  if (query.periodId) {
    params.push(query.periodId);
    where += ` AND period_id=$${params.length}`;
  }
  if (typeof query.is_locked === "boolean") {
    params.push(query.is_locked);
    where += ` AND is_locked=$${params.length}`;
  }
  params.push(limit);
  params.push(offset);

  const { rows } = await db(client).query(
    `SELECT * FROM bank_reconciliations ${where} ORDER BY reconciled_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function getById(orgId, id, client = null, forUpdate = false) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const { rows } = await db(client).query(
    `SELECT * FROM bank_reconciliations WHERE organization_id=$1 AND id=$2${lock}`,
    [orgId, id]
  );
  return rows[0] || null;
}

async function close(orgId, id, userId, note, client = null) {
  const { rows } = await db(client).query(
    `UPDATE bank_reconciliations
     SET is_locked=TRUE, closed_at=NOW(), closed_by=$3, close_note=$4
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [orgId, id, userId || null, note || null]
  );
  return rows[0] || null;
}

async function unlock(orgId, id, userId, client = null) {
  const { rows } = await db(client).query(
    `UPDATE bank_reconciliations
     SET is_locked=FALSE, closed_at=NULL, closed_by=NULL, close_note=NULL
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [orgId, id]
  );
  return rows[0] || null;
}

module.exports = { create, findActive, list, getById, close, unlock };
