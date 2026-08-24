const fs = require('fs');
const path = require('path');

const srcRoot = path.resolve(__dirname, '..');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(p);
    return [p];
  });
}
const routes = walk(srcRoot).filter((p) => /\.routes\.js$/i.test(p));
const bodyRoutes = [];
const missing = [];
for (const file of routes) {
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('req.body')) continue;
  bodyRoutes.push(file);
  const covered = /validateBody\s*\(|createModuleBodyContract\s*\(|requestSafetyMiddleware|validate\s*\([^,]+,\s*req\.body(?:\s*\|\|\s*\{\})?\s*\)/s.test(source);
  if (!covered) missing.push(path.relative(srcRoot, file));
}
console.log(JSON.stringify({ routeModules: routes.length, bodyRouteModules: bodyRoutes.length, covered: bodyRoutes.length - missing.length, missing }, null, 2));
if (missing.length) process.exitCode = 1;
