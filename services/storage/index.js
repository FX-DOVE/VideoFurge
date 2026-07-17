// Public storage facade. Only entry point for server/worker.
// Uploads ALL job artifacts when Drive is enabled: videos, images, transcript,
// captions, audio, screenplay, refs, zip — not only final.mp4.

'use strict';

const fs = require('fs');
const path = require('path');
const { loadStorageConfig, isDriveConfigured, configGaps } = require('./config');
const { createGoogleDriveService } = require('../googleDrive/googleDriveService');
const { createMongoAssetRepo } = require('./mongoAssets');
const { finalizeArtifact, cleanupIntermediates, localPathFor } = require('./finalize');
const { buildFilesDto, localFlags, openAssetReadStream } = require('./resolve');
const { discoverJobArtifacts } = require('./discoverArtifacts');
const {
  listPrimaryAssetKeys,
  getAssetDef,
  assetKeyFromDownloadParam,
} = require('./assetMap');
const { logStorage } = require('./log');

function createStorage(deps = {}) {
  const config = deps.config || loadStorageConfig(deps.env || process.env);
  const driveEnabled = deps.forceEnabled != null
    ? !!deps.forceEnabled
    : isDriveConfigured(config);

  let drive = deps.drive || null;
  let assets = deps.assets || null;
  const jobFolderCache = deps.jobFolderCache || new Map();

  function ensureClients() {
    if (!driveEnabled) return;
    if (!drive) {
      drive = createGoogleDriveService({
        authMode: config.google.authMode,
        credentialsPath: config.google.credentialsPath,
        projectId: config.google.projectId || undefined,
        oauthClientId: config.google.oauthClientId,
        oauthClientSecret: config.google.oauthClientSecret,
        oauthTokenPath: config.google.oauthTokenPath,
        oauthRedirectUri: config.google.oauthRedirectUri,
        maxRetries: config.google.maxRetries,
        retryBaseMs: config.google.retryBaseMs,
        onRetry: ({ label, attempt, delay, error }) => {
          logStorage({
            event: 'upload.retry',
            fields: { label, attempt, delay, error },
          });
        },
      });
    }
    if (!assets) {
      assets = createMongoAssetRepo(config);
    }
  }

  function isEnabled() {
    return driveEnabled;
  }

  function getConfigSummary() {
    const { resolveEffectiveAuthMode } = require('./config');
    return {
      enabled: config.enabled,
      configured: driveEnabled,
      authMode: resolveEffectiveAuthMode(config),
      gaps: configGaps(config),
      createJobFolders: config.google.createJobFolders,
      cleanupIntermediates: config.policy.cleanupIntermediates,
      uploadAllOutputs: config.policy.uploadAllOutputs,
      uploadClips: config.policy.uploadClips,
    };
  }

  async function getJobAssets(job, jobDirPath) {
    if (!job || job.status !== 'done') return null;
    const dir = jobDirPath;
    const flags = localFlags(dir, config.policy.minLocalBytes);

    let mongoByKey = {};
    let allMongo = [];
    if (driveEnabled) {
      try {
        ensureClients();
        allMongo = await assets.findByJob(job.id);
        for (const r of allMongo) {
          if (r && r.assetKey) mongoByKey[r.assetKey] = r;
        }
      } catch (err) {
        logStorage({
          event: 'mongo.read.failed',
          jobId: job.id,
          fields: { error: err.message },
        });
      }
    }

    const ready = (key) => {
      if (flags[key]) return true;
      const r = mongoByKey[key];
      return !!(r && r.driveFileId && ['verified', 'local_deleted', 'uploaded'].includes(r.status));
    };

    const imagesReady = ready('images') || flags.images
      || allMongo.some(r => r.assetKey && /^frame_\d{4}$/i.test(r.assetKey) && r.driveFileId);

    const files = buildFilesDto(job.id, flags, mongoByKey);

    // Extra inventory of non-primary assets on Drive (clips, frames, transcript, …)
    const extras = allMongo
      .filter(r => r && r.driveFileId && !files[r.assetKey])
      .map(r => ({
        key: r.assetKey,
        ready: true,
        name: r.filename,
        mimeType: r.mimeType,
        size: r.size,
        driveFileId: r.driveFileId,
        driveViewUrl: r.driveViewUrl,
        status: r.status,
        downloadUrl: null,
      }));

    const storageComplete = !!(job.storage && job.storage.complete);

    return {
      video: ready('final'),
      acted: ready('acted'),
      concat: ready('concat'),
      edited: ready('edited'),
      images: imagesReady,
      storage: {
        provider: driveEnabled ? 'google_drive' : 'local',
        enabled: driveEnabled,
        complete: storageComplete || (
          driveEnabled && ready('final') && !flags.final
        ),
        artifactCount: allMongo.filter(r => r.driveFileId).length,
      },
      files,
      extras,
    };
  }

  /**
   * Upload ALL discovered artifacts (or primary-only if policy says so).
   */
  async function finalizeJobOutputs(job, jobDirPath, { stage = 'stitch', appendJobLog = null } = {}) {
    if (!driveEnabled) {
      logStorage({
        event: 'storage.disabled',
        jobId: job.id,
        fields: { stage, gaps: configGaps(config) },
        appendJobLog,
      });
      return {
        enabled: false,
        complete: false,
        results: [],
      };
    }

    ensureClients();
    const ctx = { drive, assets, config, appendJobLog, jobFolderCache };

    let artifacts = discoverJobArtifacts(jobDirPath, { stage });

    // Policy filters
    if (!config.policy.uploadAllOutputs) {
      // Primary deliverables only (+ edited)
      const primary = new Set(['final', 'acted', 'edited', 'concat', 'images']);
      artifacts = artifacts.filter(a => primary.has(a.assetKey));
    } else {
      if (!config.policy.uploadClips) {
        artifacts = artifacts.filter(a => a.kind !== 'video' || !/^clip_\d{4}$/i.test(a.assetKey));
      }
      if (!config.policy.uploadFrames) {
        artifacts = artifacts.filter(a => a.kind !== 'image' || !/^frame_/i.test(a.assetKey));
      }
      if (!config.policy.uploadTranscript) {
        artifacts = artifacts.filter(a => a.kind !== 'transcript' && a.kind !== 'captions');
      }
      if (!config.policy.uploadAudio) {
        artifacts = artifacts.filter(a => a.kind !== 'audio');
      }
      if (!config.policy.uploadDocs) {
        artifacts = artifacts.filter(a => a.kind !== 'doc' && a.kind !== 'ref');
      }
    }

    // Edit stage: only edited if that's all that changed — still allow any discovered edited+extras
    if (stage === 'edit') {
      artifacts = artifacts.filter(a =>
        a.assetKey === 'edited' || a.kind === 'doc'
      );
      // If edited missing, nothing to do
    }

    logStorage({
      event: 'upload.batch.started',
      jobId: job.id,
      fields: { stage, count: artifacts.length, kinds: summarizeKinds(artifacts) },
      appendJobLog,
    });

    const results = [];
    for (const art of artifacts) {
      try {
        const r = await finalizeArtifact(ctx, {
          job,
          jobDirPath,
          assetKey: art.assetKey,
          localPath: art.localPath,
          filename: art.filename,
          originalFilename: art.originalFilename,
          mimeHint: art.mimeHint,
          driveSubdir: art.driveSubdir,
          kind: art.kind,
          minBytes: art.kind === 'video' || art.kind === 'package' ? 1000 : 32,
        });
        results.push(r);
      } catch (err) {
        logStorage({
          event: 'upload.failed',
          jobId: job.id,
          fields: { assetKey: art.assetKey, error: err.message },
          appendJobLog,
        });
        results.push({ ok: false, assetKey: art.assetKey, error: err.message, localKept: true });
      }
    }

    const primaryKeys = new Set(['final', 'acted', 'edited']);
    const primaryResults = results.filter(r => primaryKeys.has(r.assetKey) && !r.skipped);
    const primaryFailed = primaryResults.some(r => r.ok === false);
    // If final was expected (exists in discovery or job done with video) treat missing final upload as incomplete
    const finalResult = results.find(r => r.assetKey === 'final');
    const finalOk = finalResult ? !!finalResult.ok : !artifacts.some(a => a.assetKey === 'final');
    const anyFailed = results.some(r => r.ok === false && !r.skipped);
    const anyOk = results.some(r => r.ok === true);

    if (anyOk && config.policy.cleanupIntermediates && stage === 'stitch' && !primaryFailed) {
      try {
        cleanupIntermediates(jobDirPath, { jobId: job.id, appendJobLog });
      } catch (err) {
        logStorage({
          event: 'cleanup.failed',
          jobId: job.id,
          fields: { error: err.message, phase: 'intermediates' },
          appendJobLog,
        });
      }
    }

    logStorage({
      event: 'upload.batch.completed',
      jobId: job.id,
      fields: {
        stage,
        ok: results.filter(r => r.ok).length,
        failed: results.filter(r => r.ok === false && !r.skipped).length,
        skipped: results.filter(r => r.skipped).length,
      },
      appendJobLog,
    });

    const summary = {
      provider: 'google_drive',
      enabled: true,
      complete: finalOk && !primaryFailed,
      completedAt: new Date().toISOString(),
      error: primaryFailed
        ? (results.find(r => r.ok === false && primaryKeys.has(r.assetKey))?.error || 'storage failed')
        : (anyFailed ? 'some secondary assets failed (locals kept)' : null),
      artifactCount: results.filter(r => r.ok).length,
      assets: {},
    };
    for (const r of results) {
      if (!r.assetKey) continue;
      summary.assets[r.assetKey] = {
        ok: !!r.ok,
        skipped: !!r.skipped,
        driveFileId: r.driveFileId || null,
        error: r.error || null,
        localKept: !!r.localKept,
      };
    }

    return {
      enabled: true,
      complete: summary.complete,
      results,
      storage: summary,
    };
  }

  function summarizeKinds(artifacts) {
    const m = {};
    for (const a of artifacts) {
      m[a.kind] = (m[a.kind] || 0) + 1;
    }
    return m;
  }

  async function openRead(jobId, jobDirPath, downloadParam) {
    if (driveEnabled) ensureClients();
    return openAssetReadStream(
      { drive, assets, driveEnabled },
      { jobId, jobDirPath, downloadParam }
    );
  }

  /**
   * Open by Mongo assetKey (clip_0001, frame_0000, transcript_json, …).
   */
  async function openReadByAssetKey(jobId, jobDirPath, assetKey) {
    if (driveEnabled) ensureClients();
    // Try local path patterns first
    const def = getAssetDef(assetKey);
    if (def) {
      return openAssetReadStream(
        { drive, assets, driveEnabled },
        { jobId, jobDirPath, assetKey }
      );
    }

    // Local heuristics
    const candidates = [
      path.join(jobDirPath, 'output', 'videoclips', `${assetKey}.mp4`),
      path.join(jobDirPath, 'output', 'images', `${assetKey}.png`),
      path.join(jobDirPath, 'output', 'images', `${assetKey}.jpg`),
      path.join(jobDirPath, 'output', `${assetKey}.json`),
      path.join(jobDirPath, 'output', 'transcript.json'),
      path.join(jobDirPath, 'output', 'captions.ass'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) {
        return {
          source: 'local',
          path: p,
          mimeType: require('./mediaProbe').guessMime(p),
          size: fs.statSync(p).size,
          filename: path.basename(p),
          assetKey,
        };
      }
    }

    if (!driveEnabled || !assets || !drive) {
      const err = new Error('asset not found');
      err.status = 404;
      throw err;
    }
    const rec = await assets.findOne(jobId, assetKey);
    if (!rec || !rec.driveFileId) {
      const err = new Error('asset not found');
      err.status = 404;
      throw err;
    }
    const stream = await drive.getFileStream(rec.driveFileId);
    return {
      source: 'drive',
      stream,
      mimeType: rec.mimeType || 'application/octet-stream',
      size: rec.size || null,
      filename: rec.filename || assetKey,
      assetKey,
      driveFileId: rec.driveFileId,
    };
  }

  async function deleteJobStorage(jobId) {
    if (!driveEnabled) return { enabled: false };
    ensureClients();
    const rows = await assets.findByJob(jobId);
    for (const r of rows) {
      if (r.driveFileId) {
        try {
          await drive.deleteFile(r.driveFileId, { permanent: !config.google.trashOnDelete });
        } catch (err) {
          logStorage({
            event: 'drive.delete.failed',
            jobId,
            fields: { assetKey: r.assetKey, error: err.message },
          });
        }
      }
    }
    // Trash job folder if we created one
    try {
      if (config.google.createJobFolders) {
        const folderId = rows.find(r => r.driveFolderId && r.driveFolderId !== config.google.folderId)?.driveFolderId;
        // Prefer folder named jobId under root
        // ensureFolder list — use first asset's parent chain: we stored subfolder ids; job root is cache
        // Best effort: find folder by name
        // drive.findFileByName only finds files; folders need files.list with mimeType folder
        // deleteFolder with stored driveFolderId from a top-level file (final sits in job folder)
        const topLevel = rows.find(r =>
          r.driveFolderId &&
          r.driveFolderId !== config.google.folderId &&
          ['final', 'acted', 'edited', 'concat', 'images'].includes(r.assetKey)
        );
        if (topLevel && topLevel.driveFolderId) {
          await drive.deleteFolder(topLevel.driveFolderId, { permanent: !config.google.trashOnDelete });
        }
      }
    } catch (_) {}

    try {
      await assets.deleteByJob(jobId);
    } catch (err) {
      logStorage({ event: 'mongo.delete.failed', jobId, fields: { error: err.message } });
    }
    return { enabled: true, deleted: rows.length };
  }

  return {
    isEnabled,
    getConfigSummary,
    getJobAssets,
    finalizeJobOutputs,
    openRead,
    openReadByAssetKey,
    deleteJobStorage,
    _config: config,
  };
}

let defaultStorage = null;

function getStorage() {
  if (!defaultStorage) defaultStorage = createStorage();
  return defaultStorage;
}

module.exports = {
  createStorage,
  getStorage,
  loadStorageConfig,
  isDriveConfigured,
  getAssetDef,
  assetKeyFromDownloadParam,
  listPrimaryAssetKeys,
};
