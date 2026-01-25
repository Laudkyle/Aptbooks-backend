const { pool } = require('../../../db/pool'); 
const { withTransaction } = require('../../../db/tx'); 

const repo = require('./collections.repository'); 

async function queue({ orgId, asOfDate, minDaysPastDue, includeDisputed }) {
  const client = await pool.connect(); 
  try {
    return await repo.listQueue({ orgId, asOfDate, minDaysPastDue, includeDisputed, client }); 
  } finally {
    client.release(); 
  }
}


async function partnerOpenInvoices({ orgId, partnerId, asOfDate }) {
  const client = await pool.connect(); 
  try {
    return await repo.listPartnerOpenInvoices({ orgId, partnerId, asOfDate, client }); 
  } finally {
    client.release(); 
  }
}

// Templates
async function listTemplates({ orgId }) {
  const client = await pool.connect(); 
  try { return await repo.listTemplates({ orgId, client });  } finally { client.release();  }
}
async function createTemplate({ orgId, payload }) {
  return withTransaction(async (client) => repo.createTemplate({ orgId, payload, client })); 
}
async function updateTemplate({ orgId, id, payload }) {
  return withTransaction(async (client) => repo.updateTemplate({ orgId, id, payload, client })); 
}
async function deleteTemplate({ orgId, id }) {
  return withTransaction(async (client) => repo.deleteTemplate({ orgId, id, client })); 
}

// Rules
async function listRules({ orgId }) {
  const client = await pool.connect(); 
  try { return await repo.listRules({ orgId, client });  } finally { client.release();  }
}
async function createRule({ orgId, payload }) {
  return withTransaction(async (client) => repo.createRule({ orgId, payload, client })); 
}
async function updateRule({ orgId, id, payload }) {
  return withTransaction(async (client) => repo.updateRule({ orgId, id, payload, client })); 
}
async function deleteRule({ orgId, id }) {
  return withTransaction(async (client) => repo.deleteRule({ orgId, id, client })); 
}

// Cases
async function listCases({ orgId, status }) {
  const client = await pool.connect(); 
  try { return await repo.listCases({ orgId, status, client });  } finally { client.release();  }
}
async function createCase({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => {
    const created = await repo.createCase({ orgId, actorUserId, payload, client }); 
    await repo.addCaseAction({ orgId, caseId: created.id, actorUserId, action_type: 'case_opened', payload: { notes: payload.notes||null }, client }); 
    return created; 
  }); 
}
async function updateCase({ orgId, caseId, payload }) {
  return withTransaction(async (client) => repo.updateCase({ orgId, caseId, payload, client })); 
}
async function addAction({ orgId, caseId, actorUserId, action_type, payload }) {
  return withTransaction(async (client) => repo.addCaseAction({ orgId, caseId, actorUserId, action_type, payload, client })); 
}

// Dunning run generation (manual)
async function generateDunningRun({ orgId, actorUserId, ruleId, asOfDate }) {
  return withTransaction(async (client) => {
    const run = await repo.generateDunningRun({ orgId, actorUserId, ruleId, asOfDate, client }); 
    return await repo.getDunningRun({ orgId, runId: run.id, client }); 
  }); 
}

async function listDunningRuns({ orgId }) {
  const client = await pool.connect(); 
  try {
    const { rows } = await client.query(`SELECT * FROM dunning_runs WHERE organization_id=$1 ORDER BY id DESC`, [orgId]); 
    return rows; 
  } finally { client.release();  }
}

async function getDunningRun({ orgId, runId }) {
  const client = await pool.connect(); 
  try { return await repo.getDunningRun({ orgId, runId, client });  } finally { client.release();  }
}

module.exports = {
  queue,
  partnerOpenInvoices,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  listCases,
  createCase,
  updateCase,
  addAction,
  generateDunningRun,
  listDunningRuns,
  getDunningRun
}; 
