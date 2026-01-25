const router = require("express").Router(); 

const { authRequired } = require("../../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../../middleware/permission.middleware"); 
const { idempotency } = require("../../../../middleware/idempotency.middleware"); 
const { validate } = require("../../../../shared/validators/validate"); 

const {
  createPayrollComponentSchema,
  updatePayrollComponentSchema,
} = require("../../../../shared/validators/hr.payroll.validators"); 

const svc = require("./components.service"); 

router.use(authRequired); 

router.post(
  "/",
  idempotency({ required: true }),
  requirePermission("hr.payroll.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id; 
      const payload = validate(createPayrollComponentSchema, req.body); 
      res.status(201).json(await svc.createComponent({ orgId, payload })); 
    } catch (e) {
      next(e); 
    }
  }
); 

router.get("/", requirePermission("hr.payroll.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.listComponents({ orgId, query: req.query })); 
  } catch (e) {
    next(e); 
  }
}); 

router.get("/:id", requirePermission("hr.payroll.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.getComponent({ orgId, componentId: req.params.id })); 
  } catch (e) {
    next(e); 
  }
}); 

router.put("/:id", requirePermission("hr.payroll.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const payload = validate(updatePayrollComponentSchema, req.body); 
    res.json(await svc.updateComponent({ orgId, componentId: req.params.id, payload })); 
  } catch (e) {
    next(e); 
  }
}); 

router.delete("/:id", requirePermission("hr.payroll.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.deactivateComponent({ orgId, componentId: req.params.id })); 
  } catch (e) {
    next(e); 
  }
}); 

module.exports = router; 
