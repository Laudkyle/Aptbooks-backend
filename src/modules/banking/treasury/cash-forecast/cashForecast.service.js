
const repo = require('./cashForecast.repository');

function toIsoDate(d) { return d.toISOString().slice(0, 10); }

async function generate(orgId, query = {}, actorUserId = null) {
  const startDate = query.startDate || toIsoDate(new Date());
  const horizonDays = Math.max(Number(query.horizonDays || 30), 1);
  const end = new Date(`${startDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + horizonDays);
  const endDate = query.endDate || toIsoDate(end);

  const opening = await repo.getCurrentBalances(orgId);
  const outflows = await repo.getPlannedOutflows(orgId, endDate);
  const inflows = await repo.getPlannedInflows(orgId, endDate);

  const byBank = new Map();
  for (const row of opening) {
    byBank.set(row.bank_account_id, {
      bankAccountId: row.bank_account_id,
      code: row.code,
      name: row.name,
      currencyCode: row.currency_code,
      openingBalance: Number(row.current_balance || 0),
      inflows: 0,
      outflows: 0,
      projectedClosingBalance: Number(row.current_balance || 0),
      events: []
    });
  }
  for (const row of inflows) {
    const bucket = byBank.get(row.bank_account_id);
    if (!bucket) continue;
    const amount = Number(row.amount || 0);
    bucket.inflows += amount;
    bucket.projectedClosingBalance += amount;
    bucket.events.push({ direction: 'inflow', ...row, amount });
  }
  for (const row of outflows) {
    const bucket = byBank.get(row.bank_account_id);
    if (!bucket) continue;
    const amount = Number(row.amount || 0);
    bucket.outflows += Math.abs(amount);
    bucket.projectedClosingBalance += amount;
    bucket.events.push({ direction: 'outflow', ...row, amount });
  }
  const accounts = Array.from(byBank.values()).sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const summary = accounts.reduce((acc, a) => {
    acc.openingBalance += a.openingBalance;
    acc.totalInflows += a.inflows;
    acc.totalOutflows += a.outflows;
    acc.projectedClosingBalance += a.projectedClosingBalance;
    return acc;
  }, { openingBalance: 0, totalInflows: 0, totalOutflows: 0, projectedClosingBalance: 0 });

  const result = { startDate, endDate, horizonDays, summary, accounts };

  if (query.persist === 'true' && actorUserId) {
    const snapshot = await repo.createSnapshot(orgId, {
      name: query.name || `Cash forecast ${startDate} to ${endDate}`,
      startDate,
      endDate,
      horizonDays,
      assumptionsJson: { source: 'treasury.phase3' },
      generatedJson: result,
    }, actorUserId);
    result.snapshot = snapshot;
  }

  return result;
}

async function listSnapshots(orgId) { return repo.listSnapshots(orgId); }

module.exports = { generate, listSnapshots };
