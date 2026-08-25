const repo = require('./bankAccounts.repository');
const { AppError } = require('../../../shared/errors/AppError');
const { withTransaction } = require('../../../db/tx');
const { writeAudit } = require('../../../core/foundation/audit-logs/audit.service');
const { normalizeMoney } = require('../../../shared/utils/financialMath');

function normalize(payload={}){
  return {
    code:String(payload.code||'').trim(), name:String(payload.name||'').trim(), currencyCode:String(payload.currencyCode||payload.currency_code||'').trim().toUpperCase(),
    glAccountId:payload.glAccountId||payload.gl_account_id, isActive:payload.isActive ?? payload.is_active ?? true,
    bankName:String(payload.bankName||payload.bank_name||'').trim()||null, branchName:String(payload.branchName||payload.branch_name||'').trim()||null,
    accountNumberMasked:String(payload.accountNumberMasked||payload.account_number_masked||'').trim()||null,
    swiftBic:String(payload.swiftBic||payload.swift_bic||'').trim().toUpperCase()||null, accountType:payload.accountType||payload.account_type||'current',
    minimumBalance:normalizeMoney(payload.minimumBalance??payload.minimum_balance??'0'), overdraftLimit:normalizeMoney(payload.overdraftLimit??payload.overdraft_limit??'0'),
    reconciliationTolerance:normalizeMoney(payload.reconciliationTolerance??payload.reconciliation_tolerance??'0.01')
  };
}

async function validateGl(orgId, glAccountId, client){
  const {rows}=await client.query(`SELECT id,is_postable,status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,[orgId,glAccountId]);
  if(!rows.length) throw new AppError(404,'Linked GL account not found');
  if(!rows[0].is_postable || rows[0].status!=='active') throw new AppError(409,'Linked GL account must be active and postable');
}

async function create(orgId, actorUserId, payload) {
  const data=normalize(payload); for(const k of ['code','name','currencyCode','glAccountId']) if(!data[k]) throw new AppError(400,`${k} is required`);
  return withTransaction(async client=>{ await validateGl(orgId,data.glAccountId,client); const row=await repo.create(orgId,data,client); await writeAudit({organizationId:orgId,actorUserId,action:'BANK_ACCOUNT_CREATED',entityType:'bank_account',entityId:row.id,after:row,client}); return row; });
}
async function list(orgId){return repo.list(orgId);}
async function get(orgId,id){const row=await repo.get(orgId,id);if(!row)throw new AppError(404,'Bank account not found');return row;}
async function update(orgId,id,actorUserId,payload){return withTransaction(async client=>{
  const before=await repo.get(orgId,id,client,true); if(!before)throw new AppError(404,'Bank account not found'); const patch={};
  const normalized=normalize({...before,...payload});
  for(const key of ['code','name','currencyCode','glAccountId','isActive','bankName','branchName','accountNumberMasked','swiftBic','accountType','minimumBalance','overdraftLimit','reconciliationTolerance']){
    const snake=key.replace(/[A-Z]/g,m=>`_${m.toLowerCase()}`); if(Object.prototype.hasOwnProperty.call(payload,key)||Object.prototype.hasOwnProperty.call(payload,snake)) patch[key]=normalized[key];
  }
  if(patch.glAccountId) await validateGl(orgId,patch.glAccountId,client);
  if(patch.isActive===false && before.is_active!==false){ const usage=await repo.getBlockingUsage(orgId,id,client); const total=Number(usage.payment_runs)+Number(usage.transfers)+Number(usage.issued_cheques)+Number(usage.open_statements); if(total>0) throw new AppError(409,`Bank account cannot be deactivated while it has active treasury/banking work (${total} blocking records)`); }
  const row=await repo.update(orgId,id,patch,client); await writeAudit({organizationId:orgId,actorUserId,action:'BANK_ACCOUNT_UPDATED',entityType:'bank_account',entityId:id,before,after:row,client}); return row;
});}
module.exports={create,list,get,update};
