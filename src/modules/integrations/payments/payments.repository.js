const { pool } = require("../../../db/pool"); 

async function insertIntent({ orgId, providerCode, direction, reference, amount, currencyCode, customerEmail, customerPhone, metadata, createdBy }) {
  const { rows } = await pool.query(
    `
    INSERT INTO payment_intents(
      organization_id, provider_code, direction, reference, amount, currency_code,
      customer_email, customer_phone, metadata, created_by, status
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')
    RETURNING *
    `,
    [orgId, providerCode, direction, reference, amount, currencyCode, customerEmail || null, customerPhone || null, metadata || {}, createdBy || null]
  ); 
  return rows[0]; 
}

async function setIntentProviderFields({ id, orgId, fields }) {
  const keys = Object.keys(fields || {}); 
  if (keys.length === 0) return; 
  const sets = keys.map((k, idx) => `${k}=$${idx + 3}`); 
  const vals = keys.map((k) => fields[k]); 
  await pool.query(
    `UPDATE payment_intents SET ${sets.join(", ")}, updated_at=now() WHERE id=$1 AND organization_id=$2`,
    [id, orgId, ...vals]
  ); 
}

async function updateIntentStatus({ id, orgId, status, rawLastResponse, providerTransactionId, fees }) {
  const { rows } = await pool.query(
    `
    UPDATE payment_intents
    SET status=$3,
        raw_last_response=COALESCE($4, raw_last_response),
        provider_transaction_id=COALESCE($5, provider_transaction_id),
        fees=COALESCE($6, fees),
        updated_at=now()
    WHERE id=$1 AND organization_id=$2
    RETURNING *
    `,
    [id, orgId, status, rawLastResponse || null, providerTransactionId || null, fees || null]
  ); 
  return rows[0] || null; 
}

async function getIntentById({ orgId, id }) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_intents WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  ); 
  return rows[0] || null; 
}

async function findIntentByProviderReference({ providerCode, reference }) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_intents WHERE provider_code=$1 AND reference=$2 ORDER BY created_at DESC LIMIT 1`,
    [providerCode, reference]
  ); 
  return rows[0] || null; 
}

async function insertIntentLinks({ intentId, links }) {
  if (!Array.isArray(links) || links.length === 0) return; 
  for (const l of links) {
    await pool.query(
      `INSERT INTO payment_intent_links(payment_intent_id, entity_type, entity_id) VALUES($1,$2,$3)`,
      [intentId, l.entityType, l.entityId]
    ); 
  }
}

async function getIntentLinks({ intentId }) {
  const { rows } = await pool.query(
    `SELECT entity_type, entity_id FROM payment_intent_links WHERE payment_intent_id=$1 ORDER BY id ASC`,
    [intentId]
  ); 
  return rows; 
}

async function recordWebhookEvent({ providerCode, externalEventId, signature, payload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO payment_webhook_events(provider_code, external_event_id, signature, payload)
    VALUES($1,$2,$3,$4)
    RETURNING *
    `,
    [providerCode, externalEventId || null, signature || null, payload]
  ); 
  return rows[0]; 
}

async function markWebhookProcessed({ id, error }) {
  await pool.query(
    `UPDATE payment_webhook_events SET processed_at=now(), processing_error=$2 WHERE id=$1`,
    [id, error || null]
  ); 
}

async function attachPostedReceipt({ orgId, intentId, customerReceiptId }) {
  await pool.query(
    `UPDATE payment_intents SET posted_customer_receipt_id=$3, updated_at=now() WHERE organization_id=$1 AND id=$2`,
    [orgId, intentId, customerReceiptId]
  ); 
}

module.exports = {
  insertIntent,
  setIntentProviderFields,
  updateIntentStatus,
  getIntentById,
  findIntentByProviderReference,
  insertIntentLinks,
  getIntentLinks,
  recordWebhookEvent,
  markWebhookProcessed,
  attachPostedReceipt
}; 
