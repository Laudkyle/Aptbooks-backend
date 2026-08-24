const fs = require('fs');
const path = require('path');
const cp = require('child_process');

let dir = path.resolve(__dirname, '..');
while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
if (!fs.existsSync(path.join(dir, 'package.json'))) {
  console.error('Dependency audit unavailable: package.json was not included in this source-only artifact. Run this gate from the full backend repository.');
  process.exit(2);
}
if (!fs.existsSync(path.join(dir, 'package-lock.json')) && !fs.existsSync(path.join(dir, 'npm-shrinkwrap.json'))) {
  console.error('Dependency audit failed: a committed npm lockfile is required for reproducible production builds.');
  process.exit(1);
}
const result = cp.spawnSync('npm', ['audit', '--audit-level=high'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
