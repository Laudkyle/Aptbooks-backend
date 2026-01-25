const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

function stableStringify(obj) {
  if (obj === null || obj === undefined) return "";
  // Buffer bodies (e.g., application/octet-stream uploads) must not be JSON-stringified.
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

/**
 * Idempotency middleware for write endpoints.
 *
 * Uses header: Idempotency-Key
 *
 * Semantics:
 * - First request creates a key row (IN_PROGRESS).
 * - If a prior COMPLETED exists with same request hash, returns stored response.
 * - If prior exists with different request hash, returns 409.
 * - If IN_PROGRESS exists, returns 409 with retry hint.
 */
function idempotency({ required = true } = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.header("Idempotency-Key") || req.header("idempotency-key");
    if (!key) {
      if (required) return next(new AppError(400, "Missing Idempotency-Key"));
      return next();
    }

    if (!req.user?.organization_id) {
      return next(new AppError(500, "Idempotency requires authenticated organization context"));
    }

    const orgId = req.user.organization_id;
    const method = (req.method || "").toUpperCase();
    const path = req.baseUrl + (req.route?.path || "");
    const requestHash = sha256(method + "|" + path + "|" + stableStringify(req.body));

    try {
      const { rows: existing } = await pool.query(
        `SELECT id, request_hash, status, response_code, response_body
         FROM api_idempotency_keys
         WHERE organization_id=$1 AND idem_key=$2 AND method=$3 AND path=$4`,
        [orgId, key, method, path]
      );

      if (existing.length) {
        const row = existing[0];
        if (row.request_hash !== requestHash) {
          return next(new AppError(409, "Idempotency-Key reuse with different request payload"));
        }
        if (row.status === "COMPLETED") {
          return res.status(row.response_code || 200).json(row.response_body);
        }
        // IN_PROGRESS or FAILED
        res.setHeader("Retry-After", "2");
        return next(new AppError(409, "Request with this Idempotency-Key is already in progress"));
      }

      // create IN_PROGRESS row
      await pool.query(
        `INSERT INTO api_idempotency_keys(organization_id, idem_key, method, path, request_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [orgId, key, method, path, requestHash]
      );

      // capture response
      const origJson = res.json.bind(res);
      const origSend = res.send.bind(res);
      let finalized = false;
      const finalize = async (body) => {
        if (finalized) return;
        finalized = true;
        const responseBody = body && typeof body === "object" ? body : { result: body };
        try {
          await pool.query(
            `UPDATE api_idempotency_keys
             SET status='COMPLETED', response_code=$6, response_body=$7, updated_at=NOW()
             WHERE organization_id=$1 AND idem_key=$2 AND method=$3 AND path=$4 AND request_hash=$5`,
            [orgId, key, method, path, requestHash, res.statusCode, responseBody]
          );
        } catch (_) {
          // best-effort;do not break response
        }
      };

      const markFailedIfUnfinished = async () => {
        if (finalized) return;
        finalized = true;
        try {
          await pool.query(
            `UPDATE api_idempotency_keys
             SET status='FAILED', response_code=499, response_body=$6, updated_at=NOW()
             WHERE organization_id=$1 AND idem_key=$2 AND method=$3 AND path=$4 AND request_hash=$5`,
            [orgId, key, method, path, requestHash, { ok: false, error: "request_aborted" }]
          );
        } catch (_) {
          // best-effort
        }
      };

      // If the client disconnects mid-request, ensure the idempotency key is not stuck IN_PROGRESS.
      res.on("close", () => {
        if (!res.writableEnded) {
          void markFailedIfUnfinished();
        }
      });

      res.json = (body) => {
        void finalize(body);
        return origJson(body);
      };
      res.send = (body) => {
        // avoid storing large buffers;store metadata only
        if (Buffer.isBuffer(body)) {
          void finalize({ ok: true, buffer: true, bytes: body.length });
        } else {
          void finalize(body);
        }
        return origSend(body);
      };

      return next();
    } catch (e) {
      return next(e);
    }
  };
}

module.exports = { idempotency };
