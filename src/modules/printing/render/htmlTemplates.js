
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(value, currencyCode) {
  const amount = Number(value || 0);
  return `${currencyCode || ''} ${amount.toFixed(2)}`.trim();
}

function joinAddress(address) {
  if (!address) return '';
  return [address.line1, address.line2, address.city, address.region, address.postalCode, address.country]
    .filter(Boolean)
    .map(esc)
    .join('<br/>');
}

function renderTableRows(lines, currencyCode) {
  return (lines || []).map((line) => `
    <tr>
      <td>${esc(line.lineNo)}</td>
      <td>${esc(line.description || '')}</td>
      <td style="text-align:right;">${line.quantity == null ? '' : esc(line.quantity)}</td>
      <td style="text-align:right;">${line.unitPrice == null ? '' : esc(Number(line.unitPrice).toFixed(2))}</td>
      <td style="text-align:right;">${esc(fmtMoney(line.amount, currencyCode))}</td>
    </tr>
  `).join('');
}

function commonStyles(accentColor, density = 'comfortable') {
  const pad = density === 'tight' ? '8px' : '12px';
  const font = density === 'tight' ? '12px' : '13px';
  return `
    body { font-family: Arial, sans-serif; color: #0f172a; margin: 0; background: #fff; }
    .page { width: 100%; max-width: 960px; margin: 0 auto; padding: 28px; box-sizing: border-box; }
    .accent { color: ${accentColor}; }
    .top-rule { height: 6px; background: ${accentColor}; border-radius: 6px; margin-bottom: 20px; }
    h1 { margin: 0; font-size: 28px; }
    .muted { color: #475569; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .panel { border: 1px solid #e2e8f0; border-radius: 10px; padding: ${pad}; background: #fff; }
    .meta-table td { padding: 4px 0; vertical-align: top; }
    table.doc-table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: ${font}; }
    .doc-table th { text-align: left; background: #f8fafc; border-bottom: 1px solid #cbd5e1; padding: ${pad}; }
    .doc-table td { border-bottom: 1px solid #e2e8f0; padding: ${pad}; }
    .totals { margin-top: 18px; width: 320px; margin-left: auto; }
    .totals td { padding: 6px 0; }
    .totals .strong { font-weight: 700; border-top: 2px solid #0f172a; }
    .footer { margin-top: 28px; font-size: 12px; color: #64748b; }
    .signature { margin-top: 36px; display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
    .signature .line { border-top: 1px solid #94a3b8; margin-top: 28px; padding-top: 6px; font-size: 12px; color: #475569; }
    .badge { display: inline-block; padding: 5px 10px; border-radius: 999px; background: #eff6ff; color: ${accentColor}; font-size: 12px; font-weight: 700; }
  `;
}

function renderBase({ title, payload, accentColor = '#0f172a', density = 'comfortable', headerVariant = 'classic', showSignatureBlock = true }) {
  const currencyCode = payload?.meta?.currencyCode || payload?.organization?.base_currency_code || 'GHS';
  const org = payload.organization || {};
  const cp = payload.counterparty || {};
  const meta = payload.meta || {};
  const summary = payload.summary || {};
  const address = joinAddress(cp.address);

  const header = headerVariant === 'split'
    ? `
      <div style="display:flex; justify-content:space-between; gap:24px; align-items:flex-start; margin-bottom:20px;">
        <div>
          <h1 class="accent">${esc(title)}</h1>
          <div class="muted" style="margin-top:8px;">${esc(org.name || '')}</div>
          <div class="muted">${esc(org.email || '')} ${org.phone ? '· ' + esc(org.phone) : ''}</div>
        </div>
        <div style="text-align:right;">
          <div class="badge">${esc(meta.status || 'draft')}</div>
          <div style="margin-top:10px; font-size:12px;" class="muted">Workflow: ${esc(meta.workflowStatus || 'n/a')}</div>
        </div>
      </div>`
    : `
      <div class="top-rule"></div>
      <h1 class="accent">${esc(title)}</h1>
      <div class="muted" style="margin-top:6px;">${esc(org.name || '')}</div>
      <div class="muted">${esc(org.email || '')} ${org.phone ? '· ' + esc(org.phone) : ''}</div>
    `;

  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>${esc(title)}</title>
    <style>${commonStyles(accentColor, density)}</style>
  </head>
  <body>
    <div class="page">
      ${header}
      <div class="grid" style="margin-top:18px;">
        <div class="panel">
          <div style="font-weight:700; margin-bottom:8px;">Counterparty</div>
          <div>${esc(cp.name || '—')}</div>
          ${cp.email ? `<div class="muted">${esc(cp.email)}</div>` : ''}
          ${cp.phone ? `<div class="muted">${esc(cp.phone)}</div>` : ''}
          ${address ? `<div class="muted" style="margin-top:8px;">${address}</div>` : ''}
        </div>
        <div class="panel">
          <table class="meta-table">
            <tr><td><strong>Document No</strong></td><td>${esc(meta.documentNo || '—')}</td></tr>
            <tr><td><strong>Date</strong></td><td>${esc(meta.documentDate || '—')}</td></tr>
            ${meta.dueDate ? `<tr><td><strong>Due Date</strong></td><td>${esc(meta.dueDate)}</td></tr>` : ''}
            ${meta.reference ? `<tr><td><strong>Reference</strong></td><td>${esc(meta.reference)}</td></tr>` : ''}
            ${meta.workflowStatus ? `<tr><td><strong>Workflow</strong></td><td>${esc(meta.workflowStatus)}</td></tr>` : ''}
          </table>
        </div>
      </div>

      <table class="doc-table">
        <thead>
          <tr>
            <th style="width:60px;">#</th>
            <th>Description</th>
            <th style="width:100px; text-align:right;">Qty</th>
            <th style="width:120px; text-align:right;">Unit Price</th>
            <th style="width:140px; text-align:right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${renderTableRows(payload.lines || [], currencyCode)}
        </tbody>
      </table>

      <table class="totals">
        <tr><td>Subtotal</td><td style="text-align:right;">${esc(fmtMoney(summary.subtotal, currencyCode))}</td></tr>
        <tr class="strong"><td>Total</td><td style="text-align:right; font-weight:700;">${esc(fmtMoney(summary.total, currencyCode))}</td></tr>
      </table>

      ${summary.memo ? `<div class="panel" style="margin-top:18px;"><div style="font-weight:700; margin-bottom:8px;">Notes</div><div class="muted">${esc(summary.memo)}</div></div>` : ''}

      ${showSignatureBlock ? `
      <div class="signature">
        <div><div class="line">Prepared by</div></div>
        <div><div class="line">Authorized by</div></div>
      </div>` : ''}

      <div class="footer">Generated by AptBooks document templates.</div>
    </div>
  </body>
  </html>`;
}

function renderClassic(ctx) {
  return renderBase({ title: ctx.title, payload: ctx.payload, accentColor: ctx.branding.accentColor || '#0f172a', density: ctx.layout.density || 'comfortable', headerVariant: 'classic', showSignatureBlock: ctx.branding.showSignatureBlock !== false });
}
function renderModern(ctx) {
  return renderBase({ title: ctx.title, payload: ctx.payload, accentColor: ctx.branding.accentColor || '#2563eb', density: ctx.layout.density || 'comfortable', headerVariant: 'split', showSignatureBlock: ctx.branding.showSignatureBlock === true });
}
function renderCompact(ctx) {
  return renderBase({ title: ctx.title, payload: ctx.payload, accentColor: ctx.branding.accentColor || '#334155', density: 'tight', headerVariant: 'split', showSignatureBlock: false });
}
function renderCorporate(ctx) {
  return renderBase({ title: ctx.title, payload: ctx.payload, accentColor: ctx.branding.accentColor || '#111827', density: ctx.layout.density || 'comfortable', headerVariant: 'classic', showSignatureBlock: true });
}

module.exports = { renderClassic, renderModern, renderCompact, renderCorporate };
