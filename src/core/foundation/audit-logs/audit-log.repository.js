const { pool } = require("../../../db/pool");

class AuditLogRepository {
  /**
   * Write an audit log entry
   * @param {Object} params
   * @param {string} params.organizationId - Organization ID
   * @param {string|null} params.actorUserId - User ID who performed the action
   * @param {string} params.action - Action type (CREATE, UPDATE, DELETE, LOGIN, etc.)
   * @param {string|null} params.entityType - Entity type (user, invoice, etc.)
   * @param {string|null} params.entityId - Entity ID
   * @param {string|null} params.ip - IP address
   * @param {string|null} params.userAgent - User agent string
   * @param {Object|null} params.before - State before change
   * @param {Object|null} params.after - State after change
   * @returns {Promise<void>}
   */
  async create({
    organizationId,
    actorUserId,
    action,
    entityType,
    entityId,
    ip,
    userAgent,
    before,
    after
  }) {
    const query = `
      INSERT INTO audit_logs (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        ip,
        user_agent,
        before_json,
        after_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, created_at
    `;

    const values = [
      organizationId,
      actorUserId || null,
      action,
      entityType || null,
      entityId || null,
      ip || null,
      userAgent || null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  /**
   * Find audit logs by organization with pagination
   * @param {string} organizationId - Organization ID
   * @param {Object} options - Query options
   * @param {number} options.limit - Number of records per page
   * @param {number} options.offset - Offset for pagination
   * @param {string|null} options.entityType - Filter by entity type
   * @param {string|null} options.action - Filter by action
   * @param {string|null} options.actorUserId - Filter by actor user ID
   * @param {Date|null} options.startDate - Filter from date
   * @param {Date|null} options.endDate - Filter to date
   * @param {string|null} options.search - Search in before/after JSON
   * @returns {Promise<{logs: Array, total: number}>}
   */
  async findByOrganization(organizationId, {
    limit = 50,
    offset = 0,
    entityType = null,
    action = null,
    actorUserId = null,
    startDate = null,
    endDate = null,
    search = null
  } = {}) {
    // Build WHERE clause
    const conditions = ["al.organization_id = $1"];
    const values = [organizationId];
    let paramIndex = 2;

    if (entityType) {
      conditions.push(`al.entity_type = $${paramIndex}`);
      values.push(entityType);
      paramIndex++;
    }

    if (action) {
      conditions.push(`al.action = $${paramIndex}`);
      values.push(action);
      paramIndex++;
    }

    if (actorUserId) {
      conditions.push(`al.actor_user_id = $${paramIndex}`);
      values.push(actorUserId);
      paramIndex++;
    }

    if (startDate) {
      conditions.push(`al.created_at >= $${paramIndex}`);
      values.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`al.created_at <= $${paramIndex}`);
      values.push(endDate);
      paramIndex++;
    }

    if (search) {
      conditions.push(`(
        al.before_json::text ILIKE $${paramIndex} OR
        al.after_json::text ILIKE $${paramIndex} OR
        al.action ILIKE $${paramIndex}
      )`);
      values.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM audit_logs al
      ${whereClause}
    `;

    const countResult = await pool.query(countQuery, values);
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results with user info
    const query = `
      SELECT 
        al.id,
        al.organization_id,
        al.actor_user_id,
        al.action,
        al.entity_type,
        al.entity_id,
        al.ip,
        al.user_agent,
        al.before_json,
        al.after_json,
        al.created_at,
        u.email as actor_email,
        u.full_name as actor_name
      FROM audit_logs al
      LEFT JOIN users u ON al.actor_user_id = u.id
      ${whereClause}
      ORDER BY al.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const paginatedValues = [...values, limit, offset];
    const result = await pool.query(query, paginatedValues);

    return {
      logs: result.rows.map(row => ({
        ...row,
        before: row.before_json ? JSON.parse(row.before_json) : null,
        after: row.after_json ? JSON.parse(row.after_json) : null
      })),
      total,
      limit,
      offset
    };
  }

  /**
   * Find audit logs for a specific entity
   * @param {string} organizationId - Organization ID
   * @param {string} entityType - Entity type
   * @param {string} entityId - Entity ID
   * @param {number} limit - Number of records to return
   * @returns {Promise<Array>}
   */
  async findByEntity(organizationId, entityType, entityId, limit = 100) {
    const query = `
      SELECT 
        al.id,
        al.actor_user_id,
        al.action,
        al.ip,
        al.user_agent,
        al.before_json,
        al.after_json,
        al.created_at,
        u.email as actor_email,
        u.full_name as actor_name
      FROM audit_logs al
      LEFT JOIN users u ON al.actor_user_id = u.id
      WHERE al.organization_id = $1
        AND al.entity_type = $2
        AND al.entity_id = $3
      ORDER BY al.created_at DESC
      LIMIT $4
    `;

    const result = await pool.query(query, [organizationId, entityType, entityId, limit]);

    return result.rows.map(row => ({
      ...row,
      before: row.before_json ? JSON.parse(row.before_json) : null,
      after: row.after_json ? JSON.parse(row.after_json) : null
    }));
  }

  /**
   * Get audit log by ID
   * @param {string} organizationId - Organization ID
   * @param {string} auditLogId - Audit log ID
   * @returns {Promise<Object|null>}
   */
  async findById(organizationId, auditLogId) {
    const query = `
      SELECT 
        al.*,
        u.email as actor_email,
        u.full_name as actor_name
      FROM audit_logs al
      LEFT JOIN users u ON al.actor_user_id = u.id
      WHERE al.organization_id = $1 AND al.id = $2
    `;

    const result = await pool.query(query, [organizationId, auditLogId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      ...row,
      before: row.before_json ? JSON.parse(row.before_json) : null,
      after: row.after_json ? JSON.parse(row.after_json) : null
    };
  }

  /**
   * Get audit statistics for dashboard
   * @param {string} organizationId - Organization ID
   * @param {Date} startDate - Start date for statistics
   * @param {Date} endDate - End date for statistics
   * @returns {Promise<Object>}
   */
  async getStatistics(organizationId, startDate, endDate) {
    const query = `
      SELECT 
        COUNT(*) as total_actions,
        COUNT(DISTINCT actor_user_id) as unique_users,
        entity_type,
        action,
        COUNT(*) as count,
        DATE(created_at) as date
      FROM audit_logs
      WHERE organization_id = $1
        AND created_at BETWEEN $2 AND $3
      GROUP BY entity_type, action, DATE(created_at)
      ORDER BY DATE(created_at) DESC, count DESC
    `;

    const result = await pool.query(query, [organizationId, startDate, endDate]);

    return {
      totalActions: result.rows.reduce((sum, row) => sum + parseInt(row.count, 10), 0),
      uniqueUsers: result.rows.length > 0 ? parseInt(result.rows[0].unique_users, 10) : 0,
      breakdownByEntity: result.rows.reduce((acc, row) => {
        if (!acc[row.entity_type]) acc[row.entity_type] = 0;
        acc[row.entity_type] += parseInt(row.count, 10);
        return acc;
      }, {}),
      breakdownByAction: result.rows.reduce((acc, row) => {
        if (!acc[row.action]) acc[row.action] = 0;
        acc[row.action] += parseInt(row.count, 10);
        return acc;
      }, {}),
      dailyActivity: result.rows.reduce((acc, row) => {
        if (!acc[row.date]) acc[row.date] = 0;
        acc[row.date] += parseInt(row.count, 10);
        return acc;
      }, {}),
      rawData: result.rows
    };
  }

  /**
   * Clean up old audit logs (retention policy)
   * @param {string} organizationId - Organization ID
   * @param {Date} olderThan - Delete logs older than this date
   * @returns {Promise<number>} - Number of deleted records
   */
  async cleanupOldLogs(organizationId, olderThan) {
    const query = `
      DELETE FROM audit_logs
      WHERE organization_id = $1
        AND created_at < $2
      RETURNING id
    `;

    const result = await pool.query(query, [organizationId, olderThan]);
    return result.rowCount;
  }

  /**
   * Export audit logs to JSON or CSV format
   * @param {string} organizationId - Organization ID
   * @param {Object} options - Export options
   * @param {Date} options.startDate - Start date
   * @param {Date} options.endDate - End date
   * @param {string} options.format - 'json' or 'csv'
   * @returns {Promise<Array|string>}
   */
  async exportLogs(organizationId, { startDate, endDate, format = 'json' }) {
    const query = `
      SELECT 
        al.id,
        al.actor_user_id,
        u.email as actor_email,
        al.action,
        al.entity_type,
        al.entity_id,
        al.ip,
        al.user_agent,
        al.before_json,
        al.after_json,
        al.created_at
      FROM audit_logs al
      LEFT JOIN users u ON al.actor_user_id = u.id
      WHERE al.organization_id = $1
        AND ($2::timestamp IS NULL OR al.created_at >= $2)
        AND ($3::timestamp IS NULL OR al.created_at <= $3)
      ORDER BY al.created_at DESC
    `;

    const result = await pool.query(query, [organizationId, startDate, endDate]);
    
    const logs = result.rows.map(row => ({
      ...row,
      before: row.before_json ? JSON.parse(row.before_json) : null,
      after: row.after_json ? JSON.parse(row.after_json) : null
    }));

    if (format === 'csv') {
      // Convert to CSV format
      const headers = ['ID', 'Date', 'Action', 'Entity Type', 'Entity ID', 'Actor', 'IP', 'User Agent'];
      const csvRows = [
        headers.join(','),
        ...logs.map(log => [
          log.id,
          log.created_at,
          log.action,
          log.entity_type,
          log.entity_id,
          log.actor_email,
          log.ip,
          `"${log.user_agent || ''}"`
        ].join(','))
      ];
      return csvRows.join('\n');
    }

    return logs;
  }
}

module.exports = new AuditLogRepository();