// Backwards-compatible entrypoint.
// NOTE: This script is now production-safe by default.
// Use `node src/db/migrate.js --reset --force-reset` only in non-production
// with ALLOW_DESTRUCTIVE_MIGRATIONS=true.

const { migrate } = require("./migrate");
migrate();
