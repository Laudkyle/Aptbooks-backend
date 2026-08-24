const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const findings = [];
const ignoredDirs = new Set(['node_modules', '.git']);
const ignoredFile = /(?:\.example$|PHASE1_PRODUCTION_HARDENING\.md$)/i;
const patterns = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['aws_access_key', /AKIA[0-9A-Z]{16}/],
  ['stripe_live_secret', /sk_live_[0-9A-Za-z]{20,}/],
  ['github_token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['jwt_literal', /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/],
];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(?:js|jsx|ts|tsx|json|sql|sh|env|md)$/i.test(e.name) && !ignoredFile.test(e.name)) scan(p);
  }
}
function scan(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [kind, rx] of patterns) {
    if (rx.test(text)) findings.push({ file: path.relative(root, file), kind });
  }
}
walk(root);
console.log(JSON.stringify({ findings: findings.length, items: findings }, null, 2));
if (findings.length) process.exitCode = 1;
