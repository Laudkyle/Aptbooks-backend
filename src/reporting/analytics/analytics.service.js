const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");

function parseDimensionJson(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;
  try { return JSON.parse(String(text)); } catch { throw new AppError(400, 'Invalid dimensionJson'); }
}

async function timeSeries({ orgId, fromPeriodId, toPeriodId, accountId, dimensionJson }) {
  if (!accountId) throw new AppError(400, 'accountId required');
  if (!fromPeriodId || !toPeriodId) throw new AppError(400, 'fromPeriodId and toPeriodId required');

  const dim = parseDimensionJson(dimensionJson);
  if (dim) {
    const { rows } = await pool.query(
      `
      SELECT period_id,
             SUM(debit_total) AS debit_total,
             SUM(credit_total) AS credit_total,
             SUM(debit_total - credit_total) AS net
      FROM general_ledger_dimension_balances
      WHERE organization_id=$1 AND account_id=$2
        AND period_id BETWEEN $3 AND $4
        AND dimension_json @> $5::jsonb
      GROUP BY period_id
      ORDER BY period_id ASC
      `,
      [orgId, accountId, fromPeriodId, toPeriodId, JSON.stringify(dim)]
    );
    return rows.map(r => ({ ...r, debit_total: Number(r.debit_total), credit_total: Number(r.credit_total), net: Number(r.net) }));
  }

  const { rows } = await pool.query(
    `
    SELECT period_id,
           SUM(debit_total) AS debit_total,
           SUM(credit_total) AS credit_total,
           SUM(debit_total - credit_total) AS net
    FROM general_ledger_balances
    WHERE organization_id=$1 AND account_id=$2
      AND period_id BETWEEN $3 AND $4
    GROUP BY period_id
    ORDER BY period_id ASC
    `,
    [orgId, accountId, fromPeriodId, toPeriodId]
  );
  return rows.map(r => ({ ...r, debit_total: Number(r.debit_total), credit_total: Number(r.credit_total), net: Number(r.net) }));
}

function zScoreAnomalies(series, field = 'net', threshold = 3) {
  const vals = series.map(p => Number(p[field] ?? 0));
  const n = vals.length;
  if (n === 0) return [];
  const mean = vals.reduce((a,b)=>a+b,0)/n;
  const variance = vals.reduce((a,b)=>a+Math.pow(b-mean,2),0)/n;
  const sd = Math.sqrt(variance) || 0;
  if (sd === 0) return [];
  return series
    .map((p, idx) => ({ ...p, z: (vals[idx] - mean)/sd }))
    .filter(p => Math.abs(p.z) >= threshold);
}

function movingAverage(series, field = 'net', window = 3) {
  const w = Math.max(1, Math.min(60, Number(window) || 3));
  const vals = series.map(p => Number(p[field] ?? 0));
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const start = Math.max(0, i - w + 1);
    const slice = vals.slice(start, i + 1);
    const avg = slice.reduce((a,b)=>a+b,0)/slice.length;
    out.push({ ...series[i], ma: avg });
  }
  return out;
}

function monteCarlo({ baseValue, mean = 0, stddev = 1, iterations = 1000 }) {
  const n = Math.max(10, Math.min(200000, Number(iterations) || 1000));
  const mu = Number(mean) || 0;
  const sigma = Math.max(0, Number(stddev) || 0);
  const base = Number(baseValue) || 0;

  // Box-Muller
  const samples = new Array(n);
  for (let i = 0; i < n; i++) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    samples[i] = base + mu + z * sigma;
  }

  samples.sort((a,b)=>a-b);
  const p = (q) => samples[Math.floor(q * (n - 1))];
  const sum = samples.reduce((a,b)=>a+b,0);
  const avg = sum / n;
  const varr = samples.reduce((a,b)=>a+Math.pow(b-avg,2),0)/n;
  const sd = Math.sqrt(varr);

  return {
    iterations: n,
    mean: avg,
    stddev: sd,
    p05: p(0.05),
    p50: p(0.50),
    p95: p(0.95)
  };
}

module.exports = { timeSeries, zScoreAnomalies, movingAverage, monteCarlo };
