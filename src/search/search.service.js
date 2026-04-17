const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

function normalizeQ(q) {
  const s = String(q || "").trim();
  if (s.length < 2) throw new AppError(400, "q must be at least 2 characters");
  if (s.length > 100) throw new AppError(400, "q too long");
  return s;
}

async function globalSearch({ orgId, q, limitPerType = 10 }) {
  const query = normalizeQ(q);
  const like = `%${query}%`;
  const lim = Math.min(Number(limitPerType || 10), 25);

  const results = {};

  // Business partners (customers/vendors)
  {
    const { rows } = await pool.query(
      `
      SELECT id, type, code, name, status
      FROM business_partners
      WHERE organization_id=$1
        AND (name ILIKE $2 OR code ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)
      ORDER BY name
      LIMIT ${lim}
      `,
      [orgId, like]
    );
    results.partners = rows.map((r) => ({
      type: "partner",
      id: r.id,
      label: r.name,
      meta: { partnerType: r.type, code: r.code, status: r.status }
    }));
  }

  // Chart of accounts
  {
    const { rows } = await pool.query(
      `
      SELECT id, code, name, status
      FROM chart_of_accounts
      WHERE organization_id=$1
        AND (code ILIKE $2 OR name ILIKE $2)
      ORDER BY code
      LIMIT ${lim}
      `,
      [orgId, like]
    );
    results.accounts = rows.map((r) => ({
      type: "account",
      id: r.id,
      label: `${r.code} - ${r.name}`,
      meta: { code: r.code, status: r.status }
    }));
  }

  // Journal entries
  {
    const { rows } = await pool.query(
      `
      SELECT id, entry_no, entry_date, status, memo
      FROM journal_entries
      WHERE organization_id=$1
        AND (
          CAST(entry_no AS TEXT) ILIKE $2
          OR memo ILIKE $2
        )
      ORDER BY entry_date DESC, entry_no DESC
      LIMIT ${lim}
      `,
      [orgId, like]
    );
    results.journals = rows.map((r) => ({
      type: "journal",
      id: r.id,
      label: `JE #${r.entry_no} (${r.status})`,
      meta: { entryNo: r.entry_no, entryDate: r.entry_date, memo: r.memo }
    }));
  }

  // Documents & workflow
  {
    const { rows } = await pool.query(
      `
      SELECT d.id, d.title, d.entity_type, d.entity_id, d.entity_ref, d.workflow_state_code, d.updated_at
      FROM documents d
      WHERE d.organization_id=$1
        AND (d.title ILIKE $2 OR COALESCE(d.entity_ref,'') ILIKE $2 OR d.entity_type ILIKE $2)
      ORDER BY d.updated_at DESC
      LIMIT ${lim}
      `,
      [orgId, like]
    );
    results.documents = rows.map((r) => ({
      type: "document",
      id: r.id,
      label: r.title,
      meta: {
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityRef: r.entity_ref,
        workflowState: r.workflow_state_code,
        updatedAt: r.updated_at
      }
    }));
  }

  return { query, results };
}

module.exports = { globalSearch };
