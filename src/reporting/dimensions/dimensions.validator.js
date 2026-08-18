const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const { assertUuid } = require("../_util");

// Canonical list of supported reporting dimensions.
// These map to Tier 6 dimension tables.
const ALLOWED_KEYS = [
  "costCenterId",
  "profitCenterId",
  "investmentCenterId",
  "projectId",
  "projectPhaseId",
  "projectTaskId",
];

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function assertExists({ table, orgId, id, name, allowStatuses }) {
  const { rows } = await pool.query(
    `SELECT id, status,
            COALESCE(is_blocked, FALSE) AS is_blocked,
            valid_from, valid_to
       FROM ${table}
      WHERE organization_id=$1 AND id=$2
      LIMIT 1`,
    [orgId, id]
  );
  if (!rows.length) throw new AppError(400, `${name} not found`);
  const row = rows[0];
  if (allowStatuses && !allowStatuses.includes(row.status)) {
    throw new AppError(409, `${name} is ${row.status}`);
  }
  if (row.is_blocked) {
    throw new AppError(409, `${name} is blocked`);
  }

  // Effective dating is optional; enforce only when configured.
  const t = todayIsoDate();
  if (row.valid_from && String(row.valid_from) > t) {
    throw new AppError(409, `${name} is not yet effective`);
  }
  if (row.valid_to && String(row.valid_to) < t) {
    throw new AppError(409, `${name} is no longer effective`);
  }
}

/**
 * Validate the shape of dimensionJson and ensure referenced dimension entities exist.
 *
 * Intended usage: budgets/forecasts line writes.
 */
async function validateDimensionJson({ orgId, dimensionJson }) {
  if (dimensionJson === null || dimensionJson === undefined) return {};
  if (typeof dimensionJson !== "object" || Array.isArray(dimensionJson)) {
    throw new AppError(400, "dimensionJson must be an object");
  }

  const keys = Object.keys(dimensionJson);
  for (const k of keys) {
    if (!ALLOWED_KEYS.includes(k)) {
      throw new AppError(400, `Unsupported dimension key: ${k}`);
    }
    if (dimensionJson[k] === null || dimensionJson[k] === undefined || dimensionJson[k] === "") continue;
    assertUuid(dimensionJson[k], k);
  }

  // Validate existence + status.
  if (dimensionJson.costCenterId) {
    await assertExists({
      table: "cost_centers",
      orgId,
      id: dimensionJson.costCenterId,
      name: "costCenterId",
      allowStatuses: ["active", "inactive"],
    });
  }
  if (dimensionJson.profitCenterId) {
    await assertExists({
      table: "profit_centers",
      orgId,
      id: dimensionJson.profitCenterId,
      name: "profitCenterId",
      allowStatuses: ["active", "inactive"],
    });
  }
  if (dimensionJson.investmentCenterId) {
    await assertExists({
      table: "investment_centers",
      orgId,
      id: dimensionJson.investmentCenterId,
      name: "investmentCenterId",
      allowStatuses: ["active", "inactive"],
    });
  }

  // Projects hierarchy validation.
  if (dimensionJson.projectId) {
    await assertExists({
      table: "projects",
      orgId,
      id: dimensionJson.projectId,
      name: "projectId",
      allowStatuses: ["active", "completed"],
    });
  }
  if (dimensionJson.projectPhaseId) {
    const { rows } = await pool.query(
      `SELECT id, project_id, status FROM project_phases WHERE organization_id=$1 AND id=$2 LIMIT 1`,
      [orgId, dimensionJson.projectPhaseId]
    );
    if (!rows.length) throw new AppError(400, "projectPhaseId not found");
    const phase = rows[0];
    if (!['active','completed'].includes(phase.status)) throw new AppError(409, `projectPhaseId is ${phase.status}`);
    if (dimensionJson.projectId && phase.project_id !== dimensionJson.projectId) {
      throw new AppError(400, "projectPhaseId does not belong to projectId");
    }
  }
  if (dimensionJson.projectTaskId) {
    const { rows } = await pool.query(
      `SELECT id, project_id, phase_id, status FROM project_tasks WHERE organization_id=$1 AND id=$2 LIMIT 1`,
      [orgId, dimensionJson.projectTaskId]
    );
    if (!rows.length) throw new AppError(400, "projectTaskId not found");
    const task = rows[0];
    if (!["active", "completed"].includes(task.status)) throw new AppError(409, `projectTaskId is ${task.status}`);
    if (dimensionJson.projectId && task.project_id !== dimensionJson.projectId) {
      throw new AppError(400, "projectTaskId does not belong to projectId");
    }
    if (dimensionJson.projectPhaseId && task.phase_id !== dimensionJson.projectPhaseId) {
      throw new AppError(400, "projectTaskId does not belong to projectPhaseId");
    }
  }

  return dimensionJson;
}

module.exports = {
  ALLOWED_KEYS,
  validateDimensionJson,
};
