const { pool } = require("../../db/pool");

async function listDashboards({ organizationId, includeArchived = false, limit = 50, offset = 0 }) {
  const params = [organizationId];
  let where = `organization_id=$1`;
  if (!includeArchived) where += ` AND is_archived=FALSE`;
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  params.push(Math.max(Number(offset) || 0, 0));
  const { rows } = await pool.query(
    `SELECT * FROM dashboards WHERE ${where} ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
    params
  );
  return rows;
}

async function getDashboard({ organizationId, dashboardId }) {
  const { rows } = await pool.query(
    `SELECT * FROM dashboards WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [organizationId, dashboardId]
  );
  return rows[0] || null;
}

async function createDashboard({ organizationId, actorUserId, name, description, layoutJson }) {
  const { rows } = await pool.query(
    `
    INSERT INTO dashboards(organization_id, name, description, layout_json, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING *
    `,
    [organizationId, name, description || null, JSON.stringify(layoutJson || {}), actorUserId || null]
  );
  return rows[0];
}

async function updateDashboard({ organizationId, dashboardId, patch }) {
  const { name, description, layoutJson, isArchived } = patch;
  const { rows } = await pool.query(
    `
    UPDATE dashboards
    SET name=COALESCE($3,name),
        description=COALESCE($4,description),
        layout_json=COALESCE($5,layout_json),
        is_archived=COALESCE($6,is_archived),
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [
      organizationId,
      dashboardId,
      name ?? null,
      description ?? null,
      layoutJson ? JSON.stringify(layoutJson) : null,
      typeof isArchived === "boolean" ? isArchived : null,
    ]
  );
  return rows[0] || null;
}

async function listWidgets({ organizationId, dashboardId, includeArchived = false }) {
  const params = [organizationId, dashboardId];
  let where = `organization_id=$1 AND dashboard_id=$2`;
  if (!includeArchived) where += ` AND is_archived=FALSE`;
  const { rows } = await pool.query(
    `SELECT * FROM dashboard_widgets WHERE ${where} ORDER BY created_at ASC`,
    params
  );
  return rows;
}

async function createWidget({ organizationId, dashboardId, title, widgetType, configJson, positionJson }) {
  const { rows } = await pool.query(
    `
    INSERT INTO dashboard_widgets(organization_id, dashboard_id, title, widget_type, config_json, position_json)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING *
    `,
    [organizationId, dashboardId, title, widgetType, JSON.stringify(configJson || {}), JSON.stringify(positionJson || {})]
  );
  return rows[0];
}

async function updateWidget({ organizationId, widgetId, patch }) {
  const { title, widgetType, configJson, positionJson, isArchived } = patch;
  const { rows } = await pool.query(
    `
    UPDATE dashboard_widgets
    SET title=COALESCE($3,title),
        widget_type=COALESCE($4,widget_type),
        config_json=COALESCE($5,config_json),
        position_json=COALESCE($6,position_json),
        is_archived=COALESCE($7,is_archived),
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [
      organizationId,
      widgetId,
      title ?? null,
      widgetType ?? null,
      configJson ? JSON.stringify(configJson) : null,
      positionJson ? JSON.stringify(positionJson) : null,
      typeof isArchived === "boolean" ? isArchived : null,
    ]
  );
  return rows[0] || null;
}

module.exports = {
  listDashboards,
  getDashboard,
  createDashboard,
  updateDashboard,
  listWidgets,
  createWidget,
  updateWidget,
};
