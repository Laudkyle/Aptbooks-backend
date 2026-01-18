const crypto = require("crypto");
const { env } = require("../../../../config/env");
const { fetchJson } = require("../../../../shared/utils/http");
const { AppError } = require("../../../../shared/errors/AppError");

function mustMtn() {
  const missing = [];
  if (!env.MTN_MOMO_BASE_URL) missing.push("MTN_MOMO_BASE_URL");
  if (!env.MTN_MOMO_SUBSCRIPTION_KEY) missing.push("MTN_MOMO_SUBSCRIPTION_KEY");
  if (!env.MTN_MOMO_API_USER_ID) missing.push("MTN_MOMO_API_USER_ID");
  if (!env.MTN_MOMO_API_KEY) missing.push("MTN_MOMO_API_KEY");
  if (missing.length) throw new AppError(500, `Missing MTN MoMo env vars: ${missing.join(", ")}`);
}

async function getAccessToken() {
  mustMtn();
  const basic = Buffer.from(`${env.MTN_MOMO_API_USER_ID}:${env.MTN_MOMO_API_KEY}`).toString("base64");
  const { data } = await fetchJson(`${env.MTN_MOMO_BASE_URL}/collection/token/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Ocp-Apim-Subscription-Key": env.MTN_MOMO_SUBSCRIPTION_KEY
    }
  });
  if (!data || !data.access_token) throw new AppError(502, "MTN token request failed");
  return data.access_token;
}

function newReferenceId() {
  return crypto.randomUUID();
}

async function requestToPay({ referenceId, amount, currency, phoneNumber, payerMessage, payeeNote, externalId }) {
  mustMtn();
  const token = await getAccessToken();
  await fetchJson(`${env.MTN_MOMO_BASE_URL}/collection/v1_0/requesttopay`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Reference-Id": referenceId,
      "X-Target-Environment": env.MTN_MOMO_TARGET_ENV,
      "Ocp-Apim-Subscription-Key": env.MTN_MOMO_SUBSCRIPTION_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amount: String(Number(amount).toFixed(2)),
      currency,
      externalId: externalId || referenceId,
      payer: { partyIdType: "MSISDN", partyId: phoneNumber },
      payerMessage: payerMessage || "Payment",
      payeeNote: payeeNote || "Payment"
    })
  });
  return { referenceId };
}

async function getRequestToPayStatus({ referenceId }) {
  mustMtn();
  const token = await getAccessToken();
  const { data } = await fetchJson(`${env.MTN_MOMO_BASE_URL}/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Target-Environment": env.MTN_MOMO_TARGET_ENV,
      "Ocp-Apim-Subscription-Key": env.MTN_MOMO_SUBSCRIPTION_KEY
    }
  });
  return data;
}

module.exports = {
  newReferenceId,
  requestToPay,
  getRequestToPayStatus
};
