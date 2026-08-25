const repo = require('./overview.repository');

async function getWorkspace(orgId) { return repo.getWorkspaceRows(orgId); }

module.exports = { getWorkspace };
