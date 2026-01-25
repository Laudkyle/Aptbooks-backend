const router = require("express").Router();
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./i18n.service");

router.use(authRequired);

router.get("/locales", requirePermission("utilities.i18n.read"), (req, res) => {
  res.json(svc.listLocales());
});

router.get("/messages/:locale", requirePermission("utilities.i18n.read"), (req, res, next) => {
  try { res.json(svc.getMessages(req.params.locale));}
  catch (e) { next(e);}
});

module.exports = router;
