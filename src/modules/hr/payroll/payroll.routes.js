const router = require("express").Router(); 

router.use("/components", require("./components/components.routes")); 
router.use("/employee-components", require("./employee-components/employeeComponents.routes")); 
router.use("/runs", require("./runs/payrollRuns.routes")); 

module.exports = router; 
