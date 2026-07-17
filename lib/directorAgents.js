// Director Agent stack — the acting-intelligence layer.
//
// Pipeline:  story/script → Screenwriter → Character Director → Actor Director → Camera Director
//
// It ENRICHES an already-generated screenplay (from preproduction.js) in place,
// adding the rich SceneDirectionSchema fields (performance, dialogue, camera,
// lighting, sound, emotionalIntensity) to every beat. Only runs for modes whose
// profile has directorStack === true (drama / movie / cinematic_trailer / anime).
//
// Design goals:
//   - Never fatal: any failed pass leaves the screenplay usable (falls back to
//     the existing weak fields), so a documentary-grade result is always produced.
//   - Cost-aware: enriches in one consolidated Grok call per scene batch rather
//     than one call per beat.
//   - Uses the semantic drama detector to pre-tag intensity so the model focuses
//     its strongest acting on the right beats.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { scoreIntensity } = require('./dramaDetect');
const { normSceneDirection } = require('./schemas');

const GROK_BIN = process.env.GROK_BIN || 'grok';
const GROK_TIMEOUT_MS = parseInt(process.env.GROK_DIRECTOR_TIMEOUT_MS, 10) || 10 * 60 * 1000;

function runGrokHeadless(args, cwd, timeoutMs = GROK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn(GROK_BIN, args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error('Grok director pass timed out'));
    }, timeoutMs);
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      let parsed = null;
      try { parsed = JSON.parse(trimmed); } catch (_) {}
      if (parsed && parsed.type === 'error') return reject(new Error(parsed.message || trimmed));
      if (code !== 0) {
        const msg = (parsed && parsed.text) ? parsed.text : (stderr || trimmed).slice(-600);
        return reject(new Error(`Grok director exited ${code}: ${msg}`));
      }
      resolve(parsed ? parsed : trimmed);
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function extractJson(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```json\s*([\s\S]*?)\s*```/i) || t.match(/```\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  // Grab the first balanced-looking JSON object/array
  const firstBrace = t.search(/[[{]/);
  if (firstBrace > 0) t = t.slice(firstBrace);
  return JSON.parse(t);
}

// Flatten screenplay scenes → ordered beats with scene context.
function collectBeats(screenplay) {
  const beats = [];
  if (screenplay && Array.isArray(screenplay.scenes)) {
    for (const scene of screenplay.scenes) {
      if (!Array.isArray(scene.beats)) continue;
      for (const beat of scene.beats) {
        beats.push({
          sceneId: scene.sceneId,
          location: scene.location,
          timeOfDay: scene.timeOfDay,
          weather: scene.weather,
          beat,
        });
      }
    }
  }
  return beats;
}

/**
 * Enrich the screenplay with full acting direction.
 * @param {object} screenplay  parsed screenplay.json (mutated + returned)
 * @param {object} opts { mode, characters, sceneStyle, custom, jobDir }
 * @returns {Promise<object>} enriched screenplay
 */
async function runDirectorStack(screenplay, opts = {}) {
  const { mode, sceneStyle = '', custom = {}, jobDir } = opts;
  if (!screenplay || !Array.isArray(screenplay.scenes)) return screenplay;

  const flat = collectBeats(screenplay);
  if (flat.length === 0) return screenplay;

  // Pre-tag each beat with semantic intensity so the director focuses effort.
  for (const f of flat) {
    const text = f.beat.narration || '';
    f.intensity = Number(scoreIntensity(text).score.toFixed(3));
  }

  const cast = screenplay.productionBible && screenplay.productionBible.characters
    ? Object.keys(screenplay.productionBible.characters)
    : [];

  const language = str(custom.dialogueLanguage) || 'English';
  const modeEmphasis = mode ? mode.promptEmphasis : '';
  const dialogueDriven = mode ? mode.dialogueDriven : true;

  // Process in chunks of scenes to bound prompt size / turns.
  const CHUNK = 6;
  const byScene = groupByScene(flat);
  const sceneIds = Object.keys(byScene);

  for (let i = 0; i < sceneIds.length; i += CHUNK) {
    const chunkIds = sceneIds.slice(i, i + CHUNK);
    const chunkBeats = chunkIds.flatMap(id => byScene[id]);

    const beatsForPrompt = chunkBeats.map(f => ({
      beatIndex: f.beat.beatIndex,
      sceneId: f.sceneId,
      location: f.location,
      timeOfDay: f.timeOfDay,
      narration: f.beat.narration,
      charactersPresent: f.beat.charactersPresent || [],
      intensity: f.intensity,
    }));

    const prompt = buildDirectorPrompt({
      beatsForPrompt, cast, sceneStyle, modeEmphasis, dialogueDriven, language,
    });

    const args = [
      '-p', prompt,
      '--always-approve', '--permission-mode', 'bypassPermissions',
      '--no-plan', '--max-turns', '15', '--output-format', 'json',
    ];

    try {
      process.stdout.write(`[directorAgents] enriching scenes ${chunkIds[0]}..${chunkIds[chunkIds.length - 1]} (${chunkBeats.length} beats)\n`);
      const res = await runGrokHeadless(args, jobDir);
      const text = (typeof res === 'string' ? res : (res.text || '')).trim();
      const parsed = extractJson(text);
      applyEnrichment(chunkBeats, parsed);
    } catch (e) {
      process.stdout.write(`[directorAgents] WARN: enrichment failed for scenes ${chunkIds.join(',')}: ${e.message}\n`);
      // leave those beats with their original weak fields (graceful degrade)
    }
  }

  // Persist enriched screenplay
  try {
    if (jobDir) {
      fs.writeFileSync(path.join(jobDir, 'screenplay.json'), JSON.stringify(screenplay, null, 2));
    }
  } catch (_) {}

  return screenplay;
}

function buildDirectorPrompt({ beatsForPrompt, cast, sceneStyle, modeEmphasis, dialogueDriven, language }) {
  return [
    `You are a four-in-one film DIRECTOR working as a chain:`,
    `  1) SCREENWRITER — clarify the dramatic intent of each beat.`,
    `  2) CHARACTER DIRECTOR — define each present character's inner emotional state.`,
    `  3) ACTOR DIRECTOR — translate emotion into VISIBLE performance (face, body, eyes, voice, interaction).`,
    `  4) CAMERA DIRECTOR — choose shot + movement that best captures the acting.`,
    ``,
    modeEmphasis ? `MODE DIRECTION: ${modeEmphasis}` : ``,
    sceneStyle ? `STYLE DIRECTION: ${sceneStyle}` : ``,
    `Dialogue language: ${language}.`,
    cast.length ? `Known cast: ${cast.join(', ')}.` : ``,
    ``,
    `For EACH beat below, produce rich acting direction. Higher "intensity" beats need stronger, more`,
    `specific performance. A viewer must understand who is angry, hurt, in love, or betrayed just by WATCHING.`,
    dialogueDriven
      ? `If a beat clearly involves people speaking, add realistic dialogue lines with speaker, delivery performance, and the listener's reaction.`
      : `Dialogue is optional; focus on visible acting that illustrates the narration.`,
    ``,
    `INPUT BEATS (JSON):`,
    JSON.stringify(beatsForPrompt),
    ``,
    `OUTPUT JSON ONLY — an array, one object per input beat, same order, matching:`,
    `[`,
    `  {`,
    `    "beatIndex": <number matching input>,`,
    `    "emotionalIntensity": <0..1>,`,
    `    "lighting": "concise lighting that matches the emotion",`,
    `    "camera": { "shotType": "...", "cameraMovement": "...", "framing": "...", "focus": "..." },`,
    `    "sound": { "sfx": ["..."], "music": "mood tag", "ambience": "..." },`,
    `    "performance": {`,
    `      "CharacterName": {`,
    `        "emotion": ["heartbroken", "trying to stay strong"],`,
    `        "facialExpression": ["tears forming", "trembling lips"],`,
    `        "bodyLanguage": ["hands trembling", "steps backward slowly"],`,
    `        "eyeDirection": "looking directly at the other character",`,
    `        "voicePerformance": "soft broken voice",`,
    `        "interaction": "looks at him before speaking because she still loves him"`,
    `      }`,
    `    },`,
    `    "dialogue": [`,
    `      { "speaker": "CharacterName", "line": "spoken words", "performance": ["voice shaking", "pauses"], "listenerReaction": "the other lowers his head", "emotionTransition": "calm -> anger" }`,
    `    ]`,
    `  }`,
    `]`,
    `Only include characters actually present in that beat. Keep it faithful to the narration. No text outside the JSON array.`,
  ].filter(Boolean).join('\n');
}

// Merge model output back onto the real screenplay beat objects.
function applyEnrichment(chunkBeats, parsed) {
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.beats) ? parsed.beats : []);
  if (!arr.length) return;

  const byIndex = new Map();
  for (const item of arr) {
    const idx = Number(item.beatIndex);
    if (Number.isFinite(idx)) byIndex.set(idx, item);
  }

  for (const f of chunkBeats) {
    const beat = f.beat;
    const enr = byIndex.get(Number(beat.beatIndex));
    if (!enr) continue;

    // Normalise via schema, then attach the rich fields to the real beat.
    const norm = normSceneDirection({
      ...enr,
      sceneId: f.sceneId,
      beatIndex: beat.beatIndex,
      location: f.location,
      time: f.timeOfDay,
      weather: f.weather,
      narration: beat.narration,
      charactersPresent: beat.charactersPresent || Object.keys(enr.performance || {}),
    });

    beat.performance = norm.performance;
    beat.dialogue = norm.dialogue;
    beat.camera = norm.camera;
    beat.lighting = norm.lighting || beat.lighting;
    beat.sound = norm.sound;
    beat.emotionalIntensity = norm.emotionalIntensity != null ? norm.emotionalIntensity : f.intensity;

    // Keep legacy fields populated so older code paths still work.
    if (!beat.shotType && norm.camera.shotType) beat.shotType = norm.camera.shotType;
    if (!beat.cameraMovement && norm.camera.cameraMovement) beat.cameraMovement = norm.camera.cameraMovement;
    if ((!beat.charactersPresent || !beat.charactersPresent.length) && Object.keys(norm.performance).length) {
      beat.charactersPresent = Object.keys(norm.performance);
    }
    // Bridge to legacy characterStates so promptBuilder/continuity keep functioning.
    beat.characterStates = beat.characterStates || {};
    for (const [name, perf] of Object.entries(norm.performance)) {
      const emotion = (perf.emotion && perf.emotion[0]) || 'neutral';
      const activity = [...(perf.bodyLanguage || [])].slice(0, 2).join(', ');
      beat.characterStates[name] = {
        ...(beat.characterStates[name] || {}),
        emotion,
        activity: activity || (beat.characterStates[name]?.activity || ''),
      };
    }
  }
}

function groupByScene(flat) {
  const map = {};
  for (const f of flat) {
    const k = String(f.sceneId);
    (map[k] = map[k] || []).push(f);
  }
  return map;
}

function str(v) { return v == null ? '' : String(v).trim(); }

module.exports = { runDirectorStack };
