const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const { env } = require("../../config/env");
const { encryptSecret, decryptSecret, isEncryptedSecret } = require("../../shared/security/secrets");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { runWithTenant } = require("../../shared/security/tenantContext");
const http = require("http");
const https = require("https");

function genSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function isPrivateOrReservedIpv4(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateOrReservedIpv6(address) {
  const a = String(address).toLowerCase();
  if (a === "::" || a === "::1") return true;

  // IPv4-mapped IPv6 addresses.
  if (a.startsWith("::ffff:")) {
    const mapped = a.slice("::ffff:".length);
    return net.isIP(mapped) !== 4 || isPrivateOrReservedIpv4(mapped);
  }

  const first = parseInt(a.split(":")[0] || "0", 16);
  // Restrict webhook delivery to globally routable IPv6 unicast (2000::/3).
  if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff) return true;

  // Documentation range is not routable and should never be a webhook target.
  if (a.startsWith("2001:db8:")) return true;
  return false;
}

function isPrivateOrReservedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateOrReservedIpv4(address);
  if (family === 6) return isPrivateOrReservedIpv6(address);
  return true;
}

async function assertSafeWebhookUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch (_) {
    throw new AppError(400, "targetUrl must be a valid URL");
  }

  if (!(url.protocol === "https:" || url.protocol === "http:")) {
    throw new AppError(400, "targetUrl must use http or https");
  }
  if (env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new AppError(400, "targetUrl must use https in production");
  }
  if (url.username || url.password) {
    throw new AppError(400, "targetUrl must not contain embedded credentials");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new AppError(400, "targetUrl must resolve to a public network address");
  }

  let resolved;
  if (net.isIP(hostname)) {
    resolved = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      resolved = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (_) {
      throw new AppError(400, "targetUrl hostname could not be resolved");
    }
  }

  if (!resolved.length || resolved.some((r) => isPrivateOrReservedAddress(r.address))) {
    throw new AppError(400, "targetUrl must resolve only to public network addresses");
  }

  // Pin one address for the actual request so validation and connection cannot
  // be separated by a second DNS lookup (DNS-rebinding defense).
  const selected = resolved[0];
  return { url, address: selected.address, family: selected.family };
}

async function createSubscription({ orgId, payload, actorUserId }) {
  const eventType = String(payload.eventType || "").trim();
  const targetUrl = String(payload.targetUrl || "").trim();
  if (!eventType) throw new AppError(400, "eventType is required");
  if (!targetUrl) throw new AppError(400, "targetUrl is required");

  const safeTarget = await assertSafeWebhookUrl(targetUrl);
  const secret = genSecret();
  const { rows } = await pool.query(
    `
    INSERT INTO webhook_subscriptions (organization_id, event_type, target_url, secret, status, created_by)
    VALUES ($1,$2,$3,$4,'active',$5)
    RETURNING id, organization_id, event_type, target_url, status, created_at
    `,
    [
      orgId,
      eventType,
      safeTarget.url.toString(),
      encryptSecret(secret, { context: `webhook:${orgId}` }),
      actorUserId,
    ]
  );
  // Return secret once (caller should store it securely).
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
    [orgId, id, encryptSecret(secret, { context: `webhook:${orgId}` }), actorUserId]
  );
  if (!rows.length) throw new AppError(404, "Webhook subscription not found");
  return { id: rows[0].id, secret };
}

async function enqueueEvent({ orgId, eventType, payload, client = null }) {
  if (!orgId || !eventType) return;
  const db = client || pool;
  await db.query(
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

async function postJson({ url, body, headers }) {
  try {
    const target = await assertSafeWebhookUrl(url);
    const u = target.url;
    const lib = u.protocol === "https:" ? https : http;

    return await new Promise((resolve) => {
      const req = lib.request(
        {
          method: "POST",
          hostname: u.hostname.replace(/^\[|\]$/g, ""),
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + (u.search || ""),
          headers,
          timeout: 8000,
          lookup: (_hostname, _options, callback) => {
            callback(null, target.address, target.family);
          },
        },
        (res) => {
          let data = "";
          let bytes = 0;
          const maxBytes = 64 * 1024;
          res.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes <= maxBytes) data += chunk.toString("utf8");
          });
          res.on("end", () => resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            body: data,
          }));
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, statusCode: 408, body: "timeout" });
      });
      req.on("error", (e) => resolve({ ok: false, statusCode: 0, body: e.message }));
      req.write(body);
      req.end();
    });
  } catch (e) {
    return { ok: false, statusCode: 0, body: e.message || String(e) };
  }
}

async function claimPending({ limit, orgId = null }) {
  const client = await pool.connect();
  const claimToken = crypto.randomUUID();
  try {
    await client.query("BEGIN");
    const params = [limit, claimToken];
    const orgClause = orgId ? ` AND organization_id=$3` : "";
    if (orgId) params.push(orgId);
    const { rows: events } = await client.query(
      `
      WITH candidates AS (
        SELECT id
          FROM webhook_outbox
         WHERE (
                (status='pending' AND next_attempt_at <= NOW())
             OR (status='processing' AND claimed_at <= NOW() - INTERVAL '30 minutes')
               )
           ${orgClause}
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE webhook_outbox o
         SET status='processing',
             claim_token=$2,
             claimed_at=NOW()
        FROM candidates c
       WHERE o.id=c.id
      RETURNING o.id, o.organization_id, o.event_type, o.payload,
                o.attempts, o.created_at, o.claim_token
      `,
      params
    );

    await client.query("COMMIT");
    return events;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function dispatchPending({ limit = 50, orgId = null }) {
  const safeLimit = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 50));

  // Global dispatch is implemented as explicit per-tenant work so RLS remains
  // effective even in background workers. No BYPASSRLS worker credential is used.
  if (!orgId) {
    const { rows: organizations } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);
    const combined = [];
    let remaining = safeLimit;
    for (const organization of organizations) {
      if (remaining <= 0) break;
      const tenantResults = await runWithTenant(organization.id, () =>
        dispatchPending({ limit: remaining, orgId: organization.id })
      );
      combined.push(...tenantResults);
      remaining = Math.max(0, remaining - tenantResults.length);
    }
    return combined;
  }

  const events = await claimPending({ limit: safeLimit, orgId });
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

    // Keep event identity/time stable across retries so receivers can dedupe by
    // X-Webhook-Delivery or eventId without payload drift.
    const body = JSON.stringify({
      eventId: evt.id,
      eventType: evt.event_type,
      occurredAt: evt.created_at,
      data: evt.payload,
    });

    let allOk = true;
    const deliveries = [];
    for (const sub of subs) {
      const signingSecret = decryptSecret(sub.secret, {
        context: `webhook:${evt.organization_id}`,
        allowPlaintextLegacy: true,
      });
      const sig = signBody({ secret: signingSecret, body });

      // Opportunistically migrate legacy plaintext webhook signing secrets.
      if (!isEncryptedSecret(sub.secret)) {
        await pool.query(
          `UPDATE webhook_subscriptions
              SET secret=$3, updated_at=NOW()
            WHERE organization_id=$1 AND id=$2 AND secret=$4`,
          [
            evt.organization_id,
            sub.id,
            encryptSecret(signingSecret, { context: `webhook:${evt.organization_id}` }),
            sub.secret,
          ]
        );
      }

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
      deliveries.push({
        subscriptionId: sub.id,
        ok: resp.ok,
        statusCode: resp.statusCode,
        response: resp.body?.slice?.(0, 2000) ?? resp.body,
      });
      if (!resp.ok) allOk = false;
    }

    const attempts = (evt.attempts || 0) + 1;
    if (allOk) {
      await pool.query(
        `UPDATE webhook_outbox
            SET status='sent', sent_at=NOW(), attempts=$2, last_error=NULL,
                claim_token=NULL, claimed_at=NULL
          WHERE id=$1 AND status='processing' AND claim_token=$3`,
        [evt.id, attempts, evt.claim_token]
      );
    } else {
      const delayMinutes = Math.min(60, 2 ** Math.min(6, attempts));
      await pool.query(
        `UPDATE webhook_outbox
            SET status='pending',
                attempts=$2,
                last_error=$3,
                next_attempt_at=NOW() + ($4 || ' minutes')::interval,
                claim_token=NULL,
                claimed_at=NULL
          WHERE id=$1 AND status='processing' AND claim_token=$5`,
        [
          evt.id,
          attempts,
          "one or more deliveries failed",
          String(delayMinutes),
          evt.claim_token,
        ]
      );
    }

    results.push({
      eventId: evt.id,
      eventType: evt.event_type,
      deliveredTo: deliveries.length,
      allOk,
      deliveries,
    });
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
  assertSafeWebhookUrl,
};
