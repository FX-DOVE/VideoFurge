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
const { groupIntoBeats, buildPrompts, chunkIntoBatches, segmentsFromScript, BEAT_SECONDS } = require('./lib/promptBuilder');
const { getStyleSummary, runBatch } = require('./lib/grokBatch');
const { runPreProduction } = require('./lib/preproduction');
const { updateContinuity } = require('./lib/continuityUpdater');
const { stitch } = require('./lib/stitch');
const { mixAudio } = require('./lib/audioMix');
const { renderEditedVideo } = require('./lib/editorRender');
const { getMode, normalizeModeId, hasFixedRuntime } = require('./lib/videoModes');
const { normalizeAspectKey, resolveAspect } = require('./lib/aspect');
const { generateScript } = require('./lib/scriptGenerator');
const { getStorage } = require('./services/storage');
const { startGrokSessionCleanupScheduler } = require('./lib/grokSessionCleanup');

const POLL_INTERVAL_MS = 5000;
console.log("worker is running");

// Background maintenance: delete Grok CLI session dirs older than GROK_SESSION_RETENTION_DAYS (default 2).
// Only touches ~/.grok/sessions/* (or GROK_SESSIONS_DIR); never deletes ~/.grok itself.
try {
  startGrokSessionCleanupScheduler();
} catch (err) {
  console.error('[worker] grok session cleanup scheduler failed to start (non-fatal):', err && err.message || err);
}

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

function appendJobLog(jobId, line) {
  try {
    fs.appendFileSync(path.join(jobDir(jobId), 'job.log'), line);
  } catch (_) {}
}

/**
 * Durable storage handoff (Drive + Mongo). No-op when GOOGLE_DRIVE_ENABLED is false.
 * Never throws out of processJob — failures keep local files and record storage.error.
 */
async function runStorageHandoff(job, { stage }) {
  const storage = getStorage();
  const dir = jobDir(job.id);
  try {
    const result = await storage.finalizeJobOutputs(job, dir, {
      stage,
      appendJobLog,
    });
    if (result && result.storage) {
      updateJob(job.id, { storage: result.storage });
    }
    logForJob(job.id, 'storage handoff', {
      stage,
      enabled: result.enabled,
      complete: result.complete,
      results: (result.results || []).map(r => ({
        assetKey: r.assetKey,
        ok: r.ok,
        skipped: r.skipped,
        error: r.error || null,
      })),
    });
    return result;
  } catch (err) {
    logForJob(job.id, 'storage handoff FAILED', { stage, error: String(err && err.message || err) });
    try {
      updateJob(job.id, {
        storage: {
          provider: 'google_drive',
          enabled: storage.isEnabled(),
          complete: false,
          error: String(err && err.message || err),
          completedAt: new Date().toISOString(),
        },
      });
    } catch (_) {}
    return { enabled: storage.isEnabled(), complete: false, error: String(err && err.message || err) };
  }
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
          progress: {
            phase: 'queued',
            done: 0,
            total: j.editRender.progress?.total || 0,
            percent: 0,
          },
        },
      });
      console.log(`[recover] re-queued edit render for ${id}`);
      continue;
    }

    if (['queued', 'done', 'failed'].includes(s)) continue;

    // Interrupted during Drive handoff — re-queue; local files still present for retry
    if (s === 'uploading') {
      updateJob(id, { status: 'queued', error: null, recovery: 'auto-recovered from uploading (storage handoff)' });
      console.log(`[recover] queued ${id} (was uploading) for storage/finalize retry`);
      continue;
    }

    // Re-queue interrupted jobs (including claim-only "processing") so any available
    // worker can pick them up. processJob() resume logic skips completed stages.
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

    // Upload edited.mp4 to Drive + Mongo, then delete local when confirmed
    const fresh = readJob(job.id) || job;
    await runStorageHandoff(fresh, { stage: 'edit' });

    const cur = readJob(job.id);
    const totalClips = cur?.editRender?.progress?.total
      || (Array.isArray(cur?.editTimeline?.clips)
        ? cur.editTimeline.clips.filter(c => c.enabled !== false).length
        : 1);
    updateJob(job.id, {
      editRender: {
        ...(cur?.editRender || {}),
        status: 'done',
        finishedAt: new Date().toISOString(),
        error: null,
        progress: {
          phase: 'done',
          done: totalClips,
          total: totalClips,
          percent: 100,
        },
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

    // Fast path: re-queued after interrupted Drive handoff — stitch already done, finals on disk
    const finalPath = path.join(dir, 'output', 'final.mp4');
    const actedPath = path.join(dir, 'output', 'acted.mp4');
    if (
      job.recovery && /uploading|storage/i.test(String(job.recovery)) &&
      (fs.existsSync(finalPath) || fs.existsSync(actedPath))
    ) {
      logForJob(job.id, 'storage-only recovery path');
      updateJob(job.id, { status: 'uploading', recovery: null });
      await runStorageHandoff(job, { stage: 'stitch' });
      updateJob(job.id, { status: 'done', error: null });
      logForJob(job.id, 'done (storage recovery)');
      return;
    }

    // Common inputs
    const characters = Array.isArray(job.characters) ? job.characters : [];
    const sceneStyle = job.sceneStyle || '';
    const styleReferencePaths = Array.isArray(job.styleReferencePaths) ? job.styleReferencePaths : [];

    // Video type + aspect ratio (backward compatible defaults).
    const videoType = normalizeModeId(job.videoType);
    const mode = getMode(videoType);
    const resolution = normalizeAspectKey(job.resolution || mode.defaultAspect);
    const customOptions = (job.customOptions && typeof job.customOptions === 'object') ? job.customOptions : {};
    job.videoType = videoType;
    job.resolution = resolution;
    job.customOptions = customOptions;
    updateJob(job.id, { videoType, resolution, customOptions });

    // Strict media check: only a real existing file counts. null/undefined/"" must NOT
    // reach path.resolve / whisper (that throws: paths[0] must be of type string).
    const mediaPath =
      (typeof job.mediaPath === 'string' && job.mediaPath.trim()) ? job.mediaPath.trim() : null;
    const hasMedia = !!(mediaPath && fs.existsSync(mediaPath));
    if (job.mediaPath && !hasMedia) {
      logForJob(job.id, 'mediaPath present but unusable — treating as no-media', {
        mediaPath: job.mediaPath,
      });
    }

    // Audio-first modes (documentary, explainer, commercial, music video) MUST have
    // media so visuals are timed and matched to the real audio. Acted/dialogue-driven
    // modes (drama, movie, cinematic_trailer, anime) may run from the script alone.
    if (!hasMedia && mode.mediaRequired !== false) {
      throw new Error(
        `Video type "${mode.label}" is audio-first and requires a media file. ` +
        `No media was provided. Re-create the job with an audio/video file, or choose an acted mode (Drama, Movie, Cinematic Trailer, Anime).`
      );
    }

    // Exact runtime for Drama / Movie / Anime (and any fixedRuntime mode).
    // User-chosen minutes MUST match final video length when there is no media.
    const fixedRuntime = hasFixedRuntime(videoType) || !!mode.fixedRuntime;
    const defaultMin = mode.defaultTargetMinutes || 3;
    let targetMinutes = Number(customOptions.targetMinutes);
    if (!Number.isFinite(targetMinutes) || targetMinutes < 1) {
      targetMinutes = fixedRuntime ? defaultMin : null;
    } else {
      targetMinutes = Math.max(1, Math.min(30, Math.round(targetMinutes)));
    }
    const partNumber = Math.max(1, Math.min(50, Number(customOptions.partNumber) || 1));
    if (fixedRuntime && targetMinutes) {
      customOptions.targetMinutes = targetMinutes;
      customOptions.partNumber = partNumber;
      updateJob(job.id, { customOptions, targetMinutes, partNumber });
      logForJob(job.id, 'fixed runtime', { targetMinutes, partNumber, videoType });
    }

    // Auto-generate a script ONLY when there is no media (acted modes running from
    // script alone). With media, the audio transcription is the source of truth,
    // so we never fabricate a competing script.
    if (!hasMedia && mode.allowScriptGen && (!job.script || !job.script.trim()) && !job.scriptGenerated) {
      try {
        logForJob(job.id, 'generating script from title', {
          videoType, hasMedia, targetMinutes, partNumber,
        });
        const gen = await generateScript(
          {
            title: job.title,
            mode,
            characters,
            sceneStyle,
            custom: { ...customOptions, targetMinutes, partNumber },
          },
          dir
        );
        if (gen) {
          job.script = gen;
          updateJob(job.id, { script: gen, scriptGenerated: true });
          logForJob(job.id, 'script generated', { chars: gen.length, targetMinutes });
        }
      } catch (sgErr) {
        logForJob(job.id, 'script generation WARN (non-fatal)', { error: String(sgErr && sgErr.message || sgErr) });
      }
    }

    // --- SEGMENTS: transcribe media, or synthesize from the script ---
    if (job.segments && job.totalDurationMs && !['done', 'failed'].includes(job.status)) {
      segments = job.segments;
      totalDurationMs = job.totalDurationMs;
      logForJob(job.id, 'resume from persisted segments');
    } else if (hasMedia) {
      updateJob(job.id, { status: 'transcribing' });
      logForJob(job.id, 'transcribing', { mediaPath });
      segments = await transcribe(mediaPath, dir);
      totalDurationMs = segments.at(-1)?.endMs || 0;
      updateJob(job.id, { segments, totalDurationMs });
    } else {
      // No media (typical drama/movie/anime): timed segments from the script.
      // When fixedRuntime is on, force EXACT targetMinutes and cliffhanger if needed.
      updateJob(job.id, { status: 'building_prompts', mediaPath: null, noMedia: true });
      logForJob(job.id, 'no media — building segments from script', {
        videoType,
        scriptChars: (job.script || '').length,
        targetMinutes,
        partNumber,
        fixedRuntime,
      });
      const segOpts = fixedRuntime && targetMinutes
        ? { targetMinutes, title: job.title, partNumber }
        : (targetMinutes ? { targetMinutes, title: job.title, partNumber } : {});
      segments = segmentsFromScript(job.script, segOpts);
      if (!segments.length) {
        throw new Error(
          'No media file and no usable script — cannot build a video. ' +
          'For Drama/Movie/Anime provide a title (AI writes a script) or paste a script. ' +
          'Or attach an audio/video file.'
        );
      }
      totalDurationMs = segments.totalDurationMs || segments.at(-1)?.endMs || 0;
      // Absolute snap to exact minutes for fixed-runtime modes
      if (fixedRuntime && targetMinutes) {
        const exact = Math.round(targetMinutes * 60 * 1000);
        if (segments.length && Math.abs(totalDurationMs - exact) > 2) {
          const last = segments[segments.length - 1];
          last.endMs = exact;
          totalDurationMs = exact;
        }
        totalDurationMs = exact;
      }
      const expectsPart2 = !!(segments.expectsPart2 || segments.some(s => s.expectsPart2 || s.cliffhanger));
      updateJob(job.id, {
        segments,
        totalDurationMs,
        noMedia: true,
        mediaPath: null,
        targetMinutes: targetMinutes || null,
        partNumber,
        expectsPart2,
        truncatedForRuntime: !!segments.truncated,
      });
      if (expectsPart2) {
        logForJob(job.id, 'story truncated to fit runtime — cliffhanger ending (Part 2 expected)', {
          targetMinutes,
          partNumber,
          segments: segments.length,
          totalDurationMs,
        });
      } else {
        logForJob(job.id, 'segments ready', {
          segments: segments.length,
          totalDurationMs,
          targetMinutes,
        });
      }
    }

    // --- PRE-PRODUCTION & SCREENPLAY (resume if already done) ---
    updateJob(job.id, {
      status: 'building_prompts',
      progress: {
        ...(job.progress || {}),
        phase: 'preproduction',
        detail: 'Writing screenplay & character refs via Grok…',
      },
    });
    logForJob(job.id, 'pre-production: screenplay & canonical refs', {
      videoType, resolution, hasMedia, segments: segments.length,
    });

    // Generates screenplay.json and populates jobs/<id>/refs/
    // Heartbeat so the UI does not look frozen during long Grok calls.
    const preprodHeartbeat = setInterval(() => {
      try {
        const cur = readJob(job.id);
        if (!cur || cur.status !== 'building_prompts') return;
        updateJob(job.id, {
          progress: {
            ...(cur.progress || {}),
            phase: 'preproduction',
            detail: 'Still building screenplay / refs (Grok is working)…',
            heartbeatAt: new Date().toISOString(),
          },
        });
        logForJob(job.id, 'pre-production still running (heartbeat)');
      } catch (_) {}
    }, 30000);

    let screenplay;
    try {
      screenplay = await runPreProduction(job, dir, segments);
    } finally {
      clearInterval(preprodHeartbeat);
    }
    logForJob(job.id, 'pre-production done', {
      hasScreenplay: !!screenplay,
      scenes: screenplay?.scenes?.length || 0,
    });
    
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
        // Rich acting-first fields from the director stack (may be undefined for documentary)
        performance: spBeat ? spBeat.performance : undefined,
        dialogue: spBeat && Array.isArray(spBeat.dialogue) ? spBeat.dialogue : [],
        camera: spBeat ? spBeat.camera : undefined,
        lighting: spBeat ? spBeat.lighting : undefined,
        emotionalIntensity: spBeat && spBeat.emotionalIntensity != null ? spBeat.emotionalIntensity : undefined,
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
    prompts = buildPrompts(beats, styleSummary, job.script, { characters, sceneStyle, styleReferencePaths, screenplay, videoType, resolution });
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
      logForJob(job.id, 'mixing_audio', { hasMedia });
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

      if (hasMedia) {
        // Voiceover-driven mix (voiceover + BGM + SFX).
        mixedAudioPath = await mixAudio(mediaPath, beats, outDir, actedBeats);
      } else {
        // No media/voiceover: still build the BGM+SFX bed so acted.mp4 works,
        // and use that bed as the final soundtrack (no narration).
        await mixAudio(null, beats, outDir, actedBeats);
        const actedBed = path.join(outDir, 'acted_audio.aac');
        mixedAudioPath = fs.existsSync(actedBed) ? actedBed : null;
      }
      logForJob(job.id, 'mixing_audio done', { mixedAudio: mixedAudioPath });
    } catch (mixErr) {
      // Non-fatal: log warning and continue with whatever audio is available
      logForJob(job.id, 'mixing_audio WARN (non-fatal)', { error: String(mixErr && mixErr.message || mixErr) });
      mixedAudioPath = null;
    }

    // --- STITCH (concat all clips + mux mixed audio) ---
    updateJob(job.id, { status: 'stitching' });
    logForJob(job.id, 'stitching');
    await stitch({
      jobDir: dir,
      beats,
      audioPath: hasMedia ? mediaPath : null,
      mixedAudioPath,
      beatSeconds: BEAT_SECONDS,
      segments,
      resolution,
      captionsEnabled: (customOptions.captionsOn != null ? !!customOptions.captionsOn : mode.captions),
    });

    // Durable storage: upload → verify → Mongo → delete local (or no-op if Drive disabled)
    updateJob(job.id, { status: 'uploading' });
    logForJob(job.id, 'storage handoff starting', { stage: 'stitch' });
    const jobAfterStitch = readJob(job.id) || job;
    await runStorageHandoff(jobAfterStitch, { stage: 'stitch' });

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
    // Claim uses status "processing" (worker then sets transcribing / building_prompts)
    if (!verify || verify.status !== 'processing' || verify.claimedBy !== job.claimedBy) {
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
