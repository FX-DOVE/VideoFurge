// Handoff: probe → upload (stream) → verify → Mongo → delete local.
// Never delete local unless verify + Mongo succeed.
// Supports primary deliverables AND free-form artifacts (clips, frames, transcript, audio, …).

'use strict';

const fs = require('fs');
const path = require('path');
const { probeLocalFile } = require('./mediaProbe');
const { getAssetDef } = require('./assetMap');
const { logStorage } = require('./log');

function localPathFor(jobDirPath, assetKey) {
  const def = getAssetDef(assetKey);
  if (!def) return null;
  return path.join(jobDirPath, ...def.localRelative);
}

function buildPrompt(job) {
  if (!job) return null;
  const script = job.script && String(job.script).trim();
  if (script) return script.slice(0, 50000);
  const custom = job.customOptions && job.customOptions.customPrompt;
  if (custom && String(custom).trim()) return String(custom).trim().slice(0, 50000);
  if (job.title) return String(job.title).slice(0, 500);
  return null;
}

function deriveUserId(job) {
  if (job && job.userId) return String(job.userId);
  const key = (job && job.apiKey) || 'anonymous';
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
}

async function resolveUploadFolder(ctx, jobId, driveSubdir) {
  const { drive, config, jobFolderCache } = ctx;
  let folderId = config.google.folderId;

  if (config.google.createJobFolders) {
    if (jobFolderCache && jobFolderCache.has(jobId)) {
      folderId = jobFolderCache.get(jobId);
    } else {
      folderId = await drive.ensureFolder(jobId, config.google.folderId);
      if (jobFolderCache) jobFolderCache.set(jobId, folderId);
    }
  }

  if (driveSubdir) {
    const subKey = `${jobId}::${driveSubdir}`;
    if (jobFolderCache && jobFolderCache.has(subKey)) {
      return jobFolderCache.get(subKey);
    }
    const subId = await drive.ensureFolder(driveSubdir, folderId);
    if (jobFolderCache) jobFolderCache.set(subKey, subId);
    return subId;
  }

  return folderId;
}

/**
 * Finalize any local file to Drive + Mongo, then unlink on success.
 *
 * @param {object} ctx  { drive, assets, config, appendJobLog, jobFolderCache }
 * @param {object} opts
 * @param {object} opts.job
 * @param {string} opts.assetKey
 * @param {string} [opts.localPath]
 * @param {string} [opts.jobDirPath]  used with ASSET_DEFS when localPath omitted
 * @param {string} [opts.filename]
 * @param {string} [opts.originalFilename]
 * @param {string} [opts.mimeHint]
 * @param {string|null} [opts.driveSubdir]  e.g. clips | images | docs | audio | refs
 * @param {number} [opts.minBytes]
 */
async function finalizeArtifact(ctx, opts) {
  const { drive, assets, config, appendJobLog } = ctx;
  const job = opts.job;
  const assetKey = opts.assetKey;
  if (!job || !assetKey) throw new Error('finalizeArtifact: job and assetKey required');

  const def = getAssetDef(assetKey);
  const localPath = opts.localPath
    || (opts.jobDirPath && def ? path.join(opts.jobDirPath, ...def.localRelative) : null);

  const jobId = job.id;
  const log = (event, fields) => logStorage({ event, jobId, fields, appendJobLog });

  const minBytes = opts.minBytes != null
    ? opts.minBytes
    : (def && def.isVideo === false ? 32 : (config.policy.minLocalBytes || 1000));

  // Non-video artifacts (json, small png) may be under 1000 bytes
  const effectiveMin = ['transcript', 'captions', 'doc', 'image', 'ref', 'audio', 'package'].includes(opts.kind)
    ? Math.min(minBytes, 32)
    : minBytes;

  if (!localPath || !fs.existsSync(localPath)) {
    return { ok: false, skipped: true, reason: 'missing_local', assetKey };
  }

  const st = fs.statSync(localPath);
  if (st.size < effectiveMin) {
    return { ok: false, skipped: true, reason: 'too_small', assetKey, size: st.size };
  }

  const filename = opts.filename || (def && def.filename) || path.basename(localPath);
  const originalFilename = opts.originalFilename || (def && def.originalFilename) || filename;
  const userId = deriveUserId(job);
  const projectId = job.projectId != null ? job.projectId : null;
  const title = job.title || '';
  const prompt = buildPrompt(job);

  let probe;
  try {
    probe = await probeLocalFile(localPath);
  } catch (err) {
    log('probe.failed', { assetKey, error: err.message });
    probe = {
      size: st.size,
      mimeType: opts.mimeHint || (def && def.mimeType) || 'application/octet-stream',
      duration: null,
      width: null,
      height: null,
    };
  }
  if (opts.mimeHint && (!probe.mimeType || probe.mimeType === 'application/octet-stream')) {
    probe.mimeType = opts.mimeHint;
  }

  let driveFolderId;
  try {
    driveFolderId = await resolveUploadFolder(ctx, jobId, opts.driveSubdir || null);
  } catch (err) {
    log('upload.failed', { assetKey, error: `folder: ${err.message}` });
    return { ok: false, assetKey, error: err.message, localKept: true };
  }

  log('upload.started', {
    assetKey,
    filename,
    size: probe.size,
    mimeType: probe.mimeType,
    driveSubdir: opts.driveSubdir || null,
  });

  let uploaded;
  try {
    await assets.upsertAsset({
      jobId,
      assetKey,
      userId,
      projectId,
      title,
      prompt,
      filename,
      originalFilename,
      mimeType: probe.mimeType,
      size: probe.size,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      status: 'uploading',
      error: null,
    });

    uploaded = await drive.uploadFile({
      localPath,
      filename,
      mimeType: probe.mimeType,
      folderId: driveFolderId,
    });
  } catch (err) {
    log('upload.failed', { assetKey, error: err.message, attempts: err.attempts });
    try {
      await assets.upsertAsset({
        jobId,
        assetKey,
        userId,
        projectId,
        title,
        prompt,
        filename,
        originalFilename,
        mimeType: probe.mimeType,
        size: probe.size,
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        status: 'failed',
        error: err.message,
      });
    } catch (_) {}
    return { ok: false, assetKey, error: err.message, localKept: true };
  }

  log('upload.completed', {
    assetKey,
    driveFileId: uploaded.driveFileId,
    size: uploaded.size,
  });

  // Verify size for binary media; skip strict size for tiny text if remote omits size
  let remote = uploaded;
  try {
    remote = await drive.getFileMetadata(uploaded.driveFileId) || uploaded;
    if (config.policy.verifySize && remote.size != null && probe.size != null && probe.size >= 1000) {
      if (Number(remote.size) !== Number(probe.size)) {
        const msg = `size mismatch local=${probe.size} remote=${remote.size}`;
        log('verify.failed', { assetKey, error: msg });
        try { await drive.deleteFile(uploaded.driveFileId, { permanent: false }); } catch (_) {}
        await assets.upsertAsset({
          jobId, assetKey, userId, projectId, title, prompt,
          filename, originalFilename,
          mimeType: probe.mimeType, size: probe.size,
          duration: probe.duration, width: probe.width, height: probe.height,
          driveFileId: null, status: 'failed', error: msg,
        });
        return { ok: false, assetKey, error: msg, localKept: true };
      }
    }
  } catch (err) {
    log('verify.failed', { assetKey, error: err.message });
    await assets.upsertAsset({
      jobId, assetKey, userId, projectId, title, prompt,
      filename, originalFilename,
      mimeType: probe.mimeType, size: probe.size,
      duration: probe.duration, width: probe.width, height: probe.height,
      driveFileId: uploaded.driveFileId, driveFolderId,
      status: 'failed', error: err.message,
    });
    return { ok: false, assetKey, error: err.message, localKept: true };
  }

  let saved;
  try {
    saved = await assets.upsertAsset({
      jobId,
      assetKey,
      userId,
      projectId,
      title,
      prompt,
      filename,
      originalFilename,
      mimeType: remote.mimeType || probe.mimeType,
      size: probe.size,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      driveFileId: remote.driveFileId || uploaded.driveFileId,
      driveFolderId,
      driveViewUrl: remote.driveViewUrl || uploaded.driveViewUrl,
      driveDownloadUrl: remote.driveDownloadUrl || uploaded.driveDownloadUrl,
      thumbnailUrl: remote.thumbnailUrl || uploaded.thumbnailUrl,
      status: 'verified',
      error: null,
    });
    log('mongo.saved', { assetKey, driveFileId: saved.driveFileId || uploaded.driveFileId });
  } catch (err) {
    log('mongo.failed', { assetKey, error: err.message });
    return {
      ok: false,
      assetKey,
      error: `mongo: ${err.message}`,
      localKept: true,
      driveFileId: uploaded.driveFileId,
    };
  }

  try {
    fs.unlinkSync(localPath);
    await assets.upsertAsset({
      jobId,
      assetKey,
      userId,
      projectId,
      title,
      prompt,
      filename,
      originalFilename,
      mimeType: saved.mimeType,
      size: saved.size,
      duration: saved.duration,
      width: saved.width,
      height: saved.height,
      driveFileId: saved.driveFileId,
      driveFolderId: saved.driveFolderId || driveFolderId,
      driveViewUrl: saved.driveViewUrl,
      driveDownloadUrl: saved.driveDownloadUrl,
      thumbnailUrl: saved.thumbnailUrl,
      status: 'local_deleted',
      error: null,
    });
    log('cleanup.completed', { assetKey, path: localPath });
  } catch (err) {
    log('cleanup.failed', { assetKey, error: err.message, path: localPath });
    return {
      ok: true,
      assetKey,
      driveFileId: saved.driveFileId,
      record: saved,
      localKept: true,
      cleanupError: err.message,
    };
  }

  return {
    ok: true,
    assetKey,
    driveFileId: saved.driveFileId,
    record: { ...saved, status: 'local_deleted' },
    localKept: false,
  };
}

/** @deprecated use finalizeArtifact — kept for callers */
async function finalizeLocalVideo(ctx, opts) {
  return finalizeArtifact(ctx, opts);
}

/**
 * Remove leftover temp work files after all durable artifacts are uploaded.
 * Never deletes job.json, input/, or remaining unuploaded deliverables.
 */
function cleanupIntermediates(jobDirPath, { jobId, appendJobLog } = {}) {
  const removed = [];
  const failures = [];
  const out = path.join(jobDirPath, 'output');
  if (!fs.existsSync(out)) return { removed, failures };

  const killFile = (p) => {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    } catch (err) {
      failures.push({ path: p, error: err.message });
    }
  };

  const walkKill = (dir, pred) => {
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walkKill(full, pred);
        continue;
      }
      if (pred(ent.name, full)) killFile(full);
    }
  };

  // Temp mix/normalize leftovers (clips/frames already unlinked per-file on upload)
  walkKill(path.join(out, 'videoclips'), (name) =>
    /^(norm_|acted_norm_|faded_|acted_faded_|_mix_|_t_)/i.test(name) ||
    /\.txt$/i.test(name)
  );
  walkKill(path.join(out, 'editor_work'), () => true);

  const keepDeliverables = /^(final|acted|edited|concat-video|images)\.(mp4|zip)$/i;
  if (fs.existsSync(out)) {
    for (const name of fs.readdirSync(out)) {
      if (keepDeliverables.test(name)) continue;
      if (/^bgm_list/i.test(name) || /^acted-concat/i.test(name)) {
        killFile(path.join(out, name));
      }
    }
  }

  logStorage({
    event: failures.length ? 'cleanup.intermediates.partial' : 'cleanup.intermediates.completed',
    jobId,
    fields: { removed: removed.length, failures: failures.length },
    appendJobLog,
  });

  return { removed, failures };
}

module.exports = {
  finalizeArtifact,
  finalizeLocalVideo,
  cleanupIntermediates,
  localPathFor,
  deriveUserId,
  buildPrompt,
  resolveUploadFolder,
};
