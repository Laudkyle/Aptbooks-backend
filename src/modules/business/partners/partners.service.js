const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

async function assertAccountBelongsToOrg({ orgId, accountId, fieldName }) {
  const { rows } = await pool.query(
    `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, `${fieldName} is invalid for this organization`);
}

async function assertPaymentTermsBelongsToOrg({ orgId, paymentTermsId }) {
  const { rows } = await pool.query(
    `SELECT id FROM payment_terms WHERE organization_id=$1 AND id=$2`,
    [orgId, paymentTermsId]
  );
  if (!rows.length) throw new AppError(400, "paymentTermsId is invalid for this organization");
}

async function getPartnerForOrg({ orgId, partnerId }) {
  const { rows } = await pool.query(
    `SELECT * FROM business_partners WHERE organization_id=$1 AND id=$2`,
    [orgId, partnerId]
  );
  if (!rows.length) throw new AppError(404, "Partner not found");
  return rows[0];
}

async function createPartner({ orgId, payload }) {
  if (payload.type === "customer" && payload.defaultPayableAccountId) {
    throw new AppError(400, "Customers cannot set defaultPayableAccountId");
  }
  if (payload.type === "vendor" && payload.defaultReceivableAccountId) {
    throw new AppError(400, "Vendors cannot set defaultReceivableAccountId");
  }

  if (payload.defaultReceivableAccountId) {
    await assertAccountBelongsToOrg({ orgId, accountId: payload.defaultReceivableAccountId, fieldName: "defaultReceivableAccountId" });
  }
  if (payload.defaultPayableAccountId) {
    await assertAccountBelongsToOrg({ orgId, accountId: payload.defaultPayableAccountId, fieldName: "defaultPayableAccountId" });
  }
  if (payload.paymentTermsId) {
    await assertPaymentTermsBelongsToOrg({ orgId, paymentTermsId: payload.paymentTermsId });
  }

  const { rows } = await pool.query(
    `
    INSERT INTO business_partners(
      organization_id, type, name, code, email, phone, status,
      default_receivable_account_id, default_payable_account_id, payment_terms_id, notes
    )
    VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'active'),$8,$9,$10,$11)
    RETURNING *
    `,
    [
      orgId,
      payload.type,
      payload.name,
      payload.code || null,
      payload.email || null,
      payload.phone || null,
      payload.status || null,
      payload.defaultReceivableAccountId || null,
      payload.defaultPayableAccountId || null,
      payload.paymentTermsId || null,
      payload.notes || null
    ]
  );

  return rows[0];
}

async function listPartners({ orgId, query }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;

  if (query?.type) { where.push(`type=$${i++}`); params.push(query.type); }
  if (query?.status) { where.push(`status=$${i++}`); params.push(query.status); }

  const { rows } = await pool.query(
    `SELECT * FROM business_partners WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
    params
  );

  return rows;
}

async function getPartnerDetails({ orgId, partnerId }) {
  const partner = await getPartnerForOrg({ orgId, partnerId });

  const { rows: contacts } = await pool.query(
    `SELECT * FROM business_partner_contacts
     WHERE organization_id=$1 AND partner_id=$2
     ORDER BY is_primary DESC, created_at ASC`,
    [orgId, partnerId]
  );

  const { rows: addresses } = await pool.query(
    `SELECT * FROM business_partner_addresses
     WHERE organization_id=$1 AND partner_id=$2
     ORDER BY is_primary DESC, created_at ASC`,
    [orgId, partnerId]
  );

  return { partner, contacts, addresses };
}

async function updatePartner({ orgId, partnerId, payload }) {
  const before = await getPartnerForOrg({ orgId, partnerId });

  const effectiveType = payload.type ?? before.type;
  const dr = payload.defaultReceivableAccountId ?? before.default_receivable_account_id;
  const dp = payload.defaultPayableAccountId ?? before.default_payable_account_id;
  const pt = payload.paymentTermsId ?? before.payment_terms_id;

  if (effectiveType === "customer" && dp) throw new AppError(400, "Customers cannot set defaultPayableAccountId");
  if (effectiveType === "vendor" && dr) throw new AppError(400, "Vendors cannot set defaultReceivableAccountId");

  if (dr) await assertAccountBelongsToOrg({ orgId, accountId: dr, fieldName: "defaultReceivableAccountId" });
  if (dp) await assertAccountBelongsToOrg({ orgId, accountId: dp, fieldName: "defaultPayableAccountId" });
  if (pt) await assertPaymentTermsBelongsToOrg({ orgId, paymentTermsId: pt });

  const columns = [];
  const params = [orgId, partnerId];
  let i = 3;

  const map = {
    type: "type",
    name: "name",
    code: "code",
    email: "email",
    phone: "phone",
    status: "status",
    defaultReceivableAccountId: "default_receivable_account_id",
    defaultPayableAccountId: "default_payable_account_id",
    paymentTermsId: "payment_terms_id",
    notes: "notes"
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      columns.push(`${col}=$${i++}`);
      params.push(payload[k] === "" ? null : payload[k]);
    }
  }

  if (!columns.length) return { before, after: before };

  const { rows } = await pool.query(
    `
    UPDATE business_partners
    SET ${columns.join(", ")}, updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    params
  );

  return { before, after: rows[0] };
}

/**
 * CONTACTS
 */
async function addContact({ orgId, partnerId, payload }) {
  await getPartnerForOrg({ orgId, partnerId });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (payload.isPrimary === true) {
      await client.query(
        `
        UPDATE business_partner_contacts
        SET is_primary=FALSE, updated_at=NOW()
        WHERE organization_id=$1 AND partner_id=$2 AND is_primary=TRUE
        `,
        [orgId, partnerId]
      );
    }

    const { rows } = await client.query(
      `
      INSERT INTO business_partner_contacts(
        organization_id, partner_id, name, email, phone, role, is_primary
      )
      VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,FALSE))
      RETURNING *
      `,
      [
        orgId,
        partnerId,
        payload.name,
        payload.email || null,
        payload.phone || null,
        payload.role || null,
        payload.isPrimary === true
      ]
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    // If two requests race to set primary, surface a clean 409
    if (e?.code === "23505") throw new AppError(409, "Primary contact already exists");
    throw e;
  } finally {
    client.release();
  }
}

async function updateContact({ orgId, partnerId, contactId, payload }) {
  await getPartnerForOrg({ orgId, partnerId });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: beforeRows } = await client.query(
      `
      SELECT * FROM business_partner_contacts
      WHERE organization_id=$1 AND partner_id=$2 AND id=$3
      `,
      [orgId, partnerId, contactId]
    );
    if (!beforeRows.length) throw new AppError(404, "Contact not found");
    const before = beforeRows[0];

    if (payload.isPrimary === true) {
      await client.query(
        `
        UPDATE business_partner_contacts
        SET is_primary=FALSE, updated_at=NOW()
        WHERE organization_id=$1 AND partner_id=$2 AND is_primary=TRUE
        `,
        [orgId, partnerId]
      );
    }

    const map = {
      name: "name",
      email: "email",
      phone: "phone",
      role: "role",
      isPrimary: "is_primary"
    };

    const columns = [];
    const params = [orgId, partnerId, contactId];
    let i = 4;

    for (const [k, col] of Object.entries(map)) {
      if (payload[k] !== undefined) {
        columns.push(`${col}=$${i++}`);
        params.push(payload[k] === "" ? null : payload[k]);
      }
    }

    if (!columns.length) {
      await client.query("COMMIT");
      return { before, after: before };
    }

    const { rows: afterRows } = await client.query(
      `
      UPDATE business_partner_contacts
      SET ${columns.join(", ")}, updated_at=NOW()
      WHERE organization_id=$1 AND partner_id=$2 AND id=$3
      RETURNING *
      `,
      params
    );

    await client.query("COMMIT");
    return { before, after: afterRows[0] };
  } catch (e) {
    await client.query("ROLLBACK");
    if (e?.code === "23505") throw new AppError(409, "Primary contact already exists");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * ADDRESSES
 */
async function addAddress({ orgId, partnerId, payload }) {
  await getPartnerForOrg({ orgId, partnerId });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (payload.isPrimary === true) {
      await client.query(
        `
        UPDATE business_partner_addresses
        SET is_primary=FALSE, updated_at=NOW()
        WHERE organization_id=$1 AND partner_id=$2 AND is_primary=TRUE
        `,
        [orgId, partnerId]
      );
    }

    const { rows } = await client.query(
      `
      INSERT INTO business_partner_addresses(
        organization_id, partner_id, label, line1, line2, city, region, postal_code, country, is_primary
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'Ghana'),COALESCE($10,FALSE))
      RETURNING *
      `,
      [
        orgId,
        partnerId,
        payload.label || null,
        payload.line1,
        payload.line2 || null,
        payload.city || null,
        payload.region || null,
        payload.postalCode || null,
        payload.country || null,
        payload.isPrimary === true
      ]
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    if (e?.code === "23505") throw new AppError(409, "Primary address already exists");
    throw e;
  } finally {
    client.release();
  }
}

async function updateAddress({ orgId, partnerId, addressId, payload }) {
  await getPartnerForOrg({ orgId, partnerId });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: beforeRows } = await client.query(
      `
      SELECT * FROM business_partner_addresses
      WHERE organization_id=$1 AND partner_id=$2 AND id=$3
      `,
      [orgId, partnerId, addressId]
    );
    if (!beforeRows.length) throw new AppError(404, "Address not found");
    const before = beforeRows[0];

    if (payload.isPrimary === true) {
      await client.query(
        `
        UPDATE business_partner_addresses
        SET is_primary=FALSE, updated_at=NOW()
        WHERE organization_id=$1 AND partner_id=$2 AND is_primary=TRUE
        `,
        [orgId, partnerId]
      );
    }

    const map = {
      label: "label",
      line1: "line1",
      line2: "line2",
      city: "city",
      region: "region",
      postalCode: "postal_code",
      country: "country",
      isPrimary: "is_primary"
    };

    const columns = [];
    const params = [orgId, partnerId, addressId];
    let i = 4;

    for (const [k, col] of Object.entries(map)) {
      if (payload[k] !== undefined) {
        columns.push(`${col}=$${i++}`);
        params.push(payload[k] === "" ? null : payload[k]);
      }
    }

    if (!columns.length) {
      await client.query("COMMIT");
      return { before, after: before };
    }

    const { rows: afterRows } = await client.query(
      `
      UPDATE business_partner_addresses
      SET ${columns.join(", ")}, updated_at=NOW()
      WHERE organization_id=$1 AND partner_id=$2 AND id=$3
      RETURNING *
      `,
      params
    );

    await client.query("COMMIT");
    return { before, after: afterRows[0] };
  } catch (e) {
    await client.query("ROLLBACK");
    if (e?.code === "23505") throw new AppError(409, "Primary address already exists");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  createPartner,
  listPartners,
  getPartnerForOrg,
  getPartnerDetails,
  updatePartner,
  addContact,
  updateContact,
  addAddress,
  updateAddress
};
