// Long-running worker process, separate from the API (reloaded for .env changes).
// or a systemd service, restart=always). Polls for queued jobs using a
// safe claim mechanism so that multiple workers (e.g. instances: 2) can
// safely process different jobs concurrently. A worker immediately claims
// a job (moves it out of 'queued') so no other worker will pick it.
const fs = require('fs');
require('dotenv').config();
const path = require('path');
const { claimNextQueuedJob, claimNextEditRenderJob, updateJob, jobDir, readJob } = require('./lib/jobStore');
const { transcribe } = require('./lib/transcribe');
const { groupIntoBeats, buildPrompts, chunkIntoBatches, BEAT_SECONDS } = require('./lib/promptBuilder');
const { getStyleSummary, runBatch } = require('./lib/grokBatch');
const { runPreProduction } = require('./lib/preproduction');
const { updateContinuity } = require('./lib/continuityUpdater');
const { stitch } = require('./lib/stitch');
const { mixAudio } = require('./lib/audioMix');
const { renderEditedVideo } = require('./lib/editorRender');

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

function getClipDuration(filePath) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
    const d = parseFloat(out.toString().trim());
    return isFinite(d) ? d : 10.0;
  } catch (e) {
    return 10.0;
  }
}

function isRetryable(err) {
  const m = String(err && err.message || err || '').toLowerCase();
  if (m.includes('content') && m.includes('policy')) return false;
  if (m.includes('invalid prompt') || m.includes('bad input') || m.includes('refused')) return false;
  // max-turns / non-zero exits are retryable because runBatch filters to only pending items
  // and will succeed if side-effect files were produced on a prior attempt.
  if (m.includes('max turn') || m.includes('max_turns') || m.includes('turns reached')) return true;
  if (m.includes('exited 1') || m.includes('exit 1')) return true;
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

    // Re-queue interrupted edit renders (job stays "done")
    if (s === 'done' && j.editRender && j.editRender.status === 'rendering') {
      updateJob(id, {
        editRender: {
          ...j.editRender,
          status: 'queued',
          error: null,
          claimedBy: null,
          progress: { phase: 'queued', done: 0, total: j.editRender.progress?.total || 0 },
        },
      });
      console.log(`[recover] re-queued edit render for ${id}`);
      continue;
    }

    if (['queued', 'done', 'failed'].includes(s)) continue;

    // Re-queue interrupted jobs so any available worker can pick them up.
    // The processJob() resume logic (based on persisted segments/beats/progress)
    // will skip stages that are already complete on disk.
    if (s === 'generating') {
      const pd = j.progress || { batchesDone: 0, batchesTotal: 0 };
      const note = (pd.batchesDone || 0) < (pd.batchesTotal || 0)
        ? `auto-recovered at batch ${pd.batchesDone}`
        : 'auto-recovered';
      updateJob(id, { status: 'queued', error: null, recovery: note });
      console.log(`[recover] queued ${id} to resume from ${note}`);
    } else {
      updateJob(id, { status: 'queued', error: null, recovery: `auto-recovered from ${s}` });
      console.log(`[recover] queued ${id} (was ${s}) for retry by available worker`);
    }
  }
}

async function processEditRender(job) {
  const dir = jobDir(job.id);
  logForJob(job.id, 'edit render starting');
  try {
    const timeline = job.editTimeline || null;
    await renderEditedVideo({
      jobDir: dir,
      job,
      timeline,
      onProgress: (p) => {
        try {
          const cur = readJob(job.id);
          if (!cur?.editRender || cur.editRender.status !== 'rendering') return;
          updateJob(job.id, {
            editRender: {
              ...cur.editRender,
              progress: p,
            },
          });
        } catch (_) {}
      },
    });

    const cur = readJob(job.id);
    updateJob(job.id, {
      editRender: {
        ...(cur?.editRender || {}),
        status: 'done',
        finishedAt: new Date().toISOString(),
        error: null,
        progress: { phase: 'done', done: 1, total: 1 },
      },
    });
    logForJob(job.id, 'edit render done');
  } catch (err) {
    const cur = readJob(job.id);
    updateJob(job.id, {
      editRender: {
        ...(cur?.editRender || {}),
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: String(err && err.message || err),
      },
    });
    logForJob(job.id, 'edit render FAILED', { error: String(err && err.message || err) });
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
    if (job.segments && job.totalDurationMs && !['done', 'failed'].includes(job.status)) {
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

    // --- PRE-PRODUCTION & SCREENPLAY (resume if already done) ---
    const characters = Array.isArray(job.characters) ? job.characters : [];
    const sceneStyle = job.sceneStyle || '';
    const styleReferencePaths = Array.isArray(job.styleReferencePaths) ? job.styleReferencePaths : [];

    updateJob(job.id, { status: 'building_prompts' });
    logForJob(job.id, 'pre-production: screenplay & canonical refs');
    
    // Generates screenplay.json and populates jobs/<id>/refs/
    const screenplay = await runPreProduction(job, dir, segments);
    
    // Extract and map screenplay beats strictly aligned with Whisper segments
    beats = [];
    const screenplayBeatsMap = new Map();
    if (screenplay && screenplay.scenes) {
      for (const scene of screenplay.scenes) {
        if (scene.beats) {
          for (const beat of scene.beats) {
            screenplayBeatsMap.set(beat.beatIndex, {
              ...beat,
              sceneId: scene.sceneId,
              location: scene.location,
              timeOfDay: scene.timeOfDay,
              weather: scene.weather
            });
          }
        }
      }
    }

    // Contiguously partition the entire audio timeline
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const spBeat = screenplayBeatsMap.get(i);
      
      let startMs, endMs;
      if (i === 0) {
        startMs = 0;
      } else {
        startMs = beats[i - 1].endMs;
      }
      
      if (i === segments.length - 1) {
        endMs = totalDurationMs;
      } else {
        endMs = segments[i + 1].startMs;
      }
      
      // Make sure endMs is strictly greater than startMs
      if (endMs <= startMs) {
        endMs = startMs + 1000;
      }

      beats.push({
        index: i,
        beatIndex: i,
        startMs,
        endMs,
        text: seg.text.trim(),
        narration: seg.text.trim(),
        sceneId: spBeat ? spBeat.sceneId : 1,
        location: spBeat ? spBeat.location : 'Unknown Location',
        timeOfDay: spBeat ? spBeat.timeOfDay : 'Daytime',
        weather: spBeat ? spBeat.weather : 'Clear',
        charactersPresent: spBeat ? spBeat.charactersPresent : [],
        characterStates: spBeat ? spBeat.characterStates : {},
        shotType: spBeat ? spBeat.shotType : 'medium shot',
        cameraMovement: spBeat ? spBeat.cameraMovement : 'Gentle parallax drift',
        sfx: spBeat ? spBeat.sfx : [],
        music: spBeat ? spBeat.music : null,
        emergentDetails: spBeat ? spBeat.emergentDetails : null
      });
    }
    
    // To support downstream promptBuilder backward-compat
    styleSummary = (screenplay && screenplay.productionBible && screenplay.productionBible.style) ? 
      `STYLE CLASSIFICATION: ${screenplay.productionBible.style.styleClassification}\nMedium: ${screenplay.productionBible.style.medium}` :
      (job.styleSummary || '');
      
    updateJob(job.id, { styleSummary, beats });

    // --- GENERATE + ANIMATE (one Grok session per small batch of beats) ---
    // Each batch session generates the image AND video clip for its beats.
    // runBatch skips beats that already have both files (resume-safe).
    // Small batches reduce chance of hitting --max-turns before finishing.
    prompts = buildPrompts(beats, styleSummary, job.script, { characters, sceneStyle, styleReferencePaths, screenplay });
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
          await runBatch(batches[i], styleSummary, i, dir, { characters, sceneStyle, styleReferencePaths, screenplay });
          // Phase 3: Post-Generation Continuity Loop
          if (screenplay) {
            await updateContinuity(batches[i], dir, screenplay);
          }
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
      
      // Calculate actedBeats using actual generated clip durations on disk
      const actedBeats = [];
      let currentMs = 0;
      for (let i = 0; i < beats.length; i++) {
        const b = beats[i];
        const clipFile = path.join(dir, 'output', 'videoclips', `clip_${String(i).padStart(4, '0')}.mp4`);
        const durSecs = fs.existsSync(clipFile) ? getClipDuration(clipFile) : ((b.endMs - b.startMs) / 1000);
        const startMs = currentMs;
        const endMs = startMs + Math.round(durSecs * 1000);
        currentMs = endMs;
        
        actedBeats.push({
          ...b,
          startMs,
          endMs
        });
      }
      
      mixedAudioPath = await mixAudio(job.mediaPath, beats, outDir, actedBeats);
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
  // Jitter to desynchronize multiple workers and reduce simultaneous claim races
  // (especially right after startup when recover runs in all workers).
  await new Promise(r => setTimeout(r, 50 + Math.random() * 300));

  // Prefer full pipeline jobs first, then user edit re-renders
  const job = claimNextQueuedJob();
  if (job) {
    // Extra verification after claim (defends against races at startup etc.)
    const verify = readJob(job.id);
    if (!verify || verify.status !== 'transcribing' || verify.claimedBy !== job.claimedBy) {
      logForJob(job.id || 'unknown', 'lost claim race after picking, skipping');
      setTimeout(loop, POLL_INTERVAL_MS);
      return;
    }
    logForJob(job.id, `picked for processing${job.recovery ? ' (recovered)' : ''}`);
    await processJob(job);
  } else {
    const editJob = claimNextEditRenderJob();
    if (editJob) {
      logForJob(editJob.id, 'picked for edit render');
      await processEditRender(editJob);
    }
  }
  setTimeout(loop, POLL_INTERVAL_MS);
}

loop();
