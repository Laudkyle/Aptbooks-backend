const router = require("express").Router(); 

const categoriesRoutes = require("./item-categories/itemCategories.routes"); 
const unitsRoutes = require("./item-units/itemUnits.routes"); 
const itemsRoutes = require("./items/items.routes"); 
const warehousesRoutes = require("./warehouses/warehouses.routes1"); 
const reportsRoutes = require("./reports/reports.routes"); 
const transactionsRoutes = require("./transactions/transactions.routes"); 
const stockCountsRoutes = require("./stock-counts/stockCounts.routes"); 

router.use("/categories", categoriesRoutes); 
router.use("/units", unitsRoutes); 
router.use("/items", itemsRoutes); 
router.use("/warehouses", warehousesRoutes); 
router.use("/transactions", transactionsRoutes); 
router.use("/stock-counts", stockCountsRoutes); 
router.use("/reports", reportsRoutes); 

module.exports = router; 
