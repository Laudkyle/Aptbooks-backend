const router = require("express").Router();

router.use("/categories", require("./asset-categories/assetCategories.routes"));
router.use("/fixed-assets", require("./fixed-assets/fixedAssets.routes"));
router.use("/depreciation", require("./depreciation/depreciation.routes"));

module.exports = router;
