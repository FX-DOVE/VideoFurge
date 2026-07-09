// Long-running worker process, separate from the API (run it with pm2
// or a systemd service, restart=always). Polls for the next queued job
// and processes jobs ONE AT A TIME — this is the RAM-safety rule for a
// 4GB VPS: never run two Grok CLI batches, or a whisper.cpp pass and a
// Grok batch, concurrently.
const fs = require('fs');
require('dotenv').config();
const path = require('path');
const { nextQueuedJob, updateJob, jobDir, readJob } = require('./lib/jobStore');
const { transcribe } = require('./lib/transcribe');
const { groupIntoBeats, buildPrompts, chunkIntoBatches, BEAT_SECONDS } = require('./lib/promptBuilder');
const { getStyleSummary, runBatch } = require('./lib/grokBatch');
const { stitch } = require('./lib/stitch');
const { mixAudio } = require('./lib/audioMix');

const POLL_INTERVAL_MS = 5000;
console.log("worker is running");

function logForJob(jobId, msg, extra) {
  const line = `[${new Date().toISOString()}] [${jobId}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
  // also to worker stdout (pm2 captures)
  process.stdout.write(line);
  // per-job file log (persists across restarts)
  try {
    const logPath = path.join(jobDir(jobId), 'job.log');
    fs.appendFileSync(logPath, line);
  } catch (_) { }
}

function isRetryable(err) {
  const m = String(err && err.message || err || '').toLowerCase();
  if (m.includes('content') && m.includes('policy')) return false;
  if (m.includes('invalid prompt') || m.includes('bad input') || m.includes('refused')) return false;
  return /timeout|killed|rate ?limit|429|503|502|connect|network|econn|socket|exit (1|124|137|143)/.test(m);
}

function recoverInterruptedJobs() {
  const { JOBS_DIR } = require('./lib/jobStore');
  if (!fs.existsSync(JOBS_DIR)) return;
  const ids = fs.readdirSync(JOBS_DIR);
  for (const id of ids) {
    let j;
    try { j = readJob(id); } catch (_) { continue; }
    if (!j) continue;
    const s = j.status;
    if (['queued', 'done', 'failed'].includes(s)) continue;
    if (s === 'generating') {
      // Re-queue at the last completed batch. runBatch skips items whose
      // image+clip already exist on disk, so partial batches resume safely.
      const pd = j.progress || { batchesDone: 0, batchesTotal: 0 };
      if ((pd.batchesDone || 0) < (pd.batchesTotal || 0)) {
        updateJob(id, { status: 'queued', error: null, recovery: `auto-recovered at batch ${pd.batchesDone}` });
        console.log(`[recover] queued ${id} to resume generating from batch ${pd.batchesDone}`);
      } else {
        updateJob(id, { status: 'queued' });
      }
    } else {
      updateJob(id, { status: 'failed', error: `interrupted during ${s}; resubmit to retry from start` });
      console.log(`[recover] marked ${id} failed (was ${s})`);
    }
  }
}

recoverInterruptedJobs();

async function processJob(job) {
  const dir = jobDir(job.id);
  let segments, totalDurationMs, styleSummary, beats, prompts, batches;
  const p = job.progress || { batchesDone: 0, batchesTotal: 0 };
  let startBatch = Number(p.batchesDone || 0);

  try {
    logForJob(job.id, 'process start', { status: job.status, progress: p });

    // --- TRANSCRIBE (resume if already done) ---
    if (job.segments && job.totalDurationMs && ['generating', 'stitching', 'queued'].includes(job.status)) {
      segments = job.segments;
      totalDurationMs = job.totalDurationMs;
      logForJob(job.id, 'resume from persisted segments');
    } else {
      updateJob(job.id, { status: 'transcribing' });
      logForJob(job.id, 'transcribing');
      segments = await transcribe(job.mediaPath, dir);
      totalDurationMs = segments.at(-1)?.endMs || 0;
      updateJob(job.id, { segments, totalDurationMs });
    }

    // --- BUILD PROMPTS (resume if already done) ---
    if (job.styleSummary && job.beats && ['generating', 'stitching', 'queued'].includes(job.status)) {
      styleSummary = job.styleSummary;
      beats = job.beats;
      logForJob(job.id, 'resume from persisted style/beats');
    } else {
      updateJob(job.id, { status: 'building_prompts' });
      logForJob(job.id, 'building_prompts');
      styleSummary = await getStyleSummary(job.referenceImagePaths, dir);
      beats = groupIntoBeats(segments, totalDurationMs);
      updateJob(job.id, { styleSummary, beats });
    }

    // --- GENERATE + ANIMATE (one Grok session per batch of 20 beats) ---
    // Each batch session generates the image AND video clip for each beat.
    // runBatch skips beats that already have both files (resume-safe).
    prompts = buildPrompts(beats, styleSummary, job.script);
    batches = chunkIntoBatches(prompts);
    const totalB = batches.length;
    if (startBatch >= totalB || startBatch < 0) startBatch = 0;

    updateJob(job.id, { status: 'generating', progress: { batchesDone: startBatch, batchesTotal: totalB } });
    logForJob(job.id, 'generating', { batchesTotal: totalB, startAt: startBatch });

    const MAX_ATTEMPTS = 3;
    const batchTimings = Array.isArray(job.batchTimings) ? [...job.batchTimings] : [];
    for (let i = startBatch; i < batches.length; i++) {
      const t0 = Date.now();
      let attempt = 0;
      while (attempt < MAX_ATTEMPTS) {
        attempt++;
        try {
          await runBatch(batches[i], styleSummary, i, dir);
          break;
        } catch (e) {
          const retryable = isRetryable(e);
          logForJob(job.id, `batch ${i} attempt ${attempt} ${retryable ? 'retryable-fail' : 'fatal'}`, { err: e.message });
          if (!retryable || attempt >= MAX_ATTEMPTS) {
            throw new Error(`batch ${i} failed after ${attempt} attempts (${retryable ? 'retries exhausted' : 'fatal'}): ${e.message}`);
          }
          const backoff = 1500 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
      const dt = Date.now() - t0;
      batchTimings[i] = dt;
      updateJob(job.id, {
        progress: { batchesDone: i + 1, batchesTotal: totalB },
        batchTimings,
      });
      // rough ETA
      const avg = batchTimings.filter(Boolean).reduce((a, b) => a + b, 0) / Math.max(1, batchTimings.filter(Boolean).length);
      const remain = Math.max(0, totalB - (i + 1));
      const etaMs = Math.round(avg * remain);
      logForJob(job.id, `batch ${i + 1}/${totalB} done`, { ms: dt, etaMs: remain ? etaMs : 0 });
    }

    // --- MIX AUDIO (voiceover + BGM + ambient SFX) ---
    let mixedAudioPath = null;
    try {
      updateJob(job.id, { status: 'mixing_audio' });
      logForJob(job.id, 'mixing_audio');
      const outDir = path.join(dir, 'output');
      mixedAudioPath = await mixAudio(job.mediaPath, beats, outDir);
      logForJob(job.id, 'mixing_audio done', { mixedAudio: mixedAudioPath });
    } catch (mixErr) {
      // Non-fatal: log warning and continue with raw voiceover
      logForJob(job.id, 'mixing_audio WARN (non-fatal, using raw voiceover)', { error: String(mixErr && mixErr.message || mixErr) });
      mixedAudioPath = null;
    }

    // --- STITCH (concat all clips + mux mixed audio) ---
    updateJob(job.id, { status: 'stitching' });
    logForJob(job.id, 'stitching');
    await stitch({ jobDir: dir, beats, audioPath: job.mediaPath, mixedAudioPath, beatSeconds: BEAT_SECONDS, segments });

    updateJob(job.id, { status: 'done', error: null });
    logForJob(job.id, 'done');
  } catch (err) {
    updateJob(job.id, { status: 'failed', error: String(err && err.message || err) });
    logForJob(job.id, 'FAILED', { error: String(err && err.message || err) });
  }
}

async function loop() {
  const job = nextQueuedJob();
  if (job) {
    logForJob(job.id, `picked for processing${job.recovery ? ' (recovered)' : ''}`);
    await processJob(job);
  }
  setTimeout(loop, POLL_INTERVAL_MS);
}

loop();
