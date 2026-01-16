const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

function genSecret() {
  return crypto.randomBytes(32).toString("hex");
}

async function createSubscription({ orgId, payload, actorUserId, req }) {
  const eventType = String(payload.eventType || "").trim();
  const targetUrl = String(payload.targetUrl || "").trim();
  if (!eventType) throw new AppError(400, "eventType is required");
  if (!targetUrl) throw new AppError(400, "targetUrl is required");

  const secret = genSecret();
  const { rows } = await pool.query(
    `
    INSERT INTO webhook_subscriptions (organization_id, event_type, target_url, secret, status, created_by)
    VALUES ($1,$2,$3,$4,'active',$5)
    RETURNING id, organization_id, event_type, target_url, status, created_at
    `,
    [orgId, eventType, targetUrl, secret, actorUserId]
  );
  // Return secret once (caller should store)
  return { ...rows[0], secret };
}

async function listSubscriptions({ orgId }) {
  const { rows } = await pool.query(
    `SELECT id, event_type, target_url, status, created_at, updated_at FROM webhook_subscriptions WHERE organization_id=$1 ORDER BY created_at DESC`,
    [orgId]
  );
  return rows;
}

async function disableSubscription({ orgId, id, actorUserId }) {
  const { rows } = await pool.query(
    `UPDATE webhook_subscriptions SET status='disabled', updated_at=NOW(), disabled_by=$3 WHERE organization_id=$1 AND id=$2 RETURNING id, status`,
    [orgId, id, actorUserId]
  );
  if (!rows.length) throw new AppError(404, "Webhook subscription not found");
  return rows[0];
}

async function rotateSecret({ orgId, id, actorUserId }) {
  const secret = genSecret();
  const { rows } = await pool.query(
    `UPDATE webhook_subscriptions SET secret=$3, updated_at=NOW(), rotated_by=$4 WHERE organization_id=$1 AND id=$2 RETURNING id`,
    [orgId, id, secret, actorUserId]
  );
  if (!rows.length) throw new AppError(404, "Webhook subscription not found");
  return { id: rows[0].id, secret };
}

async function enqueueEvent({ orgId, eventType, payload }) {
  if (!orgId || !eventType) return;
  await pool.query(
    `
    INSERT INTO webhook_outbox (organization_id, event_type, payload, status, attempts, next_attempt_at)
    VALUES ($1,$2,$3,'pending',0,NOW())
    `,
    [orgId, eventType, payload]
  );
}

function signBody({ secret, body }) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function postJson({ url, body, headers }) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          method: "POST",
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + (u.search || ""),
          headers,
          timeout: 8000,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, body: data }));
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, statusCode: 408, body: "timeout" });
      });
      req.on("error", (e) => resolve({ ok: false, statusCode: 0, body: e.message }));
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, statusCode: 0, body: e.message });
    }
  });
}

async function dispatchPending({ limit = 50 }) {
  const { rows: events } = await pool.query(
    `
    SELECT id, organization_id, event_type, payload, attempts
    FROM webhook_outbox
    WHERE status='pending' AND next_attempt_at <= NOW()
    ORDER BY created_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED
    `,
    [limit]
  );

  const results = [];

  for (const evt of events) {
    const { rows: subs } = await pool.query(
      `
      SELECT id, target_url, secret
      FROM webhook_subscriptions
      WHERE organization_id=$1 AND status='active'
        AND (event_type=$2 OR event_type='*')
      `,
      [evt.organization_id, evt.event_type]
    );

    const body = JSON.stringify({
      eventType: evt.event_type,
      occurredAt: new Date().toISOString(),
      data: evt.payload,
    });

    let allOk = true;
    const deliveries = [];
    for (const sub of subs) {
      const sig = signBody({ secret: sub.secret, body });
      const resp = await postJson({
        url: sub.target_url,
        body,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Webhook-Event": evt.event_type,
          "X-Webhook-Signature": sig,
          "X-Webhook-Delivery": String(evt.id),
        },
      });
      deliveries.push({ subscriptionId: sub.id, ok: resp.ok, statusCode: resp.statusCode, response: resp.body?.slice?.(0, 2000) ?? resp.body });
      if (!resp.ok) allOk = false;
    }

    const attempts = (evt.attempts || 0) + 1;
    if (allOk) {
      await pool.query(`UPDATE webhook_outbox SET status='sent', sent_at=NOW(), attempts=$2, last_error=NULL WHERE id=$1`, [evt.id, attempts]);
    } else {
      const delayMinutes = Math.min(60, 2 ** Math.min(6, attempts));
      await pool.query(
        `UPDATE webhook_outbox SET attempts=$2, last_error=$3, next_attempt_at=NOW() + ($4 || ' minutes')::interval WHERE id=$1`,
        [evt.id, attempts, "one or more deliveries failed", String(delayMinutes)]
      );
    }

    results.push({ eventId: evt.id, eventType: evt.event_type, deliveredTo: deliveries.length, allOk, deliveries });
  }

  return { processed: results.length, results };
}

module.exports = {
  createSubscription,
  listSubscriptions,
  disableSubscription,
  rotateSecret,
  enqueueEvent,
  dispatchPending,
};
