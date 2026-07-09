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

  // 2. Write concat demuxer list
  const listContent = clipFiles
    .map(c => `file '${c.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatList, listContent, 'utf8');

  // 3. Concat all clips — stream copy (fast, no re-encode)
  await runFfmpeg([
    '-f', 'concat', '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    '-y', concatVideo,
  ], 'concat clips');

  // 4. Generate ASS captions from whisper segments (if available)
  let vfFilter = null;
  if (segments && segments.length > 0) {
    try {
      generateAss(segments, captionsFile);
      const escaped = assFilterPath(path.resolve(captionsFile));
      vfFilter = `ass='${escaped}'`;
      process.stdout.write(`[stitch] captions.ass written (${segments.length} segments)\n`);
    } catch (e) {
      // Non-fatal: log and continue without captions
      process.stdout.write(`[stitch] WARN: failed to generate captions: ${e.message}\n`);
    }
  }

  // 5. Final mux: video + audio (mixed or raw) + (optional) burned-in captions
  const muxArgs = [
    '-i', concatVideo,
    '-i', effectiveAudio,
  ];

  if (vfFilter) {
    // Re-encode video to burn in subtitle filter
    muxArgs.push(
      '-vf', vfFilter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'
    );
  } else {
    // No captions: stream-copy the video track (faster)
    muxArgs.push('-c:v', 'copy');
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
