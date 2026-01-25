const { AppError } = require("../../shared/errors/AppError");
const repo = require("./dashboards.repository");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");

function assertName(name) {
  if (!name || !String(name).trim()) throw new AppError(400, "Name is required");
  return String(name).trim();
}

async function listDashboards(ctx, query) {
  return repo.listDashboards({ organizationId: ctx.organizationId, includeArchived: query.includeArchived, limit: query.limit, offset: query.offset });
}

async function createDashboard(ctx, payload) {
  const d = await repo.createDashboard({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    name: assertName(payload.name),
    description: payload.description || null,
    layoutJson: payload.layoutJson || {},
  });

  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "reporting.dashboard.create",
    entityType: "dashboard",
    entityId: d.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before: null,
    after: d,
  });
  return d;
}

async function updateDashboard(ctx, dashboardId, patch) {
  const before = await repo.getDashboard({ organizationId: ctx.organizationId, dashboardId });
  if (!before) throw new AppError(404, "Dashboard not found");
  const after = await repo.updateDashboard({ organizationId: ctx.organizationId, dashboardId, patch: {
    ...patch,
    name: patch.name ? assertName(patch.name) : undefined,
  }});
  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "reporting.dashboard.update",
    entityType: "dashboard",
    entityId: dashboardId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before,
    after,
  });
  return after;
}

async function listWidgets(ctx, dashboardId, includeArchived) {
  const d = await repo.getDashboard({ organizationId: ctx.organizationId, dashboardId });
  if (!d) throw new AppError(404, "Dashboard not found");
  return repo.listWidgets({ organizationId: ctx.organizationId, dashboardId, includeArchived });
}

async function createWidget(ctx, dashboardId, payload) {
  const d = await repo.getDashboard({ organizationId: ctx.organizationId, dashboardId });
  if (!d) throw new AppError(404, "Dashboard not found");
  const w = await repo.createWidget({
    organizationId: ctx.organizationId,
    dashboardId,
    title: assertName(payload.title),
    widgetType: assertName(payload.widgetType),
    configJson: payload.configJson || {},
    positionJson: payload.positionJson || {},
  });
  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "reporting.dashboard.widget.create",
    entityType: "dashboard_widget",
    entityId: w.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before: null,
    after: w,
  });
  return w;
}

async function updateWidget(ctx, widgetId, patch) {
  const w = await repo.updateWidget({ organizationId: ctx.organizationId, widgetId, patch: {
    ...patch,
    title: patch.title ? assertName(patch.title) : undefined,
    widgetType: patch.widgetType ? assertName(patch.widgetType) : undefined,
  }});
  if (!w) throw new AppError(404, "Widget not found");
  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "reporting.dashboard.widget.update",
    entityType: "dashboard_widget",
    entityId: widgetId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before: null,
    after: w,
  });
  return w;
}

module.exports = {
  listDashboards,
  createDashboard,
  updateDashboard,
  listWidgets,
  createWidget,
  updateWidget,
};
