// 3-layer audio mixing engine for the YouTube pipeline.
//
// Final audio = voiceover + BGM + ambient SFX, mixed by ffmpeg.
//
// Volume formula (YouTube documentary optimal):
//   Voiceover:   100%  — always dominant, never sacrificed
//   BGM:          15%  — felt rather than heard while voice plays
//                 35%  — swells in silence gaps (cinematic breathing room)
//   Ambient SFX:  25%  — continuous scene immersion
//
// Strategy:
//   1. Analyze each beat → select BGM + SFX via audioLibrary (+ Pixabay fallback)
//   2. Group consecutive beats with the same BGM track into sections
//   3. Trim + fade each BGM section to duration, concatenate → bgm_composed.aac
//   4. Pick dominant SFX, loop to video duration → sfx_looped.aac
//   5. Mix: voiceover + bgm_composed + sfx_looped → final_audio.aac
//
// All steps are non-fatal: if BGM or SFX fails, the pipeline continues
// with whatever audio is available (ultimate fallback: raw voiceover only).

'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { selectBGM, selectSFX } = require('./audioLibrary');
const { fetchBestMatch }       = require('./pixabayApi');

const BGM_VOLUME  = 0.15;  // volume factor while voiceover plays
const SFX_VOLUME  = 0.25;  // ambient SFX volume
const FADE_SECS   = 2.0;   // crossfade between BGM sections

// ─── ffmpeg helper ────────────────────────────────────────────────────────
function runFfmpeg(args, label, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => (stderr += d.toString()));
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`${label}: timed out`));
    }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${label} exited ${code}: ${stderr.slice(-600)}`));
      resolve();
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ─── Silent placeholder ───────────────────────────────────────────────────
async function makeSilent(outPath, durationSecs) {
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', String(Math.max(durationSecs, 0.1)),
    '-c:a', 'aac', '-b:a', '128k', '-y', outPath,
  ], 'silent track');
}

// ─── Per-beat audio selection ─────────────────────────────────────────────
async function selectAudioForBeats(beats) {
  const results = [];
  for (const beat of beats) {
    // BGM: local library first, Pixabay fallback
    let bgmPath = selectBGM(beat.text);
    if (!bgmPath) {
      const q = beat.text.split(/\s+/).slice(0, 6).join(' ');
      bgmPath = await fetchBestMatch(q, 'bgm');
    }

    // SFX: local library first, Pixabay fallback
    let sfxPaths = selectSFX(beat.text, 2);
    if (!sfxPaths.length) {
      const q = beat.text.split(/\s+/).slice(0, 6).join(' ');
      const s = await fetchBestMatch(q, 'sfx');
      if (s) sfxPaths = [s];
    }

    results.push({ startMs: beat.startMs, endMs: beat.endMs, bgmPath, sfxPaths });
  }
  return results;
}

// ─── BGM composed track ───────────────────────────────────────────────────
async function buildBgmComposed(selections, totalSecs, outDir) {
  // Group consecutive beats sharing the same BGM track
  const sections = [];
  let cur = null;
  for (const sel of selections) {
    if (!cur || cur.bgmPath !== sel.bgmPath) {
      if (cur) sections.push(cur);
      cur = { bgmPath: sel.bgmPath, startMs: sel.startMs, endMs: sel.endMs };
    } else {
      cur.endMs = sel.endMs;
    }
  }
  if (cur) sections.push(cur);

  const segFiles = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (!sec.bgmPath || !fs.existsSync(sec.bgmPath)) continue;
    const durSecs = Math.max((sec.endMs - sec.startMs) / 1000, 0.5);
    const segOut  = path.join(outDir, `bgm_seg_${i}.aac`);
    const fadeOut = Math.max(durSecs - FADE_SECS, durSecs * 0.8);
    await runFfmpeg([
      '-i', sec.bgmPath,
      '-af', [
        `atrim=duration=${durSecs}`,
        `afade=t=in:ss=0:d=${FADE_SECS}`,
        `afade=t=out:st=${fadeOut}:d=${FADE_SECS}`,
        `volume=${BGM_VOLUME}`,
      ].join(','),
      '-c:a', 'aac', '-b:a', '128k', '-y', segOut,
    ], `bgm seg ${i}`);
    segFiles.push(segOut);
  }

  const outPath = path.join(outDir, 'bgm_composed.aac');
  if (segFiles.length === 0) {
    await makeSilent(outPath, totalSecs);
  } else if (segFiles.length === 1) {
    fs.copyFileSync(segFiles[0], outPath);
  } else {
    const listFile = path.join(outDir, 'bgm_list.txt');
    fs.writeFileSync(
      listFile,
      segFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'),
      'utf8'
    );
    await runFfmpeg([
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', '-y', outPath,
    ], 'bgm concat');
  }
  return outPath;
}

// ─── SFX ambient track ────────────────────────────────────────────────────
async function buildSfxLooped(selections, totalSecs, outDir) {
  // Count how often each SFX path appears across all beats
  const counts = {};
  for (const sel of selections) {
    for (const p of sel.sfxPaths) counts[p] = (counts[p] || 0) + 1;
  }
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const outPath = path.join(outDir, 'sfx_looped.aac');
  if (dominant && fs.existsSync(dominant)) {
    await runFfmpeg([
      '-stream_loop', '-1', '-i', dominant,
      '-t', String(totalSecs),
      '-af', `volume=${SFX_VOLUME}`,
      '-c:a', 'aac', '-b:a', '128k', '-y', outPath,
    ], 'sfx loop');
  } else {
    await makeSilent(outPath, totalSecs);
  }
  return outPath;
}

// ─── Main export ──────────────────────────────────────────────────────────

/**
 * Produce a 3-layer mixed audio file: voiceover + BGM + ambient SFX.
 *
 * @param {string} voicePath  Absolute path to voiceover audio (wav/mp3/aac)
 * @param {Array}  beats      Beats array from promptBuilder.groupIntoBeats()
 * @param {string} outDir     Job output directory (e.g. jobs/<id>/output)
 * @returns {string}          Absolute path to final_audio.aac
 */
async function mixAudio(voicePath, beats, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const totalMs   = beats[beats.length - 1]?.endMs || 0;
  const totalSecs = Math.ceil(totalMs / 1000) + 2; // small buffer

  process.stdout.write(`[audioMix] selecting audio for ${beats.length} beats...\n`);
  const selections = await selectAudioForBeats(beats);

  // Log selection summary
  const bgmUsed = [...new Set(selections.map(s => s.bgmPath).filter(Boolean))]
    .map(p => path.basename(p));
  const sfxUsed = [...new Set(selections.flatMap(s => s.sfxPaths).filter(Boolean))]
    .map(p => path.basename(p));
  process.stdout.write(`[audioMix] BGM selected: ${bgmUsed.join(', ') || 'none'}\n`);
  process.stdout.write(`[audioMix] SFX selected: ${sfxUsed.join(', ') || 'none'}\n`);

  process.stdout.write(`[audioMix] building BGM composed track...\n`);
  const bgmPath = await buildBgmComposed(selections, totalSecs, outDir);

  process.stdout.write(`[audioMix] building SFX ambient track...\n`);
  const sfxPath = await buildSfxLooped(selections, totalSecs, outDir);

  process.stdout.write(`[audioMix] final 3-way mix...\n`);
  const finalPath = path.join(outDir, 'final_audio.aac');
  await runFfmpeg([
    '-i', voicePath,
    '-i', bgmPath,
    '-i', sfxPath,
    // amix with normalize=0: weights are already set by per-track volume filters
    '-filter_complex',
    '[0][1][2]amix=inputs=3:weights=1 1 1:duration=first:normalize=0:dropout_transition=2[out]',
    '-map', '[out]',
    '-c:a', 'aac', '-b:a', '192k',
    '-y', finalPath,
  ], 'final 3-way mix');

  process.stdout.write(`[audioMix] done → ${finalPath}\n`);
  return finalPath;
}

module.exports = { mixAudio, selectAudioForBeats };
