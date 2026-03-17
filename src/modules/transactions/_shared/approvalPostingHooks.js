const { AppError } = require("../../../shared/errors/AppError");

const HOOKS = {
  expense: async ({ orgId, actorUserId, entityId }) => {
    const svc = require("../expenses/expenses.service");
    return svc.finalize({ orgId, actorUserId, documentId: entityId });
  },
  petty_cash: async ({ orgId, actorUserId, entityId }) => {
    const svc = require("../petty-cash/pettycash.service");
    return svc.finalize({ orgId, actorUserId, documentId: entityId });
  },
  advance: async ({ orgId, actorUserId, entityId }) => {
    const svc = require("../advances/advances.service");
    return svc.finalize({ orgId, actorUserId, documentId: entityId });
  },
  refund: async ({ orgId, actorUserId, entityId }) => {
    const svc = require("../refunds/refunds.service");
    return svc.finalize({ orgId, actorUserId, documentId: entityId });
  },
  return: async ({ orgId, actorUserId, entityId }) => {
    const svc = require("../returns/returns.service");
    return svc.finalize({ orgId, actorUserId, documentId: entityId });
  },
  goods_receipt: async ({ orgId, actorUserId, entityId }) => {
    const svc = require("../goods-receipts/goodsreceipts.service");
    return svc.finalize({ orgId, actorUserId, documentId: entityId });
  }
};

function normalizeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || "Unknown posting-hook error",
    statusCode: error?.statusCode || error?.status || 500,
    code: error?.code || null
  };
}

async function runApprovalPostingHook({ entityType, orgId, actorUserId, entityId }) {
  const hook = HOOKS[entityType];
  if (!hook) {
    return {
      attempted: false,
      status: "skipped",
      entityType,
      entityId,
      reason: "No posting hook registered"
    };
  }

  try {
    const entity = await hook({ orgId, actorUserId, entityId });
    return {
      attempted: true,
      status: "success",
      entityType,
      entityId,
      entity
    };
  } catch (error) {
    if (!(error instanceof AppError)) {
      error.postingHookContext = { entityType, entityId };
    }
    return {
      attempted: true,
      status: "failed",
      entityType,
      entityId,
      error: normalizeError(error)
    };
  }
}

module.exports = {
  runApprovalPostingHook
};
