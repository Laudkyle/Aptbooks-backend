const { AppError } = require("../errors/AppError");

/**
 * Very small multipart/form-data parser.
 *
 * Supports:
 * - single file field (buffered in memory)
 * - small text fields
 *
 * This is intentionally minimal to avoid extra dependencies in the repo.
 */

function parseContentType(ct) {
  const m = String(ct || "").match(/multipart\/form-data;\s*boundary=(.+)$/i);
  return m ? m[1].replace(/^"|"$/g, "") : null;
}

async function readRawBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new AppError(413, "Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseHeadersBlock(block) {
  const headers = {};
  const lines = block.split("\r\n").filter(Boolean);
  for (const l of lines) {
    const idx = l.indexOf(":");
    if (idx === -1) continue;
    const k = l.slice(0, idx).trim().toLowerCase();
    const v = l.slice(idx + 1).trim();
    headers[k] = v;
  }
  return headers;
}

function parseDisposition(v) {
  const out = {};
  const parts = String(v || "").split(";").map((p) => p.trim());
  for (const p of parts) {
    const m = p.match(/^([a-zA-Z0-9_-]+)=(.+)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^"|"$/g, "");
    out[key] = val;
  }
  return out;
}

async function parseMultipart(req, { maxBytes } = {}) {
  const boundary = parseContentType(req.headers["content-type"]);
  if (!boundary) throw new AppError(400, "Expected multipart/form-data");

  const raw = await readRawBody(req, maxBytes);
  const boundaryBuf = Buffer.from(`--${boundary}`);

  // Split by boundary.
  const parts = [];
  let start = raw.indexOf(boundaryBuf);
  while (start !== -1) {
    start += boundaryBuf.length;
    // End marker
    if (raw.slice(start, start + 2).toString() === "--") break;
    // Skip CRLF
    if (raw.slice(start, start + 2).toString() === "\r\n") start += 2;

    const next = raw.indexOf(boundaryBuf, start);
    if (next === -1) break;

    // Trim trailing CRLF before next boundary
    let end = next - 2;
    const buf = raw.slice(start, end);
    parts.push(buf);
    start = next;
  }

  const fields = {};
  const files = {};

  for (const p of parts) {
    const sep = p.indexOf(Buffer.from("\r\n\r\n"));
    if (sep === -1) continue;
    const headerBlock = p.slice(0, sep).toString("utf8");
    const body = p.slice(sep + 4);
    const headers = parseHeadersBlock(headerBlock);
    const disp = parseDisposition(headers["content-disposition"]);
    if (!disp.name) continue;

    const name = disp.name;
    const filename = disp.filename;
    if (filename) {
      files[name] = {
        filename,
        contentType: headers["content-type"] || "application/octet-stream",
        buffer: body
      };
    } else {
      fields[name] = body.toString("utf8");
    }
  }

  return { fields, files };
}

module.exports = { parseMultipart };
