const fs = require('fs');
const path = require('path');
const SRC = path.resolve(__dirname, '../..');
function read(relative) { return fs.readFileSync(path.join(SRC, relative), 'utf8'); }
function readTaxRouteSources() {
  const dir = path.join(SRC, 'core/accounting/tax');
  const modules = fs.readdirSync(dir).filter((name) => /^tax-(?:setup|compliance|returns|withholding)\.routes\.js$/.test(name)).sort();
  return [read('core/accounting/tax/tax.routes.js'), ...modules.map((name) => read(`core/accounting/tax/${name}`))].join('\n');
}
module.exports = { readTaxRouteSources };
