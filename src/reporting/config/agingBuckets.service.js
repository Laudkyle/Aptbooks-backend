const { pool } = require('../../db/pool');
const { withTransaction } = require('../../db/tx');
const { AppError } = require('../../shared/errors/AppError');

async function listBucketSets({ orgId }) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT * FROM aging_bucket_sets WHERE organization_id=$1 ORDER BY id DESC`, [orgId]);
    return rows;
  } finally { client.release();}
}

async function createBucketSet({ orgId, payload }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO aging_bucket_sets (organization_id, name, is_default)
       VALUES ($1,$2,$3)
       RETURNING *`,
      [orgId, payload.name, !!payload.is_default]
    );
    const set = rows[0];
    if (payload.is_default) {
      await client.query(`UPDATE aging_bucket_sets SET is_default=FALSE WHERE organization_id=$1 AND id<>$2`, [orgId, set.id]);
    }
    return set;
  });
}

async function setDefaultBucketSet({ orgId, id }) {
  return withTransaction(async (client) => {
    await client.query(`UPDATE aging_bucket_sets SET is_default=FALSE WHERE organization_id=$1`, [orgId]);
    const { rows } = await client.query(`UPDATE aging_bucket_sets SET is_default=TRUE, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, id]);
    if (!rows.length) throw new AppError(404,'Bucket set not found');
    return rows[0];
  });
}

async function deleteBucketSet({ orgId, id }) {
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM aging_buckets WHERE organization_id=$1 AND bucket_set_id=$2`, [orgId, id]);
    await client.query(`DELETE FROM aging_bucket_sets WHERE organization_id=$1 AND id=$2`, [orgId, id]);
    return { ok: true };
  });
}

async function updateBucketSet({ orgId, id, payload }) {
  if (payload.is_default) {
    // If setting default, do it atomically.
    return setDefaultBucketSet({ orgId, id });
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE aging_bucket_sets
          SET name=COALESCE($3,name),
              updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      [orgId, id, payload.name || null]
    );
    if (!rows.length) throw new AppError(404,'Bucket set not found');
    return rows[0];
  });
}

async function replaceBuckets({ orgId, bucketSetId, buckets }) {
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM aging_buckets WHERE organization_id=$1 AND bucket_set_id=$2`, [orgId, bucketSetId]);
    const inserted = [];
    for (const b of buckets) {
      if (!b.label) throw new AppError(400,'Each bucket requires label');
      const { rows } = await client.query(
        `INSERT INTO aging_buckets (organization_id, bucket_set_id, label, start_days, end_days, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [orgId, bucketSetId, b.label, b.start_days, b.end_days ?? null, b.sort_order ?? 0]
      );
      inserted.push(rows[0]);
    }
    return inserted;
  });
}

async function listBuckets({ orgId, bucketSetId }) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT * FROM aging_buckets WHERE organization_id=$1 AND bucket_set_id=$2 ORDER BY sort_order ASC`,
      [orgId, bucketSetId]
    );
    return rows;
  } finally { client.release();}
}

async function upsertBucket({ orgId, bucketSetId, payload }) {
  return withTransaction(async (client) => {
    if (!payload.label) throw new AppError(400,'label is required');
    const { rows } = await client.query(
      `INSERT INTO aging_buckets (organization_id, bucket_set_id, label, start_days, end_days, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [orgId, bucketSetId, payload.label, payload.start_days, payload.end_days ?? null, payload.sort_order ?? 0]
    );
    return rows[0];
  });
}

async function updateBucket({ orgId, id, payload }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE aging_buckets
          SET label=COALESCE($3,label),
              start_days=COALESCE($4,start_days),
              end_days=COALESCE($5,end_days),
              sort_order=COALESCE($6,sort_order),
              updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      [orgId, id, payload.label || null, payload.start_days, payload.end_days, payload.sort_order]
    );
    if (!rows.length) throw new AppError(404,'Bucket not found');
    return rows[0];
  });
}

async function deleteBucket({ orgId, id }) {
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM aging_buckets WHERE organization_id=$1 AND id=$2`, [orgId, id]);
    return { ok: true };
  });
}

async function getDefaultBucketSet({ orgId, client }) {
  const { rows } = await client.query(`SELECT * FROM aging_bucket_sets WHERE organization_id=$1 AND is_default=TRUE ORDER BY id DESC LIMIT 1`, [orgId]);
  return rows[0] || null;
}

module.exports = {
  listBucketSets,
  createBucketSet,
  updateBucketSet,
  setDefaultBucketSet,
  deleteBucketSet,
  listBuckets,
  replaceBuckets,
  upsertBucket,
  updateBucket,
  deleteBucket,
  getDefaultBucketSet
};
