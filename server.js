// API layer. Deliberately does almost no work itself — it only ever
// writes a job file and returns immediately. The worker process does
// the actual transcription / prompting / Grok / stitching in the background.
// This is the fix for "website waits until Grok is done": never block a request.

// Load .env before anything else so process.env is populated for all constants below.
require('dotenv').config();

const express = require('express');
const multer  = require('multer');
const { v4: uuid } = require('uuid');
const fs   = require('fs');
const path = require('path');
const { createServer } = require('http');
const { Server: SocketIO } = require('socket.io');
const {
  createJob, readJob, updateJob, deleteJob, jobDir, jobStorageBytes, JOBS_DIR,
} = require('./lib/jobStore');
const { listModes, normalizeModeId, getMode, isMediaRequired, hasFixedRuntime } = require('./lib/videoModes');
const { normalizeAspectKey, ASPECT_PRESETS } = require('./lib/aspect');

const app        = express();
const httpServer = createServer(app);
const io         = new SocketIO(httpServer, {
  // Same-origin only. If you put nginx/caddy in front on a different origin,
  // set: cors: { origin: 'https://videofurge.voiceforgeai.site' }
  cors: { origin: false },
});

app.use(express.json());

const MAX_DISK_BYTES   = parseInt(process.env.MAX_DISK_BYTES   || (30 * 1024 * 1024 * 1024), 10);
const API_KEYS         = (process.env.API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_JOBS_PER_DAY = parseInt(process.env.MAX_JOBS_PER_DAY || '5',    10);
const MAX_SCRIPT_CHARS = parseInt(process.env.MAX_SCRIPT_CHARS || '8000', 10);

// Allowed media for upload
const ALLOWED_MIME = /^(audio|video)\//;
const ALLOWED_EXT  = /\.(mp3|wav|m4a|aac|ogg|flac|mp4|mov|mkv|webm|avi)$/i;

// Central list of allowed file upload field names for /api/jobs
// (kept in sync between multer config and error messages)
const ALLOWED_UPLOAD_FIELDS = [
  { name: 'media',            maxCount: 1 },
  { name: 'characterImages',  maxCount: 12 },
  { name: 'styleReferences',  maxCount: 8 },
  { name: 'referenceImages',  maxCount: 20 }, // legacy
];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = jobDir(req.jobId);
      fs.mkdirSync(path.join(dir, 'input'), { recursive: true });
      cb(null, path.join(dir, 'input'));
    },
    filename: (req, file, cb) => {
      // For character images, give them stable indexed names so we can pair with metadata
      if (file.fieldname === 'characterImages') {
        // Will be renamed after upload based on index in handler
        return cb(null, 'char_' + Date.now() + '_' + Math.random().toString(36).slice(2) + path.extname(file.originalname));
      }
      if (file.fieldname === 'styleReferences') {
        return cb(null, 'style_' + Date.now() + '_' + Math.random().toString(36).slice(2) + path.extname(file.originalname));
      }
      cb(null, file.fieldname + path.extname(file.originalname));
    },
  }),
  limits: {
    fileSize:  3 * 1024 * 1024 * 1024, // 3 GB per file
    files:     30,   // 1 media + up to ~8 chars + style refs + legacy refs
    fields:    15,
  },
  fileFilter: (req, file, cb) => {
    // Character images and style refs — image types
    if (file.fieldname === 'characterImages' || file.fieldname === 'styleReferences') {
      return cb(null, true);
    }
    // Legacy referenceImages
    if (file.fieldname === 'referenceImages') return cb(null, true);
    // Media file — check mime/ext
    const okMime = ALLOWED_MIME.test(file.mimetype || '');
    const okExt  = ALLOWED_EXT.test(file.originalname || '');
    if (okMime || okExt) return cb(null, true);
    cb(Object.assign(new Error('media must be an audio or video file'), { status: 400 }));
  },
});

// ---- Auth ----
// Also accepts ?k= query param for browser-native media elements (<video src>, <a download>)
// that cannot send custom request headers.
function requireAuth(req, res, next) {
  const key = req.get('x-api-key')
    || req.get('authorization')?.replace(/^Bearer\s+/i, '')
    || req.query.k;
  if (!key) {
    return res.status(401).json({ error: 'API key required (X-API-Key header or ?k= query param)' });
  }
  if (API_KEYS.length > 0 && !API_KEYS.includes(key)) {
    return res.status(401).json({ error: 'invalid API key' });
  }
  req.apiKey = key;
  next();
}

function checkDailyRate(apiKey) {
  if (!fs.existsSync(JOBS_DIR)) return true;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let count = 0;
  try {
    const ids = fs.readdirSync(JOBS_DIR);
    for (const id of ids) {
      try {
        const j = readJob(id);
        if (j && j.apiKey === apiKey && j.createdAt >= since) count++;
      } catch (_) {}
    }
  } catch (_) {}
  return count < MAX_JOBS_PER_DAY;
}

// ---- Public config endpoint (no auth required) ----
// The frontend fetches this on startup to auto-connect without manual key entry.
// Returns the first key from API_KEYS env, or "dev" when API_KEYS is empty
// (the server accepts any non-empty key in that case).
// SECURITY NOTE: exposes one API key to any client that can reach the server.
// Replace with a proper login endpoint when you add real user auth.
app.get('/api/config', (req, res) => {
  res.json({
    apiKey: API_KEYS[0] || 'dev',
    dev:    API_KEYS.length === 0,
    videoTypes: listModes(),
    aspectRatios: Object.entries(ASPECT_PRESETS).map(([id, v]) => ({ id, label: v.label, w: v.w, h: v.h })),
  });
});

// ---- Auth for all /api/jobs routes ----
app.use('/api/jobs', requireAuth);

// ---- Helpers ----

// Small input sanitizers for customOptions.
function str(v, max = 200) {
  if (v == null) return '';
  return String(v).trim().slice(0, max);
}
function clampInt(v, lo, hi) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}


// Which output files exist (so the UI only shows working players / download links).
function getJobAssets(job) {
  if (!job || job.status !== 'done') return null;
  const out = path.join(jobDir(job.id), 'output');
  const exists = (name) => {
    try {
      const p = path.join(out, name);
      return fs.existsSync(p) && fs.statSync(p).size > 1000;
    } catch (_) {
      return false;
    }
  };
  return {
    video:  exists('final.mp4'),
    acted:  exists('acted.mp4'),
    concat: exists('concat-video.mp4'),
    edited: exists('edited.mp4'),
    images: exists('images.zip')
      || fs.existsSync(path.join(out, 'images'))
      || fs.existsSync(path.join(out, 'videoclips')),
  };
}

// Strip filesystem paths and heavy computed fields before sending to clients.
function stripSafe(job) {
  if (!job) return null;
  const {
    mediaPath, referenceImagePaths, segments, beats, styleSummary, apiKey, script,
    styleReferencePaths, editTimeline, ...rest
  } = job;

  // Sanitize characters: keep useful info for UI, remove disk paths
  if (Array.isArray(rest.characters)) {
    rest.characters = rest.characters.map(c => ({
      name: c.name,
      gender: c.gender || 'unspecified',
    }));
  }
  rest.assets = getJobAssets(job);

  // Expose lightweight edit-render status (no full timeline dump on every poll)
  if (job.editRender) {
    rest.editRender = {
      status: job.editRender.status || null,
      error: job.editRender.error || null,
      progress: job.editRender.progress || null,
      queuedAt: job.editRender.queuedAt || null,
      startedAt: job.editRender.startedAt || null,
      finishedAt: job.editRender.finishedAt || null,
    };
  } else {
    delete rest.editRender;
  }
  return rest;
}

// Compact summary for the list view.
function jobSummary(job) {
  if (!job) return null;
  const summary = {
    id:        job.id,
    title:     job.title,
    status:    job.status,
    videoType: job.videoType || 'documentary',
    resolution: job.resolution || '16:9',
    targetMinutes: job.targetMinutes || job.customOptions?.targetMinutes || null,
    partNumber: job.partNumber || job.customOptions?.partNumber || null,
    expectsPart2: !!job.expectsPart2,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt  || null,
    progress:  job.progress,
    error:     job.error      || null,
    recovery:  job.recovery   || null,
    assets:    getJobAssets(job),
  };
  // Surface edit-render progress so the jobs list can show a live progress bar
  if (job.editRender && job.editRender.status) {
    summary.editRender = {
      status: job.editRender.status || null,
      error: job.editRender.error || null,
      progress: job.editRender.progress || null,
      queuedAt: job.editRender.queuedAt || null,
      startedAt: job.editRender.startedAt || null,
      finishedAt: job.editRender.finishedAt || null,
    };
  }
  return summary;
}

// ---- Routes ----

// POST /api/jobs — create a new job (multipart upload)
// Rate limit is enforced here only (not on list/detail/retry/delete).
app.post(
  '/api/jobs',
  (req, res, next) => {
    if (!checkDailyRate(req.apiKey)) {
      return res.status(429).json({ error: `rate limit: max ${MAX_JOBS_PER_DAY} jobs per 24h per key` });
    }
    req.jobId = uuid();
    next();
  },
  upload.fields(ALLOWED_UPLOAD_FIELDS),
  (req, res) => {
    try {
      console.log(`[upload] starting job creation for apiKey=${req.apiKey?.slice(0,8)}... mediaSize=${req.headers['content-length'] || '?'} bytes`);
      const t0 = Date.now();
      const totalUsed = getTotalStorageUsed();
      if (totalUsed > MAX_DISK_BYTES) {
        console.warn('[upload] storage limit hit');
        return res.status(507).json({ error: 'VPS storage is near capacity, delete old jobs first' });
      }

      const { title, script, characters: charactersRaw, sceneStyle, videoType, resolution, customOptions: customOptionsRaw } = req.body;

      if (!title) {
        return res.status(400).json({ error: 'title is required' });
      }
      // Media is now OPTIONAL. When absent, the worker builds the video from the
      // (provided or AI-generated) script. Require at least title so a script can be written.

      // Script is now OPTIONAL. When empty, the worker generates one from the title.
      if (script != null && (typeof script !== 'string' || script.length > MAX_SCRIPT_CHARS)) {
        return res.status(400).json({ error: `script too long (max ${MAX_SCRIPT_CHARS} chars)` });
      }
      if (title.length > 200) {
        return res.status(400).json({ error: 'title too long (max 200 chars)' });
      }

      // Video type + aspect ratio (validated/normalized against known presets).
      const normVideoType = normalizeModeId(videoType);
      const normResolution = normalizeAspectKey(resolution || getMode(normVideoType).defaultAspect);

      // Optional freeform customization (tone, pacing, captions on/off, language, target minutes).
      let customOptions = {};
      if (customOptionsRaw) {
        try {
          const parsed = typeof customOptionsRaw === 'string' ? JSON.parse(customOptionsRaw) : customOptionsRaw;
          if (parsed && typeof parsed === 'object') {
            customOptions = {
              tone: str(parsed.tone, 120),
              pacing: str(parsed.pacing, 40),
              dialogueLanguage: str(parsed.dialogueLanguage, 40),
              targetMinutes: clampInt(parsed.targetMinutes, 1, 30),
              partNumber: clampInt(parsed.partNumber, 1, 50),
              captionsOn: parsed.captionsOn == null ? null : !!parsed.captionsOn,
              customPrompt: str(parsed.customPrompt, 2000),
            };
          }
        } catch (_) {
          return res.status(400).json({ error: 'Invalid customOptions data' });
        }
      }

      const files = req.files || {};
      const media = files.media?.[0] || null;
      if (media) {
        const badMedia = !ALLOWED_EXT.test(media.originalname) && !ALLOWED_MIME.test(media.mimetype || '');
        if (badMedia) {
          return res.status(400).json({ error: 'media must be an audio or video file' });
        }
        // Multer should always set .path; reject weird empty media fields early
        if (typeof media.path !== 'string' || !media.path.trim()) {
          return res.status(400).json({ error: 'media upload failed (no file path). Try again.' });
        }
      } else if (isMediaRequired(normVideoType)) {
        // Narration-first modes (documentary, explainer, commercial, music video) are
        // AUDIO-FIRST: the visuals are timed and matched to the real audio, so a media
        // file is mandatory. Only acted/dialogue-driven modes (drama, movie, trailer,
        // anime) may run without media (built from the script).
        return res.status(400).json({
          error: `A media (audio/video) file is required for the "${getMode(normVideoType).label}" video type. ` +
                 `Only Drama, Movie, Cinematic Trailer, and Anime can be created without media.`,
        });
      }

      // Parse structured characters (preferred)
      let characters = [];
      if (charactersRaw) {
        try {
          const parsed = JSON.parse(charactersRaw);
          if (Array.isArray(parsed)) {
            characters = parsed
              .filter(c => c && typeof c.name === 'string' && c.name.trim())
              .map(c => ({
                name: c.name.trim().slice(0, 60),
                gender: (c.gender || 'unspecified').toString().slice(0, 30),
              }));
          }
        } catch (e) {
          return res.status(400).json({ error: 'Invalid characters data' });
        }
      }

      const charFiles = files.characterImages || [];
      if (characters.length > 0) {
        if (charFiles.length !== characters.length) {
          return res.status(400).json({ error: `You provided ${characters.length} character(s) but uploaded ${charFiles.length} image(s). They must match.` });
        }
        // Validate image types
        for (const f of charFiles) {
          if (!/\.(png|jpg|jpeg|webp)$/i.test(f.originalname)) {
            return res.status(400).json({ error: 'Character images must be PNG, JPG, or WebP' });
          }
          if (typeof f.path !== 'string' || !f.path.trim()) {
            return res.status(400).json({ error: 'Character image upload failed (no file path). Try again.' });
          }
        }
      }

      // Legacy fallback: turn old referenceImages into simple characters if no structured ones provided
      const legacyRefs = files.referenceImages || [];
      if (characters.length === 0 && legacyRefs.length > 0) {
        for (const img of legacyRefs) {
          if (!/\.(png|jpg|jpeg|webp)$/i.test(img.originalname)) {
            return res.status(400).json({ error: 'referenceImages must be png/jpg/jpeg/webp' });
          }
        }
        characters = legacyRefs.map((f, idx) => ({
          name: `Character ${idx + 1}`,
          gender: 'unspecified',
          // we will assign paths below
        }));
      }

      // Now assign image paths (new or legacy) — only files with real string paths
      const finalCharacters = [];
      const allCharFiles = [...charFiles, ...legacyRefs]; // prefer new, fallback uses legacy
      for (let i = 0; i < characters.length; i++) {
        const srcFile = allCharFiles[i];
        if (!srcFile || typeof srcFile.path !== 'string' || !srcFile.path.trim()) break;
        finalCharacters.push({
          ...characters[i],
          imagePath: srcFile.path,
        });
      }

      // Optional style reference images (for art direction / environments)
      const styleRefPaths = (files.styleReferences || [])
        .map(f => f && f.path)
        .filter(p => typeof p === 'string' && p.trim());

      // Drama / Movie / Anime: always store an exact target runtime (minutes).
      const modeProf = getMode(normVideoType);
      if (hasFixedRuntime(normVideoType) || modeProf.fixedRuntime) {
        const defMin = modeProf.defaultTargetMinutes || 3;
        const tm = customOptions.targetMinutes != null ? customOptions.targetMinutes : defMin;
        customOptions.targetMinutes = Math.max(1, Math.min(30, Number(tm) || defMin));
        customOptions.partNumber = Math.max(1, Math.min(50, Number(customOptions.partNumber) || 1));
      }

      const jobData = {
        title: title.slice(0, 200),
        script: (script || '').slice(0, MAX_SCRIPT_CHARS),
        // Always null (not undefined / empty string) when no media — drama path depends on this
        mediaPath: media && typeof media.path === 'string' && media.path.trim() ? media.path : null,
        characters: finalCharacters,
        sceneStyle: (sceneStyle || '').toString().slice(0, 2000),
        styleReferencePaths: styleRefPaths,
        videoType: normVideoType,
        resolution: normResolution,
        customOptions,
        targetMinutes: customOptions.targetMinutes || null,
        partNumber: customOptions.partNumber || null,
        apiKey: req.apiKey,
      };

      // For backward compat with existing worker code that still looks for referenceImagePaths
      if (finalCharacters.length > 0) {
        jobData.referenceImagePaths = finalCharacters
          .map(c => c.imagePath)
          .filter(p => typeof p === 'string' && p.trim());
      } else if (legacyRefs.length) {
        jobData.referenceImagePaths = legacyRefs
          .map(f => f.path)
          .filter(p => typeof p === 'string' && p.trim());
      }

      if (!jobData.characters || jobData.characters.length === 0) {
        return res.status(400).json({ error: 'At least one character (with image) is required for consistent visuals.' });
      }

      const job = createJob(req.jobId, jobData);
      const dt = Date.now() - t0;
      console.log(`[upload] job ${job.id} created in ${dt}ms (storage scan + write + checks)`);
      _storageCache.ts = 0; // force fresh scan next time (we just added data)
      res.status(202).json({ id: job.id, status: job.status });
    } catch (err) {
      console.error('[upload] error during job creation', err);
      next(err);
    }
  }
);

// GET /api/jobs — list all jobs for this API key, newest first
app.get('/api/jobs', (req, res, next) => {
  try {
    if (!fs.existsSync(JOBS_DIR)) return res.json([]);
    const ids  = fs.readdirSync(JOBS_DIR);
    const jobs = ids
      .map(id => { try { return readJob(id); } catch (_) { return null; } })
      .filter(j => j && j.apiKey === req.apiKey)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(jobSummary);
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id — job detail
app.get('/api/jobs/:id', (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    const safe = stripSafe(job);
    if (!safe) return res.status(404).json({ error: 'not found' });
    safe.styleRefCount = Array.isArray(job.styleReferencePaths) ? job.styleReferencePaths.length : 0;
    // Keep heavy fields the UI may still show (script is stripped for size)
    safe.totalDurationMs = job.totalDurationMs || null;
    res.json(safe);
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/editor — clip list + saved timeline + render status
app.get('/api/jobs/:id/editor', (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    if (job.status !== 'done') {
      return res.status(400).json({ error: 'Job must be finished before editing clips' });
    }

    const { listJobClips, defaultTimeline, normalizeTimeline } = require('./lib/editorRender');
    const dir = jobDir(job.id);
    const sourceClips = listJobClips(dir, job).map(c => ({
      index: c.index,
      name: c.name,
      duration: c.duration,
      text: c.text,
      startMs: c.startMs,
      endMs: c.endMs,
      url: `/api/jobs/${job.id}/preview/clip/${c.index}`,
    }));

    if (sourceClips.length === 0) {
      return res.status(404).json({ error: 'No video clips found for this job' });
    }

    let timeline = job.editTimeline || null;
    // Prefer last saved timeline on disk if job field missing
    if (!timeline) {
      const diskPath = path.join(dir, 'output', 'edit_timeline.json');
      if (fs.existsSync(diskPath)) {
        try { timeline = JSON.parse(fs.readFileSync(diskPath, 'utf8')); } catch (_) {}
      }
    }
    const clipsMeta = listJobClips(dir, job);
    timeline = timeline
      ? normalizeTimeline(timeline, clipsMeta)
      : defaultTimeline(clipsMeta);

    res.json({
      jobId: job.id,
      title: job.title,
      clips: sourceClips,
      timeline,
      editRender: job.editRender ? {
        status: job.editRender.status,
        error: job.editRender.error || null,
        progress: job.editRender.progress || null,
        queuedAt: job.editRender.queuedAt || null,
        startedAt: job.editRender.startedAt || null,
        finishedAt: job.editRender.finishedAt || null,
      } : { status: 'idle' },
      assets: getJobAssets(job),
      transitions: [
        'none', 'mix', 'fade', 'dissolve', 'fadeblack', 'fadewhite',
        'slideleft', 'slideright', 'slideup', 'slidedown',
        'wipeleft', 'wiperight', 'circleopen', 'circleclose', 'distance', 'pixelize',
      ],
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/jobs/:id/editor — save timeline (auto-save / before render)
app.put('/api/jobs/:id/editor', (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    if (job.status !== 'done') {
      return res.status(400).json({ error: 'Job must be finished before editing' });
    }
    if (job.editRender && ['queued', 'rendering'].includes(job.editRender.status)) {
      return res.status(409).json({ error: 'Cannot edit timeline while a render is in progress' });
    }

    const { listJobClips, normalizeTimeline } = require('./lib/editorRender');
    const dir = jobDir(job.id);
    const clipsMeta = listJobClips(dir, job);
    const timeline = normalizeTimeline(req.body?.timeline || req.body, clipsMeta);

    const updated = updateJob(job.id, { editTimeline: timeline });
    try {
      fs.writeFileSync(
        path.join(dir, 'output', 'edit_timeline.json'),
        JSON.stringify(timeline, null, 2),
        'utf8'
      );
    } catch (_) {}

    res.json({ ok: true, timeline: updated.editTimeline });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/editor/audio — upload audio track (BGM or voiceTrack)
const audioUpload = multer().single('audioTrack');
app.post('/api/jobs/:id/editor/audio', (req, res, next) => {
  audioUpload(req, res, (err) => {
    if (err) return next(err);
    try {
      const job = readJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'not found' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const trackType = req.body.trackType || 'bgMusic'; // 'bgMusic' or 'voiceTrack'
      const ext = path.extname(req.file.originalname) || '.mp3';
      const targetName = `editor_${trackType}${ext}`;
      const dir = jobDir(job.id);
      const destPath = path.join(dir, 'output', targetName);
      
      fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
      fs.writeFileSync(destPath, req.file.buffer);

      const previewUrl = `/api/jobs/${job.id}/preview/audio/${trackType}${ext}`;
      res.json({
        ok: true,
        url: previewUrl,
        path: destPath,
      });
    } catch (e) {
      next(e);
    }
  });
});

// GET /api/jobs/:id/preview/audio/:type — serve uploaded audio
app.get('/api/jobs/:id/preview/audio/:type', (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    
    const type = req.params.type;
    const file = path.resolve(path.join(jobDir(job.id), 'output', `editor_${type}`));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'audio not found' });

    res.sendFile(file, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/preview/frame/:index — serve static frame image for timeline thumbnail
app.get('/api/jobs/:id/preview/frame/:index', (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job || job.status !== 'done') return res.status(404).json({ error: 'not ready' });

    const idx = parseInt(req.params.index, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx > 9999) {
      return res.status(400).json({ error: 'invalid frame index' });
    }

    const file = path.resolve(
      path.join(jobDir(job.id), 'output', 'images', `frame_${String(idx).padStart(4, '0')}.png`)
    );
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'frame not found' });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/editor/import — upload and transcode image/video clip on the fly
const importUpload = multer().single('importFile');
app.post('/api/jobs/:id/editor/import', (req, res, next) => {
  importUpload(req, res, async (err) => {
    if (err) return next(err);
    try {
      const job = readJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'not found' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const originalName = req.file.originalname || 'imported_file';
      const isImg = /\.(png|jpg|jpeg|webp|gif)$/i.test(originalName);
      const isVid = /\.(mp4|mov|mkv|webm|avi)$/i.test(originalName);

      if (!isImg && !isVid) {
        return res.status(400).json({ error: 'Only images (png/jpg/webp/gif) or videos (mp4/mov/mkv/webm) can be imported' });
      }

      const { listJobClips } = require('./lib/editorRender');
      const dir = jobDir(job.id);
      const clips = listJobClips(dir, job);
      const nextIdx = clips.length;
      const padIdx = String(nextIdx).padStart(4, '0');

      const tempInputPath = path.join(dir, 'output', `temp_import_${Date.now()}${path.extname(originalName)}`);
      fs.writeFileSync(tempInputPath, req.file.buffer);

      const destClipPath = path.join(dir, 'output', 'videoclips', `clip_${padIdx}.mp4`);
      const destFramePath = path.join(dir, 'output', 'images', `frame_${padIdx}.png`);

      fs.mkdirSync(path.join(dir, 'output', 'videoclips'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'output', 'images'), { recursive: true });

      const { exec } = require('child_process');
      const execPromise = (cmd) => new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr || error.message));
          else resolve(stdout);
        });
      });

      if (isImg) {
        const transcodeCmd = `ffmpeg -loop 1 -i "${tempInputPath}" -f lavfi -i anullsrc=r=44100:cl=stereo -c:v libx264 -t 5 -pix_fmt yuv420p -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black" -r 24 -c:a aac -shortest -y "${destClipPath}"`;
        await execPromise(transcodeCmd);
        fs.copyFileSync(tempInputPath, destFramePath);
      } else {
        const transcodeCmd = `ffmpeg -i "${tempInputPath}" -c:v libx264 -pix_fmt yuv420p -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black" -r 24 -c:a aac -ar 48000 -y "${destClipPath}"`;
        await execPromise(transcodeCmd);
        const frameCmd = `ffmpeg -i "${destClipPath}" -vframes 1 -q:v 2 -y "${destFramePath}"`;
        await execPromise(frameCmd);
      }

      try { fs.unlinkSync(tempInputPath); } catch (_) {}

      const freshClips = listJobClips(dir, job);
      const newClipMeta = freshClips.find(c => c.index === nextIdx);
      if (!newClipMeta) {
        throw new Error('Failed to find the newly imported clip metadata');
      }

      const { defaultTimeline } = require('./lib/editorRender');
      let timeline = job.editTimeline;
      if (!timeline || !Array.isArray(timeline.clips) || timeline.clips.length === 0) {
        timeline = defaultTimeline(clips);
      }

      timeline.clips.push({
        id: `c${nextIdx}-${nextIdx}`,
        sourceIndex: nextIdx,
        enabled: true,
        trimStart: 0,
        trimEnd: Number(newClipMeta.duration.toFixed(3)),
        speed: 1,
        transition: timeline.defaultTransition || 'mix',
        transitionDuration: Number(timeline.defaultTransitionDuration ?? 0.5) || 0.5,
      });

      updateJob(job.id, { editTimeline: timeline });

      const sourceClips = freshClips.map(c => ({
        index: c.index,
        name: c.name,
        duration: c.duration,
        text: c.text,
        startMs: c.startMs,
        endMs: c.endMs,
        url: `/api/jobs/${job.id}/preview/clip/${c.index}`,
      }));

      res.json({
        ok: true,
        clips: sourceClips,
        timeline,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: `Import failed: ${e.message}` });
    }
  });
});


// POST /api/jobs/:id/editor/render — queue server-side re-render (works offline after)
app.post('/api/jobs/:id/editor/render', (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    if (job.status !== 'done') {
      return res.status(400).json({ error: 'Job must be finished before rendering an edit' });
    }
    if (job.editRender && ['queued', 'rendering'].includes(job.editRender.status)) {
      return res.status(409).json({ error: 'A render is already in progress for this job' });
    }

    const { listJobClips, normalizeTimeline } = require('./lib/editorRender');
    const dir = jobDir(job.id);
    const clipsMeta = listJobClips(dir, job);
    if (clipsMeta.length === 0) {
      return res.status(404).json({ error: 'No video clips found for this job' });
    }

    const bodyTimeline = req.body?.timeline || job.editTimeline || null;
    const timeline = normalizeTimeline(bodyTimeline, clipsMeta);
    const enabledCount = timeline.clips.filter(c => c.enabled !== false).length;
    if (enabledCount === 0) {
      return res.status(400).json({ error: 'Enable at least one clip before rendering' });
    }

    const editRender = {
      status: 'queued',
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      progress: { phase: 'queued', done: 0, total: enabledCount, percent: 0 },
      claimedBy: null,
    };

    updateJob(job.id, { editTimeline: timeline, editRender });
    try {
      fs.writeFileSync(
        path.join(dir, 'output', 'edit_timeline.json'),
        JSON.stringify(timeline, null, 2),
        'utf8'
      );
    } catch (_) {}

    res.status(202).json({
      ok: true,
      jobId: job.id,
      editRender,
      message: 'Edit render queued. You can close this tab and download later.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/download/:asset — download as attachment
app.get('/api/jobs/:id/download/:asset', async (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job || job.status !== 'done') return res.status(404).json({ error: 'not ready' });
    const targets = {
      video:  path.join(jobDir(job.id), 'output', 'final.mp4'),
      acted:  path.join(jobDir(job.id), 'output', 'acted.mp4'),
      concat: path.join(jobDir(job.id), 'output', 'concat-video.mp4'),
      edited: path.join(jobDir(job.id), 'output', 'edited.mp4'),
      images: path.join(jobDir(job.id), 'output', 'images.zip'),
    };
    if (req.params.asset === 'transcript') {
      const formatMs = (ms) => {
        if (ms == null) return '00:00.0';
        const totalSecs = ms / 1000;
        const mins = Math.floor(totalSecs / 60);
        const secs = Math.floor(totalSecs % 60);
        const tenths = Math.floor((ms % 1000) / 100);
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
      };

      const segments = Array.isArray(job.segments) ? job.segments : [];
      if (segments.length === 0) {
        try {
          const jsonPath = path.join(jobDir(job.id), 'output', 'transcript.json');
          if (fs.existsSync(jsonPath)) {
            const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const transcription = raw.transcription || [];
            segments.push(...transcription.map(t => ({
              startMs: t.offsets?.from || 0,
              endMs: t.offsets?.to || 0,
              text: t.text || ''
            })));
          }
        } catch (_) {}
      }

      if (segments.length === 0) {
        return res.status(404).json({ error: 'transcript not found or not yet generated' });
      }

      const lines = segments.map(seg => {
        return `[${formatMs(seg.startMs)}] ${seg.text}`;
      });
      const transcriptText = lines.join('\n');

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="transcript_${job.id}.txt"`);
      return res.send(transcriptText);
    }

    let file = targets[req.params.asset];
    if (!file) return res.status(404).json({ error: 'asset not found' });

    // If it's the images/assets zip and it's missing, generate it on the fly
    if (req.params.asset === 'images' && !fs.existsSync(file)) {
      console.log(`[server] images.zip missing for job ${job.id}, generating on the fly...`);
      try {
        const { spawn } = require('child_process');
        const dir = jobDir(job.id);
        const relativePaths = [];
        if (fs.existsSync(path.join(dir, 'output', 'images'))) relativePaths.push('output/images');
        if (fs.existsSync(path.join(dir, 'output', 'videoclips'))) relativePaths.push('output/videoclips');
        if (fs.existsSync(path.join(dir, 'output', 'captions.ass'))) relativePaths.push('output/captions.ass');
        if (fs.existsSync(path.join(dir, 'output', 'final_audio.aac'))) relativePaths.push('output/final_audio.aac');

        if (relativePaths.length > 0) {
          const psPaths = relativePaths.map(p => `'${p}'`).join(', ');
          const psCommand = `Compress-Archive -Path ${psPaths} -DestinationPath 'output/images.zip' -Force`;
          
          await new Promise((resolve, reject) => {
            const proc = spawn('powershell', ['-NoProfile', '-Command', psCommand], { cwd: dir });
            let stderr = '';
            proc.stderr.on('data', d => stderr += d.toString());
            proc.on('close', code => {
              if (code !== 0) reject(new Error(`PowerShell exited ${code}: ${stderr}`));
              else resolve();
            });
            proc.on('error', reject);
          });
        } else {
          return res.status(404).json({ error: 'no images or clips found to zip' });
        }
      } catch (zipErr) {
        console.error(`[server] failed to generate zip on the fly:`, zipErr);
        return res.status(500).json({ error: `failed to build zip archive: ${zipErr.message}` });
      }
    }

    if (!fs.existsSync(file)) return res.status(404).json({ error: 'asset not found' });
    res.download(file, (err) => { if (err && !res.headersSent) next(err); });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/preview/clip/:index — stream a single source clip for the editor
app.get('/api/jobs/:id/preview/clip/:index', (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job || job.status !== 'done') return res.status(404).json({ error: 'not ready' });

    const idx = parseInt(req.params.index, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx > 9999) {
      return res.status(400).json({ error: 'invalid clip index' });
    }

    const file = path.resolve(
      path.join(jobDir(job.id), 'output', 'videoclips', `clip_${String(idx).padStart(4, '0')}.mp4`)
    );
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'clip not found' });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, {
      acceptRanges: true,
      headers: { 'Content-Type': 'video/mp4' },
    }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/preview/:asset — inline video stream for <video src>.
// Uses res.sendFile so browsers can play inline and range-request for scrubbing.
// Auth: also accepts ?k= query param because <video> cannot send custom headers.
app.get('/api/jobs/:id/preview/:asset', (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job || job.status !== 'done') return res.status(404).json({ error: 'not ready' });
    
    let filename;
    if (req.params.asset === 'video') filename = 'final.mp4';
    else if (req.params.asset === 'acted') filename = 'acted.mp4';
    else if (req.params.asset === 'edited') filename = 'edited.mp4';
    else return res.status(404).json({ error: 'asset not found' });

    const file = path.resolve(path.join(jobDir(job.id), 'output', filename));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'asset not found' });

    // Explicit media headers help browsers (and reverse proxies) treat this as
    // a seekable video stream rather than a generic download.
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.sendFile(file, {
      acceptRanges: true,
      // Do not force download; <video> needs inline playback
      headers: {
        'Content-Type': 'video/mp4',
      },
    }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/retry — manual retry for a failed job
app.post('/api/jobs/:id/retry', (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    if (job.status !== 'failed') return res.status(400).json({ error: 'Only failed jobs can be retried' });
    
    // We update status to queued, clear the error, and clear computed properties
    // to ensure the job runs fresh from start with the new granular whisper segmenting.
    updateJob(job.id, { 
      status: 'queued', 
      error: null, 
      segments: null,
      totalDurationMs: null,
      styleSummary: null,
      beats: null,
      progress: null,
      batchTimings: null,
      recovery: 'Manual retry initiated' 
    });
    
    res.json({ id: job.id, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/jobs/:id — wipes all files for a job
app.delete('/api/jobs/:id', (req, res, next) => {
  try {
    deleteJob(req.params.id);
    _storageCache.ts = 0; // force fresh scan
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Cache to avoid expensive full recursive walks of jobs/ on every upload.
// The storage limit (default 30 GB) is high, so a short staleness is fine.
let _storageCache = { value: 0, ts: 0 };
const STORAGE_CACHE_TTL_MS = 10_000; // 10 seconds

function getTotalStorageUsed() {
  const now = Date.now();
  if (now - _storageCache.ts < STORAGE_CACHE_TTL_MS) {
    return _storageCache.value;
  }
  if (!fs.existsSync(JOBS_DIR)) {
    _storageCache = { value: 0, ts: now };
    return 0;
  }
  const total = fs.readdirSync(JOBS_DIR).reduce((sum, id) => sum + jobStorageBytes(id), 0);
  _storageCache = { value: total, ts: now };
  return total;
}

// ---- Static frontend ----
// Served AFTER API routes so /api/* always takes precedence.
app.use(express.static(path.join(__dirname, 'frontend')));

// ---- Global error handler ----
// Catches anything passed to next(err), including multer errors.
// Must have exactly 4 parameters so Express recognises it as an error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Multer errors → 400 Bad Request (never 500)
  // Covers: LIMIT_FILE_SIZE, LIMIT_UNEXPECTED_FILE ("Unexpected field"), LIMIT_FILE_COUNT, etc.
  if (err instanceof multer.MulterError || err.status === 400) {
    const expected = ALLOWED_UPLOAD_FIELDS.map(f => `"${f.name}"`).join(', ');
    const msg = err.code === 'LIMIT_FILE_SIZE'       ? 'File too large (max 3 GB)'
              : err.code === 'LIMIT_FILE_COUNT'      ? 'Too many files'
              : err.code === 'LIMIT_UNEXPECTED_FILE' ? `Unexpected upload field: "${err.field}" — expected one of: ${expected}`
              : err.message || 'File upload error';
    // Note: characterImages + styleReferences are the modern fields.
    // referenceImages is legacy only.
    console.warn('[upload 400]', msg);
    return res.status(400).json({ error: msg });
  }

  // Log & return a clean 500 for everything else
  console.error('[server 500]', err.stack || err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ---- Socket.IO — auth middleware ----
io.use((socket, next) => {
  const key = socket.handshake.auth?.apiKey
    || socket.handshake.headers?.['x-api-key'];
  if (!key) return next(new Error('API key required'));
  if (API_KEYS.length > 0 && !API_KEYS.includes(key)) return next(new Error('invalid API key'));
  socket.apiKey = key;
  next();
});

// ---- Socket.IO — connection handler ----
io.on('connection', (socket) => {
  socket.join(`list:${socket.apiKey}`);

  socket.on('job:subscribe', ({ jobId } = {}) => {
    if (!jobId || typeof jobId !== 'string') return;
    let job;
    try { job = readJob(jobId); } catch (_) { return; }
    if (!job || job.apiKey !== socket.apiKey) return;
    socket.join(`job:${jobId}`);
    socket.emit('job:update', stripSafe(job));
  });

  socket.on('job:unsubscribe', ({ jobId } = {}) => {
    if (jobId) socket.leave(`job:${jobId}`);
  });
});

// ---- fs.watch bridge: worker writes → server emits via Socket.IO ----
// The worker and server are separate processes; their only shared state is the filesystem.
// When worker calls updateJob() → fs.writeFileSync(jobs/<id>/job.json, ...)
// → fs.watch detects the change → server emits 'job:update' to subscribed clients (~150ms).

const _watchTimers = new Map();

function debouncedEmit(jobId) {
  if (_watchTimers.has(jobId)) clearTimeout(_watchTimers.get(jobId));
  _watchTimers.set(jobId, setTimeout(() => {
    _watchTimers.delete(jobId);
    let job;
    try { job = readJob(jobId); } catch (_) { return; }
    if (!job) return;
    io.to(`job:${jobId}`).emit('job:update', stripSafe(job));
    io.to(`list:${job.apiKey}`).emit('jobs:update', jobSummary(job));
  }, 150));
}

fs.mkdirSync(JOBS_DIR, { recursive: true });

try {
  fs.watch(JOBS_DIR, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (!filename.endsWith('job.json')) return;
    const parts = filename.split(/[/\\]/);
    if (parts.length < 2) return;
    debouncedEmit(parts[0]);
  });
} catch (e) {
  console.warn('[watch] fs.watch failed:', e.message, '— live push disabled, clients will refresh on reconnect.');
}

// ---- Start ----
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () =>
  console.log(`API + Socket.IO + frontend listening on :${PORT}  (API_KEYS: ${API_KEYS.length ? API_KEYS.length + ' key(s) configured' : 'OPEN (dev mode)'})`)
);

// Catch EADDRINUSE early so nodemon / the user gets a readable message instead of a raw crash.
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[server] Port ${PORT} is already in use.`);
    console.error(`[server] Kill the other process first:`);
    console.error(`[server]   Windows PowerShell: Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }`);
    console.error(`[server]   Linux / macOS:      fuser -k ${PORT}/tcp`);
    process.exit(1);
  } else {
    throw err; // re-throw unexpected errors
  }
});
