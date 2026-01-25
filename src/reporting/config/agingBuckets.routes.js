const express = require('express');
const { requirePermission } = require('../../middleware/permission.middleware');
const svc = require('./agingBuckets.service');

const router = express.Router();
router.use(requirePermission('reporting.config.manage'));

router.get('/bucket-sets', async (req,res,next)=>{
  try{
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listBucketSets({ orgId }) });
  }catch(e){ next(e);}
});

router.post('/bucket-sets', async (req,res,next)=>{
  try{
    const { organization_id: orgId } = req.user;
    res.status(201).json({ data: await svc.createBucketSet({ orgId, payload: req.body }) });
  }catch(e){ next(e);}
});

router.patch('/bucket-sets/:id', async (req,res,next)=>{
  try{
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.updateBucketSet({ orgId, id: Number(req.params.id), payload: req.body }) });
  }catch(e){ next(e);}
});

router.delete('/bucket-sets/:id', async (req,res,next)=>{
  try{
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.deleteBucketSet({ orgId, id: Number(req.params.id) }) });
  }catch(e){ next(e);}
});

router.get('/bucket-sets/:id/buckets', async (req,res,next)=>{
  try{
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listBuckets({ orgId, bucketSetId: Number(req.params.id) }) });
  }catch(e){ next(e);}
});

router.put('/bucket-sets/:id/buckets', async (req,res,next)=>{
  try{
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.replaceBuckets({ orgId, bucketSetId: Number(req.params.id), buckets: req.body.buckets || [] }) });
  }catch(e){ next(e);}
});

module.exports = router;
