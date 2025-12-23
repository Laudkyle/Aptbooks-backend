const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { AppError } = require("../shared/errors/AppError");

function authRequired(req, _res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return next(new AppError(401, "Missing bearer token"));

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    req.user = payload; // { id, organization_id, email }
    return next();
  } catch {
    return next(new AppError(401, "Invalid token"));
  }
}

module.exports = { authRequired };
