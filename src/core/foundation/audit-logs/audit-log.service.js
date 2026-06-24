const auditLogRepository = require('./audit-log.repository');

function getDateRange(period) {
  const endDate = new Date();
  const startDate = new Date(endDate);
  switch (period) {
    case 'day':
      startDate.setDate(endDate.getDate() - 1);
      break;
    case 'week':
      startDate.setDate(endDate.getDate() - 7);
      break;
    case 'year':
      startDate.setFullYear(endDate.getFullYear() - 1);
      break;
    case 'month':
    default:
      startDate.setMonth(endDate.getMonth() - 1);
      break;
  }
  return { startDate, endDate };
}

async function getAuditLogs(organizationId, filters = {}, page = 1, limit = 50) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const offset = (safePage - 1) * safeLimit;
  const result = await auditLogRepository.findByOrganization(organizationId, {
    ...filters,
    limit: safeLimit,
    offset
  });
  const totalPages = Math.ceil(result.total / safeLimit) || 1;
  return {
    logs: result.logs,
    page: safePage,
    limit: safeLimit,
    total: result.total,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPrevPage: safePage > 1
  };
}

async function getEntityAuditTrail(organizationId, entityType, entityId) {
  return auditLogRepository.findByEntity(organizationId, entityType, entityId);
}

async function getAuditStatistics(organizationId, period = 'month') {
  const { startDate, endDate } = getDateRange(period);
  return auditLogRepository.getStatistics(organizationId, startDate, endDate);
}

async function exportAuditLogs(organizationId, options = {}) {
  return auditLogRepository.exportLogs(organizationId, options);
}

async function applyRetentionPolicy(organizationId, retentionDays = 365) {
  const olderThan = new Date();
  olderThan.setDate(olderThan.getDate() - Math.max(1, Number(retentionDays) || 365));
  return auditLogRepository.cleanupOldLogs(organizationId, olderThan);
}

module.exports = {
  getAuditLogs,
  getEntityAuditTrail,
  getAuditStatistics,
  exportAuditLogs,
  applyRetentionPolicy
};
