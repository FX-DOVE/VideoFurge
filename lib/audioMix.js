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
const { detectMood }           = require('./promptBuilder');

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
    let bgmPath = beat.music ? selectBGM(beat.music) : null;
    if (!bgmPath) bgmPath = selectBGM(beat.text || beat.narration);
    if (!bgmPath) {
      const q = beat.music || (beat.text || beat.narration || '').split(/\s+/).slice(0, 6).join(' ');
      bgmPath = await fetchBestMatch(q, 'bgm');
    }

    // SFX: precise tags first, then fallback
    let sfxPaths = [];
    if (beat.sfx && beat.sfx.length > 0) {
      for (const tag of beat.sfx) {
         const hits = selectSFX(tag, 1);
         if (hits.length) sfxPaths.push(hits[0]);
         else {
           const p = await fetchBestMatch(tag, 'sfx');
           if (p) sfxPaths.push(p);
         }
      }
    } else {
      sfxPaths = selectSFX(beat.text || beat.narration || '', 2);
      if (!sfxPaths.length) {
        const q = (beat.text || beat.narration || '').split(/\s+/).slice(0, 6).join(' ');
        const s = await fetchBestMatch(q, 'sfx');
        if (s) sfxPaths = [s];
      }
    }

    // For emphasis (danger, years, dramatic words): pick a stronger "stinger" SFX if available
    const textToCheck = beat.text || beat.narration || '';
    const mood = detectMood(textToCheck);
    const hasEmphasis = /\b(\d+[\s-]?(year|years)|danger|deadly|death|war|crisis|disaster|must|never)\b/i.test(textToCheck);
    if (hasEmphasis || mood === 'dramatic') {
      // Prefer a punchy impact sfx if present in library (e.g. earthquake, fire, crowd for tension)
      const impact = selectSFX(textToCheck + ' impact hit rumble explosion', 1);
      if (impact.length) {
        sfxPaths = [...sfxPaths, ...impact].slice(0, 3);
      }
    }

    results.push({ startMs: beat.startMs, endMs: beat.endMs, bgmPath, sfxPaths, hasEmphasis });
  }
  return results;
}

// ─── BGM composed track ───────────────────────────────────────────────────
async function buildBgmComposed(selections, totalSecs, outDir, customOutPath = null) {
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

  const outPath = customOutPath || path.join(outDir, 'bgm_composed.aac');
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

// ─── SFX precise placement track ──────────────────────────────────────────
async function buildSfxComposed(selections, totalSecs, outDir, customOutPath = null) {
  const sfxEvents = [];
  for (const sel of selections) {
    if (sel.sfxPaths && sel.sfxPaths.length > 0) {
       for (const p of sel.sfxPaths) {
          if (fs.existsSync(p)) {
             sfxEvents.push({ path: p, delayMs: sel.startMs });
          }
       }
    }
  }

  const outPath = customOutPath || path.join(outDir, 'sfx_composed.aac');
  if (sfxEvents.length === 0) {
    await makeSilent(outPath, totalSecs);
    return outPath;
  }

  // Cap at 32 inputs to avoid ffmpeg command length / input limits
  const cappedEvents = sfxEvents.slice(0, 32);

  const inputs = [];
  const filters = [];
  const mixInputs = [];
  
  for (let i = 0; i < cappedEvents.length; i++) {
    const ev = cappedEvents[i];
    inputs.push('-i', ev.path);
    const ms = Math.max(0, ev.delayMs);
    filters.push(`[${i}:a]volume=${SFX_VOLUME},adelay=${ms}|${ms}[a${i}]`);
    mixInputs.push(`[a${i}]`);
  }
  
  filters.push(`${mixInputs.join('')}amix=inputs=${cappedEvents.length}:dropout_transition=2:normalize=0[out]`);
  
  await runFfmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-c:a', 'aac', '-b:a', '128k', '-y', outPath,
  ], 'sfx compose');
  
  return outPath;
}

// ─── Main export ──────────────────────────────────────────────────────────

/**
 * Produce a 3-layer mixed audio file: voiceover + BGM + ambient SFX.
 *
 * @param {string} voicePath  Absolute path to voiceover audio (wav/mp3/aac)
 * @param {Array}  beats      Beats array from promptBuilder.groupIntoBeats()
 * @param {string} outDir     Job output directory (e.g. jobs/<id>/output)
 * @param {Array}  actedBeats Optional native-aligned beats for acted soundtrack
 * @returns {string}          Absolute path to final_audio.aac
 */
async function mixAudio(voicePath, beats, outDir, actedBeats = null) {
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

  process.stdout.write(`[audioMix] building SFX precise placement track...\n`);
  const sfxPath = await buildSfxComposed(selections, totalSecs, outDir);

  process.stdout.write(`[audioMix] final ${voicePath ? '3-way (voice+BGM+SFX)' : '2-way (BGM+SFX, no voiceover)'} mix...\n`);
  const finalPath = path.join(outDir, 'final_audio.aac');
  if (voicePath && fs.existsSync(voicePath)) {
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
  } else {
    // No voiceover track — mix only BGM + SFX.
    await runFfmpeg([
      '-i', bgmPath,
      '-i', sfxPath,
      '-filter_complex',
      '[0][1]amix=inputs=2:weights=1 1:duration=first:normalize=0:dropout_transition=2[out]',
      '-map', '[out]',
      '-c:a', 'aac', '-b:a', '192k',
      '-y', finalPath,
    ], 'final 2-way mix (no voiceover)');
  }

  process.stdout.write(`[audioMix] acted (BGM + SFX, no voice) mix...\n`);
  const actedAudioPath = path.join(outDir, 'acted_audio.aac');
  try {
    let targetBgmPath = bgmPath;
    let targetSfxPath = sfxPath;
    
    if (actedBeats) {
      process.stdout.write(`[audioMix] building custom BGM/SFX tracks for acted timeline...\n`);
      const actedTotalMs = actedBeats[actedBeats.length - 1]?.endMs || 0;
      const actedTotalSecs = Math.ceil(actedTotalMs / 1000) + 2;
      const actedSelections = await selectAudioForBeats(actedBeats);
      
      targetBgmPath = path.join(outDir, 'bgm_composed_acted.aac');
      targetSfxPath = path.join(outDir, 'sfx_composed_acted.aac');
      
      await buildBgmComposed(actedSelections, actedTotalSecs, outDir, targetBgmPath);
      await buildSfxComposed(actedSelections, actedTotalSecs, outDir, targetSfxPath);
    }

    await runFfmpeg([
      '-i', targetBgmPath,
      '-i', targetSfxPath,
      '-filter_complex',
      '[0][1]amix=inputs=2:weights=1 1:duration=first:normalize=0:dropout_transition=2[out]',
      '-map', '[out]',
      '-c:a', 'aac', '-b:a', '192k',
      '-y', actedAudioPath,
    ], 'acted audio mix');
  } catch (actedErr) {
    process.stdout.write(`[audioMix] WARN: acted audio mix failed: ${actedErr.message}\n`);
  }

  process.stdout.write(`[audioMix] done → ${finalPath}\n`);
  return finalPath;
}

module.exports = { mixAudio, selectAudioForBeats };
