// MongoDB persistence for generated video assets. Additive schema only.

'use strict';

const { getDb } = require('../mongo/client');

const ASSET_STATUSES = new Set([
  'pending', 'uploading', 'uploaded', 'verified', 'local_deleted', 'failed', 'deleted',
]);

function createMongoAssetRepo(config) {
  const uri = config.mongo.uri;
  const dbName = config.mongo.dbName;
  const collName = config.mongo.assetsCollection;
  let indexesReady = false;

  async function collection() {
    const db = await getDb(uri, dbName);
    const col = db.collection(collName);
    if (!indexesReady) {
      try {
        await col.createIndex({ jobId: 1, assetKey: 1 }, { unique: true });
        await col.createIndex({ userId: 1, createdAt: -1 });
        await col.createIndex({ driveFileId: 1 }, { unique: true, sparse: true });
        await col.createIndex({ status: 1, updatedAt: 1 });
        indexesReady = true;
      } catch (_) {
        // Non-fatal: concurrent workers may race on index create
        indexesReady = true;
      }
    }
    return col;
  }

  function normalize(doc) {
    if (!doc) return null;
    const out = { ...doc };
    if (out._id) out.id = String(out._id);
    return out;
  }

  async function upsertAsset(record) {
    const col = await collection();
    const now = new Date();
    const jobId = record.jobId;
    const assetKey = record.assetKey;
    if (!jobId || !assetKey) throw new Error('upsertAsset: jobId and assetKey required');

    const status = ASSET_STATUSES.has(record.status) ? record.status : 'pending';
    const set = {
      userId: record.userId || 'anonymous',
      projectId: record.projectId != null ? record.projectId : null,
      title: record.title || '',
      prompt: record.prompt != null ? record.prompt : null,
      filename: record.filename,
      originalFilename: record.originalFilename || record.filename,
      mimeType: record.mimeType || 'application/octet-stream',
      size: record.size != null ? Number(record.size) : null,
      duration: record.duration != null ? Number(record.duration) : null,
      width: record.width != null ? Number(record.width) : null,
      height: record.height != null ? Number(record.height) : null,
      driveFileId: record.driveFileId || null,
      driveFolderId: record.driveFolderId || null,
      driveViewUrl: record.driveViewUrl || null,
      driveDownloadUrl: record.driveDownloadUrl || null,
      thumbnailUrl: record.thumbnailUrl || null,
      status,
      error: record.error != null ? String(record.error).slice(0, 2000) : null,
      updatedAt: now,
    };

    await col.updateOne(
      { jobId, assetKey },
      {
        $set: set,
        $setOnInsert: { jobId, assetKey, createdAt: now },
      },
      { upsert: true }
    );
    const doc = await col.findOne({ jobId, assetKey });
    return normalize(doc);
  }

  async function findByJob(jobId) {
    const col = await collection();
    const rows = await col.find({ jobId }).toArray();
    return rows.map(normalize);
  }

  async function findOne(jobId, assetKey) {
    const col = await collection();
    const doc = await col.findOne({ jobId, assetKey });
    return normalize(doc);
  }

  async function findFailed({ limit = 50 } = {}) {
    const col = await collection();
    return (await col.find({ status: 'failed' }).sort({ updatedAt: 1 }).limit(limit).toArray()).map(normalize);
  }

  async function markDeleted(jobId, assetKey) {
    return upsertAsset({
      jobId,
      assetKey,
      status: 'deleted',
      error: null,
    });
  }

  async function deleteByJob(jobId) {
    const col = await collection();
    await col.deleteMany({ jobId });
  }

  return {
    upsertAsset,
    findByJob,
    findOne,
    findFailed,
    markDeleted,
    deleteByJob,
  };
}

module.exports = { createMongoAssetRepo, ASSET_STATUSES };
