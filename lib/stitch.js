// Stitches the animated video clips (one per beat) into a single video synced
// to the original audio, with CapCut-style karaoke word-highlight captions
// burned in via ffmpeg's ass= filter.
//
// Steps:
//   1. Gather all clip_XXXX.mp4 files from output/videoclips/ (sorted).
//   2. Normalize each clip (trim + scale, NO fade-to-black).
//   3. Join with true CapCut-style Mix (opacity blend via xfade, not black dips).
//   4. Generate captions.ass from whisper segments (word-level karaoke timing).
//   5. Final mux: concat-video + audio (mixed or raw) + burn-in captions → final.mp4
//   6. Acted path: full native clips + Mix joins + BGM/SFX mux → acted.mp4
//
// Only one ffmpeg runs at a time, per the global single-worker constraint.
// Requires ffmpeg built with libass (standard in most distributions).

'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { generateAss } = require('./captions');
const { ffmpegScalePad } = require('./aspect');
const {
  DEFAULT_MIX_SECONDS,
  getClipDuration,
  hasAudio,
  joinWithMix,
  normalizeClip,
  runFfmpeg,
} = require('./videoJoin');

// Kept for backward-compat with any callers that import these
const XFADE_SECONDS  = DEFAULT_MIX_SECONDS;
const SUBCLIP_FRAMES = 20;
const MIX_SECONDS    = DEFAULT_MIX_SECONDS;

/**
 * Escape an absolute path for use inside an ffmpeg filter string value.
 * On Windows, the drive-letter colon must be escaped and backslashes replaced.
 * e.g.  C:\foo\bar.ass  →  C\:/foo/bar.ass
 */
function assFilterPath(absPath) {
  return absPath
    .replace(/\\/g, '/')          // backslash → forward slash
    .replace(/^([A-Za-z]):\//, '$1\\:/'); // C:/ → C\:/
}

async function stitch({ jobDir, beats, audioPath, mixedAudioPath, beatSeconds, segments, resolution, captionsEnabled }) {
  const scalePad = ffmpegScalePad(resolution || '16:9');
  const captionsOn = captionsEnabled !== false; // default on for backward-compat
  // Use mixed audio (voiceover + BGM + SFX) if available, else raw voiceover
  const effectiveAudio = (mixedAudioPath && fs.existsSync(mixedAudioPath))
    ? mixedAudioPath
    : ((audioPath && fs.existsSync(audioPath)) ? audioPath : null);
  process.stdout.write(`[stitch] audio: ${!effectiveAudio ? 'none (video-only, clips carry native sound)' : (effectiveAudio === mixedAudioPath ? 'mixed (BGM+SFX)' : 'raw voiceover')} | aspect: ${resolution || '16:9'}\n`);
  process.stdout.write(`[stitch] transition: Mix (opacity blend @ ${MIX_SECONDS}s) — not fade-through-black\n`);

  const clipsDir    = path.join(jobDir, 'output', 'videoclips');
  const concatVideo = path.join(jobDir, 'output', 'concat-video.mp4');
  const captionsFile = path.join(jobDir, 'output', 'captions.ass');
  const outFile     = path.join(jobDir, 'output', 'final.mp4');

  // 1. Gather all clips in sorted order
  if (!fs.existsSync(clipsDir)) {
    throw new Error(`videoclips directory not found: ${clipsDir}. Run the generating step first.`);
  }

  const clipFiles = fs.readdirSync(clipsDir)
    .filter(f => f.match(/^clip_\d{4}\.mp4$/))
    .sort() // lexicographic sort is correct for zero-padded names
    .map(f => path.resolve(path.join(clipsDir, f)));

  if (clipFiles.length === 0) {
    throw new Error(`No clip_XXXX.mp4 files found in ${clipsDir}`);
  }

  // 2. Normalize each clip (trim to beat length, scale) — NO edge fade-to-black.
  //    True Mix blending happens at join time so frames dissolve into each other.
  process.stdout.write(`[stitch] Normalizing ${clipFiles.length} clips for Mix joins...\n`);
  const processedClips = [];

  for (let i = 0; i < clipFiles.length; i++) {
    const rawClip = clipFiles[i];
    const beat = beats[i] || {};
    let durSecs = beatSeconds;
    if (beat.endMs && beat.startMs) durSecs = (beat.endMs - beat.startMs) / 1000;
    else if (beat.durationMs) durSecs = beat.durationMs / 1000;

    const normClip = path.join(clipsDir, `norm_${String(i).padStart(4, '0')}.mp4`);
    process.stdout.write(`[stitch] Normalize clip ${i} → ${durSecs.toFixed(2)}s\n`);
    await normalizeClip(rawClip, normClip, {
      trimStart: 0,
      duration: durSecs,
      scalePad,
      fps: 24,
    });
    processedClips.push(normClip);
  }

  // 3. Join with true Mix (opacity blend) — not fade through black
  process.stdout.write(`[stitch] Joining ${processedClips.length} clips with Mix @ ${MIX_SECONDS}s...\n`);
  await joinWithMix(processedClips, concatVideo, {
    mixDur: MIX_SECONDS,
    includeAudio: true,
    onProgress: (msg) => process.stdout.write(`[stitch] ${msg}\n`),
  });

  // 4. Generate ASS captions from whisper segments (if available)
  let vfFilter = null;
  if (captionsOn && segments && segments.length > 0) {
    try {
      generateAss(segments, captionsFile);
      const escaped = assFilterPath(path.resolve(captionsFile));
      vfFilter = `ass='${escaped}'`;
      process.stdout.write(`[stitch] captions.ass written (${segments.length} segments) with emphasis support\n`);
    } catch (e) {
      // Non-fatal: log and continue without captions
      process.stdout.write(`[stitch] WARN: failed to generate captions: ${e.message}\n`);
    }
  }

  // 5. Final mux: video + audio (mixed or raw) + (optional) burned-in captions
  const muxArgs = [
    '-i', concatVideo,
  ];
  if (effectiveAudio) muxArgs.push('-i', effectiveAudio);

  if (vfFilter) {
    const cinematicVf = `${scalePad},${vfFilter}`;
    muxArgs.push(
      '-vf', cinematicVf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'
    );
  } else {
    muxArgs.push(
      '-vf', scalePad,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'
    );
  }

  if (effectiveAudio) {
    muxArgs.push(
      '-c:a', 'aac',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest',
      '-movflags', '+faststart',
      '-y', outFile
    );
  } else {
    // No external audio track — keep the native clip audio from the Mix join
    const hasNative = hasAudio(concatVideo);
    if (hasNative) {
      muxArgs.push('-c:a', 'aac', '-map', '0:v:0', '-map', '0:a:0');
    } else {
      muxArgs.push('-map', '0:v:0', '-an');
    }
    muxArgs.push('-shortest', '-movflags', '+faststart', '-y', outFile);
  }

  await runFfmpeg(muxArgs, vfFilter ? 'final mux with captions' : 'final mux');

  // ── Acted video: full untrimmed clips + Mix joins + BGM/SFX ────────────
  const actedAudio = path.join(jobDir, 'output', 'acted_audio.aac');
  const actedVideo = path.join(jobDir, 'output', 'acted.mp4');
  if (fs.existsSync(actedAudio)) {
    process.stdout.write(`[stitch] Normalizing un-trimmed clips for acted video...\n`);
    const actedProcessedClips = [];

    for (let i = 0; i < clipFiles.length; i++) {
      const rawClip = clipFiles[i];
      const nativeDur = getClipDuration(rawClip);
      const normClip = path.join(clipsDir, `acted_norm_${String(i).padStart(4, '0')}.mp4`);
      process.stdout.write(`[stitch] Acted normalize clip ${i} → full ${nativeDur.toFixed(2)}s\n`);
      await normalizeClip(rawClip, normClip, {
        trimStart: 0,
        duration: nativeDur,
        scalePad,
        fps: 24,
      });
      actedProcessedClips.push(normClip);
    }

    const actedConcatVideo = path.join(jobDir, 'output', 'acted-concat-video.mp4');
    process.stdout.write(`[stitch] Joining acted clips with Mix @ ${MIX_SECONDS}s...\n`);
    await joinWithMix(actedProcessedClips, actedConcatVideo, {
      mixDur: MIX_SECONDS,
      includeAudio: true,
      onProgress: (msg) => process.stdout.write(`[stitch] acted ${msg}\n`),
    });

    process.stdout.write(`[stitch] Muxing acted (Mix joins, no voiceover, no captions) video...\n`);
    const hasNativeAudio = hasAudio(actedConcatVideo);

    // Single filter_complex for video+audio (mixing -vf with -filter_complex
    // can produce edit-list / timestamp quirks some browsers refuse to play).
    const vScale =
      `[0:v]${scalePad},format=yuv420p,setsar=1[v]`;

    const actedArgs = [
      '-i', actedConcatVideo,
      '-i', actedAudio,
    ];

    if (hasNativeAudio) {
      actedArgs.push(
        '-filter_complex',
        `${vScale};[0:a][1:a]amix=inputs=2:weights=1|1:duration=first:dropout_transition=0:normalize=0[aout]`,
        '-map', '[v]',
        '-map', '[aout]'
      );
    } else {
      actedArgs.push(
        '-filter_complex', vScale,
        '-map', '[v]',
        '-map', '1:a:0'
      );
    }

    actedArgs.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-shortest',
      '-movflags', '+faststart',
      '-fflags', '+genpts',
      '-avoid_negative_ts', 'make_zero',
      '-y', actedVideo
    );

    try {
      await runFfmpeg(actedArgs, 'acted video mux');
      process.stdout.write(`[stitch] Acted video generated successfully at: ${actedVideo}\n`);
    } catch (actedMuxErr) {
      process.stdout.write(`[stitch] WARN: Acted video generation failed: ${actedMuxErr.message}\n`);
    }
  }

  // 6. Create ZIP file of assets (images, videoclips, captions.ass, final mixed audio) for CapCut editing
  try {
    const destZip = path.join(jobDir, 'output', 'images.zip');
    const relativePaths = [];

    if (fs.existsSync(path.join(jobDir, 'output', 'images'))) relativePaths.push('output/images');
    if (fs.existsSync(path.join(jobDir, 'output', 'videoclips'))) relativePaths.push('output/videoclips');
    if (fs.existsSync(path.join(jobDir, 'output', 'captions.ass'))) relativePaths.push('output/captions.ass');
    if (fs.existsSync(path.join(jobDir, 'output', 'final_audio.aac'))) relativePaths.push('output/final_audio.aac');

    if (relativePaths.length > 0) {
      process.stdout.write(`[stitch] Creating ZIP for CapCut: ${relativePaths.join(', ')}\n`);

      const psPaths = relativePaths.map(p => `'${p}'`).join(', ');
      const psCommand = `Compress-Archive -Path ${psPaths} -DestinationPath 'output/images.zip' -Force`;

      const proc = spawn('powershell', ['-NoProfile', '-Command', psCommand], { cwd: jobDir });
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());

      await new Promise((resolve) => {
        proc.on('close', code => {
          if (code !== 0) {
            process.stdout.write(`[stitch] ZIP warning (exited ${code}): ${stderr}\n`);
          } else {
            process.stdout.write(`[stitch] Created images.zip at ${destZip}\n`);
          }
          resolve();
        });
        proc.on('error', err => {
          process.stdout.write(`[stitch] ZIP spawn error: ${err.message}\n`);
          resolve();
        });
      });
    }
  } catch (zipErr) {
    process.stdout.write(`[stitch] Non-fatal ZIP error: ${zipErr.message}\n`);
  }

  return outFile;
}

module.exports = { stitch, XFADE_SECONDS, SUBCLIP_FRAMES, MIX_SECONDS };
