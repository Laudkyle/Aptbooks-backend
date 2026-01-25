const repo = require("./reports.repository"); 

async function headcount({ orgId, query }) {
  return repo.headcountSummary(orgId, query); 
}

async function leaveBalances({ orgId, query }) {
  return repo.leaveBalancesSummary(orgId, query); 
}

async function payrollCosts({ orgId, query }) {
  return repo.payrollCostSummary(orgId, query); 
}

module.exports = { headcount, leaveBalances, payrollCosts }; 
