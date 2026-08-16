const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const { encryptSecret } = require('../../../shared/security/secrets');
const {
  payloadHash,
  sumMoney,
  percentageRate,
  validateFiscalPayload,
  nextRetryAt,
  offlineDeadline
} = require('./fiscalization.kernel');
const { submitToGraEvat } = require('./graEvat.adapter');

function dbOrPool(db) { return db || pool; }
function asAddress(value = {}) {
  if (!value) return null;
  const parts = [value.line1 || value.addressLine1, value.line2 || value.addressLine2, value.city, value.region, value.postalCode, value.country]
    .filter(Boolean).map((x) => String(x).trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
function asIso(value) { return value ? new Date(value).toISOString() : new Date().toISOString(); }
function sourceDocumentType(sourceType) {
  return ({ invoice: 'tax_invoice', pos_sale: 'sales_receipt', credit_note: 'credit_note', debit_note: 'debit_note', pos_return: 'refund_receipt' })[sourceType];
}

async function logFiscal({ db, orgId, documentId = null, queueId = null, eventCode, severity = 'info', actorUserId = null, deviceId = null, details = {} }) {
  const q = dbOrPool(db);
  await q.query(
    `INSERT INTO fiscal_system_logs(organization_id,fiscal_document_id,queue_id,event_code,severity,actor_user_id,device_id,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [orgId, documentId, queueId, eventCode, severity, actorUserId, deviceId, JSON.stringify(details || {})]
  );
}

async function getSettings({ orgId, db = null }) {
  const q = dbOrPool(db);
  const { rows } = await q.query(
    `SELECT organization_id,country_code,enabled,adapter_code,adapter_mode,onboarding_status,gra_go_live_date,
            api_endpoint,api_contract_version,auto_prepare_invoices,auto_prepare_pos,auto_queue,offline_window_hours,
            require_customer_tax_id_for_input_credit,metadata,created_at,updated_at,
            (api_key_encrypted IS NOT NULL AND api_key_encrypted <> '') AS has_api_key,
            (api_secret_encrypted IS NOT NULL AND api_secret_encrypted <> '') AS has_api_secret
       FROM fiscalization_settings WHERE organization_id=$1`, [orgId]
  );
  return rows[0] || {
    organization_id: orgId,
    country_code: 'GH', enabled: false, adapter_code: 'GRA_EVAT_SIM', adapter_mode: 'simulation',
    onboarding_status: 'not_requested', auto_prepare_invoices: true, auto_prepare_pos: true,
    auto_queue: false, offline_window_hours: 24, require_customer_tax_id_for_input_credit: true,
    has_api_key: false, has_api_secret: false, metadata: {}
  };
}

async function getSettingsRaw({ orgId, db = null }) {
  const q = dbOrPool(db);
  const { rows } = await q.query(`SELECT * FROM fiscalization_settings WHERE organization_id=$1`, [orgId]);
  return rows[0] || null;
}

async function saveSettings({ orgId, actorUserId, payload = {} }) {
  const existing = await getSettingsRaw({ orgId });
  const mode = payload.adapterMode || payload.adapter_mode || existing?.adapter_mode || 'simulation';
  const onboarding = payload.onboardingStatus || payload.onboarding_status || existing?.onboarding_status || 'not_requested';
  const endpoint = payload.apiEndpoint !== undefined ? payload.apiEndpoint : (payload.api_endpoint !== undefined ? payload.api_endpoint : existing?.api_endpoint || null);
  const contractVersion = payload.apiContractVersion || payload.api_contract_version || existing?.api_contract_version || null;
  if (mode === 'live') {
    if (!['signed_off','live'].includes(onboarding)) throw new AppError(400, 'Live mode requires GRA signed_off/live onboarding status');
    if (!contractVersion) throw new AppError(400, 'apiContractVersion is required for live mode');
    if (!endpoint || !/^https:\/\//i.test(String(endpoint))) throw new AppError(400, 'Live GRA API endpoint must use HTTPS');
  }
  const apiKey = payload.apiKey !== undefined
    ? (payload.apiKey ? encryptSecret(payload.apiKey, { context: `gra-evat:${orgId}:api-key` }) : null)
    : existing?.api_key_encrypted || null;
  const apiSecret = payload.apiSecret !== undefined
    ? (payload.apiSecret ? encryptSecret(payload.apiSecret, { context: `gra-evat:${orgId}:api-secret` }) : null)
    : existing?.api_secret_encrypted || null;

  const { rows } = await pool.query(
    `INSERT INTO fiscalization_settings(
       organization_id,country_code,enabled,adapter_code,adapter_mode,onboarding_status,gra_go_live_date,api_endpoint,
       api_key_encrypted,api_secret_encrypted,api_contract_version,auto_prepare_invoices,auto_prepare_pos,auto_queue,
       offline_window_hours,require_customer_tax_id_for_input_credit,metadata,created_by,updated_by)
     VALUES($1,'GH',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$17)
     ON CONFLICT(organization_id) DO UPDATE SET
       enabled=EXCLUDED.enabled,adapter_code=EXCLUDED.adapter_code,adapter_mode=EXCLUDED.adapter_mode,
       onboarding_status=EXCLUDED.onboarding_status,gra_go_live_date=EXCLUDED.gra_go_live_date,api_endpoint=EXCLUDED.api_endpoint,
       api_key_encrypted=EXCLUDED.api_key_encrypted,api_secret_encrypted=EXCLUDED.api_secret_encrypted,
       api_contract_version=EXCLUDED.api_contract_version,auto_prepare_invoices=EXCLUDED.auto_prepare_invoices,
       auto_prepare_pos=EXCLUDED.auto_prepare_pos,auto_queue=EXCLUDED.auto_queue,offline_window_hours=EXCLUDED.offline_window_hours,
       require_customer_tax_id_for_input_credit=EXCLUDED.require_customer_tax_id_for_input_credit,metadata=EXCLUDED.metadata,
       updated_by=EXCLUDED.updated_by,updated_at=NOW()
     RETURNING organization_id`,
    [orgId, payload.enabled !== undefined ? !!payload.enabled : !!existing?.enabled, payload.adapterCode || payload.adapter_code || existing?.adapter_code || 'GRA_EVAT_SIM', mode, onboarding,
      payload.graGoLiveDate || payload.gra_go_live_date || existing?.gra_go_live_date || null, endpoint, apiKey, apiSecret,
      contractVersion,
      payload.autoPrepareInvoices !== undefined ? !!payload.autoPrepareInvoices : (existing?.auto_prepare_invoices ?? true), payload.autoPreparePos !== undefined ? !!payload.autoPreparePos : (existing?.auto_prepare_pos ?? true), payload.autoQueue !== undefined ? !!payload.autoQueue : !!existing?.auto_queue,
      Math.max(1, Math.min(24, Number(payload.offlineWindowHours ?? existing?.offline_window_hours ?? 24))), payload.requireCustomerTaxIdForInputCredit !== undefined ? !!payload.requireCustomerTaxIdForInputCredit : (existing?.require_customer_tax_id_for_input_credit ?? true),
      JSON.stringify(payload.metadata || existing?.metadata || {}), actorUserId || null]
  );
  await logFiscal({ orgId, eventCode: 'fiscal.settings.updated', actorUserId, details: { adapterMode: mode, onboardingStatus: onboarding, enabled: payload.enabled !== undefined ? !!payload.enabled : !!existing?.enabled } });
  return getSettings({ orgId });
}

async function listLocations({ orgId }) {
  const { rows } = await pool.query(`SELECT * FROM fiscal_locations WHERE organization_id=$1 ORDER BY code`, [orgId]);
  return rows;
}
async function saveLocation({ orgId, payload = {} }) {
  if (!payload.code || !payload.name) throw new AppError(400, 'code and name are required');
  const { rows } = await pool.query(
    `INSERT INTO fiscal_locations(organization_id,code,name,store_id,address_json,gra_branch_reference,status)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
     ON CONFLICT(organization_id,code) DO UPDATE SET name=EXCLUDED.name,store_id=EXCLUDED.store_id,address_json=EXCLUDED.address_json,
       gra_branch_reference=EXCLUDED.gra_branch_reference,status=EXCLUDED.status,updated_at=NOW() RETURNING *`,
    [orgId, payload.code, payload.name, payload.storeId || null, JSON.stringify(payload.address || {}), payload.graBranchReference || null, payload.status || 'active']
  );
  return rows[0];
}
async function listDevices({ orgId }) {
  const { rows } = await pool.query(
    `SELECT d.*,l.code AS location_code,l.name AS location_name,r.code AS register_code,r.name AS register_name
       FROM fiscal_devices d LEFT JOIN fiscal_locations l ON l.id=d.fiscal_location_id
       LEFT JOIN pos_registers r ON r.id=d.register_id
      WHERE d.organization_id=$1 ORDER BY d.device_code`, [orgId]
  );
  return rows;
}
async function saveDevice({ orgId, payload = {} }) {
  if (!payload.deviceCode) throw new AppError(400, 'deviceCode is required');
  const { rows } = await pool.query(
    `INSERT INTO fiscal_devices(organization_id,fiscal_location_id,store_id,register_id,pos_device_id,device_code,device_name,machine_registration_code,verification_engine_id,device_serial_number,status,certified_at,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11 IN ('certified','active') THEN NOW() ELSE NULL END,$12::jsonb)
     ON CONFLICT(organization_id,device_code) DO UPDATE SET fiscal_location_id=EXCLUDED.fiscal_location_id,store_id=EXCLUDED.store_id,
       register_id=EXCLUDED.register_id,pos_device_id=EXCLUDED.pos_device_id,device_name=EXCLUDED.device_name,
       machine_registration_code=EXCLUDED.machine_registration_code,verification_engine_id=EXCLUDED.verification_engine_id,
       device_serial_number=EXCLUDED.device_serial_number,status=EXCLUDED.status,
       certified_at=COALESCE(fiscal_devices.certified_at,EXCLUDED.certified_at),metadata=EXCLUDED.metadata,updated_at=NOW() RETURNING *`,
    [orgId, payload.fiscalLocationId || null, payload.storeId || null, payload.registerId || null, payload.posDeviceId || null,
      payload.deviceCode, payload.deviceName || null, payload.machineRegistrationCode || null, payload.verificationEngineId || null,
      payload.deviceSerialNumber || null, payload.status || 'pending', JSON.stringify(payload.metadata || {})]
  );
  return rows[0];
}

async function loadSeller(db, orgId) {
  const { rows } = await db.query(
    `SELECT o.id,o.name,o.contact_email,o.contact_phone,o.address_json,
            tr.registration_no,tr.legal_entity_name
       FROM organizations o
       LEFT JOIN LATERAL (
         SELECT registration_no,legal_entity_name FROM tax_registrations
          WHERE organization_id=o.id AND registration_type='VAT'
            AND effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
          ORDER BY is_primary DESC,effective_from DESC LIMIT 1
       ) tr ON TRUE
      WHERE o.id=$1`, [orgId]
  );
  if (!rows.length) throw new AppError(404, 'Organization not found');
  const r = rows[0];
  return {
    name: r.legal_entity_name || r.name,
    taxId: r.registration_no || null,
    address: asAddress(r.address_json || {}),
    email: r.contact_email || null,
    phone: r.contact_phone || null,
    countryCode: 'GH'
  };
}

async function loadBuyer(db, orgId, partnerId) {
  if (!partnerId) return { name: null, taxId: null, address: null, countryCode: 'GH' };
  const { rows } = await db.query(
    `SELECT bp.id,bp.name,bp.tax_id,bp.email,bp.phone,
            COALESCE(tpp.tax_registration_no,bp.tax_id) AS fiscal_tax_id,
            pa.line1,pa.line2,pa.city,pa.region,pa.postal_code,pa.country
       FROM business_partners bp
       LEFT JOIN tax_partner_profiles tpp ON tpp.organization_id=bp.organization_id AND tpp.partner_id=bp.id
       LEFT JOIN LATERAL (
         SELECT line1,line2,city,region,postal_code,country FROM business_partner_addresses
          WHERE organization_id=bp.organization_id AND partner_id=bp.id ORDER BY is_primary DESC,created_at ASC LIMIT 1
       ) pa ON TRUE
      WHERE bp.organization_id=$1 AND bp.id=$2`, [orgId, partnerId]
  );
  if (!rows.length) return { name: 'Customer', taxId: null, address: null, countryCode: 'GH' };
  const r = rows[0];
  return {
    name: r.name || 'Customer', taxId: r.fiscal_tax_id || null,
    address: asAddress({ line1: r.line1, line2: r.line2, city: r.city, region: r.region, postalCode: r.postal_code, country: r.country }),
    email: r.email || null, phone: r.phone || null, countryCode: r.country || 'GH'
  };
}

function summarizeTaxes(taxRows) {
  const groups = new Map();
  for (const t of taxRows || []) {
    const key = `${t.tax_type || 'VAT'}::${t.tax_code || t.tax_code_id || ''}::${t.rate ?? t.tax_rate ?? '0'}`;
    if (!groups.has(key)) groups.set(key, { taxType: t.tax_type || 'VAT', taxCode: t.tax_code || null, rate: String(t.rate ?? t.tax_rate ?? '0'), taxableAmount: '0.00', taxAmount: '0.00' });
    const g = groups.get(key);
    g.taxableAmount = sumMoney([g.taxableAmount, t.taxable_amount || '0.00']);
    g.taxAmount = sumMoney([g.taxAmount, t.tax_amount || '0.00']);
  }
  return Array.from(groups.values());
}

async function loadInvoicePayload(db, orgId, sourceId) {
  const { rows: invRows } = await db.query(`SELECT * FROM invoices WHERE organization_id=$1 AND id=$2`, [orgId, sourceId]);
  const inv = invRows[0];
  if (!inv) throw new AppError(404, 'Invoice not found');
  if (!['issued','paid'].includes(inv.status)) throw new AppError(409, 'Only issued/paid invoices can be fiscalized');
  const seller = await loadSeller(db, orgId);
  const buyer = await loadBuyer(db, orgId, inv.customer_id);
  const { rows: lines } = await db.query(`SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`, [sourceId]);
  const ids = lines.map((x) => x.id);
  const taxRows = ids.length ? (await db.query(`SELECT d.*,tc.code AS tax_code,tc.name AS tax_name FROM invoice_line_tax_details d LEFT JOIN tax_codes tc ON tc.id=d.tax_code_id WHERE d.line_id=ANY($1::uuid[]) ORDER BY d.line_id,d.sequence_no`, [ids])).rows : [];
  const byLine = new Map();
  for (const tax of taxRows) { if (!byLine.has(tax.line_id)) byLine.set(tax.line_id, []); byLine.get(tax.line_id).push(tax); }
  const fiscalLines = lines.map((line) => ({
    sourceLineId: line.id,
    lineNo: line.line_no,
    description: line.description || 'Item/service', quantity: String(line.quantity || '1'), unitOfMeasure: 'EA',
    unitPrice: String(line.unit_price || '0.00'), discountAmount: '0.00', discountRate: '0.000000',
    taxExclusiveAmount: String(line.taxable_amount || line.line_total || '0.00'),
    taxAmount: String(line.tax_amount || '0.00'), lineTotal: String(line.line_total || '0.00'),
    taxes: (byLine.get(line.id) || []).map((t) => ({ taxType: t.tax_type, taxCode: t.tax_code || null, rate: String(t.tax_rate || '0'), taxableAmount: String(t.taxable_amount || '0.00'), taxAmount: String(t.tax_amount || '0.00'), exemptionReasonCode: t.exemption_reason_code || null }))
  }));
  return {
    documentType: 'tax_invoice', transactionType: 'sale', documentNumber: inv.invoice_no || inv.id,
    sourceType: 'invoice', sourceId: inv.id, supplyAt: asIso(inv.issued_at || inv.invoice_date), invoiceAt: asIso(inv.issued_at || inv.invoice_date),
    currencyCode: inv.currency_code || 'GHS', seller, buyer, lines: fiscalLines, taxSummary: summarizeTaxes(taxRows),
    totals: { taxExclusiveAmount: String(inv.subtotal || '0.00'), discountAmount: '0.00', totalTax: String(inv.tax_total || '0.00'), taxInclusiveAmount: String(inv.total || '0.00'), payableAmount: String(inv.total || '0.00') }
  };
}

async function loadPosPayload(db, orgId, sourceId) {
  const { rows: saleRows } = await db.query(
    `SELECT s.*,r.code AS register_code,st.code AS store_code FROM pos_sales s
     JOIN pos_registers r ON r.id=s.register_id JOIN pos_stores st ON st.id=s.store_id
     WHERE s.organization_id=$1 AND s.id=$2`, [orgId, sourceId]
  );
  const sale = saleRows[0];
  if (!sale) throw new AppError(404, 'POS sale not found');
  if (!['completed','posted','partially_returned','returned','partially_refunded','refunded'].includes(sale.status)) throw new AppError(409, 'POS sale must be completed before fiscalization');
  const seller = await loadSeller(db, orgId);
  const buyer = await loadBuyer(db, orgId, sale.customer_id);
  const { rows: lines } = await db.query(
    `SELECT l.*,i.unit AS item_unit,i.sku FROM pos_sale_lines l JOIN inventory_items i ON i.id=l.item_id
      WHERE l.organization_id=$1 AND l.sale_id=$2 ORDER BY l.line_no`, [orgId, sourceId]
  );
  const { rows: taxRows } = await db.query(`SELECT * FROM pos_sale_line_taxes WHERE organization_id=$1 AND sale_id=$2 ORDER BY sale_line_id,tax_code`, [orgId, sourceId]);
  const byLine = new Map();
  for (const tax of taxRows) { if (!byLine.has(tax.sale_line_id)) byLine.set(tax.sale_line_id, []); byLine.get(tax.sale_line_id).push(tax); }
  const { rows: devices } = await db.query(
    `SELECT d.*,fl.id AS location_id FROM fiscal_devices d LEFT JOIN fiscal_locations fl ON fl.id=d.fiscal_location_id
      WHERE d.organization_id=$1 AND d.register_id=$2 AND d.status NOT IN ('revoked','inactive') ORDER BY d.updated_at DESC LIMIT 1`,
    [orgId, sale.register_id]
  );
  const device = devices[0] || null;
  const fiscalLines = lines.map((line) => ({
    sourceLineId: line.id, lineNo: line.line_no, itemId: line.item_id, sku: line.sku || null,
    description: line.description || line.sku || 'Item', quantity: String(line.quantity), unitOfMeasure: line.item_unit || 'EA',
    unitPrice: String(line.unit_price || '0.00'), discountAmount: String(line.discount_amount || '0.00'),
    discountRate: percentageRate(String(line.discount_amount || '0.00'), sumMoney([String(line.taxable_amount || '0.00'), String(line.discount_amount || '0.00')])),
    taxExclusiveAmount: String(line.taxable_amount || '0.00'), taxAmount: String(line.tax_amount || '0.00'), lineTotal: String(line.total_amount || '0.00'),
    taxes: (byLine.get(line.id) || []).map((t) => ({ taxType: t.tax_type, taxCode: t.tax_code || null, rate: String(t.rate || '0'), taxableAmount: String(t.taxable_amount || '0.00'), taxAmount: String(t.tax_amount || '0.00') }))
  }));
  return {
    documentType: 'sales_receipt', transactionType: 'sale', documentNumber: sale.sale_no,
    sourceType: 'pos_sale', sourceId: sale.id, supplyAt: asIso(sale.created_at || sale.sale_date), invoiceAt: asIso(sale.created_at || sale.sale_date),
    currencyCode: sale.currency_code || 'GHS', seller, buyer,
    device: device ? { id: device.id, deviceCode: device.device_code, machineRegistrationCode: device.machine_registration_code, verificationEngineId: device.verification_engine_id, serialNumber: device.device_serial_number } : null,
    location: { storeId: sale.store_id, storeCode: sale.store_code, registerId: sale.register_id, registerCode: sale.register_code },
    lines: fiscalLines, taxSummary: summarizeTaxes(taxRows),
    totals: { taxExclusiveAmount: String(sale.subtotal_amount || '0.00'), discountAmount: String(sale.discount_amount || '0.00'), totalTax: String(sale.tax_amount || '0.00'), taxInclusiveAmount: String(sale.total_amount || '0.00'), payableAmount: String(sale.total_amount || '0.00') }
  };
}

async function buildSourcePayload(db, orgId, sourceType, sourceId) {
  if (sourceType === 'invoice') return loadInvoicePayload(db, orgId, sourceId);
  if (sourceType === 'pos_sale') return loadPosPayload(db, orgId, sourceId);
  throw new AppError(400, `Fiscal source type ${sourceType} is modelled but not yet prepared by this release`);
}

async function prepareFiscalDocument({ orgId, actorUserId = null, sourceType, sourceId, db = null, force = false }) {
  const q = dbOrPool(db);
  const settings = await getSettingsRaw({ orgId, db: q });
  if (!force && (!settings || !settings.enabled)) return null;
  const payload = await buildSourcePayload(q, orgId, sourceType, sourceId);
  const validation = validateFiscalPayload(payload);
  if (!validation.valid) throw new AppError(422, `Fiscal document is incomplete: ${validation.errors.join('; ')}`);
  const hash = payloadHash(payload);
  const fiscalDeviceId = payload.device?.id || null;
  let fiscalLocationId = null;
  if (fiscalDeviceId) {
    const { rows } = await q.query(`SELECT fiscal_location_id FROM fiscal_devices WHERE organization_id=$1 AND id=$2`, [orgId, fiscalDeviceId]);
    fiscalLocationId = rows[0]?.fiscal_location_id || null;
  }
  const { rows } = await q.query(
    `INSERT INTO fiscal_documents(
      organization_id,source_type,source_id,document_type,transaction_type,source_number,consecutive_number,supply_at,invoice_at,currency_code,
      fiscal_location_id,fiscal_device_id,seller_json,buyer_json,lines_json,tax_summary_json,totals_json,payload_json,payload_hash,status,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,'ready',$19,$19)
     ON CONFLICT(organization_id,source_type,source_id) DO UPDATE SET
       document_type=EXCLUDED.document_type,transaction_type=EXCLUDED.transaction_type,source_number=EXCLUDED.source_number,
       consecutive_number=EXCLUDED.consecutive_number,supply_at=EXCLUDED.supply_at,invoice_at=EXCLUDED.invoice_at,currency_code=EXCLUDED.currency_code,
       fiscal_location_id=EXCLUDED.fiscal_location_id,fiscal_device_id=EXCLUDED.fiscal_device_id,seller_json=EXCLUDED.seller_json,
       buyer_json=EXCLUDED.buyer_json,lines_json=EXCLUDED.lines_json,tax_summary_json=EXCLUDED.tax_summary_json,totals_json=EXCLUDED.totals_json,
       payload_json=EXCLUDED.payload_json,payload_hash=EXCLUDED.payload_hash,status=CASE WHEN fiscal_documents.status='certified' THEN fiscal_documents.status ELSE 'ready' END,
       updated_by=EXCLUDED.updated_by,updated_at=NOW()
     RETURNING *`,
    [orgId, sourceType, sourceId, sourceDocumentType(sourceType), payload.transactionType, payload.documentNumber, payload.supplyAt, payload.invoiceAt,
      payload.currencyCode, fiscalLocationId, fiscalDeviceId, JSON.stringify(payload.seller), JSON.stringify(payload.buyer), JSON.stringify(payload.lines),
      JSON.stringify(payload.taxSummary), JSON.stringify(payload.totals), JSON.stringify(payload), hash, actorUserId]
  );
  const doc = rows[0];
  await logFiscal({ db: q, orgId, documentId: doc.id, eventCode: 'fiscal.document.prepared', actorUserId, deviceId: fiscalDeviceId, details: { sourceType, sourceId, payloadHash: hash } });
  if (settings?.auto_queue) await queueFiscalDocument({ orgId, actorUserId, fiscalDocumentId: doc.id, db: q });
  return doc;
}

async function autoPrepareForSource({ db, orgId, actorUserId, sourceType, sourceId }) {
  const settings = await getSettingsRaw({ orgId, db });
  if (!settings?.enabled) return null;
  if (sourceType === 'invoice' && !settings.auto_prepare_invoices) return null;
  if (sourceType === 'pos_sale' && !settings.auto_prepare_pos) return null;
  return prepareFiscalDocument({ orgId, actorUserId, sourceType, sourceId, db });
}

async function getDocument({ orgId, id }) {
  const { rows } = await pool.query(`SELECT * FROM fiscal_documents WHERE organization_id=$1 AND id=$2`, [orgId, id]);
  return rows[0] || null;
}
async function listDocuments({ orgId, query = {} }) {
  const params = [orgId]; const where = ['organization_id=$1']; let n = 2;
  if (query.status) { where.push(`status=$${n++}`); params.push(query.status); }
  if (query.sourceType) { where.push(`source_type=$${n++}`); params.push(query.sourceType); }
  const { rows } = await pool.query(`SELECT * FROM fiscal_documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 250`, params);
  return rows;
}

async function queueFiscalDocument({ orgId, actorUserId = null, fiscalDocumentId, db = null }) {
  const q = dbOrPool(db);
  const { rows: docs } = await q.query(`SELECT * FROM fiscal_documents WHERE organization_id=$1 AND id=$2`, [orgId, fiscalDocumentId]);
  const doc = docs[0];
  if (!doc) throw new AppError(404, 'Fiscal document not found');
  if (doc.status === 'certified') return { alreadyCertified: true, fiscalDocument: doc };
  const settings = await getSettingsRaw({ orgId, db: q });
  if (!settings?.enabled) throw new AppError(409, 'Fiscalization is not enabled');
  const key = `gra-evat:${doc.id}:${doc.payload_hash}`;
  const { rows } = await q.query(
    `INSERT INTO fiscal_transmission_queue(organization_id,fiscal_document_id,adapter_code,idempotency_key,status,request_payload,created_by)
     VALUES($1,$2,$3,$4,'queued',$5::jsonb,$6)
     ON CONFLICT(organization_id,idempotency_key) DO UPDATE SET
       status=CASE WHEN fiscal_transmission_queue.status IN ('certified','submitted') THEN fiscal_transmission_queue.status ELSE 'queued' END,
       next_attempt_at=CASE WHEN fiscal_transmission_queue.status IN ('certified','submitted') THEN fiscal_transmission_queue.next_attempt_at ELSE NOW() END,
       updated_at=NOW()
     RETURNING *`,
    [orgId, doc.id, settings.adapter_code || 'GRA_EVAT_SIM', key, JSON.stringify(doc.payload_json || {}), actorUserId]
  );
  await q.query(`UPDATE fiscal_documents SET status=CASE WHEN status='offline_pending' THEN status ELSE 'queued' END,updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND status<>'certified'`, [orgId, doc.id]);
  await logFiscal({ db: q, orgId, documentId: doc.id, queueId: rows[0].id, eventCode: 'fiscal.document.queued', actorUserId, details: { adapterCode: rows[0].adapter_code, idempotencyKey: key } });
  return rows[0];
}

async function markOffline({ orgId, actorUserId = null, fiscalDocumentId, reason = 'connectivity_unavailable' }) {
  const settings = await getSettingsRaw({ orgId });
  if (!settings?.enabled) throw new AppError(409, 'Fiscalization is not enabled');
  const now = new Date(); const deadline = offlineDeadline(now, settings.offline_window_hours || 24);
  const { rows } = await pool.query(
    `UPDATE fiscal_documents SET status='offline_pending',offline_recorded_at=$3,offline_deadline_at=$4,fiscal_status_reason=$5,updated_at=NOW(),updated_by=$6
      WHERE organization_id=$1 AND id=$2 AND status<>'certified' RETURNING *`,
    [orgId, fiscalDocumentId, now, deadline, reason, actorUserId]
  );
  if (!rows.length) throw new AppError(404, 'Fiscal document not found');
  await queueFiscalDocument({ orgId, actorUserId, fiscalDocumentId });
  await logFiscal({ orgId, documentId: fiscalDocumentId, eventCode: 'fiscal.document.offline_recorded', severity: 'warning', actorUserId, details: { reason, deadline: deadline.toISOString() } });
  return rows[0];
}

async function claimQueue({ orgId, workerId, limit = 10 }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE fiscal_transmission_queue SET status='retry',claimed_at=NULL,claimed_by=NULL,next_attempt_at=NOW(),updated_at=NOW() WHERE organization_id=$1 AND status='claimed' AND claimed_at < NOW() - INTERVAL '10 minutes'`, [orgId]);
    const { rows } = await client.query(
      `WITH candidates AS (
         SELECT id FROM fiscal_transmission_queue
          WHERE organization_id=$3 AND status IN ('queued','retry') AND next_attempt_at <= NOW() AND attempt_count < max_attempts
          ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE fiscal_transmission_queue q SET status='claimed',claimed_at=NOW(),claimed_by=$2,attempt_count=q.attempt_count+1,updated_at=NOW()
       FROM candidates c WHERE q.id=c.id RETURNING q.*`, [Math.max(1, Math.min(50, Number(limit || 10))), workerId, orgId]
    );
    await client.query('COMMIT'); return rows;
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { client.release(); }
}

async function applyCertification(queueRow, doc, result) {
  const s = result.security || {};
  const simulated = !!result.simulation;
  const documentStatus = simulated ? 'simulated' : 'certified';
  const queueStatus = simulated ? 'simulated' : 'certified';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE fiscal_documents SET status=$3,is_simulation=$4,commissioner_general_signature=$5,qr_code=$6,receipt_signature=$7,invoice_signature=$8,
        verification_engine_id=$9,encrypted_data=$10,fiscal_timestamp=COALESCE($11::timestamptz,NOW()),serial_number=$12,receipt_number=$13,
        machine_registration_code=$14,gra_reference=$15,certified_at=CASE WHEN $4 THEN NULL ELSE NOW() END,
        fiscal_status_reason=CASE WHEN $4 THEN 'Simulation only - not GRA certified' ELSE NULL END,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [doc.organization_id, doc.id, documentStatus, simulated, s.commissionerGeneralSignature, s.qrCode, s.receiptSignature, s.invoiceSignature,
        s.verificationEngineId, s.encryptedData, s.fiscalTimestamp || null, s.serialNumber, s.receiptNumber, s.machineRegistrationCode, s.graReference]
    );
    await client.query(
      `UPDATE fiscal_transmission_queue SET status=$3,response_payload=$4::jsonb,last_http_status=$5,submitted_at=COALESCE(submitted_at,NOW()),completed_at=NOW(),claimed_at=NULL,claimed_by=NULL,last_error=NULL,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2`, [doc.organization_id, queueRow.id, queueStatus, JSON.stringify(result.raw || {}), result.httpStatus || 200]
    );
    await logFiscal({ db: client, orgId: doc.organization_id, documentId: doc.id, queueId: queueRow.id, eventCode: simulated ? 'fiscal.document.simulated' : 'fiscal.document.certified', deviceId: doc.fiscal_device_id, details: { graReference: s.graReference, simulation: simulated } });
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { client.release(); }
}

async function failQueue(queueRow, doc, error) {
  const dead = queueRow.attempt_count >= queueRow.max_attempts;
  const next = nextRetryAt(queueRow.attempt_count, new Date());
  const status = dead ? 'dead_letter' : 'retry';
  await pool.query(
    `UPDATE fiscal_transmission_queue SET status=$3,next_attempt_at=$4,claimed_at=NULL,claimed_by=NULL,last_error=$5,last_http_status=$6,updated_at=NOW(),completed_at=CASE WHEN $3='dead_letter' THEN NOW() ELSE NULL END
      WHERE organization_id=$1 AND id=$2`, [doc.organization_id, queueRow.id, status, next, String(error?.message || error), Number(error?.status || error?.statusCode || 0) || null]
  );
  await pool.query(`UPDATE fiscal_documents SET status=CASE WHEN status='offline_pending' THEN status ELSE 'failed' END,fiscal_status_reason=$3,updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND status<>'certified'`, [doc.organization_id, doc.id, String(error?.message || error)]);
  await logFiscal({ orgId: doc.organization_id, documentId: doc.id, queueId: queueRow.id, eventCode: dead ? 'fiscal.transmission.dead_letter' : 'fiscal.transmission.retry_scheduled', severity: 'error', details: { error: String(error?.message || error), attemptCount: queueRow.attempt_count, nextAttemptAt: dead ? null : next.toISOString() } });
}

async function processQueue({ orgId, workerId = `worker-${process.pid}`, limit = 10 } = {}) {
  if (!orgId) throw new AppError(400, 'organization context is required to process fiscal queue');
  const claimed = await claimQueue({ orgId, workerId, limit });
  const results = [];
  for (const qrow of claimed) {
    const { rows: docs } = await pool.query(`SELECT * FROM fiscal_documents WHERE organization_id=$1 AND id=$2`, [qrow.organization_id, qrow.fiscal_document_id]);
    const doc = docs[0];
    if (!doc) continue;
    try {
      const settings = await getSettingsRaw({ orgId: doc.organization_id });
      const result = await submitToGraEvat({ settings, fiscalDocument: doc });
      await applyCertification(qrow, doc, result);
      results.push({ queueId: qrow.id, fiscalDocumentId: doc.id, status: result.simulation ? 'simulated' : 'certified', simulation: !!result.simulation });
    } catch (e) {
      await failQueue(qrow, doc, e);
      results.push({ queueId: qrow.id, fiscalDocumentId: doc.id, status: 'retry_or_failed', error: e.message });
    }
  }
  return { claimed: claimed.length, results };
}

async function listQueue({ orgId, query = {} }) {
  const params = [orgId]; const where = ['q.organization_id=$1']; let n=2;
  if (query.status) { where.push(`q.status=$${n++}`); params.push(query.status); }
  const { rows } = await pool.query(
    `SELECT q.*,d.source_type,d.source_id,d.source_number,d.status AS fiscal_document_status
       FROM fiscal_transmission_queue q JOIN fiscal_documents d ON d.id=q.fiscal_document_id
      WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC LIMIT 250`, params
  ); return rows;
}
async function listLogs({ orgId, query = {} }) {
  const params=[orgId]; const where=['organization_id=$1']; let n=2;
  if (query.documentId) { where.push(`fiscal_document_id=$${n++}`); params.push(query.documentId); }
  const { rows } = await pool.query(`SELECT * FROM fiscal_system_logs WHERE ${where.join(' AND ')} ORDER BY event_at DESC LIMIT 500`, params); return rows;
}


function csvCell(value) {
  const text = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  return `"${text.replace(/"/g, '""')}"`;
}
async function exportLogsCsv({ orgId }) {
  const rows = await listLogs({ orgId, query: {} });
  const headers = ['id','event_at','event_code','severity','fiscal_document_id','queue_id','actor_user_id','device_id','details'];
  return [headers.map(csvCell).join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\n');
}

async function readiness({ orgId }) {
  const settings = await getSettings({ orgId });
  const { rows: reg } = await pool.query(`SELECT registration_no FROM tax_registrations WHERE organization_id=$1 AND registration_type='VAT' AND effective_from<=CURRENT_DATE AND (effective_to IS NULL OR effective_to>=CURRENT_DATE) ORDER BY is_primary DESC LIMIT 1`, [orgId]);
  const { rows: deviceStats } = await pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status IN ('certified','active'))::int AS certified FROM fiscal_devices WHERE organization_id=$1`, [orgId]);
  const { rows: queueStats } = await pool.query(`SELECT COUNT(*) FILTER(WHERE status IN ('queued','retry','claimed'))::int AS pending,COUNT(*) FILTER(WHERE status='dead_letter')::int AS dead_letter FROM fiscal_transmission_queue WHERE organization_id=$1`, [orgId]);
  const { rows: overdue } = await pool.query(`SELECT COUNT(*)::int AS overdue FROM fiscal_documents WHERE organization_id=$1 AND status='offline_pending' AND offline_deadline_at<NOW()`, [orgId]);
  const checks = {
    fiscalizationEnabled: !!settings.enabled,
    vatRegistrationConfigured: !!reg[0]?.registration_no,
    onboardingSignedOff: ['signed_off','live'].includes(settings.onboarding_status),
    certifiedDeviceAvailable: Number(deviceStats[0]?.certified || 0) > 0,
    noDeadLetters: Number(queueStats[0]?.dead_letter || 0) === 0,
    noOverdueOfflineDocuments: Number(overdue[0]?.overdue || 0) === 0,
    liveContractConfigured: settings.adapter_mode !== 'live' || !!settings.api_contract_version
  };
  const passed = Object.values(checks).filter(Boolean).length;
  return { score: Math.round((passed / Object.keys(checks).length) * 100), checks, settings, stats: { devices: deviceStats[0], queue: queueStats[0], overdueOffline: Number(overdue[0]?.overdue || 0) } };
}

module.exports = {
  getSettings, saveSettings, listLocations, saveLocation, listDevices, saveDevice,
  prepareFiscalDocument, autoPrepareForSource, getDocument, listDocuments,
  queueFiscalDocument, markOffline, processQueue, listQueue, listLogs, exportLogsCsv, readiness,
  loadInvoicePayload, loadPosPayload
};
