const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

const DEFAULT_LEASE_SECONDS = 120;
const MAX_KEY_LENGTH = 200;

function stableStringify(obj) {
  if (obj === null || obj === undefined) return "";
  if (Buffer.isBuffer(obj)) {
    return `__buffer_sha256:${crypto.createHash("sha256").update(obj).digest("hex")}`;
  }
  if (typeof obj !== "object") return String(obj);
  const allKeys = [];
  JSON.stringify(obj, (k, v) => (allKeys.push(k), v));
  allKeys.sort();
  return JSON.stringify(obj, allKeys);
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function newOwnerToken() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function retryAfterSeconds(row, fallback = 2) {
  if (!row?.lease_expires_at) return fallback;
  const remaining = Math.ceil((new Date(row.lease_expires_at).getTime() - Date.now()) / 1000);
  return Math.max(1, Number.isFinite(remaining) ? remaining : fallback);
}

/**
 * Lease-backed idempotency middleware for authenticated tenant write endpoints.
 *
 * Guarantees:
 * - COMPLETED requests are replayed only for the identical request hash.
 * - Active IN_PROGRESS requests cannot be double-claimed.
 * - Stale IN_PROGRESS and FAILED records are reclaimable with the same key/hash.
 * - The response is not sent until the idempotency outcome has been persisted.
 * - 5xx responses become FAILED (retryable); <500 responses become COMPLETED.
 *
 * Financial services should still use a domain idempotency key in the same DB
 * transaction as the accounting mutation. The journal API does this in Step 4,
 * closing the commit-before-response crash gap for journal creation.
 */
function idempotency({ required = true, leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const rawKey = req.header("Idempotency-Key") || req.header("idempotency-key");
    if (!rawKey) {
      if (required) return next(new AppError(400, "Missing Idempotency-Key"));
      return next();
    }

    const key = String(rawKey).trim();
    if (!key || key.length > MAX_KEY_LENGTH) {
      return next(new AppError(400, `Idempotency-Key must be 1-${MAX_KEY_LENGTH} characters`));
    }
    if (!req.user?.organization_id) {
      return next(new AppError(500, "Idempotency requires authenticated organization context"));
    }

    const seconds = Number(leaseSeconds);
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
      return next(new AppError(500, "Invalid idempotency lease configuration"));
    }

    const orgId = req.user.organization_id;
    const method = (req.method || "").toUpperCase();
    // Use the concrete request pathname, not the Express route template.
    // Otherwise the same key/body on /:id/post for two different entity IDs
    // could be mistaken for the same operation.
    const path = String(req.originalUrl || (req.baseUrl + (req.path || ""))).split("?")[0];
    const requestHash = sha256(
      method + "|" + path + "|" + stableStringify(req.query || {}) + "|" + stableStringify(req.body)
    );
    const ownerToken = newOwnerToken();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id, request_hash, status, response_code, response_body,
                lease_expires_at, attempt_count
           FROM api_idempotency_keys
          WHERE organization_id=$1 AND idem_key=$2 AND method=$3 AND path=$4
          FOR UPDATE`,
        [orgId, key, method, path]
      );

      if (rows.length) {
        const row = rows[0];
        if (row.request_hash !== requestHash) {
          await client.query("ROLLBACK");
          return next(new AppError(409, "Idempotency-Key reuse with different request payload"));
        }
        if (row.status === "COMPLETED") {
          await client.query("COMMIT");
          return res.status(row.response_code || 200).json(row.response_body);
        }

        const leaseActive = row.status === "IN_PROGRESS" && row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now();
        if (leaseActive) {
          await client.query("ROLLBACK");
          res.setHeader("Retry-After", String(retryAfterSeconds(row)));
          return next(new AppError(409, "Request with this Idempotency-Key is already in progress"));
        }

        await client.query(
          `UPDATE api_idempotency_keys
              SET status='IN_PROGRESS', owner_token=$5,
                  lease_expires_at=NOW() + ($6::text || ' seconds')::interval,
                  attempt_count=COALESCE(attempt_count,0)+1,
                  response_code=NULL, response_body=NULL, completed_at=NULL,
                  updated_at=NOW()
            WHERE organization_id=$1 AND idem_key=$2 AND method=$3 AND path=$4`,
          [orgId, key, method, path, ownerToken, String(seconds)]
        );
      } else {
        await client.query(
          `INSERT INTO api_idempotency_keys
             (organization_id, idem_key, method, path, request_hash, status,
              owner_token, lease_expires_at, attempt_count)
           VALUES ($1,$2,$3,$4,$5,'IN_PROGRESS',$6,
                   NOW() + ($7::text || ' seconds')::interval,1)`,
          [orgId, key, method, path, requestHash, ownerToken, String(seconds)]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      client.release();
      return next(e);
    }
    client.release();

    // Make the claimed operation available to domain services that want to bind
    // their own transaction-level idempotency to the HTTP key.
    req.idempotency = { key, requestHash, ownerToken };

    // Keep legitimately long-running commands from becoming reclaimable while
    // they are still executing. If the process dies, the heartbeat dies too and
    // the lease becomes reclaimable after the configured interval.
    const heartbeatMs = Math.max(1000, Math.floor((seconds * 1000) / 3));
    const heartbeat = setInterval(() => {
      void pool.query(
        `UPDATE api_idempotency_keys
            SET lease_expires_at=NOW() + ($6::text || ' seconds')::interval, updated_at=NOW()
          WHERE organization_id=$1 AND idem_key=$2 AND method=$3 AND path=$4
            AND request_hash=$5 AND owner_token=$7 AND status='IN_PROGRESS'`,
        [orgId, key, method, path, requestHash, String(seconds), ownerToken]
      ).catch(() => {});
    }, heartbeatMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    res.once("close", () => clearInterval(heartbeat));

    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    let finalized = false;
    let bypassSendWrapper = false;

    async function persistOutcome(body, isBuffer = false) {
      if (finalized) return;
      finalized = true;
      clearInterval(heartbeat);
      const statusCode = res.statusCode || 200;
      const finalStatus = statusCode >= 500 ? "FAILED" : "COMPLETED";
      const responseBody = isBuffer
        ? { ok: statusCode < 400, buffer: true, bytes: body.length }
        : (body && typeof body === "object" ? body : { result: body });

      const { rowCount } = await pool.query(
        `UPDATE api_idempotency_keys
            SET status=$6, response_code=$7, response_body=$8,
                completed_at=CASE WHEN $6='COMPLETED' THEN NOW() ELSE NULL END,
                owner_token=NULL, lease_expires_at=NULL, updated_at=NOW()
          WHERE organization_id=$1 AND idem_key=$2 AND method=$3 AND path=$4
            AND request_hash=$5 AND owner_token=$9 AND status='IN_PROGRESS'`,
        [orgId, key, method, path, requestHash, finalStatus, statusCode, responseBody, ownerToken]
      );
      if (rowCount !== 1) {
        throw new AppError(503, "Could not durably finalize idempotent request");
      }
    }

    res.json = (body) => {
      void (async () => {
        try {
          await persistOutcome(body, false);
          bypassSendWrapper = true;
          try { origJson(body); } finally { bypassSendWrapper = false; }
        } catch (e) {
          next(e);
        }
      })();
      return res;
    };

    res.send = (body) => {
      if (bypassSendWrapper) return origSend(body);
      void (async () => {
        try {
          await persistOutcome(body, Buffer.isBuffer(body));
          origSend(body);
        } catch (e) {
          next(e);
        }
      })();
      return res;
    };

    return next();
  };
}

module.exports = { idempotency, stableStringify, sha256 };
