const { AppError } = require('../../../shared/errors/AppError');
const repo = require('./metric.repository');
const cache = require('./metricCache');
const { getMetric, listMetrics, publicMetric } = require('./metricRegistry');

function normalizeFilters(filters) {
  const out={};
  if (filters?.fromDate) out.fromDate=String(filters.fromDate).slice(0,10);
  if (filters?.toDate) out.toDate=String(filters.toDate).slice(0,10);
  if (out.fromDate && out.toDate && out.fromDate>out.toDate) throw new AppError(422,'Dashboard date range is invalid',null,'dashboard_invalid_date_range');
  return out;
}

async function authorizedMetricList(ctx) {
  const output=[];
  for (const def of listMetrics()) {
    if (await repo.hasPermission({organizationId:ctx.organizationId,userId:ctx.userId,permission:def.permission})) output.push(publicMetric(def));
  }
  return output;
}

async function executeMetric(ctx, request) {
  const def=getMetric(request?.key);
  if (!def) throw new AppError(404,'Metric is not registered',null,'dashboard_metric_not_found');
  const allowed=await repo.hasPermission({organizationId:ctx.organizationId,userId:ctx.userId,permission:def.permission});
  if (!allowed) throw new AppError(403,'You do not have permission to view this metric',{metricKey:def.key},'dashboard_metric_forbidden');
  const groupBy=request?.groupBy || null;
  if (groupBy && !def.allowedGroupBy.includes(groupBy)) throw new AppError(422,'This metric does not support the selected grouping',{metricKey:def.key,groupBy},'dashboard_metric_grouping_invalid');
  const filters=normalizeFilters(request?.filters||{});
  const cacheParts={organizationId:ctx.organizationId,userId:ctx.userId,key:def.key,groupBy,filters};
  const cached=cache.get(cacheParts);
  if (cached) return {...cached,cached:true};
  const data=await def.execute({organizationId:ctx.organizationId,userId:ctx.userId,filters,groupBy});
  const output={metric:publicMetric(def),groupBy,filters,data,cached:false,generatedAt:new Date().toISOString()};
  cache.set(cacheParts,output,def.cacheTtlMs);
  return output;
}

async function executeBatch(ctx, requests) {
  const input=Array.isArray(requests)?requests:[];
  if (input.length>30) throw new AppError(422,'A dashboard may request at most 30 metrics at once',null,'dashboard_metric_batch_too_large');
  const results=[];
  for (const request of input) {
    try { results.push({key:request?.key,ok:true,result:await executeMetric(ctx,request)}); }
    catch (error) {
      if (error?.status===403) results.push({key:request?.key,ok:false,error:{code:error.code||'forbidden',message:error.message,status:403}});
      else throw error;
    }
  }
  return results;
}

module.exports={authorizedMetricList,executeMetric,executeBatch};
