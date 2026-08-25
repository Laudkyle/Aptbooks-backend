const repo=require('./warehouses.repository1');
const {AppError}=require('../../../shared/errors/AppError');
async function createWarehouse(orgId,payload){ return repo.createWarehouse(orgId,payload); }
async function listWarehouses(orgId,opts){ return repo.listWarehouses(orgId,opts); }
async function getWarehouse(orgId,id){ const w=await repo.getWarehouse(orgId,id); if(!w) throw new AppError(404,'Warehouse not found'); return w; }
async function updateWarehouse(orgId,id,payload){ const current=await getWarehouse(orgId,id); if(payload.isActive===false&&current.is_active){ const s=await repo.getStockSummary(orgId,id); if(Number(s.qty_on_hand)!==0) throw new AppError(409,'Move all stock out before deactivating this warehouse'); if(await repo.hasOpenReservations(orgId,id)) throw new AppError(409,'Release active reservations before deactivating this warehouse'); } const out=await repo.updateWarehouse(orgId,id,payload); if(!out) throw new AppError(404,'Warehouse not found'); return out; }
module.exports={createWarehouse,listWarehouses,getWarehouse,updateWarehouse};
