// Re-renders a job from a user edit timeline (reorder / trim / transitions).
// Produces output/edited.mp4. Runs inside the worker so users can leave and
// download later.

'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ffmpegScalePad, resolveAspect } = require('./aspect');

// Join / transition catalog (CapCut-style names).
// kind:
//   cut   — hard concat, no blend
//   mix   — true opacity blend (xfade transition=fade) + acrossfade audio
//           Clips dissolve into each other — NOT fade-through-black.
//   xfade — other overlapping xfade styles (slides, wipe, fadeblack, …)
const TRANSITION_DEFS = {
  none:       { kind: 'cut',   label: 'Cut' },
  mix:        { kind: 'mix',   label: 'Mix',       xfade: 'fade' },
  fade:       { kind: 'xfade', label: 'Crossfade', xfade: 'fade' },
  dissolve:   { kind: 'xfade', label: 'Dissolve',  xfade: 'fade' },
  fadeblack:  { kind: 'xfade', label: 'Fade black', xfade: 'fadeblack' },
  fadewhite:  { kind: 'xfade', label: 'Fade white', xfade: 'fadewhite' },
  slideleft:  { kind: 'xfade', label: 'Slide ←',   xfade: 'slideleft' },
  slideright: { kind: 'xfade', label: 'Slide →',   xfade: 'slideright' },
  slideup:    { kind: 'xfade', label: 'Slide ↑',   xfade: 'slideup' },
  slidedown:  { kind: 'xfade', label: 'Slide ↓',   xfade: 'slidedown' },
  wipeleft:   { kind: 'xfade', label: 'Wipe ←',    xfade: 'wipeleft' },
  wiperight:  { kind: 'xfade', label: 'Wipe →',    xfade: 'wiperight' },
  circleopen: { kind: 'xfade', label: 'Circle open', xfade: 'circleopen' },
  circleclose:{ kind: 'xfade', label: 'Circle close', xfade: 'circleclose' },
  distance:   { kind: 'xfade', label: 'Distance',  xfade: 'distance' },
  pixelize:   { kind: 'xfade', label: 'Pixelize',  xfade: 'pixelize' },
};

const TRANSITIONS = new Set(Object.keys(TRANSITION_DEFS));
const DEFAULT_TRANSITION = 'mix';
const DEFAULT_TRANSITION_DURATION = 0.5;

function transitionKind(id) {
  return (TRANSITION_DEFS[id] && TRANSITION_DEFS[id].kind) || 'cut';
}

function mapXfadeName(id) {
  const def = TRANSITION_DEFS[id];
  if (def && def.xfade) return def.xfade;
  // Mix defaults to opacity blend (fade), not fadeblack
  if (id === 'mix') return 'fade';
  return 'fade';
}

/** True when this join should use overlapping blend (Mix or any xfade style). */
function wantsBlend(kind, duration) {
  return (kind === 'mix' || kind === 'xfade') && Number(duration) > 0.05;
}

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`${label} exited ${code}: ${stderr.slice(-1200)}`));
      resolve();
    });
    proc.on('error', reject);
  });
}

function getClipDuration(filePath) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8' }
    );
    const d = parseFloat(String(out).trim());
    return isFinite(d) ? d : 0;
  } catch (_) {
    return 0;
  }
}

function hasAudio(filePath) {
  try {
    const out = execSync(
      `ffprobe -v error -select_streams a -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8' }
    );
    return String(out).trim().length > 0;
  } catch (_) {
    return false;
  }
}

function escConcatPath(p) {
  return p.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

/**
 * List source clips for a job (raw Grok clips preferred).
 * Returns [{ index, file, name, duration, text, startMs, endMs }]
 */
function listJobClips(jobDir, job) {
  const clipsDir = path.join(jobDir, 'output', 'videoclips');
  if (!fs.existsSync(clipsDir)) return [];

  const files = fs.readdirSync(clipsDir)
    .filter(f => /^clip_\d{4}\.mp4$/i.test(f))
    .sort();

  const beats = Array.isArray(job?.beats) ? job.beats : [];
  const segments = Array.isArray(job?.segments) ? job.segments : [];

  return files.map((name, i) => {
    const file = path.join(clipsDir, name);
    const duration = getClipDuration(file);
    const beat = beats[i] || segments[i] || {};
    const text = beat.narration || beat.text || `Clip ${i + 1}`;
    const startMs = beat.startMs ?? null;
    const endMs = beat.endMs ?? null;
    return {
      index: i,
      name,
      file,
      duration,
      text: String(text).slice(0, 200),
      startMs,
      endMs,
    };
  });
}

/**
 * Build a default timeline from existing clips (assembled in original order).
 */
function defaultTimeline(clips) {
  return {
    version: 1,
    clips: clips.map((c, i) => ({
      id: `c${i}-${c.index}`,
      sourceIndex: c.index,
      enabled: true,
      trimStart: 0,
      trimEnd: Number(c.duration.toFixed(3)),
      speed: 1,
      // Transition applied when entering this clip from the previous one
      transition: i === 0 ? 'none' : DEFAULT_TRANSITION,
      transitionDuration: i === 0 ? 0 : DEFAULT_TRANSITION_DURATION,
    })),
    audioMode: 'acted', // 'acted' | 'voice' | 'silent'
    defaultTransition: DEFAULT_TRANSITION,
    defaultTransitionDuration: DEFAULT_TRANSITION_DURATION,
    resolution: '1920x1080',
    captions: {
      enabled: false,
      font: 'Arial',
      fontSize: 48,
      color: '#ffffff',
      bgColor: '#000000',
      position: 'bottom',
      style: 'shadow',
    },
  };
}

function normalizeTimeline(timeline, clips) {
  const byIndex = new Map(clips.map(c => [c.index, c]));
  const src = timeline && typeof timeline === 'object' ? timeline : {};
  const rawClips = Array.isArray(src.clips) ? src.clips : [];

  const outClips = [];
  for (const item of rawClips) {
    const sourceIndex = Number(item.sourceIndex);
    if (!Number.isInteger(sourceIndex) || !byIndex.has(sourceIndex)) continue;
    const meta = byIndex.get(sourceIndex);
    const maxDur = meta.duration || 0;
    let trimStart = Math.max(0, Number(item.trimStart) || 0);
    let trimEnd = item.trimEnd == null ? maxDur : Number(item.trimEnd);
    if (!isFinite(trimEnd) || trimEnd <= trimStart) trimEnd = maxDur;
    trimStart = Math.min(trimStart, Math.max(0, maxDur - 0.05));
    trimEnd = Math.min(Math.max(trimEnd, trimStart + 0.05), maxDur || trimEnd);
    const transition = TRANSITIONS.has(item.transition) ? item.transition : 'none';
    const transitionDuration = Math.max(0, Math.min(2, Number(item.transitionDuration) || 0));
    const speed = Math.max(0.25, Math.min(4, Number(item.speed) || 1));
    outClips.push({
      id: String(item.id || `c${outClips.length}-${sourceIndex}`),
      sourceIndex,
      enabled: item.enabled !== false,
      trimStart: Number(trimStart.toFixed(3)),
      trimEnd: Number(trimEnd.toFixed(3)),
      speed,
      transition,
      transitionDuration,
    });
  }

  // If empty, fall back to full assembly
  if (outClips.length === 0) return defaultTimeline(clips);

  const audioMode = ['acted', 'voice', 'silent'].includes(src.audioMode) ? src.audioMode : 'acted';
  const defaultTransition = TRANSITIONS.has(src.defaultTransition) ? src.defaultTransition : DEFAULT_TRANSITION;
  const defaultTransitionDuration = Math.max(
    0,
    Math.min(2, Number(src.defaultTransitionDuration ?? DEFAULT_TRANSITION_DURATION) || 0)
  );
  // Accept a WxH string (from any aspect preset) or the legacy fixed options.
  const aspt = resolveAspect(src.resolution || '1920x1080');
  const resolution = `${aspt.w}x${aspt.h}`;
  const cap = src.captions && typeof src.captions === 'object' ? src.captions : {};
  const captions = {
    enabled: Boolean(cap.enabled),
    font: String(cap.font || 'Arial').slice(0, 40),
    fontSize: Math.max(18, Math.min(96, Number(cap.fontSize) || 48)),
    color: /^#[0-9a-fA-F]{6}$/.test(cap.color) ? cap.color : '#ffffff',
    bgColor: /^#[0-9a-fA-F]{6}$/.test(cap.bgColor) ? cap.bgColor : '#000000',
    position: ['top', 'center', 'bottom'].includes(cap.position) ? cap.position : 'bottom',
    style: ['normal', 'bold', 'shadow', 'outline', 'box'].includes(cap.style) ? cap.style : 'shadow',
  };

  const bgMusic = src.bgMusic && typeof src.bgMusic === 'object' ? {
    enabled: Boolean(src.bgMusic.enabled),
    filename: String(src.bgMusic.filename || ''),
    volume: Number(src.bgMusic.volume ?? 0.4),
    serverPath: String(src.bgMusic.serverPath || ''),
    url: String(src.bgMusic.url || ''),
  } : { enabled: false, filename: '', volume: 0.4, serverPath: '', url: '' };

  const voiceTrack = src.voiceTrack && typeof src.voiceTrack === 'object' ? {
    enabled: Boolean(src.voiceTrack.enabled),
    filename: String(src.voiceTrack.filename || ''),
    volume: Number(src.voiceTrack.volume ?? 1.0),
    serverPath: String(src.voiceTrack.serverPath || ''),
    url: String(src.voiceTrack.url || ''),
  } : { enabled: false, filename: '', volume: 1.0, serverPath: '', url: '' };

  return {
    version: 1,
    clips: outClips,
    audioMode,
    defaultTransition,
    defaultTransitionDuration,
    resolution,
    captions,
    bgMusic,
    voiceTrack,
  };
}

/**
 * Process a single clip segment (trim + scale only).
 * Always writes a stereo AAC track so later concat / mix steps never mute clips:
 *   - source audio when present (original Grok clip sound)
 *   - silence when the source has no audio
 *
 * No edge fade-to-black. Mix / Crossfade blends are applied at join time via xfade
 * so consecutive clips dissolve into each other (true CapCut Mix).
 */
async function processSegment(srcFile, destFile, {
  trimStart,
  trimEnd,
  scalePad = null,
}) {
  const dur = Math.max(0.05, trimEnd - trimStart);
  const clipHasAudio = hasAudio(srcFile);

  const sp = scalePad || 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black';
  const vf = `${sp},setsar=1,fps=24,format=yuv420p`;

  const args = [
    '-ss', String(trimStart),
    '-t', String(dur),
    '-i', srcFile,
  ];

  if (clipHasAudio) {
    args.push(
      '-vf', vf,
      '-af', 'aformat=sample_rates=48000:channel_layouts=stereo',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      '-y', destFile
    );
  } else {
    // Generate silence so every segment has a usable audio stream for acrossfade
    args.push(
      '-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-filter_complex', `[0:v]${vf}[v];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      '-shortest',
      '-y', destFile
    );
  }

  await runFfmpeg(args, `editor segment ${path.basename(destFile)}`);
}

/**
 * Concatenate per-segment audio into one continuous native clip-audio bed.
 * Used when the video path is xfade (video-only) so we still keep original sound.
 *
 * FFmpeg concat demuxer resolves relative paths against the list file's directory,
 * so we always write basenames + put the list next to the segment files.
 */
async function buildNativeAudioFromSegments(processed, outFile) {
  if (!processed.length) throw new Error('No segments for native audio');

  const workDir = path.dirname(processed[0].file);
  const listFile = path.join(workDir, 'native_audio_concat.txt');
  // Use basenames — all segs live in the same workDir as the list file
  fs.writeFileSync(
    listFile,
    processed.map(p => `file '${path.basename(p.file).replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  );

  // Extract+concat audio only (re-encode for consistent params)
  await runFfmpeg([
    '-f', 'concat', '-safe', '0',
    '-i', listFile,
    '-vn',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k',
    '-y', outFile,
  ], 'editor native audio concat');
}

/**
 * Weighted progress for the frontend progress bar.
 * prepare clips ≈ 0–70%, transitions ≈ 70–85%, final mux ≈ 85–99%.
 */
function emitProgress(onProgress, { phase, done, total, percent }) {
  if (typeof onProgress !== 'function') return;
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeDone = Math.max(0, Math.min(safeTotal || Number(done) || 0, Number(done) || 0));
  let pct = percent;
  if (pct == null && safeTotal > 0) {
    pct = Math.round((safeDone / safeTotal) * 100);
  }
  if (pct == null) pct = 0;
  pct = Math.max(0, Math.min(99, Math.round(pct)));
  onProgress({
    phase: phase || 'working',
    done: safeDone,
    total: safeTotal || 1,
    percent: pct,
  });
}

/**
 * Render the full timeline into output/edited.mp4
 */
async function renderEditedVideo({ jobDir, job, timeline, onProgress }) {
  const clips = listJobClips(jobDir, job);
  if (clips.length === 0) throw new Error('No source clips found for this job');

  const plan = normalizeTimeline(timeline, clips);
  const enabled = plan.clips.filter(c => c.enabled !== false);
  if (enabled.length === 0) throw new Error('Timeline has no enabled clips');

  // Aspect-correct scale/pad for every segment (default from job resolution).
  if (!plan.resolution && job && job.resolution) {
    const a = resolveAspect(job.resolution);
    plan.resolution = `${a.w}x${a.h}`;
  }
  const segScalePad = ffmpegScalePad(plan.resolution || '1920x1080');

  const workDir = path.join(jobDir, 'output', 'editor_work');
  fs.mkdirSync(workDir, { recursive: true });

  // Clean previous work files
  for (const f of fs.readdirSync(workDir)) {
    try { fs.unlinkSync(path.join(workDir, f)); } catch (_) {}
  }

  emitProgress(onProgress, {
    phase: 'prepare',
    done: 0,
    total: enabled.length,
    percent: 2,
  });

  // Join styles:
  //   cut   — hard concat
  //   mix   — true opacity blend (xfade fade) + acrossfade audio — preferred for acted
  //   xfade — slides / wipe / fadeblack / etc.
  // Mix no longer dips through black; clips dissolve into each other.
  // Acted fancy xfade styles degrade to Mix so dialogue acrossfades cleanly.
  const mode = plan.audioMode || 'acted';
  const actedLike = mode === 'acted' || mode === 'silent';
  const defaultDur = Math.max(
    0,
    Math.min(2, Number(plan.defaultTransitionDuration ?? DEFAULT_TRANSITION_DURATION) || DEFAULT_TRANSITION_DURATION)
  );

  // Resolve effective transition per clip (first clip always cut).
  const resolved = enabled.map((item, i) => {
    if (i === 0) return { ...item, transition: 'none', transitionDuration: 0, kind: 'cut' };
    let tr = TRANSITIONS.has(item.transition) ? item.transition : (plan.defaultTransition || DEFAULT_TRANSITION);
    let td = Math.max(0, Math.min(2, Number(item.transitionDuration) || defaultDur));
    if (tr === 'none') td = 0;
    let kind = transitionKind(tr);
    // Acted: fancy xfade styles (slides/wipes/fadeblack) → Mix opacity blend
    // so A/V stay locked via matching acrossfade (no black dips).
    if (actedLike && kind === 'xfade' && td > 0.05) {
      tr = 'mix';
      kind = 'mix';
    }
    return { ...item, transition: tr, transitionDuration: td, kind };
  });

  const processed = [];
  for (let i = 0; i < resolved.length; i++) {
    const item = resolved[i];
    const meta = clips.find(c => c.index === item.sourceIndex);
    if (!meta || !fs.existsSync(meta.file)) {
      throw new Error(`Missing source clip index ${item.sourceIndex}`);
    }
    const dest = path.join(workDir, `seg_${String(i).padStart(4, '0')}.mp4`);

    // No edge fade-to-black — blend happens at join time.
    await processSegment(meta.file, dest, {
      trimStart: item.trimStart,
      trimEnd: item.trimEnd,
      scalePad: segScalePad,
    });
    processed.push({
      file: dest,
      duration: Math.max(0.05, item.trimEnd - item.trimStart),
      transition: item.transition || 'none',
      transitionDuration: item.transitionDuration || 0,
      kind: item.kind || 'cut',
    });
    // Prepare phase occupies 0–70% of the overall bar
    const prepPct = 2 + Math.round(((i + 1) / enabled.length) * 68);
    emitProgress(onProgress, {
      phase: 'prepare',
      done: i + 1,
      total: enabled.length,
      percent: prepPct,
    });
  }

  const concatVideo = path.join(workDir, 'concat.mp4');
  // Use overlapping blend path whenever any join is Mix or xfade (including acted).
  // Pairwise Mix handles long timelines; multi-input xfade is fine for shorter ones.
  const needsBlend =
    processed.length >= 2 &&
    processed.some((p, i) => i > 0 && wantsBlend(p.kind, p.transitionDuration));

  // Prefer pairwise Mix when every blend join is Mix (or cut) — scales to 30+ clips.
  const allMixOrCut = processed.every((p, i) =>
    i === 0 || p.kind === 'cut' || p.kind === 'mix' || !wantsBlend(p.kind, p.transitionDuration)
  );
  const usePairwiseMix = needsBlend && allMixOrCut;
  // Multi-input xfade for fancy styles (voice mode slides etc.), capped for filter size
  const useMultiXfade =
    needsBlend && !usePairwiseMix && processed.length <= 40;

  emitProgress(onProgress, {
    phase: needsBlend ? 'xfade' : 'concat',
    done: enabled.length,
    total: enabled.length,
    percent: 72,
  });

  if (usePairwiseMix) {
    const { joinWithMix } = require('./videoJoin');
    // Use the max requested mix duration across joins (typical default 0.5s)
    let mixDur = defaultDur;
    for (let i = 1; i < processed.length; i++) {
      if (wantsBlend(processed[i].kind, processed[i].transitionDuration)) {
        mixDur = Math.max(mixDur, processed[i].transitionDuration || defaultDur);
      }
    }
    // If some joins are hard cuts, pairwise uniform mix would still blend them.
    // Fall back to multi-input path when cut and mix are mixed on the same timeline.
    const anyHardCutJoin = processed.some((p, i) =>
      i > 0 && !wantsBlend(p.kind, p.transitionDuration)
    );
    if (anyHardCutJoin && processed.length <= 40) {
      await renderWithXfade(processed, concatVideo, onProgress);
    } else {
      await joinWithMix(
        processed.map(p => p.file),
        concatVideo,
        {
          mixDur,
          includeAudio: true,
          onProgress: (msg) => emitProgress(onProgress, {
            phase: 'xfade',
            done: enabled.length,
            total: enabled.length,
            percent: 72 + Math.min(12, Math.round(12 * (parseInt(msg, 10) || 0) / Math.max(1, processed.length))),
            message: msg,
          }),
        }
      );
      emitProgress(onProgress, {
        phase: 'xfade',
        done: enabled.length,
        total: enabled.length,
        percent: 85,
      });
    }
  } else if (useMultiXfade) {
    await renderWithXfade(processed, concatVideo, onProgress);
  } else {
    // Hard concat — video + native clip audio stay locked
    const listFile = path.join(workDir, 'concat.txt');
    fs.writeFileSync(
      listFile,
      // basenames: concat demuxer resolves paths relative to the list file dir
      processed.map(p => `file '${path.basename(p.file).replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8'
    );
    await runFfmpeg([
      '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y', concatVideo,
    ], 'editor concat');
    emitProgress(onProgress, {
      phase: 'concat',
      done: enabled.length,
      total: enabled.length,
      percent: 85,
    });
  }

  emitProgress(onProgress, {
    phase: 'mux',
    done: enabled.length,
    total: enabled.length,
    percent: 88,
  });

  // ── Audio strategy ────────────────────────────────────────────────────
  // acted  → native Grok clip dialogue + BGM + SFX (NO voiceover)  [= acted.mp4]
  // voice  → documentary narration mix (optional custom voice track)
  // silent → native clip audio only
  const outDir = path.join(jobDir, 'output');
  const actedAudio = path.join(outDir, 'acted_audio.aac'); // BGM+SFX only
  const finalAudio = path.join(outDir, 'final_audio.aac'); // voice+BGM+SFX
  const bgmActed = path.join(outDir, 'bgm_composed_acted.aac');
  const sfxActed = path.join(outDir, 'sfx_composed_acted.aac');
  const bgmDoc = path.join(outDir, 'bgm_composed.aac');
  const sfxDoc = path.join(outDir, 'sfx_composed.aac');

  // Fallback native bed only if concat video lost its audio (xfade path)
  const nativeAudioPath = path.join(workDir, 'native_audio.m4a');
  let nativeAudioOk = false;
  if (!hasAudio(concatVideo)) {
    try {
      await buildNativeAudioFromSegments(processed, nativeAudioPath);
      nativeAudioOk = fs.existsSync(nativeAudioPath) && hasAudio(nativeAudioPath);
    } catch (e) {
      console.warn('[editorRender] native audio rebuild failed:', e.message || e);
    }
  }

  const hasVidAudio = hasAudio(concatVideo);
  const outFile = path.join(outDir, 'edited.mp4');

  const [outW, outH] = String(plan.resolution || '1920x1080').split('x').map(n => parseInt(n, 10) || 0);
  const W = outW > 0 ? outW : 1920;
  const H = outH > 0 ? outH : 1080;

  const captionsFile = path.join(outDir, 'captions.ass');
  let captionFilter = '';
  if (plan.captions?.enabled && fs.existsSync(captionsFile)) {
    const escaped = captionsFile
      .replace(/\\/g, '/')
      .replace(/^([A-Za-z]):\//, '$1\\:/')
      .replace(/'/g, "\\'");
    captionFilter = `,ass='${escaped}'`;
  }

  const vScale =
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p,setsar=1${captionFilter}[v]`;

  // ── Acted path: identical mix recipe to stitch acted.mp4 ───────────────
  // [0] concat video (with native clip dialogue locked to picture)
  // [1] acted_audio.aac (BGM + SFX only — no narration)
  // amix weights 1|1, duration=first, normalize=0
  if (mode === 'acted') {
    const args = ['-i', concatVideo];
    const filters = [vScale];

    let bedPath = null;
    if (fs.existsSync(actedAudio)) {
      bedPath = actedAudio;
    }

    if (hasVidAudio && bedPath) {
      args.push('-i', bedPath);
      // Match stitch.js acted mux exactly
      filters.push(
        '[0:a]aformat=sample_rates=48000:channel_layouts=stereo[aclip]',
        '[1:a]aformat=sample_rates=48000:channel_layouts=stereo[aacted]',
        '[aclip][aacted]amix=inputs=2:weights=1|1:duration=first:dropout_transition=0:normalize=0[aout]'
      );
      args.push(
        '-filter_complex', filters.join(';'),
        '-map', '[v]', '-map', '[aout]'
      );
    } else if (hasVidAudio && !bedPath) {
      // No bed on disk — still keep native talking; try separate BGM/SFX stems
      const bgmPath = fs.existsSync(bgmActed) ? bgmActed : (fs.existsSync(bgmDoc) ? bgmDoc : null);
      const sfxPath = fs.existsSync(sfxActed) ? sfxActed : (fs.existsSync(sfxDoc) ? sfxDoc : null);
      const labels = ['[aclip]'];
      filters.push('[0:a]aformat=sample_rates=48000:channel_layouts=stereo[aclip]');
      if (bgmPath) {
        args.push('-i', bgmPath);
        filters.push(`[${args.filter(a => a === '-i').length - 1}:a]aformat=sample_rates=48000:channel_layouts=stereo[abgm]`);
        labels.push('[abgm]');
      }
      if (sfxPath) {
        args.push('-i', sfxPath);
        filters.push(`[${args.filter(a => a === '-i').length - 1}:a]aformat=sample_rates=48000:channel_layouts=stereo[asfx]`);
        labels.push('[asfx]');
      }
      if (labels.length === 1) {
        filters.push('[aclip]anull[aout]');
      } else {
        const w = labels.map(() => '1').join('|');
        filters.push(
          `${labels.join('')}amix=inputs=${labels.length}:weights=${w}:duration=first:dropout_transition=0:normalize=0[aout]`
        );
      }
      args.push('-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[aout]');
    } else if (!hasVidAudio && nativeAudioOk && bedPath) {
      args.push('-i', nativeAudioPath, '-i', bedPath);
      filters.push(
        '[1:a]aformat=sample_rates=48000:channel_layouts=stereo[aclip]',
        '[2:a]aformat=sample_rates=48000:channel_layouts=stereo[aacted]',
        '[aclip][aacted]amix=inputs=2:weights=1|1:duration=first:dropout_transition=0:normalize=0[aout]'
      );
      args.push('-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[aout]');
    } else if (bedPath) {
      args.push('-i', bedPath);
      args.push('-filter_complex', vScale, '-map', '[v]', '-map', '1:a:0');
    } else if (hasVidAudio) {
      filters.push('[0:a]aformat=sample_rates=48000:channel_layouts=stereo[aout]');
      args.push('-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[aout]');
    } else {
      args.push('-filter_complex', vScale, '-map', '[v]', '-an');
    }

    // Optional user BGM on top of acted bed (extra layer)
    const bgm = plan.bgMusic || {};
    const hasUserBgm = bgm.enabled && bgm.serverPath && fs.existsSync(bgm.serverPath);
    // Optional user voice — only if explicitly enabled (default: off for acted)
    const vt = plan.voiceTrack || {};
    const hasUserVoice = vt.enabled && vt.serverPath && fs.existsSync(vt.serverPath);

    if ((hasUserBgm || hasUserVoice) && args.includes('-map')) {
      // Rebuild with user layers when needed (re-run complex mix)
      const uInputs = ['-i', concatVideo];
      const uFilters = [vScale];
      const mix = [];
      let idx = 1;
      if (hasVidAudio) {
        uFilters.push('[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[aclip]');
        mix.push('[aclip]');
      } else if (nativeAudioOk) {
        uInputs.push('-i', nativeAudioPath);
        uFilters.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[aclip]`);
        mix.push('[aclip]');
        idx += 1;
      }
      if (bedPath) {
        uInputs.push('-i', bedPath);
        uFilters.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[aacted]`);
        mix.push('[aacted]');
        idx += 1;
      }
      if (hasUserBgm) {
        uInputs.push('-i', bgm.serverPath);
        const vol = Math.max(0, Math.min(2, Number(bgm.volume ?? 0.4)));
        uFilters.push(
          `[${idx}:a]aloop=loop=-1:size=2e9,aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol}[abgmuser]`
        );
        mix.push('[abgmuser]');
        idx += 1;
      }
      if (hasUserVoice) {
        uInputs.push('-i', vt.serverPath);
        const vol = Math.max(0, Math.min(2, Number(vt.volume ?? 1.0)));
        uFilters.push(
          `[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol}[avoiceuser]`
        );
        mix.push('[avoiceuser]');
      }
      if (mix.length === 0) {
        // fall through to silent below
      } else if (mix.length === 1) {
        uFilters.push(`${mix[0]}anull[aout]`);
      } else {
        const w = mix.map(() => '1').join('|');
        uFilters.push(
          `${mix.join('')}amix=inputs=${mix.length}:weights=${w}:duration=first:dropout_transition=0:normalize=0[aout]`
        );
      }
      if (mix.length > 0) {
        args.length = 0;
        args.push(
          ...uInputs,
          '-filter_complex', uFilters.join(';'),
          '-map', '[v]', '-map', '[aout]',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'
        );
      }
    } else if (args.includes('-map') && !args.includes('-c:a') && !args.includes('-an')) {
      args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
    }

    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
      '-shortest',
      '-movflags', '+faststart',
      '-fflags', '+genpts',
      '-avoid_negative_ts', 'make_zero',
      '-y', outFile
    );
    await runFfmpeg(args, 'editor mux acted (clip dialogue + BGM/SFX)');
  } else {
    // ── Voice / silent modes ────────────────────────────────────────────
    const inputs = ['-i', concatVideo];
    let nextIdx = 1;
    const filterClauses = [vScale];
    const mixLabels = [];

    let clipAudioIdx = -1;
    if (hasVidAudio) clipAudioIdx = 0;
    else if (nativeAudioOk) {
      inputs.push('-i', nativeAudioPath);
      clipAudioIdx = nextIdx;
      nextIdx += 1;
    }

    if (mode === 'silent' && clipAudioIdx >= 0) {
      const src = clipAudioIdx === 0 ? '[0:a]' : `[${clipAudioIdx}:a]`;
      filterClauses.push(`${src}aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[aclip]`);
      mixLabels.push('[aclip]');
    }

    if (mode === 'voice') {
      let voicePath = null;
      if (fs.existsSync(finalAudio)) voicePath = finalAudio;
      else if (job.mediaPath && fs.existsSync(job.mediaPath)) voicePath = job.mediaPath;
      if (voicePath) {
        inputs.push('-i', voicePath);
        const idx = nextIdx;
        nextIdx += 1;
        filterClauses.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[avoicebed]`);
        mixLabels.push('[avoicebed]');
      } else if (clipAudioIdx >= 0) {
        const src = clipAudioIdx === 0 ? '[0:a]' : `[${clipAudioIdx}:a]`;
        filterClauses.push(`${src}aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[aclipv]`);
        mixLabels.push('[aclipv]');
      }
    }

    const bgm = plan.bgMusic || {};
    if (bgm.enabled && bgm.serverPath && fs.existsSync(bgm.serverPath)) {
      inputs.push('-i', bgm.serverPath);
      const idx = nextIdx;
      nextIdx += 1;
      const vol = Math.max(0, Math.min(2, Number(bgm.volume ?? 0.4)));
      filterClauses.push(
        `[${idx}:a]aloop=loop=-1:size=2e9,aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol}[abgmuser]`
      );
      mixLabels.push('[abgmuser]');
    }

    const vt = plan.voiceTrack || {};
    if (vt.enabled && vt.serverPath && fs.existsSync(vt.serverPath)) {
      inputs.push('-i', vt.serverPath);
      const idx = nextIdx;
      nextIdx += 1;
      const vol = Math.max(0, Math.min(2, Number(vt.volume ?? 1.0)));
      filterClauses.push(
        `[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol}[avoiceuser]`
      );
      mixLabels.push('[avoiceuser]');
    }

    const args = [...inputs];
    if (mixLabels.length > 0) {
      if (mixLabels.length === 1) {
        filterClauses.push(`${mixLabels[0]}anull[aout]`);
      } else {
        const weights = mixLabels.map(() => '1').join('|');
        filterClauses.push(
          `${mixLabels.join('')}amix=inputs=${mixLabels.length}:weights=${weights}:duration=first:dropout_transition=0:normalize=0[aout]`
        );
      }
      args.push(
        '-filter_complex', filterClauses.join(';'),
        '-map', '[v]', '-map', '[aout]',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'
      );
    } else {
      args.push('-filter_complex', filterClauses.join(';'), '-map', '[v]', '-an');
    }

    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
      '-shortest',
      '-movflags', '+faststart',
      '-fflags', '+genpts',
      '-avoid_negative_ts', 'make_zero',
      '-y', outFile
    );
    await runFfmpeg(args, 'editor mux voice/silent');
  }

  emitProgress(onProgress, {
    phase: 'finalize',
    done: enabled.length,
    total: enabled.length,
    percent: 97,
  });

  // Persist normalized timeline next to output
  const timelinePath = path.join(outDir, 'edit_timeline.json');
  fs.writeFileSync(timelinePath, JSON.stringify(plan, null, 2), 'utf8');

  return { outFile, timeline: plan };
}

async function renderWithXfade(processed, outFile, onProgress) {
  // Build overlapping blend chain for Mix + xfade styles.
  // Mix uses opacity blend (transition=fade) — NOT fadeblack.
  // Audio uses matching acrossfade so acted dialogue stays lip-synced.
  const inputs = [];
  for (const p of processed) {
    inputs.push('-i', p.file);
  }

  let vFilter = '';
  let aFilter = '';
  let offset = 0;
  let lastV = '[0:v]';
  let lastA = '[0:a]';
  const durs = processed.map(p => p.duration);
  const allHaveAudio = processed.every(p => hasAudio(p.file));

  for (let i = 1; i < processed.length; i++) {
    const kind = processed[i].kind || transitionKind(processed[i].transition);
    const blend = wantsBlend(kind, processed[i].transitionDuration);
    const td = blend
      ? Math.min(
          processed[i].transitionDuration || DEFAULT_TRANSITION_DURATION,
          durs[i - 1] / 2,
          durs[i] / 2,
          1.5
        )
      : 0.01;
    const vOut = i === processed.length - 1 ? '[vout]' : `[v${i}]`;
    const aOut = i === processed.length - 1 ? '[aout]' : `[a${i}]`;

    if (blend) {
      offset += durs[i - 1] - td;
      const trans = mapXfadeName(processed[i].transition);
      vFilter += `${lastV}[${i}:v]xfade=transition=${trans}:duration=${td.toFixed(3)}:offset=${Math.max(0, offset).toFixed(3)}${vOut};`;
      lastV = vOut;
      if (allHaveAudio) {
        aFilter += `${lastA}[${i}:a]acrossfade=d=${td.toFixed(3)}:c1=tri:c2=tri${aOut};`;
        lastA = aOut;
      }
    } else {
      // Hard cut: near-zero xfade keeps a single filter chain without visible blend
      offset += durs[i - 1];
      vFilter += `${lastV}[${i}:v]xfade=transition=fade:duration=0.01:offset=${Math.max(0, offset).toFixed(3)}${vOut};`;
      lastV = vOut;
      offset -= 0.01;
      if (allHaveAudio) {
        // Concat audio with tiny acrossfade so graph stays valid
        aFilter += `${lastA}[${i}:a]acrossfade=d=0.01:c1=tri:c2=tri${aOut};`;
        lastA = aOut;
      }
    }
  }

  const filter = (vFilter + aFilter).replace(/;$/, '');
  const args = [
    ...inputs,
    '-filter_complex', filter,
    '-map', '[vout]',
  ];
  if (allHaveAudio) {
    args.push(
      '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      '-y', outFile
    );
  } else {
    args.push(
      '-an',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-y', outFile
    );
  }

  await runFfmpeg(args, 'editor xfade/mix');
  emitProgress(onProgress, {
    phase: 'xfade',
    done: processed.length,
    total: processed.length,
    percent: 85,
  });
}

module.exports = {
  listJobClips,
  defaultTimeline,
  normalizeTimeline,
  renderEditedVideo,
  getClipDuration,
  TRANSITIONS: [...TRANSITIONS],
  TRANSITION_DEFS,
  DEFAULT_TRANSITION,
  DEFAULT_TRANSITION_DURATION,
};
