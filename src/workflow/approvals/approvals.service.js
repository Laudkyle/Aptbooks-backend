const repo = require("./approvals.repository");

function normalizeOptionalFilter(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text.toLowerCase() === "undefined" || text.toLowerCase() === "null" || text.toLowerCase() === "all") return null;
  return text;
}

async function inbox(orgId, userId, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit || 50), 1), 200);
  const offset = Math.max(Number(query.offset || 0), 0);
  const documentTypeId = normalizeOptionalFilter(query.documentTypeId || query.document_type_id);
  const state = normalizeOptionalFilter(query.state);
  const source = normalizeOptionalFilter(query.source);
  return { data: await repo.listInbox({ orgId, userId, limit, offset, documentTypeId, state, source }), paging: { limit, offset } };
}

module.exports = { inbox, normalizeOptionalFilter };
