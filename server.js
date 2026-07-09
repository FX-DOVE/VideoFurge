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

const app        = express();
const httpServer = createServer(app);
const io         = new SocketIO(httpServer, {
  // Same-origin only. If you put nginx in front on a different origin,
  // set: cors: { origin: 'https://your-domain.com' }
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

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = jobDir(req.jobId);
      fs.mkdirSync(path.join(dir, 'input'), { recursive: true });
      cb(null, path.join(dir, 'input'));
    },
    filename: (req, file, cb) => cb(null, file.fieldname + path.extname(file.originalname)),
  }),
  limits: {
    fileSize:  3 * 1024 * 1024 * 1024, // 3 GB per file
    files:     21,   // 1 media + 20 reference images
    fields:    10,   // title, script + a few spares
  },
  fileFilter: (req, file, cb) => {
    // Reference images — pass through (ext validated in the route handler after upload)
    if (file.fieldname === 'referenceImages') return cb(null, true);
    // Media file — check mime/ext
    const okMime = ALLOWED_MIME.test(file.mimetype || '');
    const okExt  = ALLOWED_EXT.test(file.originalname || '');
    if (okMime || okExt) return cb(null, true);
    // Pass error via cb — do NOT throw: throwing inside busboy callbacks bypasses
    // Express error handling and crashes the request with an unhandled exception.
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
  });
});

// ---- Auth + rate-limit middleware for all /api/jobs routes ----
// req.jobId is set here for every request but only consumed by POST /api/jobs.
app.use('/api/jobs', requireAuth, (req, res, next) => {
  if (!checkDailyRate(req.apiKey)) {
    return res.status(429).json({ error: `rate limit: max ${MAX_JOBS_PER_DAY} jobs per 24h per key` });
  }
  req.jobId = uuid();
  next();
});

// ---- Helpers ----

// Strip filesystem paths and heavy computed fields before sending to clients.
function stripSafe(job) {
  if (!job) return null;
  const { mediaPath, referenceImagePaths, segments, beats, styleSummary, apiKey, script, ...rest } = job;
  return rest;
}

// Compact summary for the list view.
function jobSummary(job) {
  if (!job) return null;
  return {
    id:        job.id,
    title:     job.title,
    status:    job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt  || null,
    progress:  job.progress,
    error:     job.error      || null,
    recovery:  job.recovery   || null,
  };
}

// ---- Routes ----

// POST /api/jobs — create a new job (multipart upload)
app.post(
  '/api/jobs',
  upload.fields([
    { name: 'media',           maxCount: 1  },
    { name: 'referenceImages', maxCount: 20 },
  ]),
  (req, res) => {
    try {
      const totalUsed = getTotalStorageUsed();
      if (totalUsed > MAX_DISK_BYTES) {
        return res.status(507).json({ error: 'VPS storage is near capacity, delete old jobs first' });
      }

      const { title, script } = req.body;
      if (!title || !script || !req.files?.media || !req.files?.referenceImages?.length) {
        return res.status(400).json({
          error: 'title, script, media file, and at least one reference image are required',
        });
      }
      if (typeof script !== 'string' || script.length > MAX_SCRIPT_CHARS) {
        return res.status(400).json({ error: `script too long (max ${MAX_SCRIPT_CHARS} chars)` });
      }
      if (title.length > 200) {
        return res.status(400).json({ error: 'title too long (max 200 chars)' });
      }

      const media    = req.files.media[0];
      const badMedia = !ALLOWED_EXT.test(media.originalname) && !ALLOWED_MIME.test(media.mimetype || '');
      if (badMedia) {
        return res.status(400).json({ error: 'media must be an audio or video file' });
      }
      for (const img of req.files.referenceImages) {
        if (!/\.(png|jpg|jpeg|webp)$/i.test(img.originalname)) {
          return res.status(400).json({ error: 'referenceImages must be png/jpg/jpeg/webp' });
        }
      }

      const job = createJob(req.jobId, {
        title:               title.slice(0, 200),
        script:              script.slice(0, MAX_SCRIPT_CHARS),
        mediaPath:           req.files.media[0].path,
        referenceImagePaths: req.files.referenceImages.map(f => f.path),
        apiKey:              req.apiKey,
      });

      res.status(202).json({ id: job.id, status: job.status });
    } catch (err) {
      next(err); // let the global error handler format the response
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
    const { mediaPath, referenceImagePaths, ...safe } = job;
    res.json(safe);
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
      images: path.join(jobDir(job.id), 'output', 'images.zip'),
    };
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

// GET /api/jobs/:id/preview/video — inline video stream for <video src>.
// Uses res.sendFile so browsers can play inline and range-request for scrubbing.
// Auth: also accepts ?k= query param because <video> cannot send custom headers.
app.get('/api/jobs/:id/preview/video', (req, res, next) => {
  try {
    const job = readJob(req.params.id);
    if (!job || job.status !== 'done') return res.status(404).json({ error: 'not ready' });
    const file = path.resolve(path.join(jobDir(job.id), 'output', 'final.mp4'));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'asset not found' });
    res.sendFile(file, (err) => { if (err && !res.headersSent) next(err); });
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
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

function getTotalStorageUsed() {
  if (!fs.existsSync(JOBS_DIR)) return 0;
  return fs.readdirSync(JOBS_DIR).reduce((sum, id) => sum + jobStorageBytes(id), 0);
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
    const msg = err.code === 'LIMIT_FILE_SIZE'       ? 'File too large (max 3 GB)'
              : err.code === 'LIMIT_FILE_COUNT'      ? 'Too many files'
              : err.code === 'LIMIT_UNEXPECTED_FILE' ? `Unexpected upload field: "${err.field}" — expected "media" or "referenceImages"`
              : err.message || 'File upload error';
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
