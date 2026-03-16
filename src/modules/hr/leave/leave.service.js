const repo = require("./leave.repository");
const { AppError } = require("../../../shared/errors/AppError");
const { withTransaction } = require("../../../db/tx");
const documentableSvc = require("../../../workflow/documents/documentable.service");

function assertDateOrder(start, end) {
  if (new Date(start) > new Date(end)) throw new AppError(400, "INVALID_DATES", "start_date must be <= end_date");
}

async function createLeaveType({ orgId, actorUserId, payload, audit, writeAudit }) {
  const created = await repo.createLeaveType(orgId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.leave_type.created",
      entityType: "hr_leave_types",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return created;
}

async function listLeaveTypes({ orgId, query }) {
  return repo.listLeaveTypes(orgId, query);
}

async function updateLeaveType({ orgId, actorUserId, leaveTypeId, payload, audit, writeAudit }) {
  const updated = await repo.updateLeaveType(orgId, leaveTypeId, payload);
  if (!updated) throw new AppError(404, "NOT_FOUND", "Leave type not found");
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.leave_type.updated",
      entityType: "hr_leave_types",
      entityId: updated.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return updated;
}

async function deactivateLeaveType({ orgId, actorUserId, leaveTypeId, audit, writeAudit }) {
  const updated = await repo.deactivateLeaveType(orgId, leaveTypeId);
  if (!updated) throw new AppError(404, "NOT_FOUND", "Leave type not found");
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.leave_type.deactivated",
      entityType: "hr_leave_types",
      entityId: updated.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
    });
  }
  return updated;
}

async function upsertLeaveBalance({ orgId, actorUserId, payload, audit, writeAudit }) {
  const bal = await repo.upsertLeaveBalance(orgId, {
    employeeId: payload.employee_id,
    leaveTypeId: payload.leave_type_id,
    balanceDays: payload.balance_days,
  });

  await repo.insertLeaveLedger(orgId, {
    employeeId: payload.employee_id,
    leaveTypeId: payload.leave_type_id,
    deltaDays: 0,
    reason: payload.reason || "Balance set",
    refType: "manual",
    refId: bal.id,
  });

  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.leave_balance.upserted",
      entityType: "hr_leave_balances",
      entityId: bal.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return bal;
}

async function listLeaveBalances({ orgId, query }) {
  return repo.listLeaveBalances(orgId, query);
}

async function createLeaveRequest({ orgId, actorUserId, payload, audit, writeAudit }) {
  assertDateOrder(payload.start_date, payload.end_date);
  const created = await repo.createLeaveRequest(orgId, actorUserId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.leave_request.created",
      entityType: "hr_leave_requests",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return created;
}

async function listLeaveRequests({ orgId, query }) {
  return repo.listLeaveRequests(orgId, query);
}

async function getLeaveRequest({ orgId, requestId }) {
  const r = await repo.getLeaveRequest(orgId, requestId);
  if (!r) throw new AppError(404, "NOT_FOUND", "Leave request not found");
  return r;
}

async function submitLeaveRequest({ orgId, actorUserId, requestId, audit, writeAudit }) {
  const updated = await withTransaction(async (client) => {
    const r = await repo.getLeaveRequest(orgId, requestId, client, true);
    if (!r) throw new AppError(404, "NOT_FOUND", "Leave request not found");
    if (!["draft", "rejected"].includes(r.status)) throw new AppError(409, "BAD_STATE", "Only draft/rejected leave requests can be submitted");

    await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "leave_request",
      entity: r,
      workflowDocumentId: r.workflow_document_id || r.document_id || null,
      snapshot: {
        header: r,
        lines: [],
        related: {
          employee_id: r.employee_id,
          leave_type_id: r.leave_type_id
        },
        meta: {
          status: r.status,
          start_date: r.start_date,
          end_date: r.end_date,
          days: r.days
        }
      },
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await client.query(
          `UPDATE hr_leave_requests SET workflow_document_id=$3, document_id=COALESCE(document_id, $3), updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
          [orgId, requestId, workflowDocumentId]
        );
      }
    });

    return repo.setLeaveRequestStatus(orgId, requestId, "submitted", client);
  });

  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.leave_request.submitted",
      entityType: "hr_leave_requests",
      entityId: requestId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
    });
  }
  return updated;
}

async function approveLeaveRequest({ orgId, actorUserId, requestId, audit, writeAudit }) {
  const result = await withTransaction(async (client) => {
    const req = await repo.getLeaveRequest(orgId, requestId, client, true);
    if (!req) throw new AppError(404, "NOT_FOUND", "Leave request not found");
    if (req.status !== "submitted") throw new AppError(409, "BAD_STATE", "Only submitted requests can be approved");

    if (!req.workflow_document_id && !req.document_id) throw new AppError(409, "BAD_STATE", "Leave request has no workflow document");
    await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: "leave_request",
      workflowDocumentId: req.workflow_document_id || req.document_id,
      creatorUserId: req.created_by_user_id,
      client
    });

    const lt = await repo.getLeaveType(orgId, req.leave_type_id);
    if (!lt) throw new AppError(409, "CONFIG", "Leave type missing");
    if (lt.is_paid) {
      const bal = await repo.getLeaveBalance(orgId, { employeeId: req.employee_id, leaveTypeId: req.leave_type_id }, client, true);
      const cur = bal ? Number(bal.balance_days) : 0;
      const days = Number(req.days);
      if (cur < days) throw new AppError(409, "INSUFFICIENT_BALANCE", "Insufficient leave balance");
      await repo.setLeaveBalance(orgId, { employeeId: req.employee_id, leaveTypeId: req.leave_type_id, newBalance: cur - days }, client);
      await repo.insertLeaveLedger(orgId, {
        employeeId: req.employee_id,
        leaveTypeId: req.leave_type_id,
        deltaDays: -days,
        reason: "Leave approved",
        refType: "leave_request",
        refId: req.id,
      }, client);
    }
    return repo.setLeaveRequestStatus(orgId, requestId, "approved", client);
  });

  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.leave_request.approved",
      entityType: "hr_leave_requests",
      entityId: requestId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
    });
  }
  return result;
}

async function rejectLeaveRequest({ orgId, actorUserId, requestId, payload, audit, writeAudit }) {
  const updated = await withTransaction(async (client) => {
    const r = await repo.getLeaveRequest(orgId, requestId, client, true);
    if (!r) throw new AppError(404, "NOT_FOUND", "Leave request not found");
    if (r.status !== "submitted") throw new AppError(409, "BAD_STATE", "Only submitted requests can be rejected");

    if (!r.workflow_document_id && !r.document_id) throw new AppError(409, "BAD_STATE", "Leave request has no workflow document");
    await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: "leave_request",
      workflowDocumentId: r.workflow_document_id || r.document_id,
      creatorUserId: r.created_by_user_id,
      comment: payload?.reason || "Leave rejected",
      client
    });

    await repo.insertLeaveLedger(orgId, {
      employeeId: r.employee_id,
      leaveTypeId: r.leave_type_id,
      deltaDays: 0,
      reason: payload?.reason || "Leave rejected",
      refType: "leave_request",
      refId: r.id,
    }, client);
    return repo.setLeaveRequestStatus(orgId, requestId, "rejected", client);
  });

  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.leave_request.rejected",
      entityType: "hr_leave_requests",
      entityId: requestId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return updated;
}

async function cancelLeaveRequest({ orgId, actorUserId, requestId, audit, writeAudit }) {
  const updated = await withTransaction(async (client) => {
    const r = await repo.getLeaveRequest(orgId, requestId, client, true);
    if (!r) throw new AppError(404, "NOT_FOUND", "Leave request not found");
    if (!["draft","submitted"].includes(r.status)) throw new AppError(409, "BAD_STATE", "Only draft/submitted requests can be cancelled");
    return repo.setLeaveRequestStatus(orgId, requestId, "cancelled", client);
  });

  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.leave_request.cancelled",
      entityType: "hr_leave_requests",
      entityId: requestId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
    });
  }
  return updated;
}

module.exports = {
  // types
  createLeaveType,
  listLeaveTypes,
  updateLeaveType,
  deactivateLeaveType,
  // balances
  upsertLeaveBalance,
  listLeaveBalances,
  // requests
  createLeaveRequest,
  listLeaveRequests,
  getLeaveRequest,
  submitLeaveRequest,
  approveLeaveRequest,
  rejectLeaveRequest,
  cancelLeaveRequest,
};
