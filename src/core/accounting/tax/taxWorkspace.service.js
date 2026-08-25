const ghCitSvc = require('./ghanaCit.service');
const ghWithholdingSvc = require('./ghanaWithholding.service');
const repo = require('./taxWorkspace.repository');

function settled(result, fallback = null) {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function summarizeWithholding(dashboard) {
  const rows = dashboard?.eventSummary || [];
  let payableOpen = 0;
  let receivableOpen = 0;
  let openEvents = 0;
  for (const row of rows) {
    if (String(row.status || '').toLowerCase() !== 'open') continue;
    const amount = Number(row.withheld_amount || 0);
    const count = Number(row.event_count || 0);
    openEvents += count;
    if (String(row.direction || '').toLowerCase() === 'payable') payableOpen += amount;
    if (String(row.direction || '').toLowerCase() === 'receivable') receivableOpen += amount;
  }
  const dueDates = (dashboard?.returnSummary || [])
    .map((row) => row.next_due_date)
    .filter(Boolean)
    .map(String)
    .sort();
  return {
    openEvents,
    payableOpen: payableOpen.toFixed(2),
    receivableOpen: receivableOpen.toFixed(2),
    vendorsOverThreshold: Number(dashboard?.vendorsOverThreshold || 0),
    nextReturnDueDate: dueDates[0] || null,
  };
}

async function getWorkspaceSummary({ orgId }) {
  const [readinessResult, withholdingResult, vatResult, corporateResult, fiscalResult] = await Promise.allSettled([
    ghCitSvc.getReadiness({ orgId, persist: false }),
    ghWithholdingSvc.getDashboard({ orgId }),
    repo.getVatSnapshot({ orgId }),
    repo.getCorporateTaxSnapshot({ orgId }),
    repo.getFiscalizationSnapshot({ orgId }),
  ]);

  const readiness = settled(readinessResult, { score: 0, status: 'unavailable', blockers: [], warnings: [], checks: [] });
  const withholding = summarizeWithholding(settled(withholdingResult, {}));

  return {
    jurisdiction: { countryCode: 'GH', name: 'Ghana', authority: 'GRA' },
    readiness: {
      score: Number(readiness?.score || 0),
      status: readiness?.status || 'unavailable',
      blockers: readiness?.blockers || [],
      warnings: readiness?.warnings || [],
      checks: readiness?.checks || [],
    },
    vat: settled(vatResult, { registered: false, unavailable: true }),
    withholding,
    corporateTax: settled(corporateResult, { enabled: false, unavailable: true }),
    eVat: settled(fiscalResult, { enabled: false, unavailable: true, pending: 0, deadLetters: 0 }),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getWorkspaceSummary };
