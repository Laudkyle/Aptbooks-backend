const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const svc = require("./journal.service");
const { pool } = require("../../../db/pool");

router.use(authRequired);

router.post("/", requirePermission("accounting.journal.create"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await svc.createDraftJournal({ orgId, actorUserId, payload: req.body });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.post("/:id/post", requirePermission("accounting.journal.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await svc.postDraftJournal({ orgId, journalId: req.params.id, actorUserId });
    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/void", requirePermission("accounting.journal.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await svc.voidPostedJournal({
      orgId, journalId: req.params.id, actorUserId, reason: req.body?.reason
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("accounting.journal.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows: j } = await pool.query(
      `SELECT * FROM journal_entries WHERE organization_id=$1 AND id=$2`,
      [orgId, req.params.id]
    );
    if (!j.length) return res.status(404).json({ error: "Not found" });

    const { rows: lines } = await pool.query(
      `SELECT * FROM journal_entry_lines WHERE journal_entry_id=$1 ORDER BY line_no`,
      [req.params.id]
    );

    res.json({ journal: j[0], lines });
  } catch (e) { next(e); }
});

module.exports = router;
