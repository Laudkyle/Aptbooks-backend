const { pool } = require("../../../db/pool");
function db(client){ return client || pool; }
async function createWarehouse(orgId, payload, client=null) {
  const { rows } = await db(client).query(
    `INSERT INTO warehouses(organization_id,code,name,is_active,status,updated_at)
     VALUES($1,$2,$3,$4,CASE WHEN $4 THEN 'active' ELSE 'inactive' END,NOW())
     RETURNING id,organization_id,code,name,is_active,status,created_at,updated_at`,
    [orgId,payload.code,payload.name,payload.isActive!==false]);
  return rows[0];
}
async function listWarehouses(orgId,{activeOnly=false}={},client=null){
  const {rows}=await db(client).query(
    `SELECT w.id,w.organization_id,w.code,w.name,w.is_active,w.status,w.created_at,w.updated_at,
            COALESCE(x.sku_count,0)::int AS sku_count, COALESCE(x.qty_on_hand,0)::text AS qty_on_hand,
            COALESCE(x.inventory_value,0)::text AS inventory_value
       FROM warehouses w
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE ib.qty_on_hand<>0) AS sku_count,
                SUM(ib.qty_on_hand) AS qty_on_hand,
                SUM(ib.qty_on_hand*ib.avg_unit_cost) AS inventory_value
           FROM inventory_balances ib WHERE ib.organization_id=w.organization_id AND ib.warehouse_id=w.id
       ) x ON TRUE
      WHERE w.organization_id=$1 AND ($2::boolean=false OR (w.status='active' AND w.is_active=true)) ORDER BY w.code`,[orgId,!!activeOnly]); return rows;
}
async function getWarehouse(orgId,id,client=null,{forUpdate=false}={}){ const {rows}=await db(client).query(
  `SELECT id,organization_id,code,name,is_active,status,created_at,updated_at FROM warehouses WHERE organization_id=$1 AND id=$2${forUpdate?' FOR UPDATE':''}`,[orgId,id]); return rows[0]||null; }
async function updateWarehouse(orgId,id,payload,client=null){ const active=payload.isActive; const {rows}=await db(client).query(
  `UPDATE warehouses SET code=COALESCE($3,code),name=COALESCE($4,name),is_active=COALESCE($5,is_active),
      status=CASE WHEN $5::boolean IS NULL THEN status WHEN $5 THEN 'active' ELSE 'inactive' END,updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING id,organization_id,code,name,is_active,status,created_at,updated_at`,
  [orgId,id,payload.code??null,payload.name??null,active===undefined?null:!!active]); return rows[0]||null; }
async function getStockSummary(orgId,id,client=null){ const {rows}=await db(client).query(
  `SELECT COALESCE(SUM(qty_on_hand),0)::text AS qty_on_hand, COUNT(*) FILTER(WHERE qty_on_hand<>0)::int AS sku_count
     FROM inventory_balances WHERE organization_id=$1 AND warehouse_id=$2`,[orgId,id]); return rows[0]; }
async function hasOpenReservations(orgId,id,client=null){ const {rows}=await db(client).query(
  `SELECT 1 FROM inventory_reservations WHERE organization_id=$1 AND warehouse_id=$2 AND status='active' LIMIT 1`,[orgId,id]); return rows.length>0; }
module.exports={createWarehouse,listWarehouses,getWarehouse,updateWarehouse,getStockSummary,hasOpenReservations};
