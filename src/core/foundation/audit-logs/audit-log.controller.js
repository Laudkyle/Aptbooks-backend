const auditLogService = require('./audit-log.service');

class AuditLogController {
  /**
   * Get audit logs (for admin/reporting interface)
   */
  async getAuditLogs(req, res, next) {
    try {
      const { organizationId } = req.organization; // From auth middleware
      const {
        page = 1,
        limit = 50,
        entityType,
        action,
        actorUserId,
        startDate,
        endDate,
        search
      } = req.query;

      const filters = {
        entityType: entityType || null,
        action: action || null,
        actorUserId: actorUserId || null,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        search: search || null
      };

      const result = await auditLogService.getAuditLogs(
        organizationId,
        filters,
        parseInt(page, 10),
        parseInt(limit, 10)
      );

      res.json({
        success: true,
        data: result.logs,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages,
          hasNextPage: result.hasNextPage,
          hasPrevPage: result.hasPrevPage
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get audit trail for a specific entity
   */
  async getEntityAuditTrail(req, res, next) {
    try {
      const { organizationId } = req.organization;
      const { entityType, entityId } = req.params;

      const auditTrail = await auditLogService.getEntityAuditTrail(
        organizationId,
        entityType,
        entityId
      );

      res.json({
        success: true,
        data: auditTrail
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get audit statistics
   */
  async getAuditStatistics(req, res, next) {
    try {
      const { organizationId } = req.organization;
      const { period = 'month' } = req.query;

      const statistics = await auditLogService.getAuditStatistics(
        organizationId,
        period
      );

      res.json({
        success: true,
        data: statistics
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Export audit logs
   */
  async exportAuditLogs(req, res, next) {
    try {
      const { organizationId } = req.organization;
      const {
        startDate,
        endDate,
        format = 'json'
      } = req.query;

      const exportData = await auditLogService.exportAuditLogs(organizationId, {
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        format
      });

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.csv"`);
        return res.send(exportData);
      }

      res.json({
        success: true,
        data: exportData
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Apply retention policy (admin only)
   */
  async applyRetentionPolicy(req, res, next) {
    try {
      const { organizationId } = req.organization;
      const { retentionDays = 365 } = req.body;

      const deletedCount = await auditLogService.applyRetentionPolicy(
        organizationId,
        parseInt(retentionDays, 10)
      );

      res.json({
        success: true,
        message: `Successfully cleaned up ${deletedCount} old audit logs`,
        data: { deletedCount }
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuditLogController();