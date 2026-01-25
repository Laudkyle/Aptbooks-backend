const { pool } = require('../../../db/pool'); 
const { withTransaction } = require('../../../db/tx'); 
const { AppError } = require('../../../shared/errors/AppError'); 
const repo = require('./paymentPlans.repository'); 

function addDays(d, days) {
  const dt = new Date(d); 
  dt.setDate(dt.getDate() + days); 
  return dt.toISOString().slice(0,10); 
}
function addMonths(d, months) {
  const dt = new Date(d); 
  dt.setMonth(dt.getMonth() + months); 
  return dt.toISOString().slice(0,10); 
}

function buildSchedule({ start_date, frequency, installment_count, total_amount }) {
  const n = Number(installment_count); 
  const total = Number(total_amount); 
  if (!n || n < 1) throw new AppError(400, 'installment_count must be >=1'); 
  const base = Math.floor((total / n) * 100) / 100; 
  const schedule = []; 
  let allocated = 0; 
  for (let i = 0;  i < n;  i++) {
    let amount = base; 
    if (i === n - 1) amount = Number((total - allocated).toFixed(2)); 
    allocated = Number((allocated + amount).toFixed(2)); 
    let due = start_date; 
    if (frequency === 'weekly') due = addDays(start_date, 7 * i); 
    else if (frequency === 'biweekly') due = addDays(start_date, 14 * i); 
    else if (frequency === 'monthly') due = addMonths(start_date, 1 * i); 
    schedule.push({ due_date: due, amount }); 
  }
  return schedule; 
}

async function listPlans({ orgId, status }) {
  const client = await pool.connect(); 
  try { return await repo.listPlans({ orgId, status, client });  } finally { client.release();  }
}
async function getPlan({ orgId, id }) {
  const client = await pool.connect(); 
  try { return await repo.getPlan({ orgId, id, client });  } finally { client.release();  }
}

async function createPlan({ orgId, actorUserId, payload }) {
  const schedule = buildSchedule(payload); 
  return withTransaction(async (client) => {
    const created = await repo.createPlan({ orgId, actorUserId, payload, client }); 
    await repo.insertInstallments({ orgId, planId: created.id, schedule, client }); 
    return repo.getPlan({ orgId, id: created.id, client }); 
  }); 
}

async function cancelPlan({ orgId, id, actorUserId }) {
  return withTransaction(async (client) => repo.setStatus({ orgId, id, status: 'cancelled', actorUserId, client })); 
}

async function markInstallmentPaid({ orgId, planId, installmentId, actorUserId, settlement_ref }) {
  return withTransaction(async (client) => {
    await repo.markInstallmentPaid({ orgId, planId, installmentId, actorUserId, settlement_ref, client }); 
    return repo.getPlan({ orgId, id: planId, client }); 
  }); 
}

module.exports = {
  listPlans,
  getPlan,
  createPlan,
  cancelPlan,
  markInstallmentPaid
}; 
