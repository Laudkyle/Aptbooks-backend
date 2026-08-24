const { AppError } = require('../errors/AppError');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireOrganizationId(organizationId) {
  if (organizationId === null || organizationId === undefined || String(organizationId).trim() === '') {
    throw new AppError(400, 'Organization context is required', null, 'organization_required');
  }
  return organizationId;
}

function requireDbClient(client) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A PostgreSQL client/pool with query(text, values) is required');
  }
  return client;
}

function explicitColumns(columns, { alias = null } = {}) {
  if (!Array.isArray(columns) || columns.length === 0) throw new TypeError('Explicit repository columns are required');
  if (alias && !IDENTIFIER.test(alias)) throw new TypeError(`Unsafe SQL alias: ${alias}`);
  return columns.map((column) => {
    if (!IDENTIFIER.test(column)) throw new TypeError(`Unsafe SQL column: ${column}`);
    return alias ? `${alias}.${column}` : column;
  }).join(', ');
}

function tenantPredicate({ alias = null, parameter = 1 } = {}) {
  if (!Number.isInteger(parameter) || parameter < 1) throw new TypeError('parameter must be a positive integer');
  if (alias && !IDENTIFIER.test(alias)) throw new TypeError(`Unsafe SQL alias: ${alias}`);
  return `${alias ? `${alias}.` : ''}organization_id=$${parameter}`;
}

async function queryMany(client, text, values = []) {
  requireDbClient(client);
  const result = await client.query(text, values);
  return result.rows;
}

async function queryOne(client, text, values = []) {
  const rows = await queryMany(client, text, values);
  return rows[0] || null;
}

async function queryRequired(client, text, values = [], { status = 404, message = 'Record not found', code = 'not_found' } = {}) {
  const row = await queryOne(client, text, values);
  if (!row) throw new AppError(status, message, null, code);
  return row;
}

module.exports = {
  explicitColumns,
  queryMany,
  queryOne,
  queryRequired,
  requireDbClient,
  requireOrganizationId,
  tenantPredicate,
};
