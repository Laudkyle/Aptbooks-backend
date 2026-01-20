const repo = require("./approvals.repository");

async function inbox(orgId, query = {}) {
  const limit = Math.min(Number(query.limit || 50), 200);
  const offset = Math.max(Number(query.offset || 0), 0);
  const documentTypeId = query.documentTypeId || query.document_type_id || null;
  const state = query.state || null;
  return { data: await repo.listInbox({ orgId, limit, offset, documentTypeId, state }), paging: { limit, offset } };
}

module.exports = { inbox };
