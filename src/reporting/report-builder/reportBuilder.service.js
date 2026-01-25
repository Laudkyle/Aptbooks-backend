const { pool } = require("../../db/pool");
const crypto = require("crypto");
const { AppError } = require("../../shared/errors/AppError");
const repo = require("./reportBuilder.repository");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");

function assertSqlSafe(sql) {
  const text = String(sql || "").trim();
  if (!text) throw new AppError(400, "Query SQL is required");

  // Allow only a single statement.
  const semi = text.split(";").filter((s) => s.trim().length > 0);
  if (semi.length > 1) throw new AppError(400, "Only a single SELECT statement is allowed");

  // Must start with WITH or SELECT
  const start = text.toLowerCase().replace(/^\s+/, "");
  if (!(start.startsWith("select ") || start.startsWith("with "))) {
    throw new AppError(400, "Only SELECT queries are allowed");
  }

  // Block dangerous keywords.
  const denied = [
    "insert ",
    "update ",
    "delete ",
    "drop ",
    "alter ",
    "truncate ",
    "create ",
    "grant ",
    "revoke ",
    "copy ",
    "call ",
    "do ",
    "execute ",
  ];
  const lowered = ` ${start} `;
  for (const k of denied) {
    if (lowered.includes(` ${k}`)) throw new AppError(400, "Unsafe SQL keyword detected");
  }

  return text;
}

function computeNextRunAt({ scheduleType, intervalSeconds, dailyHourUtc, dailyMinuteUtc }) {
  const now = new Date();
  if (scheduleType === "interval_seconds") {
    const secs = Number(intervalSeconds);
    if (!Number.isFinite(secs) || secs <= 0) throw new AppError(400, "Invalid intervalSeconds");
    return new Date(now.getTime() + secs * 1000);
  }
  if (scheduleType === "daily_at_utc") {
    const hh = Number(dailyHourUtc);
    const mm = Number(dailyMinuteUtc);
    if (!Number.isInteger(hh) || hh < 0 || hh > 23) throw new AppError(400, "Invalid dailyHourUtc");
    if (!Number.isInteger(mm) || mm < 0 || mm > 59) throw new AppError(400, "Invalid dailyMinuteUtc");

    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hh,
      mm,
      0,
      0
    ));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  throw new AppError(400, "Unsupported scheduleType");
}

async function ensureCanRead({ organizationId, userId, reportId }) {
  // Owner or explicit share grants read.
  const r = await repo.getReport({ organizationId, reportId });
  if (!r || r.is_archived) throw new AppError(404, "Report not found");

  if (r.created_by_user_id && r.created_by_user_id === userId) return { report: r, canEdit: true };

  // shared by user
  const { rows } = await pool.query(
    `
    SELECT can_edit
    FROM saved_report_shares
    WHERE organization_id=$1 AND saved_report_id=$2
      AND (
        (share_type='user' AND user_id=$3)
        OR (
          share_type='role' AND role_id IN (
            SELECT role_id FROM user_roles WHERE user_id=$3
          )
        )
      )
    LIMIT 1
    `,
    [organizationId, reportId, userId]
  );
  if (!rows.length) return { report: r, canEdit: false, denied: true };
  return { report: r, canEdit: !!rows[0].can_edit };
}

async function listReports(ctx, { includeArchived, search, limit, offset }) {
  return repo.listReports({ organizationId: ctx.organizationId, includeArchived, search, limit, offset });
}

async function createReport(ctx, payload) {
  const r = await repo.createReport({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    name: payload.name,
    description: payload.description,
    folder: payload.folder,
  });

  // Create initial version
  const kind = payload.kind || "sql";
  const querySql = kind === "sql" ? assertSqlSafe(payload.querySql || "") : null;
  const templateKey = kind === "management" ? (payload.templateKey || null) : null;
  const v = await repo.createVersion({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    reportId: r.id,
    kind,
    querySql,
    templateKey,
    parametersJson: payload.parameters || {},
  });

  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "reporting.report.create",
    entityType: "saved_report",
    entityId: r.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before: null,
    after: { report: r, version: v },
  });

  return { report: r, version: v };
}

async function updateReportMeta(ctx, reportId, patch) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  if (!access.canEdit) throw new AppError(403, "Forbidden");

  const before = access.report;
  const after = await repo.updateReportMeta({
    organizationId: ctx.organizationId,
    reportId,
    name: patch.name,
    description: patch.description,
    folder: patch.folder,
  });
  if (!after) throw new AppError(404, "Report not found");

  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "reporting.report.update_meta",
    entityType: "saved_report",
    entityId: reportId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before,
    after,
  });

  return after;
}

async function archiveReport(ctx, reportId, isArchived) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  if (!access.canEdit) throw new AppError(403, "Forbidden");
  const before = access.report;
  const after = await repo.archiveReport({ organizationId: ctx.organizationId, reportId, isArchived });
  if (!after) throw new AppError(404, "Report not found");

  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: isArchived ? "reporting.report.archive" : "reporting.report.unarchive",
    entityType: "saved_report",
    entityId: reportId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before,
    after,
  });

  return after;
}

async function createVersion(ctx, reportId, payload) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  if (!access.canEdit) throw new AppError(403, "Forbidden");

  const kind = payload.kind || "sql";
  const querySql = kind === "sql" ? assertSqlSafe(payload.querySql || "") : null;
  const templateKey = kind === "management" ? (payload.templateKey || null) : null;
  const v = await repo.createVersion({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    reportId,
    kind,
    querySql,
    templateKey,
    parametersJson: payload.parameters || {},
  });

  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "reporting.report.create_version",
    entityType: "saved_report",
    entityId: reportId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before: null,
    after: v,
  });
  return v;
}

async function runReportSql({ organizationId, sql, parameters, maxRows = 500 }) {
  const safe = assertSqlSafe(sql);
  // Enforce LIMIT
  const limit = Math.min(Math.max(Number(maxRows) || 500, 1), 2000);
  const limited = /\blimit\b/i.test(safe) ? safe : `${safe}\nLIMIT ${limit}`;

  const values = Array.isArray(parameters) ? parameters : [];
  const { rows } = await pool.query(limited, values);
  return rows;
}

async function runReport(ctx, reportId, { versionId = null, scheduleId = null, parameters = [], maxRows = 500 }) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");

  const version = versionId
    ? (await pool.query(
        `SELECT * FROM saved_report_versions WHERE organization_id=$1 AND id=$2 AND saved_report_id=$3 LIMIT 1`,
        [ctx.organizationId, versionId, reportId]
      )).rows[0]
    : await repo.getLatestVersion({ organizationId: ctx.organizationId, reportId });

  if (!version) throw new AppError(404, "Report version not found");

  // Stage 4: cache (optional)
  const ttlSeconds = Number(version.cache_ttl_seconds ?? process.env.REPORT_CACHE_TTL_SECONDS ?? 0);
  const cacheEnabled = Number.isFinite(ttlSeconds) && ttlSeconds > 0;
  let cacheKey = null;
  if (cacheEnabled && version.kind === "sql") {
    const keyObj = {
      org: ctx.organizationId,
      reportId,
      versionId: version.id,
      sql: version.query_sql,
      parameters,
      maxRows
    };
    cacheKey = crypto.createHash("sha256").update(JSON.stringify(keyObj)).digest("hex");
    const cached = await repo.getCache({ organizationId: ctx.organizationId, cacheKey });
    if (cached) {
      const run = await repo.startRun({ organizationId: ctx.organizationId, reportId, versionId: version.id, scheduleId });
      const outputJson = { ...(cached.output_json || {}), cached: true };
      const finished = await repo.finishRun({
        organizationId: ctx.organizationId,
        runId: run.id,
        status: "success",
        error: null,
        rowCount: cached.row_count ?? null,
        outputJson
      });
      return finished;
    }
  }

  const run = await repo.startRun({
    organizationId: ctx.organizationId,
    reportId,
    versionId: version.id,
    scheduleId,
  });

  try {
    let output;
    if (version.kind === "sql") {
      const rows = await runReportSql({ organizationId: ctx.organizationId, sql: version.query_sql, parameters, maxRows });
      output = { kind: "sql", rows };
      if (cacheEnabled && cacheKey) {
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        await repo.setCache({
          organizationId: ctx.organizationId,
          cacheKey,
          reportId,
          reportVersionId: version.id,
          outputJson: output,
          rowCount: rows.length,
          expiresAt
        });
      }
      const finished = await repo.finishRun({
        organizationId: ctx.organizationId,
        runId: run.id,
        status: "success",
        error: null,
        rowCount: rows.length,
        outputJson: output,
      });
      return finished;
    }

    // Management templates can be handled in Stage 3 management module.
    // For now, we persist the template request as the output.
    output = { kind: "management", templateKey: version.template_key, parameters: version.parameters_json };
    const finished = await repo.finishRun({
      organizationId: ctx.organizationId,
      runId: run.id,
      status: "success",
      error: null,
      rowCount: null,
      outputJson: output,
    });
    return finished;
  } catch (e) {
    const msg = String(e?.message || e);
    await repo.finishRun({
      organizationId: ctx.organizationId,
      runId: run.id,
      status: "failed",
      error: msg,
      rowCount: null,
      outputJson: null,
    });
    throw e;
  }
}

async function listRuns(ctx, reportId, limit) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  return repo.listRuns({ organizationId: ctx.organizationId, reportId, limit });
}

async function listVersions(ctx, reportId) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  return repo.listVersions({ organizationId: ctx.organizationId, reportId });
}

async function listShares(ctx, reportId) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  if (!access.canEdit) throw new AppError(403, "Forbidden");
  return repo.listShares({ organizationId: ctx.organizationId, reportId });
}

async function upsertShare(ctx, reportId, payload) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  if (!access.canEdit) throw new AppError(403, "Forbidden");
  if (!payload.shareType || !["user", "role"].includes(payload.shareType)) throw new AppError(400, "Invalid shareType");
  if (payload.shareType === "user" && !payload.userId) throw new AppError(400, "userId required");
  if (payload.shareType === "role" && !payload.roleId) throw new AppError(400, "roleId required");
  return repo.upsertShare({
    organizationId: ctx.organizationId,
    reportId,
    shareType: payload.shareType,
    userId: payload.userId || null,
    roleId: payload.roleId || null,
    canEdit: !!payload.canEdit,
  });
}

async function deleteShare(ctx, shareId) {
  // share deletion is manage-only;caller already has manage permission
  return repo.deleteShare({ organizationId: ctx.organizationId, shareId });
}

async function listSchedules(ctx, reportId) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  if (!access.canEdit) throw new AppError(403, "Forbidden");
  return repo.listSchedules({ organizationId: ctx.organizationId, reportId });
}

async function createSchedule(ctx, reportId, payload) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  if (!access.canEdit) throw new AppError(403, "Forbidden");
  const s = payload.schedule || {};
  const scheduleType = s.type;
  if (!scheduleType || !["interval_seconds", "daily_at_utc"].includes(scheduleType)) throw new AppError(400, "Invalid schedule type");
  const nextRunAt = computeNextRunAt({
    scheduleType,
    intervalSeconds: s.intervalSeconds,
    dailyHourUtc: s.dailyHourUtc,
    dailyMinuteUtc: s.dailyMinuteUtc,
  });

  const created = await repo.createSchedule({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    reportId,
    versionId: payload.versionId || null,
    name: payload.name || null,
    schedule: { ...s, type: scheduleType },
  });
  const updated = await repo.updateSchedule({
    organizationId: ctx.organizationId,
    scheduleId: created.id,
    patch: { nextRunAt },
  });

  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "reporting.report.schedule.create",
    entityType: "saved_report",
    entityId: reportId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before: null,
    after: updated,
  });

  return updated;
}

async function updateSchedule(ctx, scheduleId, payload) {
  const patch = { ...payload };
  // If schedule changes, recompute next run.
  if (patch.scheduleType || patch.intervalSeconds || patch.dailyHourUtc || patch.dailyMinuteUtc) {
    const scheduleType = patch.scheduleType;
    const nextRunAt = computeNextRunAt({
      scheduleType,
      intervalSeconds: patch.intervalSeconds,
      dailyHourUtc: patch.dailyHourUtc,
      dailyMinuteUtc: patch.dailyMinuteUtc,
    });
    patch.nextRunAt = nextRunAt;
  }
  return repo.updateSchedule({ organizationId: ctx.organizationId, scheduleId, patch });
}

async function listComments(ctx, reportId, limit) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  return repo.listComments({ organizationId: ctx.organizationId, reportId, limit });
}

async function addComment(ctx, reportId, body) {
  const access = await ensureCanRead({ organizationId: ctx.organizationId, userId: ctx.userId, reportId });
  if (access.denied) throw new AppError(403, "Forbidden");
  if (!body || !String(body).trim()) throw new AppError(400, "Comment body required");
  return repo.addComment({ organizationId: ctx.organizationId, reportId, userId: ctx.userId, body: String(body).trim() });
}

module.exports = {
  listReports,
  createReport,
  updateReportMeta,
  archiveReport,
  listVersions,
  createVersion,
  runReport,
  listRuns,
  listShares,
  upsertShare,
  deleteShare,
  listSchedules,
  createSchedule,
  updateSchedule,
  listComments,
  addComment,
  computeNextRunAt,
  assertSqlSafe,
};
