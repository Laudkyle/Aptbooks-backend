const { AppError } = require("../../shared/errors/AppError");
const repo = require("./forecasts.repository");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const { assertMoneyAmount, assertUuid, normalizeStatus } = require("../_util");
const { validateDimensionJson } = require("../dimensions/dimensions.validator");
const { parseCsvText } = require("../../shared/utils/csv");
const { pool } = require("../../db/pool");
const { withTransaction } = require("../../db/tx");
const documentableSvc = require("../../workflow/documents/documentable.service");

const FORECAST_STATUS = ["draft", "active", "archived"];
// Forecast versions are "scenarios". We keep lifecycle simple and enforce edit locks.
const VERSION_STATUS = ["draft", "active", "archived"];
const SCENARIO_STATUS = ["active", "inactive"];

function assertEditableWorkflow(version) {
  if (!version) throw new AppError(404, "Forecast version not found");
  const locked = new Set(["approved", "archived"]);
  if (version.workflow_status && locked.has(version.workflow_status)) {
    throw new AppError(409, `Version workflow_status '${version.workflow_status}' is not editable`);
  }
}

function assertName(name, field = "name") {
  if (!name || typeof name !== "string" || !name.trim()) throw new AppError(400, `${field} is required`);
}

async function getForecastVersionSnapshot({ orgId, forecastId, versionId, client = pool }) {
  const version = await repo.getVersionById({ orgId, id: versionId, forecastId });
  if (!version) throw new AppError(404, "Forecast version not found");
  const forecast = await repo.getForecast({ orgId, id: forecastId });
  const lines = await repo.listLines({ orgId, forecastId, forecastVersionId: versionId });
  return { version: { ...version, forecast_name: forecast?.name || null }, forecast, lines };
}


// ============================
// Scenario Management
// ============================

async function listScenarios({ orgId, includeInactive = false }) {
  return repo.listScenarios({ orgId, includeInactive });
}

async function getScenario({ orgId, scenarioId }) {
  assertUuid(scenarioId, "scenarioId");
  const scenario = await repo.getScenarioById({ orgId, scenarioId });
  if (!scenario) throw new AppError(404, "Scenario not found");
  return scenario;
}

async function getScenarioByCode({ orgId, code }) {
  if (!code || typeof code !== "string" || !code.trim()) {
    throw new AppError(400, "Scenario code is required");
  }
  const scenario = await repo.getScenarioByCode({ orgId, code: code.trim() });
  if (!scenario) throw new AppError(404, "Scenario not found");
  return scenario;
}

async function createScenario({ orgId, code, name, description, isDefault = false, isActive = true, metadata = {}, actorUserId, req }) {
  // Validate required fields
  if (!code || typeof code !== "string" || !code.trim()) {
    throw new AppError(400, "Scenario code is required");
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new AppError(400, "Scenario name is required");
  }

  // Normalize code to uppercase
  const normalizedCode = code.trim().toUpperCase();

  // Check for duplicate code
  const existing = await repo.getScenarioByCode({ orgId, code: normalizedCode });
  if (existing) {
    throw new AppError(409, `Scenario with code '${normalizedCode}' already exists`);
  }

  const created = await repo.createScenario({
    orgId,
    code: normalizedCode,
    name: name.trim(),
    description: description?.trim(),
    isDefault,
    isActive,
    metadata: metadata || {},
    createdByUserId: actorUserId
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.scenario.create",
    entityType: "scenario",
    entityId: created.id,
    ip: req?.ip,
    userAgent: req?.headers?.["user-agent"],
    before: null,
    after: created
  });

  return created;
}

async function updateScenario({ orgId, scenarioId, patch, actorUserId, req }) {
  assertUuid(scenarioId, "scenarioId");
  
  // Get existing scenario for audit and validation
  const existing = await repo.getScenarioById({ orgId, scenarioId });
  if (!existing) throw new AppError(404, "Scenario not found");

  // Validate at least one field to update
  if (Object.keys(patch).length === 0) {
    throw new AppError(400, "At least one field required for update");
  }

  // Check code uniqueness if changing
  if (patch.code && patch.code.trim().toUpperCase() !== existing.code) {
    const normalizedCode = patch.code.trim().toUpperCase();
    const duplicate = await repo.getScenarioByCode({ orgId, code: normalizedCode });
    if (duplicate && duplicate.id !== scenarioId) {
      throw new AppError(409, `Scenario with code '${normalizedCode}' already exists`);
    }
    patch.code = normalizedCode;
  }

  // Validate name if provided
  if (patch.name !== undefined) {
    if (!patch.name || typeof patch.name !== "string" || !patch.name.trim()) {
      throw new AppError(400, "Scenario name cannot be empty");
    }
    patch.name = patch.name.trim();
  }

  // Prevent deactivating the default scenario
  if (existing.is_default && patch.isActive === false) {
    throw new AppError(409, "Cannot deactivate the default scenario");
  }

  const updated = await repo.updateScenario({
    orgId,
    scenarioId,
    patch,
    updatedByUserId: actorUserId
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.scenario.update",
    entityType: "scenario",
    entityId: scenarioId,
    ip: req?.ip,
    userAgent: req?.headers?.["user-agent"],
    before: existing,
    after: updated
  });

  return updated;
}

async function deleteScenario({ orgId, scenarioId, actorUserId, req }) {
  assertUuid(scenarioId, "scenarioId");
  
  const existing = await repo.getScenarioById({ orgId, scenarioId });
  if (!existing) throw new AppError(404, "Scenario not found");

  // Prevent deletion of default scenario
  if (existing.is_default) {
    throw new AppError(409, "Cannot delete the default scenario");
  }

  // Check if scenario is in use
  const usageCount = await repo.getScenarioUsageCount({ orgId, scenarioId });
  if (usageCount > 0) {
    // Soft delete by marking inactive instead
    const updated = await repo.updateScenario({
      orgId,
      scenarioId,
      patch: { isActive: false },
      updatedByUserId: actorUserId
    });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "reporting.forecast.scenario.soft_delete",
      entityType: "scenario",
      entityId: scenarioId,
      ip: req?.ip,
      userAgent: req?.headers?.["user-agent"],
      before: existing,
      after: updated
    });

    return { ...updated, softDeleted: true, message: "Scenario deactivated as it is in use" };
  }

  // Hard delete if not used
  const deleted = await repo.hardDeleteScenario({ orgId, scenarioId });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.scenario.delete",
    entityType: "scenario",
    entityId: scenarioId,
    ip: req?.ip,
    userAgent: req?.headers?.["user-agent"],
    before: existing,
    after: null
  });

  return deleted;
}

async function getScenariosWithStats({ orgId }) {
  return repo.getScenariosWithStats({ orgId });
}

async function setDefaultScenario({ orgId, scenarioId, actorUserId, req }) {
  assertUuid(scenarioId, "scenarioId");
  
  const scenario = await repo.getScenarioById({ orgId, scenarioId });
  if (!scenario) throw new AppError(404, "Scenario not found");
  if (!scenario.is_active) throw new AppError(409, "Cannot set an inactive scenario as default");

  // Update the scenario to be default (the repository trigger will handle unsetting others)
  const updated = await repo.updateScenario({
    orgId,
    scenarioId,
    patch: { isDefault: true },
    updatedByUserId: actorUserId
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.scenario.set_default",
    entityType: "scenario",
    entityId: scenarioId,
    ip: req?.ip,
    userAgent: req?.headers?.["user-agent"],
    before: scenario,
    after: updated
  });

  return updated;
}

// ============================
// Modified Version Functions
// ============================

async function createVersion({ orgId, forecastId, versionNo, name, scenarioId, probabilityWeight = 1, status = "draft", actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  if (!Number.isInteger(versionNo) || versionNo <= 0) throw new AppError(400, "versionNo must be a positive integer");
  
  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (f.status === "archived") throw new AppError(409, "Forecast is archived");

  // Validate scenario if provided
  if (scenarioId) {
    const scenario = await repo.getScenarioById({ orgId, scenarioId });
    if (!scenario) throw new AppError(404, "Scenario not found");
    if (!scenario.is_active) throw new AppError(409, "Scenario is inactive");
  }

  // Validate probability weight
  if (probabilityWeight !== undefined) {
    if (typeof probabilityWeight !== 'number' || probabilityWeight < 0 || probabilityWeight > 1) {
      throw new AppError(400, "probability_weight must be a number between 0 and 1");
    }
  }

  const created = await repo.createVersion({
    orgId,
    forecastId,
    versionNo,
    name: (name || `Version ${versionNo}`).trim(),
    scenarioId,
    probabilityWeight,
    status: normalizeStatus(status, VERSION_STATUS, "status"),
    createdByUserId: actorUserId,
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.version.create",
    entityType: "forecast_version",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });

  return created;
}

async function updateForecastVersion({ orgId, forecastId, versionId, patch, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  assertUuid(versionId, "versionId");
  
  // Get existing version for audit and validation
  const existing = await repo.getVersionById({ orgId, id: versionId, forecastId });
  if (!existing) throw new AppError(404, "Forecast version not found");
  
  // Validate forecast exists and is not archived
  const forecast = await repo.getForecast({ orgId, id: forecastId });
  if (!forecast) throw new AppError(404, "Forecast not found");
  if (forecast.status === "archived") throw new AppError(409, "Forecast is archived");
  
  // Check editability based on workflow status
  if (patch.status || patch.version_no || patch.name || patch.scenarioId || patch.probability_weight || patch.dimension_json) {
    assertEditableWorkflow(existing);
  }
  
  // Validate scenario if provided
  if (patch.scenarioId) {
    const scenario = await repo.getScenarioById({ orgId, scenarioId: patch.scenarioId });
    if (!scenario) throw new AppError(404, "Scenario not found");
    if (!scenario.is_active) throw new AppError(409, "Scenario is inactive");
  }
  
  // Validate status if provided
  if (patch.status) {
    patch.status = normalizeStatus(patch.status, VERSION_STATUS, "status");
    
    // Prevent changing from finalized/archived in certain ways
    if (existing.status === "finalized" && patch.status !== "finalized") {
      throw new AppError(409, "Finalized versions cannot be changed to draft/active");
    }
  }
  
  // Validate version number if provided
  if (patch.version_no !== undefined) {
    if (!Number.isInteger(patch.version_no) || patch.version_no <= 0) {
      throw new AppError(400, "version_no must be a positive integer");
    }
    
    // Check for duplicate version number
    const versions = await repo.listVersions({ orgId, forecastId });
    const duplicate = versions.find(v => 
      v.id !== versionId && v.version_no === patch.version_no
    );
    if (duplicate) {
      throw new AppError(409, `Version number ${patch.version_no} already exists for this forecast`);
    }
  }
  
  // Validate probability weight if provided
  if (patch.probability_weight !== undefined) {
    if (typeof patch.probability_weight !== 'number' || 
        patch.probability_weight < 0 || 
        patch.probability_weight > 1) {
      throw new AppError(400, "probability_weight must be a number between 0 and 1");
    }
  }
  
  // Validate dimension JSON if provided
  if (patch.dimension_json !== undefined) {
    patch.dimension_json = await validateDimensionJson({ 
      orgId, 
      dimensionJson: patch.dimension_json || {} 
    });
  }
  
  const updated = await repo.updateForecastVersion({ 
    orgId, 
    forecastId, 
    versionId, 
    patch 
  });
  
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.version.update",
    entityType: "forecast_version",
    entityId: versionId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: existing,
    after: updated,
  });
  
  return updated;
}

async function copyVersion({ orgId, forecastId, sourceVersionId, newVersionNo, name, scenarioId, probabilityWeight, actorUserId, req }) {
  const src = await repo.getVersionById({ orgId, id: sourceVersionId, forecastId });
  if (!src) throw new AppError(404, "Source forecast version not found");
  if (!Number.isInteger(newVersionNo) || newVersionNo <= 0) throw new AppError(400, "newVersionNo must be a positive integer");

  // Validate scenario if provided
  if (scenarioId) {
    const scenario = await repo.getScenarioById({ orgId, scenarioId });
    if (!scenario) throw new AppError(404, "Scenario not found");
    if (!scenario.is_active) throw new AppError(409, "Scenario is inactive");
  }

  // Validate probability weight
  if (probabilityWeight !== undefined) {
    if (typeof probabilityWeight !== 'number' || probabilityWeight < 0 || probabilityWeight > 1) {
      throw new AppError(400, "probability_weight must be a number between 0 and 1");
    }
  }

  const created = await repo.copyVersion({
    orgId,
    forecastId,
    sourceVersionId,
    newVersionNo,
    name,
    scenarioId,
    probabilityWeight,
    createdByUserId: actorUserId,
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.version.copy",
    entityType: "forecast_version",
    entityId: created?.id || null,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { sourceVersionId, created },
  });

  return created;
}

// ============================
// Existing Functions (Unchanged)
// ============================

async function listForecasts({ orgId, status, limit = 100, offset = 0 }) {
  const st = status ? normalizeStatus(status, FORECAST_STATUS) : null;
  return repo.listForecasts({ orgId, status: st, limit, offset });
}

async function createForecast({ orgId, name, currencyCode, status = "draft", actorUserId, req }) {
  assertName(name);
  if (!currencyCode || typeof currencyCode !== "string") throw new AppError(400, "currencyCode is required");
  const st = normalizeStatus(status, FORECAST_STATUS);

  const created = await repo.createForecastWithDefaultVersion({
    orgId,
    name: name.trim(),
    currencyCode: currencyCode.trim().toUpperCase(),
    status: st,
    createdByUserId: actorUserId,
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.create",
    entityType: "forecast",
    entityId: created.forecast.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });

  // Return a flattened envelope for API consumers.
  return {
    ...created.forecast,
    default_version: created.version,
  };
}

async function upsertLines({ orgId, forecastId, versionId = null, lines, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  if (!Array.isArray(lines)) throw new AppError(400, "lines must be an array");

  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (f.status === "archived") throw new AppError(409, "Forecast is archived");

  // Backwards compatible behaviour:
  // - If versionId not supplied, write into the latest DRAFT version.
  const v = versionId
    ? await repo.getVersionById({ orgId, id: versionId, forecastId })
    : await repo.getLatestDraftVersion({ orgId, forecastId });

  if (!v) throw new AppError(404, "Forecast version not found");
  if (v.status !== "draft") throw new AppError(409, "Only draft forecast versions can be edited");
  assertEditableWorkflow(v);

  const saved = [];
  for (const line of lines) {
    assertUuid(line.accountId, "accountId");
    assertUuid(line.periodId, "periodId");

    const accOk = await repo.assertAccountWritable({ orgId, accountId: line.accountId });
    if (!accOk.ok) {
      throw new AppError(400, `Invalid accountId: ${accOk.reason}`);
    }
    const perOk = await repo.assertPeriodExists({ orgId, periodId: line.periodId });
    if (!perOk.ok) {
      throw new AppError(400, `Invalid periodId: ${perOk.reason}`);
    }

    const amount = assertMoneyAmount(line.amount, "amount");
    const dim = await validateDimensionJson({ orgId, dimensionJson: line.dimensionJson || {} });
    const row = await repo.upsertLine({
      orgId,
      forecastId,
      forecastVersionId: v.id,
      accountId: line.accountId,
      periodId: line.periodId,
      amount,
      dimensionJson: dim,
    });
    saved.push(row);
  }

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.lines.upsert",
    entityType: "forecast_lines",
    entityId: null,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { forecastId, forecastVersionId: v.id, count: saved.length },
  });

  return { forecastId, forecastVersionId: v.id, lines: saved };
}

async function getForecast({ orgId, forecastId, actorUserId, req}) {
  assertUuid(forecastId, "forecastId");
  const includeLines = req?.query?.includeLines === 'true'; 
  const forecast = await repo.getForecast({ orgId, id: forecastId });
  if (!forecast) throw new AppError(404, "Forecast not found");

  // Get all versions for this forecast
  const versions = await repo.listVersions({ orgId, forecastId });
  // Get lines for each version if requested
  const versionsWithLines = includeLines 
    ? await Promise.all(
        versions.map(async (version) => {
          const lines = await repo.listLines({ 
            orgId, 
            forecastId, 
            forecastVersionId: version.id 
          });
          return {
            ...version,
            lines
          };
        })
      )
    : versions;

  // Write audit log for viewing
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.view",
    entityType: "forecast",
    entityId: forecastId,
    ip: req?.ip,
    userAgent: req?.headers?.["user-agent"],
    before: null,
    after: null,
  });

  return {
    ...forecast,
    versions: versionsWithLines
  };
}

async function getForecastVersion({ orgId, forecastId, versionId, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  assertUuid(versionId, "versionId");
  
  const version = await repo.getVersionById({ orgId, id: versionId, forecastId });
  if (!version) throw new AppError(404, "Forecast version not found");

  // Get lines for this version
  const lines = await repo.listLines({ 
    orgId, 
    forecastId, 
    forecastVersionId: version.id 
  });

  // Write audit log for viewing
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.version.view",
    entityType: "forecast_version",
    entityId: versionId,
    ip: req?.ip,
    userAgent: req?.headers?.["user-agent"],
    before: null,
    after: null,
  });

  return {
    ...version,
    lines
  };
}

async function listForecastVersions({ orgId, forecastId }) {
  assertUuid(forecastId, "forecastId");
  
  const forecast = await repo.getForecast({ orgId, id: forecastId });
  if (!forecast) throw new AppError(404, "Forecast not found");

  return repo.listVersions({ orgId, forecastId });
}

async function archiveForecastVersion({ orgId, forecastId, versionId, actorUserId, req }) {
  const before = await getForecastVersion({ orgId, forecastId, versionId, actorUserId, req, includeLines: false });
  if (!before) throw new AppError(404, "Forecast version not found");
  if ((before.workflow_status || before.workflowStatus) === "approved") {
    throw new AppError(409, "Approved forecast versions cannot be archived directly");
  }
  const { rows } = await pool.query(
    `UPDATE forecast_versions
        SET status='archived', workflow_status='archived', archived_by_user_id=$4, archived_at=NOW(), updated_at=NOW()
      WHERE organization_id=$1 AND forecast_id=$2 AND id=$3
      RETURNING *`,
    [orgId, forecastId, versionId, actorUserId || null]
  );
  const updated = rows[0];
  if (!updated) throw new AppError(404, "Forecast version not found");
  await writeAudit({ organizationId: orgId, actorUserId, action: "reporting.forecast.version.archive", entityType: "forecast_version", entityId: versionId, before, after: updated, req });
  return updated;
}

async function listForecastLines({ orgId, forecastId, versionId, limit = 100, offset = 0, accountId, periodId }) {
  assertUuid(forecastId, "forecastId");
  assertUuid(versionId, "versionId");
  
  const version = await repo.getVersionById({ orgId, id: versionId, forecastId });
  if (!version) throw new AppError(404, "Forecast version not found");

  return repo.listLinesPaginated({ 
    orgId, 
    forecastId, 
    forecastVersionId: versionId,
    limit,
    offset,
    accountId,
    periodId
  });
}

async function getForecastSummary({ orgId, forecastId }) {
  assertUuid(forecastId, "forecastId");
  
  const forecast = await repo.getForecast({ orgId, id: forecastId });
  if (!forecast) throw new AppError(404, "Forecast not found");

  const versions = await repo.listVersions({ orgId, forecastId });
  
  // Calculate summary metrics
  const totalVersions = versions.length;
  const draftVersions = versions.filter(v => v.workflow_status === 'draft').length;
  const submittedVersions = versions.filter(v => v.workflow_status === 'in_review').length;
  const approvedVersions = versions.filter(v => v.workflow_status === 'approved').length;
  const rejectedVersions = versions.filter(v => v.workflow_status === 'rejected').length;
  
  // Get total lines count and sum across all versions
  let totalLines = 0;
  let totalAmount = 0;
  
  for (const version of versions) {
    const lines = await repo.listLines({ orgId, forecastId, forecastVersionId: version.id });
    totalLines += lines.length;
    totalAmount += lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  }

  return {
    forecastId,
    name: forecast.name,
    fiscal_year: forecast.fiscal_year,
    currency_code: forecast.currency_code,
    status: forecast.status,
    metrics: {
      totalVersions,
      draftVersions,
      submittedVersions,
      approvedVersions,
      rejectedVersions,
      totalLines,
      totalAmount
    },
    versionBreakdown: {
      draft: draftVersions,
      in_review: submittedVersions,
      approved: approvedVersions,
      rejected: rejectedVersions
    }
  };
}

async function getVersionWorkflowHistory({ orgId, forecastId, versionId }) {
  assertUuid(forecastId, "forecastId");
  assertUuid(versionId, "versionId");
  
  const version = await repo.getVersionById({ orgId, id: versionId, forecastId });
  if (!version) throw new AppError(404, "Forecast version not found");

  // Get audit logs for this version
  const auditLogs = await repo.getAuditLogs({ 
    orgId, 
    entityType: "forecast_version", 
    entityId: versionId 
  });

  // Build workflow history timeline
  const history = [
    {
      event: "created",
      timestamp: version.created_at,
      userId: version.created_by_user_id,
      status: version.status
    }
  ];

  if (version.submitted_at) {
    history.push({
      event: "submitted",
      timestamp: version.submitted_at,
      userId: version.submitted_by_user_id,
      status: "in_review"
    });
  }

  if (version.approved_at) {
    history.push({
      event: "approved",
      timestamp: version.approved_at,
      userId: version.approved_by_user_id,
      status: "approved"
    });
  }

  if (version.rejected_at) {
    history.push({
      event: "rejected",
      timestamp: version.rejected_at,
      userId: version.rejected_by_user_id,
      reason: version.rejection_reason,
      status: "rejected"
    });
  }

  if (version.finalized_at) {
    history.push({
      event: "finalized",
      timestamp: version.finalized_at,
      status: "finalized"
    });
  }

  // Sort by timestamp
  history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return {
    versionId,
    forecastId,
    currentStatus: version.workflow_status || version.status,
    history
  };
}

async function getVariance({ orgId, forecastId, periodId, versionId = null }) {
  assertUuid(forecastId, "forecastId");
  assertUuid(periodId, "periodId");

  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");

  const v = versionId
    ? await repo.getVersionById({ orgId, id: versionId, forecastId })
    : await repo.getLatestActiveOrDraftVersion({ orgId, forecastId });

  if (!v) throw new AppError(404, "Forecast version not found");

  const rows = await repo.getVariance({ orgId, forecastId, forecastVersionId: v.id, periodId });
  const totals = rows.reduce(
    (acc, r) => {
      acc.forecast += Number(r.forecast_amount || 0);
      acc.actual += Number(r.actual_normal || 0);
      acc.variance += Number(r.variance || 0);
      return acc;
    },
    { forecast: 0, actual: 0, variance: 0 }
  );
  return { periodId, forecastId, forecastVersionId: v.id, totals, lines: rows };
}

async function activateForecast({ orgId, forecastId, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (f.status === "archived") throw new AppError(409, "Forecast is archived");

  const activatedVersion = await repo.activateForecast({ orgId, forecastId });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.activate",
    entityType: "forecast",
    entityId: forecastId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: { status: f.status },
    after: { status: "active", activatedVersionId: activatedVersion?.id || null },
  });

  return { forecastId, activatedVersion };
}

async function archiveForecast({ orgId, forecastId, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (f.status === "archived") return { forecastId, status: "archived" };

  await repo.archiveForecast({ orgId, forecastId });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.archive",
    entityType: "forecast",
    entityId: forecastId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: { status: f.status },
    after: { status: "archived" },
  });

  return { forecastId, status: "archived" };
}

async function finalizeVersion({ orgId, forecastId, versionId, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  assertUuid(versionId, "versionId");
  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (f.status === "archived") throw new AppError(409, "Forecast is archived");

  const v = await repo.getVersionById({ orgId, id: versionId, forecastId });
  if (!v) throw new AppError(404, "Forecast version not found");
  if (v.status !== "draft") throw new AppError(409, "Only draft versions can be finalised");

  const updated = await repo.finalizeVersion({ orgId, forecastId, versionId,actorUserId });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.version.finalise",
    entityType: "forecast_version",
    entityId: versionId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: { status: v.status },
    after: { status: updated?.status || "active" },
  });
  return updated;
}

async function submitVersion({ orgId, forecastId, versionId, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  assertUuid(versionId, "versionId");
  const v = await repo.getVersionById({ orgId, id: versionId, forecastId });
  if (!v) throw new AppError(404, "Forecast version not found");
  if (v.workflow_status !== "draft" && v.workflow_status !== "rejected") {
    throw new AppError(409, "Only draft/rejected versions can be submitted");
  }
  const updated = await repo.updateVersionWorkflow({
    orgId,
    forecastId,
    versionId,
    patch: {
      workflowStatus: "in_review",
      submittedAt: new Date().toISOString(),
      submittedByUserId: actorUserId,
      rejectionReason: null,
    },
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.version.submit",
    entityType: "forecast_version",
    entityId: versionId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: v,
    after: updated,
  });
  return updated;
}

async function approveVersion({ orgId, forecastId, versionId, actorUserId, req }) {
  const v = await repo.getVersionById({ orgId, id: versionId, forecastId });
  if (!v) throw new AppError(404, "Forecast version not found");
  if (v.workflow_status !== "in_review") throw new AppError(409, "Only in_review versions can be approved");
  const updated = await repo.updateVersionWorkflow({
    orgId,
    forecastId,
    versionId,
    patch: { workflowStatus: "approved", approvedAt: new Date().toISOString(), approvedByUserId: actorUserId },
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.version.approve",
    entityType: "forecast_version",
    entityId: versionId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: v,
    after: updated,
  });
  return updated;
}

async function rejectVersion({ orgId, forecastId, versionId, reason, actorUserId, req }) {
  const v = await repo.getVersionById({ orgId, id: versionId, forecastId });
  if (!v) throw new AppError(404, "Forecast version not found");
  if (v.workflow_status !== "in_review") throw new AppError(409, "Only in_review versions can be rejected");
  const updated = await repo.updateVersionWorkflow({
    orgId,
    forecastId,
    versionId,
    patch: {
      workflowStatus: "rejected",
      rejectedAt: new Date().toISOString(),
      rejectedByUserId: actorUserId,
      rejectionReason: reason || "Rejected",
    },
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.version.reject",
    entityType: "forecast_version",
    entityId: versionId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: v,
    after: updated,
  });
  return updated;
}

async function compareVersions({ orgId, forecastId, baseVersionId, compareVersionId, periodId }) {
  assertUuid(forecastId, "forecastId");
  assertUuid(baseVersionId, "baseVersionId");
  assertUuid(compareVersionId, "compareVersionId");
  const rows = await repo.compareVersions({ orgId, forecastId, baseVersionId, compareVersionId, periodId: periodId || null });
  return { forecastId, baseVersionId, compareVersionId, periodId: periodId || null, lines: rows };
}

async function forecastVsBudget({ orgId, forecastVersionId, budgetVersionId, periodId }) {
  assertUuid(forecastVersionId, "forecastVersionId");
  assertUuid(budgetVersionId, "budgetVersionId");
  assertUuid(periodId, "periodId");
  const rows = await repo.forecastVsBudget({ orgId, forecastVersionId, budgetVersionId, periodId });
  const totals = rows.reduce(
    (acc, r) => {
      acc.forecast += Number(r.forecast_amount || 0);
      acc.budget += Number(r.budget_amount || 0);
      acc.variance += Number(r.variance || 0);
      return acc;
    },
    { forecast: 0, budget: 0, variance: 0 }
  );
  return { periodId, forecastVersionId, budgetVersionId, totals, lines: rows };
}

async function updateForecast({ orgId, forecastId, patch, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  
  // Get existing forecast for audit and validation
  const existing = await repo.getForecast({ orgId, id: forecastId });
  if (!existing) throw new AppError(404, "Forecast not found");
  
  // Validate status if provided
  if (patch.status) {
    patch.status = normalizeStatus(patch.status, FORECAST_STATUS, "status");
  }
  
  // Validate currency if provided
  if (patch.currency_code && typeof patch.currency_code !== "string") {
    throw new AppError(400, "currency_code must be a string");
  }
  
  // Validate name if provided
  if (patch.name !== undefined) {
    assertName(patch.name, "name");
  }
  
  // Don't allow updating archived forecasts
  if (existing.status === "archived" && patch.status !== "archived") {
    throw new AppError(409, "Archived forecasts cannot be modified");
  }
  
  const updated = await repo.updateForecast({ orgId, forecastId, patch });
  
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.update",
    entityType: "forecast",
    entityId: forecastId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: existing,
    after: updated,
  });
  
  return updated;
}

async function importLinesCsv({ orgId, forecastId, versionId, csvText, actorUserId, req }) {
  const rows = parseCsvText(csvText);
  const lines = rows.map((r) => {
    const accountId = r.accountId || r.account_id || r.account || r.accountCode || r.account_code;
    const periodId = r.periodId || r.period_id || r.period;
    const amount = r.amount ?? r.value;
    let dimensionJson = r.dimensionJson || r.dimension_json || r.dimensions || r.dimension;
    if (typeof dimensionJson === "string" && dimensionJson.trim().length) {
      try {
        dimensionJson = JSON.parse(dimensionJson);
      } catch (e) {
        throw new AppError(400, `Invalid dimensionJson JSON for accountId=${accountId || ""} periodId=${periodId || ""}`);
      }
    } else {
      dimensionJson = {};
    }

    return { accountId, periodId, amount, dimensionJson };
  });

  return upsertLines({ orgId, forecastId, versionId, lines, actorUserId, req });
}

// ============================
// Module Exports
// ============================
module.exports = {
  // Forecasts
  listForecasts,
  createForecast,
  getForecast,
  updateForecast,
  activateForecast,
  archiveForecast,
  getForecastSummary,
  
  // Versions
  createVersion,
  getForecastVersion,
  listForecastVersions,
  updateForecastVersion,
  finalizeVersion,
  submitVersion,
  approveVersion,
  rejectVersion,
  copyVersion,
  archiveForecastVersion,
  
  // Lines
  upsertLines,
  listForecastLines,
  importLinesCsv,
  
  // Comparisons & Analysis
  compareVersions,
  forecastVsBudget,
  getVariance,
  getVersionWorkflowHistory,
  
  // Scenarios
  listScenarios,
  getScenario,
  getScenarioByCode,
  createScenario,
  updateScenario,
  deleteScenario,
  getScenariosWithStats,
  setDefaultScenario,
};