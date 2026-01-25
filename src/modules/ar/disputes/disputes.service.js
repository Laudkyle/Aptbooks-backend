const { pool } = require('../../../db/pool'); 
const { withTransaction } = require('../../../db/tx'); 

const repo = require('./disputes.repository'); 

async function listReasonCodes({ orgId }) {
  const client = await pool.connect(); 
  try { return await repo.listReasonCodes({ orgId, client });  } finally { client.release();  }
}
async function upsertReasonCode({ orgId, payload }) {
  return withTransaction(async (client) => repo.upsertReasonCode({ orgId, payload, client })); 
}
async function deleteReasonCode({ orgId, code }) {
  return withTransaction(async (client) => repo.deleteReasonCode({ orgId, code, client })); 
}


async function listDisputes({ orgId, status }) {
  const client = await pool.connect(); 
  try { return await repo.listDisputes({ orgId, status, client });  } finally { client.release();  }
}
async function getDispute({ orgId, id }) {
  const client = await pool.connect(); 
  try { return await repo.getDispute({ orgId, id, client });  } finally { client.release();  }
}
async function createDispute({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => repo.createDispute({ orgId, actorUserId, payload, client })); 
}
async function addAction({ orgId, id, actorUserId, action_type, payload }) {
  return withTransaction(async (client) => repo.addAction({ orgId, id, actorUserId, action_type, payload, client })); 
}
async function resolveDispute({ orgId, id, actorUserId, resolution }) {
  return withTransaction(async (client) => repo.resolveDispute({ orgId, id, actorUserId, resolution, client })); 
}
async function voidDispute({ orgId, id, actorUserId }) {
  return withTransaction(async (client) => repo.voidDispute({ orgId, id, actorUserId, client })); 
}

module.exports = {
  listReasonCodes,
  upsertReasonCode,
  deleteReasonCode,
  listDisputes,
  getDispute,
  createDispute,
  addAction,
  resolveDispute,
  voidDispute
}; 
