const crypto = require("crypto");
const { env } = require("../../../../config/env");
const { fetchJson } = require("../../../../shared/utils/http");
const { AppError } = require("../../../../shared/errors/AppError");

function mustPaystack() {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new AppError(500, "PAYSTACK_SECRET_KEY is not configured");
  }
}

async function initializeTransaction({ amount, currency, customerEmail, callbackUrl, metadata, reference }) {
  mustPaystack();
  const body = {
    amount: Math.round(Number(amount) * 100), // paystack expects lowest currency unit
    email: customerEmail,
    currency,
    reference,
    callback_url: callbackUrl,
    metadata: metadata || {}
  };

  const { data } = await fetchJson(`${env.PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!data || data.status !== true) {
    throw new AppError(502, "Paystack initialize failed");
  }

  return {
    reference,
    authorizationUrl: data.data.authorization_url,
    accessCode: data.data.access_code
  };
}

async function verifyTransaction({ reference }) {
  mustPaystack();
  const { data } = await fetchJson(`${env.PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`
    }
  });
  if (!data || data.status !== true) {
    throw new AppError(502, "Paystack verify failed");
  }
  return data.data;
}

function verifyWebhookSignature({ rawBody, signatureHeader }) {
  mustPaystack();
  if (!signatureHeader) return false;
  const hmac = crypto.createHmac("sha512", env.PAYSTACK_SECRET_KEY);
  hmac.update(rawBody);
  const digest = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signatureHeader));
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature
};
