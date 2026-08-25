const { AppError } = require('../../../../shared/errors/AppError');
const periodIF = require('../../../../interfaces/periodManagement.interface');
const { moneyUnits, moneyStringFromUnits, normalizeMoney } = require('../../../../shared/utils/financialMath');
function genCode(prefix){const d=new Date();const pad=n=>String(n).padStart(2,'0');return `${prefix}-${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;}
function normalizeAmount(value,field='amount'){let units;try{units=moneyUnits(value);}catch{throw new AppError(400,`${field} must be a valid monetary amount`);}if(units<=0n)throw new AppError(400,`${field} must be greater than zero`);return moneyStringFromUnits(units);}
function parseOptionalAmount(value,field='amount'){if(value==null||value==='')return '0.00';let units;try{units=moneyUnits(value);}catch{throw new AppError(400,`${field} must be a valid monetary amount`);}if(units<0n)throw new AppError(400,`${field} cannot be negative`);return moneyStringFromUnits(units);}
async function findOpenPeriodId(orgId,date,client){const p=await periodIF.findOpenPeriodForDate({orgId,date,client});return p.id;}
module.exports={genCode,normalizeAmount,parseOptionalAmount,findOpenPeriodId,normalizeMoney};
