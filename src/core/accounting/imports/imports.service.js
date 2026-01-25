const { AppError } = require("../../../shared/errors/AppError"); 
const coa = require("../../../interfaces/coaManagement.interface"); 
const journals = require("../../../interfaces/journalPosting.interface"); 

function parseCsv(text) {
  if (typeof text !== "string" || !text.trim()) throw new AppError(400, "CSV body is required"); 
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l=>l.trim().length>0); 
  if (lines.length < 2) throw new AppError(400, "CSV must include header and at least one row"); 
  const header = splitCsvLine(lines[0]).map(h=>h.trim()); 
  const rows=[]
  for (let i=1; i<lines.length; i++) {
    const cols = splitCsvLine(lines[i]); 
    const obj={}; 
    for (let j=0; j<header.length; j++) obj[header[j]] = (cols[j] ?? "").trim(); 
    rows.push(obj); 
  }
  return rows; 
}

function splitCsvLine(line) {
  // minimal RFC4180-ish parser supporting quotes and commas
  const out=[]; 
  let cur="";  let inQ=false; 
  for (let i=0; i<line.length; i++) {
    const c=line[i]; 
    if (inQ) {
      if (c==='"') {
        if (line[i+1]==='"') { cur+='"';  i++;  }
        else inQ=false; 
      } else cur+=c; 
    } else {
      if (c===',') { out.push(cur);  cur="";  }
      else if (c==='"') inQ=true; 
      else cur+=c; 
    }
  }
  out.push(cur); 
  return out; 
}

async function importCoaCsv({ orgId, actorUserId, csvText, options = {} }) {
  const dryRun = !!options.dryRun; 
  const rows = parseCsv(csvText); 

  // Expect at minimum: code,name,accountTypeCode
  const existing = await coa.listAccounts({ orgId, includeArchived: true }); 
  const byCode = new Map(existing.map(a => [String(a.code).toUpperCase(), a.id])); 

  const pending = rows.map((r, idx) => ({ idx: idx+2, r })); 
  const created = []; 
  const errors = []; 

  // Multiple passes to resolve parentCode references.
  for (let pass=0;  pass<5 && pending.length;  pass++) {
    const still=[]; 
    for (const item of pending) {
      const r=item.r; 
      const code = String(r.code || r.Code || "").trim(); 
      const name = String(r.name || r.Name || "").trim(); 
      const accountTypeCode = String(r.accountTypeCode || r.account_type_code || r.type || "").trim(); 
      const isPostable = String(r.isPostable || r.is_postable || "true").toLowerCase() !== 'false'; 
      const parentCode = String(r.parentCode || r.parent_code || "").trim(); 
      const status = String(r.status || "active").toLowerCase(); 

      if (!code || !name || !accountTypeCode) {
        errors.push({ line: item.idx, code, message: "code, name and accountTypeCode are required" }); 
        continue; 
      }
      const codeKey = code.toUpperCase(); 
      if (byCode.has(codeKey)) {
        // already exists;  skip
        continue; 
      }

      let parentAccountId = null; 
      if (parentCode) {
        const pid = byCode.get(parentCode.toUpperCase()); 
        if (!pid) {
          still.push(item); 
          continue; 
        }
        parentAccountId = pid; 
      }

      if (dryRun) {
        created.push({ code, name, accountTypeCode, isPostable, parentCode: parentCode || null, status }); 
        byCode.set(codeKey, `DRYRUN:${codeKey}`); 
      } else {
        try {
          const out = await coa.createAccount({ orgId, payload: { code, name, accountTypeCode, isPostable, parentAccountId, status }, actorUserId }); 
          byCode.set(codeKey, out.id || out.accountId || out.data?.id || out.data?.accountId || out); 
          created.push({ code, id: byCode.get(codeKey) }); 
        } catch (e) {
          errors.push({ line: item.idx, code, message: e.message }); 
        }
      }
    }
    pending.splice(0, pending.length, ...still); 
  }

  for (const item of pending) {
    const code = item.r.code || item.r.Code; 
    errors.push({ line: item.idx, code, message: "Unresolved parentCode reference" }); 
  }

  return { dryRun, createdCount: created.length, errorCount: errors.length, created, errors }; 
}

async function importJournalsCsv({ orgId, actorUserId, csvText, options = {} }) {
  const dryRun = !!options.dryRun; 
  const autoPost = !!options.autoPost; 
  const rows = parseCsv(csvText); 

  // Expect journalKey per group + accountCode mapping
  const keyField = options.journalKeyField || 'journalKey'; 
  const journalGroups = new Map(); 

  // Load COA map for accountCode to id
  const accounts = await coa.listAccounts({ orgId, includeArchived: false }); 
  const accByCode = new Map(accounts.map(a => [String(a.code).toUpperCase(), a.id])); 

  for (const r of rows) {
    const k = String(r[keyField] || r.journal_key || r.journalId || r.journal_key || "").trim(); 
    if (!k) throw new AppError(400, `CSV missing ${keyField} on at least one row`); 
    if (!journalGroups.has(k)) journalGroups.set(k, []); 
    journalGroups.get(k).push(r); 
  }

  const results=[]; 
  for (const [k, group] of journalGroups.entries()) {
    // take header fields from first row
    const first = group[0]; 
    const typeCode = String(first.typeCode || first.type_code || 'GENERAL').trim(); 
    const periodId = String(first.periodId || first.period_id || '').trim(); 
    const entryDate = String(first.entryDate || first.entry_date || '').trim(); 
    const memo = String(first.memo || '').trim(); 
    const rateTypeCode = String(first.rateTypeCode || first.rate_type_code || 'SPOT').trim(); 
    if (!periodId || !entryDate) throw new AppError(400, `periodId and entryDate required for journalKey ${k}`); 

    const lines=[]; 
    const errs=[]; 
    for (const lr of group) {
      const accountCode = String(lr.accountCode || lr.account_code || '').trim(); 
      const accountId = accByCode.get(accountCode.toUpperCase()); 
      if (!accountId) { errs.push(`Unknown accountCode ${accountCode}`);  continue;  }
      lines.push({
        accountId,
        description: lr.description || lr.lineDescription || null,
        debit: lr.debit || 0,
        credit: lr.credit || 0,
        currencyCode: lr.currencyCode || lr.currency_code || null,
        fxRate: lr.fxRate || lr.fx_rate || null,
        rateTypeCode: lr.rateTypeCode || lr.rate_type_code || rateTypeCode,
      }); 
    }

    if (errs.length) {
      results.push({ journalKey: k, status: 'error', errors: errs }); 
      continue; 
    }

    if (dryRun) {
      results.push({ journalKey: k, status: 'dryRun', journal: { typeCode, periodId, entryDate, memo, lines } }); 
      continue; 
    }

    const created = await journals.createDraftJournal({ orgId, actorUserId, payload: { typeCode, periodId, entryDate, memo, rateTypeCode, lines } }); 
    const journalId = created.journalId || created.id; 
    let final = { journalKey: k, journalId, status: created.status || 'draft' }; 
    if (autoPost) {
      await journals.submitDraftJournal({ orgId, journalId, actorUserId }); 
      await journals.approveSubmittedJournal({ orgId, journalId, actorUserId: actorUserId + '' });  // may fail SoD
      final = await journals.postDraftJournal({ orgId, journalId, actorUserId: actorUserId + '' }); 
      final.journalKey = k; 
    }
    results.push(final); 
  }

  return { dryRun, journals: results }; 
}

module.exports = { importCoaCsv, importJournalsCsv }; 
