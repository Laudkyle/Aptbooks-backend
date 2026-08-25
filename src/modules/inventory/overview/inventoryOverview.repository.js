const { pool } = require('../../../db/pool');

async function loadOverview(orgId, client = null) {
  const db = client || pool;
  const [summary, warehouses, lowStock, workflow, anomalies, recent] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE i.status='active' AND i.is_active=true)::int AS active_items,
         COUNT(*) FILTER (WHERE i.status<>'active' OR i.is_active=false)::int AS inactive_items,
         COUNT(*) FILTER (WHERE i.tracking_method='batch')::int AS batch_tracked_items,
         COUNT(*) FILTER (WHERE i.tracking_method='serial')::int AS serial_tracked_items,
         COALESCE(SUM(b.qty_on_hand),0)::text AS quantity_on_hand,
         COALESCE(SUM(b.inventory_value),0)::text AS inventory_value
       FROM inventory_items i
       LEFT JOIN LATERAL (
         SELECT SUM(ib.qty_on_hand) AS qty_on_hand,
                SUM(ib.qty_on_hand * ib.avg_unit_cost) AS inventory_value
           FROM inventory_balances ib
          WHERE ib.organization_id=i.organization_id AND ib.item_id=i.id
       ) b ON TRUE
      WHERE i.organization_id=$1`, [orgId]),
    db.query(
      `SELECT w.id,w.code,w.name,w.status,
              COALESCE(SUM(ib.qty_on_hand),0)::text AS quantity_on_hand,
              COALESCE(SUM(ib.qty_on_hand*ib.avg_unit_cost),0)::text AS inventory_value,
              COUNT(*) FILTER(WHERE ib.qty_on_hand<>0)::int AS stocked_skus
         FROM warehouses w
         LEFT JOIN inventory_balances ib ON ib.organization_id=w.organization_id AND ib.warehouse_id=w.id
        WHERE w.organization_id=$1
        GROUP BY w.id,w.code,w.name,w.status
        ORDER BY inventory_value::numeric DESC,w.code`, [orgId]),
    db.query(
      `SELECT i.id,i.sku,i.name,i.reorder_point,
              COALESCE(SUM(ib.qty_on_hand),0)::text AS quantity_on_hand,
              i.preferred_warehouse_id
         FROM inventory_items i
         LEFT JOIN inventory_balances ib ON ib.organization_id=i.organization_id AND ib.item_id=i.id
        WHERE i.organization_id=$1 AND i.status='active' AND i.is_active=true AND i.reorder_point>0
        GROUP BY i.id,i.sku,i.name,i.reorder_point,i.preferred_warehouse_id
       HAVING COALESCE(SUM(ib.qty_on_hand),0) <= i.reorder_point
        ORDER BY (i.reorder_point-COALESCE(SUM(ib.qty_on_hand),0)) DESC,i.sku
        LIMIT 12`, [orgId]),
    db.query(
      `SELECT
         COUNT(*) FILTER(WHERE status2='draft')::int AS draft_transactions,
         COUNT(*) FILTER(WHERE status2='submitted')::int AS submitted_transactions,
         COUNT(*) FILTER(WHERE status2='approved')::int AS approved_unposted_transactions,
         COUNT(*) FILTER(WHERE status2='posted' AND journal_entry_id IS NULL AND txn_type<>'transfer')::int AS posted_without_journal
       FROM inventory_transactions WHERE organization_id=$1`, [orgId]),
    db.query(
      `SELECT
         (SELECT COUNT(*) FROM inventory_balances WHERE organization_id=$1 AND qty_on_hand<0)::int AS negative_balances,
         (SELECT COUNT(*) FROM inventory_balances WHERE organization_id=$1 AND avg_unit_cost<0)::int AS negative_costs,
         (SELECT COUNT(*) FROM inventory_items i
            LEFT JOIN item_categories c ON c.id=i.category_id AND c.organization_id=i.organization_id
            LEFT JOIN item_units u ON u.id=i.unit_id AND u.organization_id=i.organization_id
           WHERE i.organization_id=$1 AND (c.id IS NULL OR u.id IS NULL))::int AS broken_master_links,
         (SELECT COUNT(*) FROM warehouses w
            JOIN inventory_balances b ON b.organization_id=w.organization_id AND b.warehouse_id=w.id
           WHERE w.organization_id=$1 AND w.status='inactive' AND b.qty_on_hand<>0)::int AS stock_in_inactive_warehouses`, [orgId]),
    db.query(
      `SELECT t.id,t.txn_type,t.txn_date,t.reference,t.status2,t.posted_at,
              sw.code AS source_warehouse_code,dw.code AS dest_warehouse_code
         FROM inventory_transactions t
         LEFT JOIN warehouses sw ON sw.id=t.source_warehouse_id AND sw.organization_id=t.organization_id
         LEFT JOIN warehouses dw ON dw.id=t.dest_warehouse_id AND dw.organization_id=t.organization_id
        WHERE t.organization_id=$1
        ORDER BY COALESCE(t.posted_at,t.created_at) DESC LIMIT 8`, [orgId])
  ]);
  return {
    summary: summary.rows[0] || {},
    warehouses: warehouses.rows,
    lowStock: lowStock.rows,
    workflow: workflow.rows[0] || {},
    anomalies: anomalies.rows[0] || {},
    recent: recent.rows,
  };
}

module.exports = { loadOverview };
