const crypto = require("crypto"); 
const { pool } = require("../../../db/pool"); 
const { AppError } = require("../../../shared/errors/AppError"); 

const repo = require("./payments.repository"); 
const paystack = require("./providers/paystack.provider"); 
const momo = require("./providers/mtnMomo.provider"); 

const customerReceiptsSvc = require("../../transactions/receipts/customer-receipts/customerReceipts.service"); 

async function getPaymentSettings(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_settings WHERE organization_id=$1`,
    [orgId]
  ); 
  return rows[0] || null; 
}

function newReference(prefix) {
  const r = crypto.randomUUID().replace(/-/g, "").slice(0, 18); 
  return `${prefix}_${r}`; 
}

async function createPaystackInboundIntent({ orgId, actorUserId, payload }) {
  const reference = newReference("ps"); 
  const intent = await repo.insertIntent({
    orgId,
    providerCode: "paystack",
    direction: "inbound",
    reference,
    amount: Number(payload.amount).toFixed(2),
    currencyCode: payload.currency,
    customerEmail: payload.customerEmail,
    customerPhone: null,
    metadata: payload.metadata || {},
    createdBy: actorUserId
  }); 

  await repo.insertIntentLinks({ intentId: intent.id, links: payload.links || [] }); 

  const init = await paystack.initializeTransaction({
    amount: payload.amount,
    currency: payload.currency,
    customerEmail: payload.customerEmail,
    callbackUrl: payload.callbackUrl,
    metadata: { ...payload.metadata, intentId: intent.id },
    reference
  }); 

  await repo.setIntentProviderFields({
    id: intent.id,
    orgId,
    fields: { authorization_url: init.authorizationUrl, status: "pending" }
  }); 

  return {
    intentId: intent.id,
    reference,
    provider: "paystack",
    authorizationUrl: init.authorizationUrl
  }; 
}

async function createMtnInboundIntent({ orgId, actorUserId, payload }) {
  const referenceId = momo.newReferenceId(); 
  const reference = newReference("mtn"); 

  const intent = await repo.insertIntent({
    orgId,
    providerCode: "mtn_momo",
    direction: "inbound",
    reference,
    amount: Number(payload.amount).toFixed(2),
    currencyCode: payload.currency,
    customerEmail: null,
    customerPhone: payload.phoneNumber,
    metadata: payload.metadata || {},
    createdBy: actorUserId
  }); 
  await repo.insertIntentLinks({ intentId: intent.id, links: payload.links || [] }); 

  await momo.requestToPay({
    referenceId,
    amount: payload.amount,
    currency: payload.currency,
    phoneNumber: payload.phoneNumber,
    payerMessage: payload.payerMessage,
    payeeNote: payload.payeeNote,
    externalId: payload.externalId || reference
  }); 

  await repo.setIntentProviderFields({
    id: intent.id,
    orgId,
    fields: { provider_transaction_id: referenceId, status: "pending" }
  }); 

  return {
    intentId: intent.id,
    reference,
    provider: "mtn_momo",
    providerReferenceId: referenceId
  }; 
}

async function verifyIntent({ orgId, id }) {
  const intent = await repo.getIntentById({ orgId, id }); 
  if (!intent) throw new AppError(404, "Payment intent not found"); 

  if (intent.provider_code === "paystack") {
    const v = await paystack.verifyTransaction({ reference: intent.reference }); 
    const status = v.status === "success" ? "success" : (v.status === "failed" ? "failed" : "pending"); 
    await repo.updateIntentStatus({
      id,
      orgId,
      status,
      rawLastResponse: v,
      providerTransactionId: String(v.id || ""),
      fees: v.fees ? (Number(v.fees) / 100).toFixed(2) : null
    }); 
    return await repo.getIntentById({ orgId, id }); 
  }

  if (intent.provider_code === "mtn_momo") {
    const refId = intent.provider_transaction_id; 
    if (!refId) throw new AppError(409, "Missing provider reference id"); 
    const v = await momo.getRequestToPayStatus({ referenceId: refId }); 
    const status = String(v.status || "").toUpperCase(); 
    const mapped = status === "SUCCESSFUL" ? "success" : (status === "FAILED" ? "failed" : "pending"); 
    await repo.updateIntentStatus({ id, orgId, status: mapped, rawLastResponse: v }); 
    return await repo.getIntentById({ orgId, id }); 
  }

  throw new AppError(400, "Unsupported payment provider"); 
}

async function postInboundIntentToLedger({ orgId, actorUserId, id }) {
  const intent = await repo.getIntentById({ orgId, id }); 
  if (!intent) throw new AppError(404, "Payment intent not found"); 
  if (intent.direction !== "inbound") throw new AppError(409, "Only inbound intents can be posted to ledger"); 
  if (intent.status !== "success") throw new AppError(409, "Only successful intents can be posted"); 
  if (intent.posted_customer_receipt_id) {
    return { intent, postedCustomerReceiptId: intent.posted_customer_receipt_id }; 
  }

  const settings = await getPaymentSettings(orgId); 
  if (!settings || !settings.online_cash_account_id || !settings.online_payment_method_id) {
    throw new AppError(409, "Configure payment_settings.online_cash_account_id and online_payment_method_id first"); 
  }

  const links = await repo.getIntentLinks({ intentId: id }); 
  const invoiceLinks = links.filter((l) => String(l.entity_type) === "invoice"); 
  if (invoiceLinks.length === 0) throw new AppError(409, "No linked invoices to allocate receipt"); 

  // Determine customer from first invoice (enforce same customer)
  const { rows: invRows } = await pool.query(
    `SELECT id, customer_id FROM invoices WHERE organization_id=$1 AND id = ANY($2::bigint[])`,
    [orgId, invoiceLinks.map((x) => x.entity_id)]
  ); 
  if (!invRows.length) throw new AppError(409, "Linked invoices not found"); 
  const customerId = invRows[0].customer_id; 
  for (const r of invRows) {
    if (r.customer_id !== customerId) throw new AppError(409, "Linked invoices must belong to the same customer"); 
  }

  // Allocate sequentially up to outstanding
  const { rows: open } = await pool.query(
    `
    SELECT invoice_id, outstanding
    FROM reporting_ar_open_items
    WHERE organization_id=$1 AND invoice_id = ANY($2::bigint[])
    ORDER BY invoice_id ASC
    `,
    [orgId, invoiceLinks.map((x) => x.entity_id)]
  ); 
  let remaining = Number(intent.amount || 0); 
  const allocations = []; 
  for (const o of open) {
    if (remaining <= 0) break; 
    const out = Number(o.outstanding || 0); 
    if (out <= 0) continue; 
    const cash = Math.min(remaining, out); 
    allocations.push({ invoiceId: o.invoice_id, amountApplied: Number(cash.toFixed(2)) }); 
    remaining = Number((remaining - cash).toFixed(2)); 
  }

  const receipt = await customerReceiptsSvc.createDraftCustomerReceipt({
    orgId,
    actorUserId,
    payload: {
      customerId,
      receiptDate: new Date().toISOString().slice(0, 10),
      paymentMethodId: settings.online_payment_method_id,
      cashAccountId: settings.online_cash_account_id,
      amountTotal: Number(intent.amount).toFixed(2),
      memo: `Online payment (${intent.provider_code}) ref ${intent.reference}`,
      allocations
    }
  }); 

  const posted = await customerReceiptsSvc.postCustomerReceipt({ orgId, actorUserId, id: receipt.id }); 
  await repo.attachPostedReceipt({ orgId, intentId: id, customerReceiptId: posted.id }); 
  const updated = await repo.getIntentById({ orgId, id }); 
  return { intent: updated, postedCustomerReceiptId: posted.id }; 
}

module.exports = {
  createPaystackInboundIntent,
  createMtnInboundIntent,
  verifyIntent,
  postInboundIntentToLedger
}; 
