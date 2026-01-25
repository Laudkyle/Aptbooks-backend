const { AppError } = require("../errors/AppError");

async function fetchJson(url, { method = "GET", headers = {}, body = undefined, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: ctrl.signal
    });
    const txt = await res.text();
    let data = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = txt;
    }
    if (!res.ok) {
      throw new AppError(res.status, typeof data === "string" ? data : (data && data.message) || "HTTP request failed");
    }
    return { status: res.status, data, headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchJson };
