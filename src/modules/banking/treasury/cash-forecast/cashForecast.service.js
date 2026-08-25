const repo=require('./cashForecast.repository');
const {moneyUnits,moneyStringFromUnits}=require('../../../../shared/utils/financialMath');
function toIsoDate(d){return d.toISOString().slice(0,10);}
function add(bucket,key,amount){bucket[key]=(bucket[key]||0n)+moneyUnits(amount||'0');}
function render(bucket){return Object.fromEntries(Object.entries(bucket).map(([k,v])=>[k,moneyStringFromUnits(v)]));}
async function generate(orgId,query={},actorUserId=null){
  const startDate=query.startDate||toIsoDate(new Date());
  const horizonDays=Math.min(Math.max(Number.parseInt(query.horizonDays||30,10)||30,1),366);
  const end=new Date(`${startDate}T00:00:00.000Z`);end.setUTCDate(end.getUTCDate()+horizonDays);const endDate=query.endDate||toIsoDate(end);
  const [opening,outflows,inflows]=await Promise.all([repo.getCurrentBalances(orgId),repo.getPlannedOutflows(orgId,startDate,endDate),repo.getPlannedInflows(orgId,startDate,endDate)]);
  const byBank=new Map();
  for(const row of opening){const openingUnits=moneyUnits(row.current_balance||'0');byBank.set(row.bank_account_id,{bankAccountId:row.bank_account_id,code:row.code,name:row.name,currencyCode:row.currency_code,minimumBalance:String(row.minimum_balance||'0.00'),overdraftLimit:String(row.overdraft_limit||'0.00'),_opening:openingUnits,_in:0n,_out:0n,_closing:openingUnits,events:[]});}
  for(const row of inflows){const b=byBank.get(row.bank_account_id);if(!b)continue;const u=moneyUnits(row.amount||'0');b._in+=u;b._closing+=u;b.events.push({direction:'inflow',...row,amount:moneyStringFromUnits(u)});}
  for(const row of outflows){const b=byBank.get(row.bank_account_id);if(!b)continue;const signed=moneyUnits(row.amount||'0');b._out+=signed<0n?-signed:signed;b._closing+=signed;b.events.push({direction:'outflow',...row,amount:moneyStringFromUnits(signed)});}
  const summaryMap=new Map();
  const accounts=Array.from(byBank.values()).map(b=>{let s=summaryMap.get(b.currencyCode);if(!s){s={openingBalance:0n,totalInflows:0n,totalOutflows:0n,projectedClosingBalance:0n};summaryMap.set(b.currencyCode,s);}s.openingBalance+=b._opening;s.totalInflows+=b._in;s.totalOutflows+=b._out;s.projectedClosingBalance+=b._closing;return{bankAccountId:b.bankAccountId,code:b.code,name:b.name,currencyCode:b.currencyCode,minimumBalance:b.minimumBalance,overdraftLimit:b.overdraftLimit,openingBalance:moneyStringFromUnits(b._opening),inflows:moneyStringFromUnits(b._in),outflows:moneyStringFromUnits(b._out),projectedClosingBalance:moneyStringFromUnits(b._closing),events:b.events};}).sort((a,b)=>String(a.code).localeCompare(String(b.code)));
  const summaryByCurrency=Array.from(summaryMap.entries()).map(([currencyCode,s])=>({currencyCode,...render(s)})).sort((a,b)=>a.currencyCode.localeCompare(b.currencyCode));
  const result={startDate,endDate,horizonDays,summaryByCurrency,mixedCurrency:summaryByCurrency.length>1,summary:summaryByCurrency.length===1?summaryByCurrency[0]:null,accounts};
  if(query.persist==='true'&&actorUserId){result.snapshot=await repo.createSnapshot(orgId,{name:query.name||`Cash forecast ${startDate} to ${endDate}`,startDate,endDate,horizonDays,assumptionsJson:{source:'treasury.production.v1',balanceSource:'posted_gl_nominal',currencyAggregation:'per_currency'},generatedJson:result},actorUserId);}
  return result;
}
async function listSnapshots(orgId){return repo.listSnapshots(orgId);}module.exports={generate,listSnapshots};
