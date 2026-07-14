// Stitches the animated video clips (one per beat) into a single video synced
// to the original audio, with CapCut-style karaoke word-highlight captions
// burned in via ffmpeg's ass= filter.
//
// Steps:
//   1. Gather all clip_XXXX.mp4 files from output/videoclips/ (sorted).
//   2. Write ffmpeg concat demuxer list.
//   3. concat → concat-video.mp4  (stream copy, fast)
//   4. Generate captions.ass from whisper segments (word-level karaoke timing).
//   5. Final mux: concat-video + audio (mixed or raw) + burn-in captions → final.mp4
//      mixedAudioPath: 3-layer mix from audioMix.js (voiceover + BGM + SFX)
//      audioPath:      raw voiceover fallback (used if mixing wasn't run or failed)
//      (re-encode required for the ass= filter; veryfast/crf23 keeps quality high)
//
// Only one ffmpeg runs at a time, per the global single-worker constraint.
// Requires ffmpeg built with libass (standard in most distributions).

'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { generateAss } = require('./captions');

// Kept for backward-compat with any callers that import these
const XFADE_SECONDS  = 0.5;
const SUBCLIP_FRAMES = 20;

function hasAudio(filePath) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`ffprobe -v error -select_streams a -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
    return out.toString().trim().length > 0;
  } catch (e) {
    return false;
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

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`${label} exited ${code}: ${stderr.slice(-900)}`));
      resolve();
    });
    proc.on('error', reject);
  });
}

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

async function stitch({ jobDir, beats, audioPath, mixedAudioPath, beatSeconds, segments }) {
  // Use mixed audio (voiceover + BGM + SFX) if available, else raw voiceover
  const effectiveAudio = (mixedAudioPath && fs.existsSync(mixedAudioPath)) ? mixedAudioPath : audioPath;
  process.stdout.write(`[stitch] audio: ${effectiveAudio === mixedAudioPath ? 'mixed (BGM+SFX)' : 'raw voiceover'}\n`);

  const clipsDir    = path.join(jobDir, 'output', 'videoclips');
  const concatList  = path.join(clipsDir, 'concat.txt');
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

  // 2. Pre-process each clip to apply duration trim and smooth boundary fades (0.2s fade-in/out)
  process.stdout.write(`[stitch] Pre-processing ${clipFiles.length} clips with fades...\n`);
  const processedClips = [];
  
  for (let i = 0; i < clipFiles.length; i++) {
    const rawClip = clipFiles[i];
    const beat = beats[i] || {};
    let durSecs = beatSeconds;
    if (beat.endMs && beat.startMs) durSecs = (beat.endMs - beat.startMs) / 1000;
    else if (beat.durationMs) durSecs = beat.durationMs / 1000;
    
    const fadedClip = path.join(clipsDir, `faded_${String(i).padStart(4, '0')}.mp4`);
    const fadeDur = 0.2;
    const fadeOutStart = Math.max(0, durSecs - fadeDur);
    
    process.stdout.write(`[stitch] Trimming and fading clip ${i} to ${durSecs}s...\n`);
    
    const clipHasAudio = hasAudio(rawClip);
    const vf = `fade=in:st=0:d=${fadeDur},fade=out:st=${fadeOutStart}:d=${fadeDur}`;
    const af = clipHasAudio ? `afade=t=in:ss=0:d=${fadeDur},afade=t=out:st=${fadeOutStart}:d=${fadeDur}` : null;
    
    const clipArgs = [
      '-ss', '0', '-t', String(durSecs),
      '-i', rawClip,
      '-vf', vf,
    ];
    
    if (af) {
      clipArgs.push('-af', af, '-c:a', 'aac');
    } else {
      clipArgs.push('-an'); // if no audio, strip explicitly so concat list is uniform
    }
    
    clipArgs.push(
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-y', fadedClip
    );

    await runFfmpeg(clipArgs, `fade clip ${i}`);
    processedClips.push(fadedClip);
  }

  // 3. Write concat demuxer list with processed clips
  const listContent = processedClips
    .map(c => `file '${c.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatList, listContent, 'utf8');

  // 4. Concat all clips — stream copy (fast, no re-encode)
  await runFfmpeg([
    '-f', 'concat', '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    '-y', concatVideo,
  ], 'concat clips');

  // 4. Generate ASS captions from whisper segments (if available)
  // Now includes enhanced emphasis styling + big bordered "impact text" (black + border text effect)
  // for key words like years, "DANGER", dramatic facts.
  let vfFilter = null;
  if (segments && segments.length > 0) {
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
  // Now with cinematic black borders + enhanced emphasis text overlays (big bordered "impact cards").
  const muxArgs = [
    '-i', concatVideo,
    '-i', effectiveAudio,
  ];

  if (vfFilter) {
    // Cinematic black borders (letterbox/pillarbox) + burn captions
    // This gives a professional, engaging "film" look and space for border text if desired
    const cinematicVf = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,${vfFilter}`;
    muxArgs.push(
      '-vf', cinematicVf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'
    );
  } else {
    // No captions: still apply nice black borders for consistency
    muxArgs.push(
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'
    );
  }

  muxArgs.push(
    '-c:a', 'aac',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-shortest',
    '-movflags', '+faststart',
    '-y', outFile
  );

  await runFfmpeg(muxArgs, vfFilter ? 'final mux with captions' : 'final mux');

  // Mux acted video: full untrimmed clips faded + BGM + SFX + native clip audio (no voiceover, no captions)
  const actedAudio = path.join(jobDir, 'output', 'acted_audio.aac');
  const actedVideo = path.join(jobDir, 'output', 'acted.mp4');
  if (fs.existsSync(actedAudio)) {
    process.stdout.write(`[stitch] Pre-processing un-trimmed clips for acted video...\n`);
    const actedProcessedClips = [];
    
    for (let i = 0; i < clipFiles.length; i++) {
      const rawClip = clipFiles[i];
      const nativeDur = getClipDuration(rawClip);
      
      const fadedClip = path.join(clipsDir, `acted_faded_${String(i).padStart(4, '0')}.mp4`);
      const fadeDur = 0.2;
      const fadeOutStart = Math.max(0, nativeDur - fadeDur);
      
      process.stdout.write(`[stitch] Fading native clip ${i} to full duration ${nativeDur}s...\n`);
      
      const clipHasAudio = hasAudio(rawClip);
      const vf = `fade=in:st=0:d=${fadeDur},fade=out:st=${fadeOutStart}:d=${fadeDur}`;
      const af = clipHasAudio ? `afade=t=in:ss=0:d=${fadeDur},afade=t=out:st=${fadeOutStart}:d=${fadeDur}` : null;
      
      const clipArgs = [
        '-ss', '0', '-t', String(nativeDur),
        '-i', rawClip,
        '-vf', vf,
      ];
      
      if (af) {
        clipArgs.push('-af', af, '-c:a', 'aac');
      } else {
        clipArgs.push('-an');
      }
      
      clipArgs.push(
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-y', fadedClip
      );

      await runFfmpeg(clipArgs, `acted fade clip ${i}`);
      actedProcessedClips.push(fadedClip);
    }
    
    // Write concat demuxer list for acted video
    const actedConcatList = path.join(clipsDir, 'acted_concat.txt');
    fs.writeFileSync(
      actedConcatList,
      actedProcessedClips.map(c => `file '${c.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8'
    );
    
    const actedConcatVideo = path.join(jobDir, 'output', 'acted-concat-video.mp4');
    process.stdout.write(`[stitch] Concatenating un-trimmed acted clips...\n`);
    await runFfmpeg([
      '-f', 'concat', '-safe', '0',
      '-i', actedConcatList,
      '-c', 'copy',
      '-y', actedConcatVideo,
    ], 'concat acted clips');
    
    process.stdout.write(`[stitch] Muxing acted (full native duration, no voiceover, no captions) video...\n`);
    const hasNativeAudio = hasAudio(actedConcatVideo);

    // Use a single filter_complex for video+audio (mixing -vf with -filter_complex
    // can produce edit-list / timestamp quirks some browsers refuse to play).
    // Force browser-safe H.264 Main + AAC stereo + faststart.
    const vScale =
      '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,' +
      'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p,setsar=1[v]';

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

module.exports = { stitch, XFADE_SECONDS, SUBCLIP_FRAMES };
