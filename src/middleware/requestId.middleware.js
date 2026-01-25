const { randomUUID } = require("crypto"); 

function requestIdMiddleware(req, res, next) {
  const incoming = req.headers["x-request-id"]; 
  const id = (typeof incoming === "string" && incoming.trim()) ? incoming.trim() : randomUUID(); 
  req.request_id = id; 
  res.setHeader("x-request-id", id); 
  next(); 
}

module.exports = { requestIdMiddleware }; 
