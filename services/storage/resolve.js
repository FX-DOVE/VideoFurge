// Resolve asset for download/preview: local first, then Drive stream.

'use strict';

const fs = require('fs');
const path = require('path');
const { getAssetDef, assetKeyFromDownloadParam } = require('./assetMap');

/**
 * Build API-facing asset DTO from local presence + Mongo record.
 */
function buildFilesDto(jobId, localFlags, mongoByKey) {
  const files = {};
  for (const [key, def] of Object.entries(require('./assetMap').ASSET_DEFS)) {
    const rec = mongoByKey[key];
    const local = !!localFlags[key];
    const readyRemote = rec && rec.driveFileId && ['verified', 'local_deleted', 'uploaded'].includes(rec.status);
    const ready = local || readyRemote;
    if (!ready && !rec) continue;
    files[key] = {
      key,
      ready,
      name: (rec && rec.filename) || def.filename,
      mimeType: (rec && rec.mimeType) || def.mimeType,
      size: (rec && rec.size) || null,
      duration: (rec && rec.duration) != null ? rec.duration : null,
      width: (rec && rec.width) != null ? rec.width : null,
      height: (rec && rec.height) != null ? rec.height : null,
      driveFileId: (rec && rec.driveFileId) || null,
      driveViewUrl: (rec && rec.driveViewUrl) || null,
      driveDownloadUrl: (rec && rec.driveDownloadUrl) || null,
      thumbnailUrl: (rec && rec.thumbnailUrl) || null,
      status: (rec && rec.status) || (local ? 'local' : null),
      localPresent: local,
      downloadUrl: def.downloadParam ? `/api/jobs/${jobId}/download/${def.downloadParam}` : null,
      previewUrl: def.previewParam ? `/api/jobs/${jobId}/preview/${def.previewParam}` : null,
      viewUrl: (rec && rec.driveViewUrl) || null,
      createdAt: (rec && rec.createdAt) || null,
      updatedAt: (rec && rec.updatedAt) || null,
    };
  }
  return files;
}

function localFlags(jobDirPath, minBytes = 1000) {
  const flags = {};
  const { ASSET_DEFS } = require('./assetMap');
  for (const [key, def] of Object.entries(ASSET_DEFS)) {
    const p = path.join(jobDirPath, ...def.localRelative);
    try {
      flags[key] = fs.existsSync(p) && fs.statSync(p).size > minBytes;
    } catch (_) {
      flags[key] = false;
    }
  }
  // images zip OR folders (legacy)
  if (!flags.images) {
    const imgDir = path.join(jobDirPath, 'output', 'images');
    const clipDir = path.join(jobDirPath, 'output', 'videoclips');
    flags.images = fs.existsSync(imgDir) || fs.existsSync(clipDir);
  }
  return flags;
}

/**
 * Open a read source for an asset.
 * @returns {Promise<{ source: 'local'|'drive', path?: string, stream?: Readable, mimeType, size, filename, assetKey }>}
 */
async function openAssetReadStream(ctx, { jobId, jobDirPath, assetKey, downloadParam }) {
  const key = assetKey || assetKeyFromDownloadParam(downloadParam);
  const def = getAssetDef(key);
  if (!def) {
    const err = new Error('asset not found');
    err.status = 404;
    throw err;
  }

  const localPath = path.join(jobDirPath, ...def.localRelative);
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
    return {
      source: 'local',
      path: localPath,
      mimeType: def.mimeType,
      size: fs.statSync(localPath).size,
      filename: def.filename,
      assetKey: key,
    };
  }

  // Drive path
  if (!ctx.driveEnabled || !ctx.assets || !ctx.drive) {
    const err = new Error('asset not found');
    err.status = 404;
    throw err;
  }

  const rec = await ctx.assets.findOne(jobId, key);
  if (!rec || !rec.driveFileId) {
    const err = new Error('asset not found');
    err.status = 404;
    throw err;
  }

  const stream = await ctx.drive.getFileStream(rec.driveFileId);
  return {
    source: 'drive',
    stream,
    mimeType: rec.mimeType || def.mimeType,
    size: rec.size || null,
    filename: rec.filename || def.filename,
    assetKey: key,
    driveFileId: rec.driveFileId,
  };
}

module.exports = {
  buildFilesDto,
  localFlags,
  openAssetReadStream,
};
