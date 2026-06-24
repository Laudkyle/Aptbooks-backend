function auditMiddleware(req, _res, next) {
  req.audit = {
    ip: req.ip || req.socket.remoteAddress || null,
    userAgent: req.headers["user-agent"] || null
  };
  next();
}
module.exports = { auditMiddleware };
