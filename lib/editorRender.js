// Re-renders a job from a user edit timeline (reorder / trim / transitions).
// Produces output/edited.mp4. Runs inside the worker so users can leave and
// download later.

'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TRANSITIONS = new Set(['none', 'fade', 'dissolve', 'fadeblack', 'slideleft', 'slideright']);

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
      transition: i === 0 ? 'none' : 'fade',
      transitionDuration: 0.35,
    })),
    audioMode: 'acted', // 'acted' | 'voice' | 'silent'
    defaultTransition: 'fade',
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
  const defaultTransition = TRANSITIONS.has(src.defaultTransition) ? src.defaultTransition : 'fade';
  const resolution = ['1920x1080', '1280x720', '3840x2160'].includes(src.resolution)
    ? src.resolution
    : '1920x1080';
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

  return { version: 1, clips: outClips, audioMode, defaultTransition, resolution, captions, bgMusic, voiceTrack };
}

/**
 * Process a single clip segment (trim + optional edge fades for hard cuts).
 */
async function processSegment(srcFile, destFile, { trimStart, trimEnd, edgeFade = 0.15 }) {
  const dur = Math.max(0.05, trimEnd - trimStart);
  const fadeDur = Math.min(edgeFade, dur / 3);
  const fadeOutStart = Math.max(0, dur - fadeDur);
  const clipHasAudio = hasAudio(srcFile);

  const vf = fadeDur > 0.01
    ? `fade=in:st=0:d=${fadeDur},fade=out:st=${fadeOutStart}:d=${fadeDur},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24,format=yuv420p`
    : `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24,format=yuv420p`;

  const args = [
    '-ss', String(trimStart),
    '-t', String(dur),
    '-i', srcFile,
    '-vf', vf,
  ];

  if (clipHasAudio) {
    const af = fadeDur > 0.01
      ? `afade=t=in:st=0:d=${fadeDur},afade=t=out:st=${fadeOutStart}:d=${fadeDur}`
      : 'anull';
    args.push('-af', af, '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k');
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-y', destFile
  );

  await runFfmpeg(args, `editor segment ${path.basename(destFile)}`);
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

  const workDir = path.join(jobDir, 'output', 'editor_work');
  fs.mkdirSync(workDir, { recursive: true });

  // Clean previous work files
  for (const f of fs.readdirSync(workDir)) {
    try { fs.unlinkSync(path.join(workDir, f)); } catch (_) {}
  }

  const processed = [];
  for (let i = 0; i < enabled.length; i++) {
    const item = enabled[i];
    const meta = clips.find(c => c.index === item.sourceIndex);
    if (!meta || !fs.existsSync(meta.file)) {
      throw new Error(`Missing source clip index ${item.sourceIndex}`);
    }
    const dest = path.join(workDir, `seg_${String(i).padStart(4, '0')}.mp4`);
    // Soft edge fades only when no explicit transition (concat path)
    const useXfade = i > 0 && item.transition && item.transition !== 'none' && item.transitionDuration > 0.05;
    await processSegment(meta.file, dest, {
      trimStart: item.trimStart,
      trimEnd: item.trimEnd,
      edgeFade: useXfade ? 0 : 0.12,
    });
    processed.push({
      file: dest,
      duration: Math.max(0.05, item.trimEnd - item.trimStart),
      transition: item.transition || 'none',
      transitionDuration: item.transitionDuration || 0,
    });
    if (typeof onProgress === 'function') {
      onProgress({ phase: 'prepare', done: i + 1, total: enabled.length });
    }
  }

  const concatVideo = path.join(workDir, 'concat.mp4');
  const canXfade = processed.length >= 2 && processed.some((p, i) => i > 0 && p.transition !== 'none' && p.transitionDuration > 0.05);

  if (canXfade && processed.length <= 40) {
    // xfade chain for polished transitions (limited clip count for filter complexity)
    await renderWithXfade(processed, concatVideo, onProgress);
  } else {
    // Fast concat demuxer path
    const listFile = path.join(workDir, 'concat.txt');
    fs.writeFileSync(
      listFile,
      processed.map(p => `file '${escConcatPath(p.file)}'`).join('\n'),
      'utf8'
    );
    await runFfmpeg([
      '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y', concatVideo,
    ], 'editor concat');
  }

  if (typeof onProgress === 'function') onProgress({ phase: 'mux', done: 1, total: 1 });

  // Pick audio bed
  const outDir = path.join(jobDir, 'output');
  const actedAudio = path.join(outDir, 'acted_audio.aac');
  const finalAudio = path.join(outDir, 'final_audio.aac');
  let audioPath = null;
  if (plan.audioMode === 'acted' && fs.existsSync(actedAudio)) audioPath = actedAudio;
  else if (plan.audioMode === 'voice' && fs.existsSync(finalAudio)) audioPath = finalAudio;
  else if (plan.audioMode === 'voice' && job.mediaPath && fs.existsSync(job.mediaPath)) audioPath = job.mediaPath;
  else if (fs.existsSync(actedAudio)) audioPath = actedAudio;
  else if (fs.existsSync(finalAudio)) audioPath = finalAudio;

  const outFile = path.join(outDir, 'edited.mp4');
  const hasVidAudio = hasAudio(concatVideo);

  const [outW, outH] = String(plan.resolution || '1920x1080').split('x').map(n => parseInt(n, 10) || 0);
  const W = outW > 0 ? outW : 1920;
  const H = outH > 0 ? outH : 1080;

  // Optional burn-in of existing job captions.ass when user enabled captions
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

  const inputs = ['-i', concatVideo];
  let filterInputs = [];
  let filterClauses = [vScale];

  // If not silent, include the default audio bed (actedAudio / finalAudio)
  if (plan.audioMode !== 'silent' && audioPath && fs.existsSync(audioPath)) {
    inputs.push('-i', audioPath);
    const defaultIdx = inputs.length / 2 - 1;
    filterClauses.push(`[${defaultIdx}:a]volume=1.0[adefault]`);
    filterInputs.push('[adefault]');
  } else if (hasVidAudio && plan.audioMode !== 'silent') {
    // Fall back to using video clip's original audio
    filterClauses.push(`[0:a]volume=1.0[adefault]`);
    filterInputs.push('[adefault]');
  }

  // Background Music
  const bgm = plan.bgMusic || {};
  if (bgm.enabled && bgm.serverPath && fs.existsSync(bgm.serverPath)) {
    inputs.push('-i', bgm.serverPath);
    const bgmIdx = inputs.length / 2 - 1;
    const vol = Number(bgm.volume ?? 0.4);
    // Loop BGM indefinitely to cover the whole video
    filterClauses.push(`[${bgmIdx}:a]aloop=loop=-1:size=2e9,volume=${vol}[abgm]`);
    filterInputs.push('[abgm]');
  }

  // Voice/Narration Track
  const vt = plan.voiceTrack || {};
  if (vt.enabled && vt.serverPath && fs.existsSync(vt.serverPath)) {
    inputs.push('-i', vt.serverPath);
    const vtIdx = inputs.length / 2 - 1;
    const vol = Number(vt.volume ?? 1.0);
    filterClauses.push(`[${vtIdx}:a]volume=${vol}[avoice]`);
    filterInputs.push('[avoice]');
  }

  // Build FFmpeg command args
  const args = [...inputs];
  let hasAudioOut = filterInputs.length > 0;
  if (hasAudioOut) {
    if (filterInputs.length > 1) {
      filterClauses.push(`${filterInputs.join('')}amix=inputs=${filterInputs.length}:duration=first:dropout_transition=0[aout]`);
      args.push('-filter_complex', filterClauses.join(';'), '-map', '[v]', '-map', '[aout]');
    } else {
      // Just 1 audio track
      filterClauses.push(`${filterInputs[0]}anull[aout]`);
      args.push('-filter_complex', filterClauses.join(';'), '-map', '[v]', '-map', '[aout]');
    }
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  } else {
    // Silent
    args.push('-filter_complex', filterClauses.join(';'), '-map', '[v]', '-an');
  }

  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
    '-shortest',
    '-movflags', '+faststart',
    '-y', outFile
  );
  await runFfmpeg(args, 'editor mux audio complex');

  // Persist normalized timeline next to output
  const timelinePath = path.join(outDir, 'edit_timeline.json');
  fs.writeFileSync(timelinePath, JSON.stringify(plan, null, 2), 'utf8');

  return { outFile, timeline: plan };
}

async function renderWithXfade(processed, outFile, onProgress) {
  // Build xfade filter chain
  const inputs = [];
  for (const p of processed) {
    inputs.push('-i', p.file);
  }

  // Map transition names to ffmpeg xfade transitions
  const mapTrans = (t) => {
    if (t === 'fade' || t === 'dissolve') return 'fade';
    if (t === 'fadeblack') return 'fadeblack';
    if (t === 'slideleft') return 'slideleft';
    if (t === 'slideright') return 'slideright';
    return 'fade';
  };

  let filter = '';
  let offset = 0;
  let lastLabel = '[0:v]';
  const durs = processed.map(p => p.duration);

  for (let i = 1; i < processed.length; i++) {
    const td = Math.min(
      processed[i].transitionDuration || 0.35,
      durs[i - 1] / 2,
      durs[i] / 2,
      1.5
    );
    const use = processed[i].transition && processed[i].transition !== 'none' && td > 0.05;
    const outLabel = i === processed.length - 1 ? '[vout]' : `[v${i}]`;

    if (use) {
      offset += durs[i - 1] - td;
      const trans = mapTrans(processed[i].transition);
      filter += `${lastLabel}[${i}:v]xfade=transition=${trans}:duration=${td.toFixed(3)}:offset=${Math.max(0, offset).toFixed(3)}${outLabel};`;
      lastLabel = outLabel;
    } else {
      // Hard cut via concat filter (video only for simplicity)
      offset += durs[i - 1];
      // Still use xfade with very short fade to keep single chain, or concat
      filter += `${lastLabel}[${i}:v]xfade=transition=fade:duration=0.01:offset=${Math.max(0, offset).toFixed(3)}${outLabel};`;
      lastLabel = outLabel;
      offset -= 0.01; // almost full previous duration kept
    }
  }

  // Audio: simple acrossfade chain when possible, else first stream / anull
  // Prefer video-only xfade + optional external audio in mux step for reliability.
  filter = filter.replace(/;$/, '');

  const args = [
    ...inputs,
    '-filter_complex', filter,
    '-map', '[vout]',
    '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-y', outFile,
  ];

  await runFfmpeg(args, 'editor xfade');
  if (typeof onProgress === 'function') onProgress({ phase: 'xfade', done: 1, total: 1 });
}

module.exports = {
  listJobClips,
  defaultTimeline,
  normalizeTimeline,
  renderEditedVideo,
  getClipDuration,
  TRANSITIONS: [...TRANSITIONS],
};
