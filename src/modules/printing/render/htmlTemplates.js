/**
 * AptBooks Document Templates — Full Redesign
 *
 * Four completely distinct aesthetic themes:
 *
 *  renderClassic   → Luxury Editorial   (dark navy · gold · Cormorant Garamond serif)
 *  renderModern    → Brutalist Mono     (black · neon green · Bebas Neue + DM Mono)
 *  renderCompact   → Japanese Minimal   (white · vermillion · Noto Serif JP)
 *  renderCorporate → Art Deco Opulence  (deep burgundy · champagne · Cinzel serif)
 *
 * Each renderer accepts the same ctx shape:
 *   ctx.title        — document title string
 *   ctx.payload      — { organization, counterparty, meta, lines, summary }
 *   ctx.branding     — { accentColor?, goldColor?, showSignatureBlock? }
 *   ctx.layout       — { density?: 'comfortable' | 'tight' }
 */

'use strict';

/* ─────────────────────────────────────────────────────────
   Shared utilities
───────────────────────────────────────────────────────── */

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(value, code) {
  const n = Number(value || 0);
  return `${code || ''} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

function fmtMoneyExact(value, code) {
  let raw = String(value == null || value === '' ? '0' : value).trim();
  let sign = '';
  if (raw.startsWith('-')) { sign = '-'; raw = raw.slice(1); }
  const [wholeRaw, fractionRaw = ''] = raw.split('.');
  const whole = (wholeRaw || '0').replace(/^0+(?=\d)/, '');
  const fraction = (fractionRaw + '00').slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${code || ''} ${sign}${grouped}.${fraction}`.trim();
}

function nonZeroMoney(value) {
  return !/^[-+]?0*(?:\.0*)?$/.test(String(value == null ? '0' : value).trim());
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function joinAddress(addr) {
  if (!addr) return '';
  return [addr.line1, addr.line2, addr.city, addr.region, addr.postalCode, addr.country]
    .filter(Boolean).map(esc).join('<br/>');
}

function zeroPad(n, i) {
  return String(n ?? (i + 1)).padStart(2, '0');
}

function currency(payload) {
  return payload?.meta?.currencyCode || payload?.organization?.base_currency_code || 'GHS';
}

function printActorLabel(payload) {
  return payload?.printContext?.fullName || 'Unknown user';
}

function hasTaxDetails(payload) {
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  const groups = Array.isArray(payload?.summary?.taxGroups) ? payload.summary.taxGroups : [];
  return groups.length > 0 || lines.some((line) => Number(line?.taxAmount || 0) > 0 || Array.isArray(line?.taxComponents) && line.taxComponents.length);
}

function taxColumnHeader() {
  return `<th class="r" style="width:92px">Taxable</th><th class="r" style="width:92px">Tax</th><th class="r" style="width:88px">Rate</th><th style="width:124px">Tax Code</th><th class="r" style="width:132px">Gross</th>`;
}

function taxColumnCells(line, code) {
  const taxCodeLabel = [line?.taxCode, line?.taxCodeName].filter(Boolean).join(' · ');
  const rate = line?.taxRate == null ? '—' : `${Number(line.taxRate).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}%`;
  return `
  <td class="r">${esc(fmtMoney(line?.taxableAmount != null ? line.taxableAmount : line?.amount, code))}</td>
  <td class="r">${Number(line?.taxAmount || 0) ? esc(fmtMoney(line.taxAmount, code)) : '—'}</td>
  <td class="r">${esc(rate)}</td>
  <td>${esc(taxCodeLabel || '—')}</td>
  <td class="r">${esc(fmtMoney(line?.grossAmount != null ? line.grossAmount : Number(line?.amount || 0) + Number(line?.taxAmount || 0), code))}</td>`;
}

function renderTaxSummary(summary, code, variant = 'default') {
  const groups = Array.isArray(summary?.taxGroups) ? summary.taxGroups : [];
  if (!groups.length && !Number(summary?.tax || 0)) return '';
  const tag = variant === 'modern' ? 'TAX BREAKDOWN' : variant === 'corporate' ? 'Tax Schedule' : 'Tax Breakdown';
  const rows = groups.map((group) => `
    <tr>
      <td><strong>${esc(group.taxCode || group.taxType || 'Tax')}</strong>${group.taxCodeName ? `<div style="font-size:11px;opacity:.75">${esc(group.taxCodeName)}</div>` : ''}</td>
      <td class="r">${esc(fmtMoney(group.taxableAmount, code))}</td>
      <td class="r">${esc(`${Number(group.taxRate || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}%`)}</td>
      <td class="r">${esc(fmtMoney(group.taxAmount, code))}</td>
    </tr>`).join('');
  return `
    <div class="notes" style="margin-top:18px">
      <div class="plbl">${tag}</div>
      <table class="items" style="margin-top:10px">
        <thead>
          <tr>
            <th>Code / Tax Type</th>
            <th class="r" style="width:140px">Taxable Base</th>
            <th class="r" style="width:90px">Rate</th>
            <th class="r" style="width:140px">Tax Amount</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td>Total Tax</td><td class="r">—</td><td class="r">—</td><td class="r">${esc(fmtMoney(summary?.tax || 0, code))}</td></tr>`}
        </tbody>
      </table>
      <p>Total tax on this document: <strong>${esc(fmtMoney(summary?.tax || 0, code))}</strong>.</p>
    </div>`;
}

function renderSignatureBlocks(signatures, variant = 'classic') {
  const sigs = Array.isArray(signatures) ? signatures : [];
  if (!sigs.length) return '';
  const cls = variant === 'corporate' ? 'siglbl' : 'sigmeta';
  return `<div class="sig">${sigs.map((sig) => `
    <div>
      <div class="sigline">
        ${sig?.image ? `<img class="sigimg" src="${esc(sig.image)}" alt="${esc(sig.label || 'Signature')}" />` : ''}
        <div class="${cls}">${esc(sig?.label || 'Signatory')}</div>
        ${sig?.name ? `<div class="signame">${esc(sig.name)}</div>` : ''}
        ${sig?.title ? `<div class="sigtitle">${esc(sig.title)}</div>` : ''}
      </div>
    </div>`).join('')}</div>`;
}


/* ─────────────────────────────────────────────────────────
   THEME 1 — CLASSIC
   Luxury Editorial · Dark Navy · Gold · Cormorant Garamond
───────────────────────────────────────────────────────── */

function classicStyles(accent, gold, density) {
  const p  = density === 'tight' ? '10px 14px' : '14px 18px';
  const tp = density === 'tight' ? '10px 12px' : '14px 14px';
  const tf = density === 'tight' ? '12.5px' : '13.5px';
  return `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=Jost:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--acc:${accent};--gold:${gold};--bg:#fdfbf7;--bdr:#e8e0d0;--mut:#8a8070;--txt:#1a1a1a}
body{font-family:'Jost',Arial,sans-serif;background:#f5f0e8;color:var(--txt);padding:40px 24px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:860px;margin:0 auto;background:#fff;box-shadow:0 8px 60px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.07)}
.hdr{background:var(--acc);padding:44px 52px 40px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px}
.htitle{font-family:'Cormorant Garamond',Georgia,serif;font-size:52px;font-weight:700;color:#fff;letter-spacing:-1px;line-height:1}
.horg{color:rgba(255,255,255,.45);font-size:13px;margin-top:10px;letter-spacing:.5px}
.hdocno{font-family:'Cormorant Garamond',Georgia,serif;font-size:16px;color:var(--gold);letter-spacing:3px;text-transform:uppercase}
.hbadge{display:inline-block;margin-top:8px;padding:4px 16px;border:1px solid var(--gold);color:var(--gold);font-size:10px;font-weight:600;letter-spacing:3px;text-transform:uppercase;border-radius:999px}
.rule{height:3px;background:linear-gradient(90deg,var(--gold) 0%,#f0d882 40%,#e2c165 70%,var(--gold) 100%)}
.body{padding:44px 52px}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:32px}
.party{padding:${p};border:1px solid var(--bdr);background:var(--bg);position:relative;overflow:hidden}
.party::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--gold)}
.plbl{font-size:9px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:var(--gold);margin-bottom:10px}
.pnm{font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:600;color:var(--acc);margin-bottom:4px}
.pdt{font-size:12.5px;color:var(--mut);line-height:1.75}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:16px;margin-bottom:36px}
.mc{padding:${p};border:1px solid var(--bdr);background:var(--bg)}
.mlbl{font-size:9px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:#aaa098;margin-bottom:5px}
.mval{font-size:14px;font-weight:500;color:var(--acc)}
.sttl{font-size:9px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:#aaa098;margin-bottom:12px}
table.items{width:100%;border-collapse:collapse;font-size:${tf};margin-bottom:4px}
.items thead tr{border-bottom:1.5px solid var(--acc)}
.items th{font-size:9px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#aaa098;padding:0 14px 10px}
.items th:first-child{padding-left:0}.items th:last-child{padding-right:0;text-align:right}.items th.r{text-align:right}
.items tbody tr{border-bottom:1px solid var(--bdr)}.items tbody tr:last-child{border-bottom:none}
.items td{padding:${tp};vertical-align:middle}
.items td:first-child{padding-left:0;color:#aaa098;font-size:12px}.items td:last-child{padding-right:0;text-align:right;font-weight:500}
.items td.r{text-align:right}.idesc{font-weight:500;color:var(--acc)}
.totals{display:flex;justify-content:flex-end;margin-top:20px}
.totals table{width:300px;border-collapse:collapse}
.totals td{padding:7px 0;font-size:14px}.totals td:last-child{text-align:right}
.tl{color:var(--mut)}.trow td{border-top:1.5px solid var(--acc);padding-top:14px!important;font-weight:700;font-size:15px;color:var(--acc)}
.tamt{font-family:'Cormorant Garamond',Georgia,serif;font-size:24px}
.notes{margin-top:28px;padding:18px 22px;border-left:3px solid var(--gold);background:var(--bg)}
.notes p{font-size:13px;color:var(--mut);line-height:1.75;margin-top:6px}
.sig{margin-top:44px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:36px}
.sigline{padding-top:14px;border-top:1px solid #c8c0b0;font-size:11px;color:var(--mut);letter-spacing:.5px;min-height:112px}
.sigimg{display:block;max-width:180px;max-height:56px;object-fit:contain;margin:0 0 10px 0}
.sigmeta{font-size:11px;color:var(--mut);letter-spacing:.5px}
.signame{margin-top:8px;font-weight:600;color:var(--acc)}
.sigtitle{margin-top:4px;font-size:11px;color:var(--mut)}
.ftr{margin-top:36px;padding-top:18px;border-top:1px solid var(--bdr);display:flex;justify-content:space-between;font-size:11px;color:#aaa098}
.fgold{color:var(--gold);font-weight:600}
@media print{body{background:#fff;padding:0}.page{box-shadow:none}}`;
}

function classicLines(lines, code) {
  const taxed = hasTaxDetails({ lines });
  return (lines || []).map((l, i) => `
<tr>
  <td>${zeroPad(l.lineNo, i)}</td>
  <td><span class="idesc">${esc(l.description || '—')}</span></td>
  <td class="r">${l.quantity == null ? '—' : esc(l.quantity)}</td>
  <td class="r">${l.unitPrice == null ? '—' : Number(l.unitPrice).toLocaleString('en-US', {minimumFractionDigits:2})}</td>
  ${taxed ? taxColumnCells(l, code) : `<td class="r">${esc(fmtMoney(l.amount, code))}</td>`}
</tr>`).join('');
}

function renderClassic(ctx) {
  const accent  = ctx.branding?.accentColor || '#14213d';
  const gold    = ctx.branding?.goldColor   || '#c9a84c';
  const density = ctx.layout?.density       || 'comfortable';
  const showSig = ctx.branding?.showSignatureBlock !== false;
  const payload = ctx.payload || {};
  const code    = currency(payload);
  const org     = payload.organization || {};
  const cp      = payload.counterparty || {};
  const meta    = payload.meta || {};
  const sum     = payload.summary || {};
  const orgLine = [org.email, org.phone].filter(Boolean).map(esc).join(' · ');

  const metaCells = [
    { l: 'Document No', v: meta.documentNo },
    { l: 'Issue Date',  v: fmtDate(meta.documentDate) },
    meta.dueDate        && { l: 'Due Date',  v: fmtDate(meta.dueDate) },
    meta.reference      && { l: 'Reference', v: meta.reference },
    meta.workflowStatus && { l: 'Workflow',  v: meta.workflowStatus },
  ].filter(Boolean).map(c => `<div class="mc"><div class="mlbl">${esc(c.l)}</div><div class="mval">${esc(c.v || '—')}</div></div>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>${esc(ctx.title)} — ${esc(meta.documentNo || '')}</title>
<style>${classicStyles(accent, gold, density)}</style></head><body>
<div class="page">
  <div class="hdr">
    <div>
      <div class="htitle">${esc(ctx.title)}</div>
      <div class="horg">${esc(org.name || '')}${orgLine ? ' · ' + orgLine : ''}</div>
    </div>
    <div style="text-align:right">
      ${meta.documentNo ? `<div class="hdocno"># ${esc(meta.documentNo)}</div>` : ''}
      ${meta.status     ? `<div class="hbadge">${esc(meta.status)}</div>`       : ''}
    </div>
  </div>
  <div class="rule"></div>
  <div class="body">
    <div class="parties">
      <div class="party">
        <div class="plbl">${esc(ctx.title === 'Purchase Order' ? 'Vendor' : 'Bill To')}</div>
        <div class="pnm">${esc(cp.name || '—')}</div>
        <div class="pdt">${[cp.email, cp.phone].filter(Boolean).map(esc).join('<br/>')}${joinAddress(cp.address) ? '<br/>' + joinAddress(cp.address) : ''}</div>
      </div>
      <div class="party">
        <div class="plbl">Issued By</div>
        <div class="pnm">${esc(org.name || '—')}</div>
        <div class="pdt">${[org.email, org.phone].filter(Boolean).map(esc).join('<br/>')}${joinAddress(org.address) ? '<br/>' + joinAddress(org.address) : ''}</div>
      </div>
    </div>
    <div class="meta">${metaCells}</div>
    <div class="sttl">Line Items</div>
    <table class="items">
      <thead><tr><th style="width:42px">#</th><th>Description</th><th class="r" style="width:70px">Qty</th><th class="r" style="width:120px">Unit Price</th>${hasTaxDetails(payload) ? taxColumnHeader() : `<th class="r" style="width:140px">Amount</th>`}</tr></thead>
      <tbody>${classicLines(payload.lines, code)}</tbody>
    </table>
    ${renderTaxSummary(sum, code, 'classic')}
    <div class="totals"><table>
      <tr><td class="tl">Subtotal</td><td>${esc(fmtMoney(sum.subtotal, code))}</td></tr>
      ${sum.tax      != null ? `<tr><td class="tl">Tax</td><td>${esc(fmtMoney(sum.tax, code))}</td></tr>` : ''}
      ${sum.discount != null ? `<tr><td class="tl">Discount</td><td>&#8722;${esc(fmtMoney(sum.discount, code))}</td></tr>` : ''}
      <tr class="trow"><td>Total Due</td><td><span class="tamt">${esc(fmtMoney(sum.total, code))}</span></td></tr>
    </table></div>
    ${sum.memo ? `<div class="notes"><div class="plbl">Notes</div><p>${esc(sum.memo)}</p></div>` : ''}
    ${showSig ? renderSignatureBlocks(payload.signatures, 'classic') : ''}
    <div class="ftr"><span>Printed by <strong>${esc(printActorLabel(payload))}</strong> · <span class="fgold">AptBooks</span></span><span>Page 1 of 1</span></div>
  </div>
</div></body></html>`;
}


/* ─────────────────────────────────────────────────────────
   THEME 2 — MODERN
   Brutalist Monochrome · Black · Neon Green · Bebas Neue · DM Mono
───────────────────────────────────────────────────────── */

function modernStyles(accent, neon) {
  return `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=Jost:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--acc:${accent};--neon:${neon};--sur:#111;--bdr:#1e1e1e;--bdr2:#2a2a2a;--mut:#444;--dim:#333}
body{font-family:'Jost',Arial,sans-serif;background:#0a0a0a;color:#ccc;padding:40px 24px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:860px;margin:0 auto;background:var(--sur);border:1px solid var(--bdr2)}
.hdr{display:grid;grid-template-columns:1fr auto;border-bottom:1px solid var(--bdr)}
.htb{padding:40px 48px;border-right:1px solid var(--bdr)}
.htitle{font-family:'Bebas Neue',sans-serif;font-size:72px;color:var(--neon);line-height:1;letter-spacing:2px}
.horg{font-family:'DM Mono',monospace;font-size:12px;color:var(--mut);margin-top:8px;letter-spacing:.5px}
.hmb{padding:40px 36px;display:flex;flex-direction:column;justify-content:space-between;min-width:200px}
.hdocno{font-family:'DM Mono',monospace;font-size:13px;color:var(--neon);letter-spacing:2px}
.hstatus{display:inline-block;padding:6px 14px;background:var(--neon);color:#000;font-family:'DM Mono',monospace;font-size:11px;font-weight:500;letter-spacing:2px;text-transform:uppercase}
.slbl{font-family:'DM Mono',monospace;font-size:10px;color:var(--mut);letter-spacing:3px;text-transform:uppercase;margin-bottom:20px;display:flex;align-items:center;gap:12px}
.slbl::after{content:'';flex:1;height:1px;background:var(--bdr)}
.sec{border-bottom:1px solid var(--bdr);padding:32px 48px}.sec:last-child{border-bottom:none}
.parties{display:grid;grid-template-columns:1fr 1fr}
.party{padding:28px 32px;border-right:1px solid var(--bdr)}.party:last-child{border-right:none}
.plbl{font-family:'DM Mono',monospace;font-size:9px;color:var(--neon);letter-spacing:3px;text-transform:uppercase;margin-bottom:10px}
.pnm{font-family:'Bebas Neue',sans-serif;font-size:22px;color:#fff;letter-spacing:1px;margin-bottom:6px}
.pdt{font-family:'DM Mono',monospace;font-size:11.5px;color:#555;line-height:1.9}
.mrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}
.mc{padding:20px 24px;border-right:1px solid var(--bdr)}.mc:last-child{border-right:none}
.mlbl{font-family:'DM Mono',monospace;font-size:9px;color:var(--mut);letter-spacing:2px;text-transform:uppercase;margin-bottom:6px}
.mval{font-family:'DM Mono',monospace;font-size:13px;color:#ccc}
table.items{width:100%;border-collapse:collapse}
.items thead tr{border-bottom:1px solid var(--bdr2)}
.items th{font-family:'DM Mono',monospace;font-size:9px;color:var(--mut);letter-spacing:2px;text-transform:uppercase;padding:0 16px 12px;text-align:left}
.items th:first-child{padding-left:0}.items th:last-child{text-align:right;padding-right:0}.items th.r{text-align:right}
.items tbody tr{border-bottom:1px solid #1a1a1a;transition:background .15s}.items tbody tr:hover{background:#161616}.items tbody tr:last-child{border-bottom:none}
.items td{padding:14px 16px;font-size:13px;color:#bbb}
.items td:first-child{padding-left:0;font-family:'DM Mono',monospace;font-size:11px;color:var(--dim)}
.items td:last-child{padding-right:0;text-align:right;color:#fff;font-weight:500}
.items td.r{text-align:right}.idesc{color:#fff;font-weight:500}
.totrow{display:flex;justify-content:flex-end;padding:28px 48px;border-top:1px solid var(--bdr)}
.tot{width:320px}.tot table{width:100%;border-collapse:collapse}
.tot td{padding:6px 0;font-family:'DM Mono',monospace;font-size:12px}
.tot td:last-child{text-align:right;color:#aaa}.tl{color:var(--mut)}
.tot tr.tr td{border-top:1px solid var(--bdr2);padding-top:14px;color:var(--neon)}
.tamt{font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:1px}
.notes{margin:0 48px 28px;padding:20px 24px;border:1px solid var(--bdr);background:#0e0e0e}
.notes p{font-family:'DM Mono',monospace;font-size:12px;color:#555;line-height:1.9;margin-top:8px}
.sig{margin:0 48px 28px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:24px}
.sigline{border-top:1px solid var(--bdr2);padding-top:12px;min-height:104px}
.sigimg{display:block;max-width:180px;max-height:54px;object-fit:contain;margin:0 0 10px 0}
.sigmeta{font-family:'DM Mono',monospace;font-size:11px;color:#777;letter-spacing:1px;text-transform:uppercase}
.signame{margin-top:8px;color:#fff;font-weight:600}
.sigtitle{margin-top:4px;font-family:'DM Mono',monospace;font-size:11px;color:#666}
.ftr{padding:18px 48px;display:flex;justify-content:space-between;border-top:1px solid var(--bdr)}
.ftr span{font-family:'DM Mono',monospace;font-size:10px;color:var(--dim);letter-spacing:1px}
.fgold{color:var(--neon)}
@media print{body{background:#000;padding:0}.page{border:none}}`;
}

function modernLines(lines, code) {
  const taxed = hasTaxDetails({ lines });
  return (lines || []).map((l, i) => `
<tr>
  <td>${zeroPad(l.lineNo, i)}</td>
  <td><span class="idesc">${esc(l.description || '—')}</span></td>
  <td class="r">${l.quantity == null ? '—' : esc(l.quantity)}</td>
  <td class="r">${l.unitPrice == null ? '—' : Number(l.unitPrice).toLocaleString('en-US', {minimumFractionDigits:2})}</td>
  ${taxed ? taxColumnCells(l, code) : `<td class="r">${esc(fmtMoney(l.amount, code))}</td>`}
</tr>`).join('');
}

function renderModern(ctx) {
  const accent  = ctx.branding?.accentColor || '#111111';
  const neon    = ctx.branding?.goldColor   || '#e8ff47';
  const payload = ctx.payload || {};
  const code    = currency(payload);
  const org     = payload.organization || {};
  const cp      = payload.counterparty || {};
  const meta    = payload.meta || {};
  const sum     = payload.summary || {};

  const metaCells = [
    { l: 'Doc No',     v: meta.documentNo },
    { l: 'Issued',     v: fmtDate(meta.documentDate) },
    meta.dueDate        && { l: 'Due / Valid', v: fmtDate(meta.dueDate) },
    meta.reference      && { l: 'Ref',         v: meta.reference },
    meta.workflowStatus && { l: 'Workflow',     v: meta.workflowStatus },
  ].filter(Boolean).map(c => `<div class="mc"><div class="mlbl">${esc(c.l)}</div><div class="mval">${esc(c.v || '—')}</div></div>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>${esc(ctx.title)} — ${esc(meta.documentNo || '')}</title>
<style>${modernStyles(accent, neon)}</style></head><body>
<div class="page">
  <div class="hdr">
    <div class="htb">
      <div class="htitle">${esc(ctx.title)}</div>
      <div class="horg">${[org.name, org.email, org.phone].filter(Boolean).map(esc).join(' — ')}</div>
    </div>
    <div class="hmb">
      ${meta.documentNo ? `<div class="hdocno">${esc(meta.documentNo)}</div>` : ''}
      ${meta.status     ? `<div class="hstatus">${esc(meta.status).toUpperCase()}</div>` : ''}
    </div>
  </div>
  <div class="sec" style="padding:0">
    <div class="parties">
      <div class="party">
        <div class="plbl">${esc(ctx.title === 'Purchase Order' ? 'Vendor' : 'Client')}</div>
        <div class="pnm">${esc((cp.name || '—').toUpperCase())}</div>
        <div class="pdt">${[cp.email, cp.phone, joinAddress(cp.address)].filter(Boolean).join('<br/>')}</div>
      </div>
      <div class="party">
        <div class="plbl">Prepared By</div>
        <div class="pnm">${esc((org.name || '—').toUpperCase())}</div>
        <div class="pdt">${[org.email, org.phone, joinAddress(org.address)].filter(Boolean).join('<br/>')}</div>
      </div>
    </div>
  </div>
  <div class="sec" style="padding:0"><div class="mrow">${metaCells}</div></div>
  <div class="sec">
    <div class="slbl">Line Items</div>
    <table class="items">
      <thead><tr><th style="width:42px">#</th><th>Description</th><th class="r" style="width:70px">Qty</th><th class="r" style="width:120px">Unit Price</th>${hasTaxDetails(payload) ? taxColumnHeader() : `<th class="r" style="width:140px">Amount</th>`}</tr></thead>
      <tbody>${modernLines(payload.lines, code)}</tbody>
    </table>
    ${renderTaxSummary(sum, code, 'modern')}
  </div>
  <div class="totrow"><div class="tot"><table>
    <tr><td class="tl">SUBTOTAL</td><td>${esc(fmtMoney(sum.subtotal, code))}</td></tr>
    ${sum.tax      != null ? `<tr><td class="tl">TAX</td><td>${esc(fmtMoney(sum.tax, code))}</td></tr>` : ''}
    ${sum.discount != null ? `<tr><td class="tl">DISCOUNT</td><td>&#8722;${esc(fmtMoney(sum.discount, code))}</td></tr>` : ''}
    <tr class="tr"><td>TOTAL</td><td><span class="tamt">${esc(fmtMoney(sum.total, code))}</span></td></tr>
  </table></div></div>
  ${sum.memo ? `<div class="notes"><div class="plbl">Notes</div><p>${esc(sum.memo)}</p></div>` : ''}
  <div class="ftr"><span>PRINTED BY <strong>${esc(printActorLabel(payload))}</strong> · <span class="fgold">APTBOOKS</span></span><span>PAGE 01 / 01</span></div>
</div></body></html>`;
}


/* ─────────────────────────────────────────────────────────
   THEME 3 — COMPACT
   Japanese Minimalist · White · Vermillion · Noto Serif JP
───────────────────────────────────────────────────────── */

function compactStyles(red) {
  return `
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@300;400;600&family=Jost:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--red:${red};--bdr:#f0ece6;--mut:#999;--txt:#1a1a1a}
body{font-family:'Jost',Arial,sans-serif;background:#f7f5f2;color:var(--txt);padding:40px 24px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:800px;margin:0 auto;background:#fff}
.top{padding:52px 56px 0;display:flex;justify-content:space-between;align-items:flex-start}
.tmk{width:6px;height:52px;background:var(--red);flex-shrink:0;margin-right:24px}
.ttb{display:flex;align-items:flex-start}
.htitle{font-family:'Noto Serif JP',serif;font-size:38px;font-weight:600;color:var(--txt);letter-spacing:-1px;line-height:1}
.horg{font-size:12.5px;color:var(--mut);margin-top:10px;letter-spacing:.3px}
.hdocno{font-size:12px;color:var(--red);letter-spacing:2px;font-weight:500;margin-bottom:8px;text-align:right}
.hbadge{display:inline-block;padding:4px 12px;border:1px solid var(--red);color:var(--red);font-size:10px;font-weight:500;letter-spacing:2px;text-transform:uppercase}
.div1{height:1px;background:var(--bdr);margin:36px 56px 0}
.redline{height:2px;background:var(--red);width:48px;margin:0 56px}
.body{padding:36px 56px 52px}
.parties{display:grid;grid-template-columns:1fr 1fr;margin-bottom:40px}
.party{padding:24px 0;border-bottom:1px solid var(--bdr)}
.party:last-child{padding-left:32px;border-left:1px solid var(--bdr)}
.plbl{font-size:9px;font-weight:500;letter-spacing:2.5px;text-transform:uppercase;color:var(--red);margin-bottom:10px}
.pnm{font-family:'Noto Serif JP',serif;font-size:16px;font-weight:600;color:var(--txt);margin-bottom:5px}
.pdt{font-size:12px;color:var(--mut);line-height:1.9}
.meta{display:flex;gap:0;margin-bottom:40px;border-bottom:1px solid var(--bdr)}
.mc{padding:16px 24px 16px 0;margin-right:24px;border-right:1px solid var(--bdr)}.mc:last-child{border-right:none}
.mlbl{font-size:9px;font-weight:500;letter-spacing:2px;text-transform:uppercase;color:#bbb;margin-bottom:5px}
.mval{font-size:13.5px;font-weight:500;color:var(--txt)}
table.items{width:100%;border-collapse:collapse;margin-bottom:4px}
.items thead tr{border-bottom:1px solid var(--txt)}
.items th{font-size:9px;font-weight:500;letter-spacing:2px;text-transform:uppercase;color:#bbb;padding:0 12px 10px;text-align:left}
.items th:first-child{padding-left:0}.items th:last-child{text-align:right;padding-right:0}.items th.r{text-align:right}
.items tbody tr{border-bottom:1px solid var(--bdr)}.items tbody tr:last-child{border-bottom:none}
.items td{padding:14px 12px;font-size:13px}
.items td:first-child{padding-left:0;font-size:11px;color:#ccc}
.items td:last-child{padding-right:0;text-align:right;font-weight:500}
.items td.r{text-align:right}.idesc{color:var(--txt);font-weight:500}
.totals{display:flex;justify-content:flex-end;margin-top:24px;padding-top:24px;border-top:1px solid var(--bdr)}
.tot{width:260px}.tot table{width:100%;border-collapse:collapse}
.tot td{padding:6px 0;font-size:13px}.tot td:last-child{text-align:right}
.tl{color:#aaa}.tot tr.tr td{border-top:1px solid var(--txt);padding-top:12px;font-weight:600;color:var(--red)}
.tamt{font-family:'Noto Serif JP',serif;font-size:22px;font-weight:600}
.notes{margin-top:32px;padding:18px 0 18px 20px;border-left:2px solid var(--red)}
.notes p{font-size:12.5px;color:var(--mut);line-height:1.8;margin-top:6px}
.ftr{margin-top:48px;padding-top:20px;border-top:1px solid var(--bdr);display:flex;justify-content:space-between;font-size:11px;color:#ccc}
.fred{color:var(--red);font-weight:500}
@media print{body{background:#fff;padding:0}}`;
}

function compactLines(lines, code) {
  const taxed = hasTaxDetails({ lines });
  return (lines || []).map((l, i) => `
<tr>
  <td>${zeroPad(l.lineNo, i)}</td>
  <td><span class="idesc">${esc(l.description || '—')}</span></td>
  <td class="r">${l.quantity == null ? '—' : esc(l.quantity)}</td>
  <td class="r">${l.unitPrice == null ? '—' : Number(l.unitPrice).toLocaleString('en-US', {minimumFractionDigits:2})}</td>
  ${taxed ? taxColumnCells(l, code) : `<td class="r">${esc(fmtMoney(l.amount, code))}</td>`}
</tr>`).join('');
}

function renderCompact(ctx) {
  const red     = ctx.branding?.accentColor || '#c0392b';
  const payload = ctx.payload || {};
  const code    = currency(payload);
  const org     = payload.organization || {};
  const cp      = payload.counterparty || {};
  const meta    = payload.meta || {};
  const sum     = payload.summary || {};

  const metaCells = [
    { l: 'Date',          v: fmtDate(meta.documentDate) },
    meta.dueDate        && { l: 'Due / Deliver', v: fmtDate(meta.dueDate) },
    meta.reference      && { l: 'Reference',     v: meta.reference },
    meta.workflowStatus && { l: 'Workflow',       v: meta.workflowStatus },
  ].filter(Boolean).map(c => `<div class="mc"><div class="mlbl">${esc(c.l)}</div><div class="mval">${esc(c.v || '—')}</div></div>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>${esc(ctx.title)} — ${esc(meta.documentNo || '')}</title>
<style>${compactStyles(red)}</style></head><body>
<div class="page">
  <div class="top">
    <div class="ttb">
      <div class="tmk"></div>
      <div>
        <div class="htitle">${esc(ctx.title)}</div>
        <div class="horg">${[org.name, org.email, org.phone].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
    </div>
    <div>
      ${meta.documentNo ? `<div class="hdocno">${esc(meta.documentNo)}</div>` : ''}
      ${meta.status     ? `<div style="text-align:right"><div class="hbadge">${esc(meta.status)}</div></div>` : ''}
    </div>
  </div>
  <div class="div1"></div>
  <div class="redline"></div>
  <div class="body">
    <div class="parties">
      <div class="party">
        <div class="plbl">${esc(ctx.title === 'Purchase Order' ? 'Vendor' : 'Bill To')}</div>
        <div class="pnm">${esc(cp.name || '—')}</div>
        <div class="pdt">${[cp.email, cp.phone, joinAddress(cp.address)].filter(Boolean).join('<br/>')}</div>
      </div>
      <div class="party">
        <div class="plbl">${esc(ctx.title === 'Purchase Order' ? 'Ship To' : 'Issued By')}</div>
        <div class="pnm">${esc(org.name || '—')}</div>
        <div class="pdt">${[org.email, org.phone, joinAddress(org.address)].filter(Boolean).join('<br/>')}</div>
      </div>
    </div>
    <div class="meta">${metaCells}</div>
    <table class="items">
      <thead><tr><th style="width:38px">#</th><th>Item</th><th class="r" style="width:70px">Qty</th><th class="r" style="width:120px">Unit Price</th>${hasTaxDetails(payload) ? taxColumnHeader() : `<th class="r" style="width:130px">Amount</th>`}</tr></thead>
      <tbody>${compactLines(payload.lines, code)}</tbody>
    </table>
    ${renderTaxSummary(sum, code, 'compact')}
    <div class="totals"><div class="tot"><table>
      <tr><td class="tl">Subtotal</td><td>${esc(fmtMoney(sum.subtotal, code))}</td></tr>
      ${sum.tax      != null ? `<tr><td class="tl">Tax / Shipping</td><td>${esc(fmtMoney(sum.tax, code))}</td></tr>` : ''}
      ${sum.discount != null ? `<tr><td class="tl">Discount</td><td>&#8722;${esc(fmtMoney(sum.discount, code))}</td></tr>` : ''}
      <tr class="tr"><td>Total</td><td><span class="tamt">${esc(fmtMoney(sum.total, code))}</span></td></tr>
    </table></div></div>
    ${sum.memo ? `<div class="notes"><div class="plbl">Notes</div><p>${esc(sum.memo)}</p></div>` : ''}
    ${ctx.branding?.showSignatureBlock !== false ? renderSignatureBlocks(payload.signatures, 'modern') : ''}
    <div class="ftr"><span>Printed by <strong>${esc(printActorLabel(payload))}</strong> · <span class="fred">AptBooks</span></span><span>Page 1 of 1</span></div>
  </div>
</div></body></html>`;
}


/* ─────────────────────────────────────────────────────────
   THEME 4 — CORPORATE
   Art Deco Opulence · Deep Burgundy · Champagne · Cinzel
───────────────────────────────────────────────────────── */

function corpStyles(burg, champ) {
  return `
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Jost:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--burg:${burg};--champ:${champ};--bdr:#e0d5c0;--bg:#fff8ec;--mut:#8a7060;--txt:#3d0d0d}
body{font-family:'Jost',Arial,sans-serif;background:#1a0a0a;color:var(--txt);padding:40px 24px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:860px;margin:0 auto;background:#fdf8f0;box-shadow:0 16px 80px rgba(0,0,0,.5),0 4px 16px rgba(0,0,0,.3);overflow:hidden}
.deco-top{height:8px;background:repeating-linear-gradient(90deg,var(--burg) 0px,var(--burg) 20px,var(--champ) 20px,var(--champ) 22px,var(--burg) 22px,var(--burg) 42px)}
.hdr{background:var(--burg);padding:44px 52px 40px}
.hinner{display:flex;justify-content:space-between;align-items:center}
.htitle{font-family:'Cinzel',serif;font-size:40px;color:var(--champ);letter-spacing:6px;text-transform:uppercase}
.hsubtitle{font-family:'Cinzel',serif;font-size:11px;color:rgba(212,175,112,.5);letter-spacing:5px;text-transform:uppercase;margin-top:6px}
.hdocno{font-family:'Cinzel',serif;font-size:13px;color:var(--champ);letter-spacing:3px;margin-bottom:10px;text-align:right}
.hstatus{display:inline-block;padding:5px 18px;background:var(--champ);color:var(--burg);font-family:'Cinzel',serif;font-size:10px;font-weight:600;letter-spacing:3px;text-transform:uppercase}
.decohr{height:1px;background:linear-gradient(90deg,transparent,var(--champ),transparent);margin:20px 0 0}
.decostrip{height:4px;background:linear-gradient(90deg,var(--champ) 0%,#f0d882 30%,var(--champ) 60%,#f0d882 85%,var(--champ) 100%)}
.body{padding:44px 52px;background:#fdf8f0}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:36px}
.party{padding:24px 26px;border:1px solid var(--bdr);background:var(--bg);position:relative}
.party::before,.party::after{content:'\\25C6';position:absolute;font-size:7px;color:var(--champ)}
.party::before{top:8px;left:8px}.party::after{bottom:8px;right:8px}
.plbl{font-family:'Cinzel',serif;font-size:8px;letter-spacing:3px;color:var(--champ);text-transform:uppercase;margin-bottom:10px}
.pnm{font-family:'Cinzel',serif;font-size:16px;color:var(--txt);margin-bottom:5px}
.pdt{font-size:12.5px;color:var(--mut);line-height:1.75}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:18px;margin-bottom:36px}
.mc{padding:16px 18px;border:1px solid var(--bdr);background:var(--bg)}
.mlbl{font-family:'Cinzel',serif;font-size:8px;letter-spacing:2.5px;color:#c4a870;text-transform:uppercase;margin-bottom:6px}
.mval{font-size:14px;font-weight:500;color:var(--txt)}
.sttl{font-family:'Cinzel',serif;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#c4a870;margin-bottom:12px;display:flex;align-items:center;gap:14px}
.sttl span{flex:1;height:1px;background:var(--bdr)}
table.items{width:100%;border-collapse:collapse}
.items thead tr{border-bottom:2px solid var(--txt)}
.items th{font-family:'Cinzel',serif;font-size:8px;letter-spacing:2px;text-transform:uppercase;color:var(--mut);padding:0 14px 10px;text-align:left}
.items th:first-child{padding-left:0}.items th:last-child{text-align:right;padding-right:0}.items th.r{text-align:right}
.items tbody tr{border-bottom:1px solid #ece4d0}.items tbody tr:last-child{border-bottom:none}
.items td{padding:14px 14px;font-size:13.5px}
.items td:first-child{padding-left:0;font-size:11px;color:#c4a870}
.items td:last-child{padding-right:0;text-align:right;font-weight:500}
.items td.r{text-align:right}.idesc{font-weight:500;color:var(--txt)}
.totals{display:flex;justify-content:flex-end;margin-top:20px}
.tot{width:300px}.tot table{width:100%;border-collapse:collapse}
.tot td{padding:7px 0;font-size:13.5px}.tot td:last-child{text-align:right}
.tl{color:var(--mut)}.tot tr.tr td{border-top:2px solid var(--txt);padding-top:14px;font-weight:700;color:var(--txt)}
.tamt{font-family:'Cinzel',serif;font-size:22px;color:var(--txt)}
.notes{margin-top:28px;padding:18px 22px;border:1px solid var(--bdr);background:var(--bg);position:relative}
.notes::before,.notes::after{content:'\\25C6';position:absolute;font-size:7px;color:var(--champ)}
.notes::before{top:8px;left:8px}.notes::after{bottom:8px;right:8px}
.notes p{font-size:13px;color:var(--mut);line-height:1.75;margin-top:6px}
.sig{margin-top:44px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:40px}
.sigline{padding-top:14px;border-top:1px solid #c4a870;min-height:112px}
.sigimg{display:block;max-width:180px;max-height:56px;object-fit:contain;margin:0 0 10px 0}
.siglbl{font-family:'Cinzel',serif;font-size:9px;letter-spacing:2px;color:#c4a870;text-transform:uppercase}
.signame{margin-top:8px;font-weight:600;color:var(--txt)}
.sigtitle{margin-top:4px;font-size:11px;color:var(--mut)}
.ftr{padding:18px 52px;background:var(--burg);border-top:1px solid #5a1a1a;display:flex;justify-content:space-between;align-items:center}
.ftr span{font-family:'Cinzel',serif;font-size:9px;letter-spacing:2px;color:rgba(212,175,112,.5);text-transform:uppercase}
.fchamp{color:var(--champ)}
@media print{body{background:#fff;padding:0}.page{box-shadow:none}}`;
}

function corpLines(lines, code) {
  const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];
  const taxed = hasTaxDetails({ lines });
  return (lines || []).map((l, i) => `
<tr>
  <td>${ROMAN[i] || zeroPad(l.lineNo, i)}</td>
  <td><span class="idesc">${esc(l.description || '—')}</span></td>
  <td class="r">${l.quantity == null ? '—' : esc(l.quantity)}</td>
  <td class="r">${l.unitPrice == null ? '—' : Number(l.unitPrice).toLocaleString('en-US', {minimumFractionDigits:2})}</td>
  ${taxed ? taxColumnCells(l, code) : `<td class="r">${esc(fmtMoney(l.amount, code))}</td>`}
</tr>`).join('');
}

function renderCorporate(ctx) {
  const burg    = ctx.branding?.accentColor || '#3d0d0d';
  const champ   = ctx.branding?.goldColor   || '#d4af70';
  const showSig = ctx.branding?.showSignatureBlock !== false;
  const payload = ctx.payload || {};
  const code    = currency(payload);
  const org     = payload.organization || {};
  const cp      = payload.counterparty || {};
  const meta    = payload.meta || {};
  const sum     = payload.summary || {};

  const metaCells = [
    { l: 'Invoice Date', v: fmtDate(meta.documentDate) },
    meta.dueDate        && { l: 'Payment Due', v: fmtDate(meta.dueDate) },
    meta.reference      && { l: 'Reference',   v: meta.reference },
    meta.workflowStatus && { l: 'Workflow',     v: meta.workflowStatus },
  ].filter(Boolean).map(c => `<div class="mc"><div class="mlbl">${esc(c.l)}</div><div class="mval">${esc(c.v || '—')}</div></div>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>${esc(ctx.title)} — ${esc(meta.documentNo || '')}</title>
<style>${corpStyles(burg, champ)}</style></head><body>
<div class="page">
  <div class="deco-top"></div>
  <div class="hdr">
    <div class="hinner">
      <div>
        <div class="htitle">${esc(ctx.title)}</div>
        <div class="hsubtitle">${esc(org.name || '')}</div>
        <div class="decohr"></div>
      </div>
      <div>
        ${meta.documentNo ? `<div class="hdocno">&#8470; ${esc(meta.documentNo)}</div>` : ''}
        ${meta.status     ? `<div style="text-align:right"><div class="hstatus">${esc(meta.status)}</div></div>` : ''}
      </div>
    </div>
  </div>
  <div class="decostrip"></div>
  <div class="body">
    <div class="parties">
      <div class="party">
        <div class="plbl">Billed To</div>
        <div class="pnm">${esc(cp.name || '—')}</div>
        <div class="pdt">${[cp.email, cp.phone, joinAddress(cp.address)].filter(Boolean).join('<br/>')}</div>
      </div>
      <div class="party">
        <div class="plbl">Remit To</div>
        <div class="pnm">${esc(org.name || '—')}</div>
        <div class="pdt">${[org.email, org.phone, joinAddress(org.address)].filter(Boolean).join('<br/>')}</div>
      </div>
    </div>
    <div class="meta">${metaCells}</div>
    <div class="sttl">Services Rendered <span></span></div>
    <table class="items">
      <thead><tr><th style="width:42px">#</th><th>Description</th><th class="r" style="width:70px">Qty</th><th class="r" style="width:130px">Unit Price</th>${hasTaxDetails(payload) ? taxColumnHeader() : `<th class="r" style="width:140px">Amount</th>`}</tr></thead>
      <tbody>${corpLines(payload.lines, code)}</tbody>
    </table>
    ${renderTaxSummary(sum, code, 'corporate')}
    <div class="totals"><div class="tot"><table>
      <tr><td class="tl">Subtotal</td><td>${esc(fmtMoney(sum.subtotal, code))}</td></tr>
      ${sum.tax      != null ? `<tr><td class="tl">VAT / Tax</td><td>${esc(fmtMoney(sum.tax, code))}</td></tr>` : ''}
      ${sum.discount != null ? `<tr><td class="tl">Discount</td><td>&#8722;${esc(fmtMoney(sum.discount, code))}</td></tr>` : ''}
      <tr class="tr"><td>Total Due</td><td><span class="tamt">${esc(fmtMoney(sum.total, code))}</span></td></tr>
    </table></div></div>
    ${sum.memo ? `<div class="notes"><div class="plbl">Notes &amp; Terms</div><p>${esc(sum.memo)}</p></div>` : ''}
    ${showSig ? renderSignatureBlocks(payload.signatures, 'corporate') : ''}
  </div>
  <div class="ftr">
    <span>Printed by <strong>${esc(printActorLabel(payload))}</strong> · <span class="fchamp">AptBooks</span></span>
    <span>Page 1 of 1</span>
  </div>
</div></body></html>`;
}



/* ─────────────────────────────────────────────────────────
   JOURNAL LEDGER — template-aware accounting print
───────────────────────────────────────────────────────── */
function renderJournalLedger(ctx) {
  const payload = ctx.payload || {};
  const org = payload.organization || {};
  const meta = payload.meta || {};
  const sum = payload.summary || {};
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const code = currency(payload);
  const theme = String(ctx.themeKey || 'classic').toLowerCase();
  const palettes = {
    classic: { primary: '#10233f', accent: '#c5a45c', soft: '#f8f5ee', text: '#172033', muted: '#64748b' },
    modern: { primary: '#0a0a0a', accent: '#b7f34a', soft: '#f3f4f6', text: '#0a0a0a', muted: '#52525b' },
    compact: { primary: '#263238', accent: '#d34b3f', soft: '#faf8f5', text: '#1f2937', muted: '#6b7280' },
    corporate: { primary: '#451723', accent: '#d6bd86', soft: '#fbf7ef', text: '#2b1720', muted: '#75636a' }
  };
  const pal = palettes[theme] || palettes.classic;
  const accent = ctx.branding?.accentColor || pal.accent;
  const debitTotal = String(sum.debitTotal || '0.00');
  const creditTotal = String(sum.creditTotal || '0.00');
  const difference = String(sum.difference || '0.00');
  const printedBy = printActorLabel(payload);
  const printDate = payload.printContext?.printedAt ? fmtDate(payload.printContext.printedAt) : fmtDate(new Date().toISOString());
  const organizationContact = [org.email, org.phone].filter(Boolean).map(esc).join(' · ');
  const organizationAddress = joinAddress(org.address);
  const rows = lines.map((line, idx) => {
    const fx = line.currencyCode && line.currencyCode !== code
      ? `<div class="fx">${esc(line.currencyCode)} · FX ${esc(line.fxRate || '—')}</div>` : '';
    return `<tr>
      <td class="no">${zeroPad(line.lineNo, idx)}</td>
      <td><div class="acct">${esc([line.accountCode, line.accountName].filter(Boolean).join(' — ') || line.accountId || 'Account')}</div>${line.description ? `<div class="desc">${esc(line.description)}</div>` : ''}${fx}</td>
      <td class="money">${nonZeroMoney(line.debit) ? esc(fmtMoneyExact(line.debit, code)) : '—'}</td>
      <td class="money">${nonZeroMoney(line.credit) ? esc(fmtMoneyExact(line.credit, code)) : '—'}</td>
    </tr>`;
  }).join('');
  const signatures = (payload.signatures || []).map((sig) => `<div class="sigbox">
      <div class="sigspace">${sig?.image ? `<img src="${esc(sig.image)}" alt="${esc(sig.label || 'Signature')}"/>` : ''}</div>
      <div class="siglabel">${esc(sig?.label || 'Signatory')}</div>
      <div class="signame">${esc(sig?.name || '—')}</div>
      ${sig?.title ? `<div class="sigtitle">${esc(sig.title)}</div>` : ''}
    </div>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>Journal Entry — ${esc(meta.documentNo || '')}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef1f5;color:${pal.text};-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{width:min(940px,calc(100% - 36px));margin:28px auto;background:#fff;box-shadow:0 18px 55px rgba(15,23,42,.13);border-radius:18px;overflow:hidden}
.hero{background:${pal.primary};color:#fff;padding:36px 42px 32px;position:relative;overflow:hidden}.hero:after{content:"";position:absolute;width:260px;height:260px;border:48px solid ${accent};opacity:.17;border-radius:50%;right:-92px;top:-125px}
.heroTop{display:flex;justify-content:space-between;gap:28px;align-items:flex-start;position:relative;z-index:1}.eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.24em;color:${accent};font-weight:800}.title{font-size:36px;font-weight:750;letter-spacing:-.035em;margin:7px 0 8px}.org{font-size:13px;color:rgba(255,255,255,.76)}.orgContact{margin-top:9px;max-width:520px;font-size:10.5px;line-height:1.55;color:rgba(255,255,255,.54)}
.docNo{text-align:right}.docNo strong{display:block;font-size:22px;letter-spacing:.02em}.badge{display:inline-flex;margin-top:10px;padding:5px 11px;border-radius:999px;background:${accent};color:${pal.primary};font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.12em}
.body{padding:34px 42px 30px}.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:26px}.metaCard{background:${pal.soft};border:1px solid #e5e7eb;border-radius:12px;padding:13px 14px}.ml{font-size:9px;text-transform:uppercase;letter-spacing:.15em;color:${pal.muted};font-weight:800}.mv{margin-top:6px;font-size:13px;font-weight:750;color:${pal.text}}
.memo{margin:0 0 24px;padding:14px 16px;border-left:4px solid ${accent};background:${pal.soft};border-radius:0 10px 10px 0}.memoLabel{font-size:9px;text-transform:uppercase;letter-spacing:.15em;color:${pal.muted};font-weight:800}.memoText{margin-top:5px;font-size:13px;line-height:1.55}
.tableWrap{border:1px solid #e2e8f0;border-radius:14px;overflow:hidden}table{width:100%;border-collapse:collapse}thead{background:#f8fafc}th{padding:12px 14px;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0}.right{text-align:right}td{padding:15px 14px;border-bottom:1px solid #edf0f4;vertical-align:top;font-size:12.5px}.no{width:52px;color:#94a3b8;font-variant-numeric:tabular-nums}.acct{font-weight:760;color:${pal.text}}.desc{margin-top:4px;color:${pal.muted};line-height:1.45}.fx{margin-top:5px;font-size:10px;color:${pal.muted};font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.money{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:650}
tfoot td{background:${pal.soft};border-bottom:0;font-weight:800}.balanced{display:inline-flex;align-items:center;gap:7px;color:#15803d;font-size:11px}.dot{width:7px;height:7px;border-radius:50%;background:#22c55e}
.summary{display:grid;grid-template-columns:1fr 330px;gap:22px;margin-top:22px;align-items:start}.stamp{border:1px dashed #cbd5e1;border-radius:12px;padding:14px;color:${pal.muted};font-size:11px;line-height:1.6}.stamp strong{color:${pal.text}}.totals{border-radius:14px;background:${pal.primary};color:#fff;padding:18px 20px}.totRow{display:flex;justify-content:space-between;gap:20px;padding:7px 0;font-size:12px;color:rgba(255,255,255,.72)}.totRow strong{color:#fff}.totRow.final{border-top:1px solid rgba(255,255,255,.2);margin-top:6px;padding-top:14px;font-size:15px}.totRow.final strong{font-size:20px;color:${accent}}
.sigs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:30px;margin-top:40px}.sigbox{border-top:1px solid #cbd5e1;padding-top:10px;min-height:102px}.sigspace{height:46px;margin-top:-54px;margin-bottom:7px}.sigspace img{max-height:44px;max-width:170px;object-fit:contain}.siglabel{font-size:9px;text-transform:uppercase;letter-spacing:.14em;color:${pal.muted};font-weight:800}.signame{margin-top:6px;font-size:12px;font-weight:760}.sigtitle{margin-top:3px;font-size:10px;color:${pal.muted}}
.footer{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-top:30px;padding-top:16px;border-top:1px solid #e5e7eb;color:${pal.muted};font-size:10px}.footer strong{color:${pal.text}}
@media(max-width:700px){.sheet{width:100%;margin:0;border-radius:0}.hero,.body{padding-left:22px;padding-right:22px}.meta{grid-template-columns:1fr 1fr}.summary{grid-template-columns:1fr}.heroTop{flex-direction:column}.docNo{text-align:left}}
@media print{@page{size:A4;margin:10mm}body{background:#fff}.sheet{width:100%;margin:0;box-shadow:none;border-radius:0}.hero{break-inside:avoid}.tableWrap,.summary,.sigs{break-inside:avoid}}
</style></head><body><div class="sheet">
  <section class="hero"><div class="heroTop"><div><div class="eyebrow">General Ledger</div><div class="title">Journal Entry</div><div class="org">${esc(org.name || 'Organization')} · Base currency ${esc(code)}</div>${organizationContact || organizationAddress ? `<div class="orgContact">${organizationContact}${organizationContact && organizationAddress ? '<br/>' : ''}${organizationAddress}</div>` : ''}</div><div class="docNo"><div class="eyebrow">Entry number</div><strong># ${esc(meta.documentNo || '—')}</strong><span class="badge">${esc(meta.status || 'draft')}</span></div></div></section>
  <main class="body">
    <div class="meta"><div class="metaCard"><div class="ml">Entry date</div><div class="mv">${esc(fmtDate(meta.documentDate))}</div></div><div class="metaCard"><div class="ml">Journal type</div><div class="mv">${esc(meta.reference || 'General')}</div></div><div class="metaCard"><div class="ml">Currency</div><div class="mv">${esc(code)}</div></div><div class="metaCard"><div class="ml">Status</div><div class="mv">${esc(meta.status || '—')}</div></div></div>
    ${sum.memo ? `<div class="memo"><div class="memoLabel">Memo</div><div class="memoText">${esc(sum.memo)}</div></div>` : ''}
    <div class="tableWrap"><table><thead><tr><th>#</th><th>Account / description</th><th class="right">Debit</th><th class="right">Credit</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No lines</td></tr>'}</tbody><tfoot><tr><td></td><td><span class="balanced"><span class="dot"></span>${sum.balanced !== false ? 'Balanced journal' : 'Check balance'}</span></td><td class="money">${esc(fmtMoneyExact(debitTotal, code))}</td><td class="money">${esc(fmtMoneyExact(creditTotal, code))}</td></tr></tfoot></table></div>
    <div class="summary"><div class="stamp">This printout is generated from the immutable accounting journal record. <strong>Printed by ${esc(printedBy)}</strong> on ${esc(printDate)}.</div><div class="totals"><div class="totRow"><span>Total debits</span><strong>${esc(fmtMoneyExact(debitTotal, code))}</strong></div><div class="totRow"><span>Total credits</span><strong>${esc(fmtMoneyExact(creditTotal, code))}</strong></div><div class="totRow final"><span>Difference</span><strong>${esc(fmtMoneyExact(difference, code))}</strong></div></div></div>
    ${signatures ? `<div class="sigs">${signatures}</div>` : ''}
    <div class="footer"><span>Printed by <strong>${esc(printedBy)}</strong></span><span>AptBooks · Journal ${esc(meta.documentNo || '')}</span></div>
  </main>
</div></body></html>`;
}

module.exports = { renderClassic, renderModern, renderCompact, renderCorporate, renderJournalLedger };
