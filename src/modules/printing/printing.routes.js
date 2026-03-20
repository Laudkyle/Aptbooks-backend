
const router = require('express').Router();

router.use('/templates', require('./document-templates/documentTemplates.routes'));
router.use('/render', require('./render/render.routes'));

module.exports = router;
