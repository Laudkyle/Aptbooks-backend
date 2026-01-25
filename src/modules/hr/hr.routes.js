const router = require("express").Router(); 

// HR sub-modules
router.use("/departments", require("./departments/departments.routes")); 
router.use("/grades", require("./grades/grades.routes")); 
router.use("/positions", require("./positions/positions.routes")); 
router.use("/compensation-bands", require("./compensation-bands/compBands.routes")); 
router.use("/employees", require("./employees/employees.routes")); 
router.use("/payroll", require("./payroll/payroll.routes")); 
router.use("/leave", require("./leave/leave.routes")); 
router.use("/benefits", require("./benefits/benefits.routes")); 
router.use("/statutory", require("./statutory/statutory.routes")); 
router.use("/reports", require("./reports/reports.routes")); 

module.exports = router; 
