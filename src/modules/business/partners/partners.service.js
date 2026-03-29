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

async function getPartnerForOrg({ orgId, partnerId, client = pool }) {
  const { rows } = await client.query(
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

  return { partner, contacts, addresses, taxProfile: await getPartnerTaxProfile({ orgId, partnerId }) };
}

async function assertTaxCodeBelongsToOrg({ orgId, taxCodeId }) {
  if (!taxCodeId) return;
  const { rows } = await pool.query(`SELECT id FROM tax_codes WHERE organization_id=$1 AND id=$2`, [orgId, taxCodeId]);
  if (!rows.length) throw new AppError(400, 'tax code is invalid for this organization');
}

async function assertJurisdictionBelongsToOrg({ orgId, jurisdictionId }) {
  if (!jurisdictionId) return;
  const { rows } = await pool.query(`SELECT id FROM tax_jurisdictions WHERE organization_id=$1 AND id=$2`, [orgId, jurisdictionId]);
  if (!rows.length) throw new AppError(400, 'jurisdictionId is invalid for this organization');
}

async function getPartnerTaxProfile({ orgId, partnerId }) {
  await getPartnerForOrg({ orgId, partnerId });
  const { rows } = await pool.query(`SELECT * FROM tax_partner_profiles WHERE organization_id=$1 AND partner_id=$2`, [orgId, partnerId]);
  return rows[0] || null;
}

async function upsertPartnerTaxProfile({ orgId, partnerId, payload }) {
  await getPartnerForOrg({ orgId, partnerId });
  await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.defaultTaxCodeId || null });
  await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.purchaseTaxCodeId || null });
  await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.salesTaxCodeId || null });
  await assertTaxCodeBelongsToOrg({ orgId, taxCodeId: payload.withholdingTaxCodeId || null });
  await assertJurisdictionBelongsToOrg({ orgId, jurisdictionId: payload.jurisdictionId || null });

  const before = await getPartnerTaxProfile({ orgId, partnerId });
  const { rows } = await pool.query(`
    INSERT INTO tax_partner_profiles (
      organization_id, partner_id, tax_registration_no, legal_name, tax_class, default_tax_code_id, purchase_tax_code_id, sales_tax_code_id,
      jurisdiction_id, place_of_supply, is_tax_registered, is_tax_exempt, exemption_reason_code, exemption_reason, reverse_charge_applicable,
      withholding_applicable, withholding_tax_code_id, withholding_rate_override, recoverable_percent_override, certificate_reference, certificate_expiry,
      withholding_certificate_no, filing_contact_email, customer_tax_identifier_type, vendor_tax_identifier_type,
      input_tax_recovery_mode, destination_country_code, registration_status, e_invoice_network, e_invoice_endpoint,
      metadata
    ) VALUES (
      $1,$2,$3,$4,COALESCE($5,'standard'),$6,$7,$8,$9,$10,COALESCE($11,false),COALESCE($12,false),$13,$14,COALESCE($15,false),
      COALESCE($16,false),$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::jsonb
    )
    ON CONFLICT (organization_id, partner_id) DO UPDATE SET
      tax_registration_no=EXCLUDED.tax_registration_no,
      legal_name=EXCLUDED.legal_name,
      tax_class=EXCLUDED.tax_class,
      default_tax_code_id=EXCLUDED.default_tax_code_id,
      purchase_tax_code_id=EXCLUDED.purchase_tax_code_id,
      sales_tax_code_id=EXCLUDED.sales_tax_code_id,
      jurisdiction_id=EXCLUDED.jurisdiction_id,
      place_of_supply=EXCLUDED.place_of_supply,
      is_tax_registered=EXCLUDED.is_tax_registered,
      is_tax_exempt=EXCLUDED.is_tax_exempt,
      exemption_reason_code=EXCLUDED.exemption_reason_code,
      exemption_reason=EXCLUDED.exemption_reason,
      reverse_charge_applicable=EXCLUDED.reverse_charge_applicable,
      withholding_applicable=EXCLUDED.withholding_applicable,
      withholding_tax_code_id=EXCLUDED.withholding_tax_code_id,
      withholding_rate_override=EXCLUDED.withholding_rate_override,
      recoverable_percent_override=EXCLUDED.recoverable_percent_override,
      certificate_reference=EXCLUDED.certificate_reference,
      certificate_expiry=EXCLUDED.certificate_expiry,
      withholding_certificate_no=EXCLUDED.withholding_certificate_no,
      filing_contact_email=EXCLUDED.filing_contact_email,
      customer_tax_identifier_type=EXCLUDED.customer_tax_identifier_type,
      vendor_tax_identifier_type=EXCLUDED.vendor_tax_identifier_type,
      input_tax_recovery_mode=EXCLUDED.input_tax_recovery_mode,
      destination_country_code=EXCLUDED.destination_country_code,
      registration_status=EXCLUDED.registration_status,
      e_invoice_network=EXCLUDED.e_invoice_network,
      e_invoice_endpoint=EXCLUDED.e_invoice_endpoint,
      metadata=EXCLUDED.metadata,
      updated_at=NOW()
    RETURNING *
  `, [
    orgId, partnerId, payload.taxregistrationNumber || null, payload.legalName || null, payload.taxClass || null, payload.defaultTaxCodeId || null,
    payload.purchaseTaxCodeId || null, payload.salesTaxCodeId || null, payload.jurisdictionId || null, payload.placeOfSupply || null,
    payload.isTaxRegistered === true, payload.isTaxExempt === true, payload.exemptionReasonCode || null, payload.exemptionReason || null,
    payload.reverseChargeApplicable === true, payload.withholdingApplicable === true, payload.withholdingTaxCodeId || null,
    payload.withholdingRateOverride == null ? null : payload.withholdingRateOverride,
    payload.recoverablePercentOverride == null ? null : payload.recoverablePercentOverride, payload.certificateReference || null, payload.certificateExpiry || null,
    payload.withholdingCertificateNo || null, payload.filingContactEmail || null, payload.customerTaxIdentifierType || null, payload.vendorTaxIdentifierType || null,
    payload.inputTaxRecoveryMode || 'default', payload.destinationCountryCode || null, payload.registrationStatus || 'registered', payload.eInvoiceNetwork || null, payload.eInvoiceEndpoint || null,
    JSON.stringify(payload.metadata || {})
  ]);

  return { before, after: rows[0] };
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


/**
 * CREDIT POLICY (AR)
 */
async function getCreditPolicy({ orgId, partnerId }) {
  await getPartnerForOrg({ orgId, partnerId });
  const { rows } = await pool.query(
    `SELECT * FROM business_partner_credit_policies WHERE organization_id=$1 AND business_partner_id=$2`,
    [orgId, partnerId]
  );
  if (!rows.length) {
    // lazily create (backwards-compatible)
    const { rows: created } = await pool.query(
      `INSERT INTO business_partner_credit_policies(organization_id, business_partner_id)
       VALUES ($1,$2)
       ON CONFLICT (organization_id, business_partner_id) DO NOTHING
       RETURNING *`,
      [orgId, partnerId]
    );
    if (created.length) return created[0];
    const { rows: again } = await pool.query(
      `SELECT * FROM business_partner_credit_policies WHERE organization_id=$1 AND business_partner_id=$2`,
      [orgId, partnerId]
    );
    return again[0];
  }
  return rows[0];
}

async function setCreditPolicy({ orgId, partnerId, payload }) {
  await getPartnerForOrg({ orgId, partnerId });
  const current = await getCreditPolicy({ orgId, partnerId });

  const next = {
    credit_limit: payload.creditLimit ?? current.credit_limit,
    credit_days: payload.creditDays ?? current.credit_days,
    hold_if_over: payload.holdIfOver ?? current.hold_if_over,
    notes: payload.notes === undefined ? current.notes : payload.notes
  };

  const { rows } = await pool.query(
    `UPDATE business_partner_credit_policies
     SET credit_limit=$3, credit_days=$4, hold_if_over=$5, notes=$6, updated_at=NOW()
     WHERE organization_id=$1 AND business_partner_id=$2
     RETURNING *`,
    [orgId, partnerId, next.credit_limit, next.credit_days, next.hold_if_over, next.notes]
  );

  return { before: current, after: rows[0] };
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
  updateAddress,getPartnerTaxProfile,
  upsertPartnerTaxProfile,getCreditPolicy,
  setCreditPolicy,
};
