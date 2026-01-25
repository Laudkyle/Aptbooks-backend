const router = require("express").Router(); 
const { authRequired } = require("../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const { idempotency } = require("../../../middleware/idempotency.middleware"); 
const svc = require("./itemCategories.service"); 

router.use(authRequired); 

router.get("/", requirePermission("inventory.categories.read"), async (req, res, next) => {
  try {
    res.json(await svc.listCategories(req.user.organization_id)); 
  } catch (e) { next(e);  }
}); 

router.post("/", idempotency({ required: true }), requirePermission("inventory.categories.manage"), async (req, res, next) => {
  try {
    const created = await svc.createCategory(req.user.organization_id, req.body); 
    res.status(201).json(created); 
  } catch (e) { next(e);  }
}); 

router.get("/:id", requirePermission("inventory.categories.read"), async (req, res, next) => {
  try { res.json(await svc.getCategory(req.user.organization_id, req.params.id));  }
  catch (e) { next(e);  }
}); 

router.put("/:id", requirePermission("inventory.categories.manage"), async (req, res, next) => {
  try { res.json(await svc.updateCategory(req.user.organization_id, req.params.id, req.body));  }
  catch (e) { next(e);  }
}); 

router.delete("/:id", requirePermission("inventory.categories.manage"), async (req, res, next) => {
  try { res.json(await svc.deleteCategory(req.user.organization_id, req.params.id));  }
  catch (e) { next(e);  }
}); 

module.exports = router; 
