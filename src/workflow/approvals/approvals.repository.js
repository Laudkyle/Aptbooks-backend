const { pool } = require("../../db/pool");

/**
 * Unified approvals inbox.
 *
 * Returns *pending* approval requests across the whole system (not only Tier 10 documents).
 *
 * Backwards compatible: keeps the existing document_* columns.
 */
async function listInbox({ orgId, limit = 50, offset = 0, documentTypeId = null, state = null }) {
  const params = [orgId];

  // Check if documentTypeId is valid (not null, undefined, or "undefined" string)
  const hasValidDocumentTypeId = documentTypeId && documentTypeId !== 'undefined' && documentTypeId !== 'null';
  
  // For document workflow rows (Tier 10), apply filters only if documentTypeId is valid
  let docWhere = "WHERE d.organization_id=$1 AND da.status='PENDING'";
  
  // Only add document_type_id filter if documentTypeId is valid
  if (hasValidDocumentTypeId) {
    params.push(documentTypeId);
    docWhere += ` AND d.document_type_id=$${params.length}`;
  }
  
  // Only add workflow_state filter if state is provided
  if (state) {
    params.push(state);
    docWhere += ` AND d.workflow_state_code=$${params.length}`;
  }

  // Paging is applied after the union.
  params.push(limit);
  params.push(offset);
  const limitParam = `$${params.length - 1}`;
  const offsetParam = `$${params.length}`;

  const { rows } = await pool.query(
    `
    WITH unified AS (
      -- ---------------------------------------------------------------
      -- Tier 10 Documents approvals (existing behaviour)
      -- ---------------------------------------------------------------
      SELECT
        'documents'::text AS source,
        da.id AS approval_id,
        d.id AS document_id,
        d.entity_type,
        d.entity_id,
        d.title,
        d.document_type_id,
        dt.code AS document_type_code,
        dt.name AS document_type_name,
        d.workflow_state_code,
        da.sequence,
        da.approval_level_id,
        al.code AS approval_level_code,
        al.name AS approval_level_name,
        da.status AS approval_status,
        NULL::timestamptz AS submitted_at,
        d.created_at,
        d.updated_at,
        d.created_by AS requested_by_user_id,
        u.full_name AS requested_by_name,
        jsonb_build_object('kind','document') AS meta
      FROM document_approvals da
      JOIN documents d ON d.id = da.document_id
      JOIN document_types dt ON dt.id = d.document_type_id
      JOIN approval_levels al ON al.id = da.approval_level_id
      LEFT JOIN users u ON u.id = d.created_by
      ${docWhere}

      UNION ALL

      -- ---------------------------------------------------------------
      -- Journals
      -- ---------------------------------------------------------------
      SELECT
        'journals'::text AS source,
        NULL::uuid AS approval_id,
        NULL::uuid AS document_id,
        'journal_entries'::text AS entity_type,
        j.id AS entity_id,
        COALESCE('Journal #' || j.entry_no::text, 'Journal') AS title,
        NULL::uuid AS document_type_id,
        NULL::text AS document_type_code,
        NULL::text AS document_type_name,
        j.status::text AS workflow_state_code,
        1::int AS sequence,
        NULL::uuid AS approval_level_id,
        'DEFAULT'::text AS approval_level_code,
        'Default'::text AS approval_level_name,
        'PENDING'::text AS approval_status,
        j.submitted_at AS submitted_at,
        j.created_at,
        j.updated_at,
        j.submitted_by AS requested_by_user_id,
        u.full_name AS requested_by_name,
        jsonb_build_object('kind','journal','entry_no', j.entry_no, 'entry_date', j.entry_date, 'memo', j.memo) AS meta
      FROM journal_entries j
      LEFT JOIN users u ON u.id = j.submitted_by
      WHERE j.organization_id=$1 AND j.status='submitted'

      UNION ALL

      -- ---------------------------------------------------------------
      -- AR Write-offs
      -- ---------------------------------------------------------------
      SELECT
        'writeoffs'::text AS source,
        NULL::uuid AS approval_id,
        NULL::uuid AS document_id,
        'writeoffs'::text AS entity_type,
        w.id AS entity_id,
        'Write-off'::text AS title,
        NULL::uuid AS document_type_id,
        NULL::text AS document_type_code,
        NULL::text AS document_type_name,
        w.status::text AS workflow_state_code,
        1::int AS sequence,
        NULL::uuid AS approval_level_id,
        'DEFAULT'::text AS approval_level_code,
        'Default'::text AS approval_level_name,
        'PENDING'::text AS approval_status,
        wa.created_at AS submitted_at,
        w.created_at,
        w.updated_at,
        wa.actor_user_id AS requested_by_user_id,
        u.full_name AS requested_by_name,
        jsonb_build_object('kind','writeoff','entity_type', w.entity_type, 'entity_id', w.entity_id, 'partner_id', w.partner_id, 'amount', w.amount, 'notes', w.notes) AS meta
      FROM writeoffs w
      LEFT JOIN LATERAL (
        SELECT actor_user_id, created_at
        FROM writeoff_actions
        WHERE writeoff_id = w.id AND action_type='submitted'
        ORDER BY created_at DESC
        LIMIT 1
      ) wa ON TRUE
      LEFT JOIN users u ON u.id = wa.actor_user_id
      WHERE w.organization_id=$1 AND w.status='submitted'

      UNION ALL

      -- ---------------------------------------------------------------
      -- Inventory Stock Counts
      -- ---------------------------------------------------------------
      SELECT
        'stock_counts'::text AS source,
        NULL::uuid AS approval_id,
        NULL::uuid AS document_id,
        'inventory_stock_counts'::text AS entity_type,
        sc.id AS entity_id,
        COALESCE(sc.reference, 'Stock Count') AS title,
        NULL::uuid AS document_type_id,
        NULL::text AS document_type_code,
        NULL::text AS document_type_name,
        sc.status::text AS workflow_state_code,
        1::int AS sequence,
        NULL::uuid AS approval_level_id,
        'DEFAULT'::text AS approval_level_code,
        'Default'::text AS approval_level_name,
        'PENDING'::text AS approval_status,
        sc.submitted_at AS submitted_at,
        sc.created_at,
        sc.updated_at,
        sc.submitted_by AS requested_by_user_id,
        u.full_name AS requested_by_name,
        jsonb_build_object('kind','stock_count','warehouse_id', sc.warehouse_id, 'count_date', sc.count_date, 'memo', sc.memo) AS meta
      FROM inventory_stock_counts sc
      LEFT JOIN users u ON u.id = sc.submitted_by
      WHERE sc.organization_id=$1 AND sc.status='submitted'

      UNION ALL

      -- ---------------------------------------------------------------
      -- HR Leave Requests
      -- ---------------------------------------------------------------
      SELECT
        'leave_requests'::text AS source,
        NULL::uuid AS approval_id,
        NULL::uuid AS document_id,
        'hr_leave_requests'::text AS entity_type,
        lr.id AS entity_id,
        'Leave Request'::text AS title,
        NULL::uuid AS document_type_id,
        NULL::text AS document_type_code,
        NULL::text AS document_type_name,
        lr.status::text AS workflow_state_code,
        1::int AS sequence,
        NULL::uuid AS approval_level_id,
        'DEFAULT'::text AS approval_level_code,
        'Default'::text AS approval_level_name,
        'PENDING'::text AS approval_status,
        COALESCE(lr.updated_at, lr.created_at) AS submitted_at,
        lr.created_at,
        COALESCE(lr.updated_at, lr.created_at) AS updated_at,
        lr.created_by_user_id AS requested_by_user_id,
        u.full_name AS requested_by_name,
        jsonb_build_object('kind','leave_request','employee_id', lr.employee_id, 'leave_type_id', lr.leave_type_id, 'start_date', lr.start_date, 'end_date', lr.end_date, 'days', lr.days) AS meta
      FROM hr_leave_requests lr
      LEFT JOIN users u ON u.id = lr.created_by_user_id
      WHERE lr.organization_id=$1 AND lr.status='submitted'

      UNION ALL

      -- ---------------------------------------------------------------
      -- Budget versions
      -- ---------------------------------------------------------------
      SELECT
        'budget_versions'::text AS source,
        NULL::uuid AS approval_id,
        NULL::uuid AS document_id,
        'budget_versions'::text AS entity_type,
        bv.id AS entity_id,
        COALESCE(b.name || ' — ' || COALESCE(bv.name, 'v' || bv.version_no::text), b.name, 'Budget Version') AS title,
        NULL::uuid AS document_type_id,
        NULL::text AS document_type_code,
        NULL::text AS document_type_name,
        bv.workflow_status::text AS workflow_state_code,
        1::int AS sequence,
        NULL::uuid AS approval_level_id,
        'DEFAULT'::text AS approval_level_code,
        'Default'::text AS approval_level_name,
        'PENDING'::text AS approval_status,
        bv.submitted_at AS submitted_at,
        bv.created_at,
        bv.updated_at,
        bv.submitted_by_user_id AS requested_by_user_id,
        u.full_name AS requested_by_name,
        jsonb_build_object('kind','budget_version','budget_id', bv.budget_id, 'version_no', bv.version_no, 'scenario_key', bv.scenario_key) AS meta
      FROM budget_versions bv
      JOIN budgets b ON b.id = bv.budget_id
      LEFT JOIN users u ON u.id = bv.submitted_by_user_id
      WHERE bv.organization_id=$1 AND bv.workflow_status='in_review'

      UNION ALL

      -- ---------------------------------------------------------------
      -- Forecast versions
      -- ---------------------------------------------------------------
      SELECT
        'forecast_versions'::text AS source,
        NULL::uuid AS approval_id,
        NULL::uuid AS document_id,
        'forecast_versions'::text AS entity_type,
        fv.id AS entity_id,
        COALESCE(f.name || ' — ' || COALESCE(fv.name, 'v' || fv.version_no::text), f.name, 'Forecast Version') AS title,
        NULL::uuid AS document_type_id,
        NULL::text AS document_type_code,
        NULL::text AS document_type_name,
        fv.workflow_status::text AS workflow_state_code,
        1::int AS sequence,
        NULL::uuid AS approval_level_id,
        'DEFAULT'::text AS approval_level_code,
        'Default'::text AS approval_level_name,
        'PENDING'::text AS approval_status,
        fv.submitted_at AS submitted_at,
        fv.created_at,
        fv.updated_at,
        fv.submitted_by_user_id AS requested_by_user_id,
        u.full_name AS requested_by_name,
        jsonb_build_object('kind','forecast_version','forecast_id', fv.forecast_id, 'version_no', fv.version_no, 'scenario_key', fv.scenario_id, 'probability_weight', fv.probability_weight) AS meta
      FROM forecast_versions fv
      JOIN forecasts f ON f.id = fv.forecast_id
      LEFT JOIN users u ON u.id = fv.submitted_by_user_id
      WHERE fv.organization_id=$1 AND fv.workflow_status='in_review'
    )
    SELECT *
    FROM unified
    ORDER BY COALESCE(submitted_at, updated_at, created_at) DESC, source ASC
    LIMIT ${limitParam} OFFSET ${offsetParam}
    `,
    params
  );

  return rows;
}

module.exports = { listInbox };