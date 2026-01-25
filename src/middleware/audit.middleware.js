function auditMiddleware(req, _res, next) {
  req.audit = {
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    userAgent: req.headers["user-agent"] || null
  };
  next();
}
module.exports = { auditMiddleware };
