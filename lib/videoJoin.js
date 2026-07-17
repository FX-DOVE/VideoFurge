// Shared clip-join helpers for CapCut-style transitions.
//
// Mix  = true opacity blend (ffmpeg xfade transition=fade) + optional acrossfade audio.
//        Clips overlap for the transition duration — NOT a fade through black.
// Fade black / white / slides / etc. = other xfade transition names.
// Cut  = hard concat (no blend).

'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_MIX_SECONDS = 0.5;

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
 * Hard-cut concat via demuxer (stream copy when codecs match).
 */
async function hardConcat(clipFiles, outFile) {
  if (!clipFiles.length) throw new Error('hardConcat: no clips');
  if (clipFiles.length === 1) {
    await runFfmpeg(['-i', clipFiles[0], '-c', 'copy', '-y', outFile], 'copy single clip');
    return outFile;
  }
  const listFile = path.join(path.dirname(outFile), `_concat_${Date.now()}.txt`);
  fs.writeFileSync(
    listFile,
    clipFiles.map(c => `file '${escConcatPath(c)}'`).join('\n'),
    'utf8'
  );
  try {
    await runFfmpeg([
      '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y', outFile,
    ], 'hard concat');
  } finally {
    try { fs.unlinkSync(listFile); } catch (_) {}
  }
  return outFile;
}

/**
 * Clamp mix duration so it never exceeds half of either neighbouring clip.
 */
function clampMixDur(mixDur, durA, durB) {
  return Math.min(
    Math.max(0, Number(mixDur) || 0),
    durA / 2,
    durB / 2,
    1.5
  );
}

/**
 * Pairwise true Mix: opacity cross-blend (xfade fade) + matching audio acrossfade.
 * Does NOT dip through black — previous and next frames blend into each other.
 *
 * Total output duration = sum(clipDur) - mixDur * (n-1).
 *
 * @param {string[]} clipFiles  absolute paths, same resolution/fps preferred
 * @param {string} outFile
 * @param {object} [opts]
 * @param {number} [opts.mixDur=0.5]
 * @param {boolean} [opts.includeAudio=true]  when false, video-only output
 * @param {(msg:string)=>void} [opts.onProgress]
 */
async function joinWithMix(clipFiles, outFile, opts = {}) {
  const mixDur = Number(opts.mixDur ?? DEFAULT_MIX_SECONDS);
  const includeAudio = opts.includeAudio !== false;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  if (!clipFiles.length) throw new Error('joinWithMix: no clips');
  if (clipFiles.length === 1 || mixDur < 0.05) {
    return hardConcat(clipFiles, outFile);
  }

  const workDir = path.dirname(outFile);
  let current = clipFiles[0];
  let currentDur = getClipDuration(current);
  if (!(currentDur > 0.05)) currentDur = 1;
  const temps = [];

  for (let i = 1; i < clipFiles.length; i++) {
    const next = clipFiles[i];
    let nextDur = getClipDuration(next);
    if (!(nextDur > 0.05)) nextDur = 1;

    const td = clampMixDur(mixDur, currentDur, nextDur);
    if (td < 0.05) {
      // Degenerate: hard-append via concat of current+next into temp
      const isLast = i === clipFiles.length - 1;
      const dest = isLast ? outFile : path.join(workDir, `_mix_pair_${i}.mp4`);
      await hardConcat([current, next], dest);
      if (current !== clipFiles[0] && current !== dest) {
        // previous temp
      }
      if (!isLast) temps.push(dest);
      current = dest;
      currentDur = getClipDuration(current) || (currentDur + nextDur);
      onProgress(`mix pair ${i}/${clipFiles.length - 1} (cut)`);
      continue;
    }

    const isLast = i === clipFiles.length - 1;
    const dest = isLast ? outFile : path.join(workDir, `_mix_pair_${i}.mp4`);
    const offset = Math.max(0, currentDur - td);
    const aOk = includeAudio && hasAudio(current) && hasAudio(next);

    // xfade transition=fade is an opacity MIX (blend), not fadeblack.
    let filter;
    const args = ['-i', current, '-i', next];
    if (aOk) {
      filter =
        `[0:v][1:v]xfade=transition=fade:duration=${td.toFixed(3)}:offset=${offset.toFixed(3)}[v];` +
        `[0:a][1:a]acrossfade=d=${td.toFixed(3)}:c1=tri:c2=tri[a]`;
      args.push(
        '-filter_complex', filter,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', dest
      );
    } else {
      filter =
        `[0:v][1:v]xfade=transition=fade:duration=${td.toFixed(3)}:offset=${offset.toFixed(3)}[v]`;
      args.push(
        '-filter_complex', filter,
        '-map', '[v]',
        '-an',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y', dest
      );
    }

    await runFfmpeg(args, `mix pair ${i}`);
    onProgress(`mix pair ${i}/${clipFiles.length - 1} (blend ${td.toFixed(2)}s)`);

    // Drop intermediate temps from previous iteration
    if (temps.length) {
      const old = temps.pop();
      try { if (old && old !== dest && old !== outFile) fs.unlinkSync(old); } catch (_) {}
    }
    if (!isLast) temps.push(dest);

    current = dest;
    currentDur = currentDur + nextDur - td;
  }

  // Cleanup any leftover temps (shouldn't remain if last wrote outFile)
  for (const t of temps) {
    if (t !== outFile) {
      try { fs.unlinkSync(t); } catch (_) {}
    }
  }

  return outFile;
}

/**
 * Normalize a single clip: trim, scale/pad, constant fps, optional stereo AAC.
 * No edge fade-to-black — Mix blending is applied at join time instead.
 */
async function normalizeClip(srcFile, destFile, {
  trimStart = 0,
  duration = null,
  scalePad = null,
  fps = 24,
} = {}) {
  const sp = scalePad || 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black';
  const clipHasAudio = hasAudio(srcFile);
  const t = duration != null && duration > 0 ? duration : null;

  const vf = `${sp},setsar=1,fps=${fps},format=yuv420p`;
  const args = [];
  if (trimStart > 0) args.push('-ss', String(trimStart));
  if (t != null) args.push('-t', String(t));
  args.push('-i', srcFile);

  if (clipHasAudio) {
    args.push(
      '-vf', vf,
      '-af', 'aformat=sample_rates=48000:channel_layouts=stereo',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      '-y', destFile
    );
  } else {
    // Silence bed so Mix acrossfade always has an audio stream when needed
    const durArg = t != null ? String(t) : String(Math.max(0.1, getClipDuration(srcFile) || 1));
    args.push(
      '-f', 'lavfi', '-t', durArg, '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-filter_complex', `[0:v]${vf}[v];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      '-shortest',
      '-y', destFile
    );
  }

  await runFfmpeg(args, `normalize ${path.basename(destFile)}`);
  return destFile;
}

module.exports = {
  DEFAULT_MIX_SECONDS,
  runFfmpeg,
  getClipDuration,
  hasAudio,
  hardConcat,
  joinWithMix,
  normalizeClip,
  clampMixDur,
};
