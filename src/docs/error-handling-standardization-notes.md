Human-readable error handling update
- Added centralized error normalization for database, validation, auth, permission, rate-limit, and not-found errors.
- Standardized error response shape to: { ok:false, error, code, details, requestId }.
- Added route-not-found middleware so undefined endpoints no longer leak generic server errors.
- Updated key route-level manual 400/404 responses to throw AppError and flow through the shared formatter.
- Validation failures now return HTTP 422 with field-level details.
