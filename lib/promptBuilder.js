// Builds one image+video prompt per timestamp "beat", anchored to what's
// actually being said at that moment, then chunks prompts into batches
// of 20 (your batch size for each headless Grok CLI run).
//
// Enhanced for YouTube retention:
//  - Shot type rotation (6-cycle) keeps every frame visually different
//  - Mood/scene detection matches lighting, atmosphere, camera to narration
//  - Camera motion directives give Grok's video gen clear movement instructions
//  - Style + character consistency enforced via styleSummary injection

'use strict';

const { scoreIntensity } = require('./dramaDetect');
const { getMode } = require('./videoModes');

const BEAT_SECONDS = 10; // one image+video every 10s of narration
const BATCH_SIZE   = 2; // smaller batches = fewer turns per Grok session, avoids "max turns reached" during long multi-step image+video work

// ─── Shot type rotation (6-cycle) ─────────────────────────────────────────
// Cycling ensures every beat gets a DIFFERENT composition — key for retention
const SHOT_TYPES = [
  { type: 'wide establishing shot',
    desc: 'Full environment visible, subject small in frame — epic sense of scale and grandeur' },
  { type: 'medium shot',
    desc: 'Subject from waist up, environment fills background — human-scale intimacy and connection' },
  { type: 'cinematic close-up',
    desc: 'Subject fills the frame, tight focus on face or key detail — raw emotion and intensity' },
  { type: "aerial bird's-eye view",
    desc: 'Camera directly above looking down — vast landscape visible, shows spatial relationships' },
  { type: 'low angle heroic shot',
    desc: 'Camera angled upward at subject, sky behind — conveys power, dominance, and heroism' },
  { type: 'medium wide shot',
    desc: 'Subject at left or right third, environment fills two-thirds — context with human presence' },
];

// ─── Camera motion per beat (6-cycle) ─────────────────────────────────────
const CAMERA_MOTIONS = [
  'Slow, deliberate push-in (zoom in 15% over 10 seconds) — builds suspense and focus',
  'Gentle parallax drift — subtle floating camera movement, barely perceptible, deeply cinematic',
  'Slow pan from left to right, sweeping reveal of the full scene',
  'Slow pull-back reveal — camera retreats, expanding and revealing the wider world around the subject',
  'Subtle clockwise orbit around the central subject (20-degree arc over 10 seconds)',
  'Locked static frame — zero camera movement, let the scene breathe with stillness',
];

// ─── Mood keyword tables ───────────────────────────────────────────────────
const MOOD_KEYWORDS = {
  epic:        ['empire', 'civilization', 'vast', 'grand', 'rise', 'power', 'great', 'mighty',
                'glory', 'conquest', 'triumph', 'legendary', 'kingdom', 'ruler', 'command'],
  dramatic:    ['war', 'battle', 'fall', 'attack', 'destroy', 'conflict', 'struggle', 'death',
                'siege', 'collapse', 'brutal', 'fierce', 'enemy', 'blood', 'violence'],
  mysterious:  ['unknown', 'ancient', 'myth', 'legend', 'discover', 'secret', 'hidden', 'lost',
                'ruin', 'buried', 'uncover', 'oracle', 'prophecy', 'curse', 'ritual'],
  reflective:  ['remember', 'past', 'history', 'time', 'memory', 'tradition', 'heritage',
                'ancestor', 'legacy', 'era', 'century', 'long ago', 'once', 'origin'],
  hopeful:     ['new', 'grow', 'begin', 'born', 'start', 'create', 'prosper', 'flourish',
                'rebuild', 'restore', 'future', 'hope', 'advance', 'progress', 'achieve'],
  educational: ['evidence', 'research', 'according', 'shows', 'demonstrate', 'analysis',
                'study', 'found', 'reveal', 'indicate', 'reconstruction', 'combining'],
};

// ─── Lighting per mood ────────────────────────────────────────────────────
const MOOD_LIGHTING = {
  epic:        'Dramatic golden-hour sunlight with long sweeping shadows, volumetric god-rays piercing through dust and atmosphere, warm amber and ochre tones',
  dramatic:    'Harsh directional rim lighting casting deep shadows, smoky red-tinged atmosphere, fire-lit or blood-red sunset sky creating stark contrast',
  mysterious:  'Ethereal blue-silver moonlight diffused through mist, flickering torchlight or candlelight casting dancing warm shadows against cool darkness',
  reflective:  'Soft warm overcast morning light, gentle amber haze, diffused golden glow with no harsh shadows — timeless and contemplative',
  hopeful:     'Warm golden sunrise rays breaking through scattered clouds, vibrant natural greens and golds, fresh and energizing natural light',
  educational: 'Clean neutral midday daylight, crisp balanced illumination, no heavy color cast — clear, documentary-style visibility of all details',
};

// ─── Scene atmosphere per mood ────────────────────────────────────────────
const MOOD_ATMOSPHERE = {
  epic:        'Dust particles suspended in air, vast dramatic cloud formations, haze on the horizon giving immense sense of depth and scale',
  dramatic:    'Smoke and ash drifting, heat shimmer, tense charged atmosphere, urgency and danger felt in every element',
  mysterious:  'Wisps of ground-level fog, ancient dust, ethereal quality, quiet and enigmatic — time seems suspended',
  reflective:  'Gently stirring leaves or flowing cloth in a soft breeze, serene stillness, contemplative peace',
  hopeful:     'Birds in flight across the sky, lush blooming plant life, freshness and vitality in every detail',
  educational: 'Sharp crisp detail throughout, textured surfaces clearly visible, informative and authoritative clarity',
};

// ─── Scene type detection ─────────────────────────────────────────────────
function detectSceneType(text) {
  const t = text.toLowerCase();
  if (/sea|ocean|harbor|ship|coastal|naval|water|river|lake|port|voyage/.test(t))  return 'coastal';
  if (/forest|jungle|mountain|valley|desert|wilderness|nature|landscape|hill/.test(t)) return 'nature';
  if (/city|town|market|street|crowd|settlement|village|forum|plaza|urban/.test(t)) return 'urban';
  if (/palace|temple|building|structure|arch|monument|ruin|column|wall/.test(t))   return 'architecture';
  if (/battle|war|army|soldier|weapon|fight|siege|legion|cavalry|attack/.test(t))  return 'battle';
  if (/scroll|writing|document|study|research|map|manuscript|scholar/.test(t))     return 'interior-study';
  return 'landscape';
}

// ─── Mood detection ───────────────────────────────────────────────────────
function detectMood(text) {
  const lower = text.toLowerCase();
  const scores = {};
  for (const [mood, keywords] of Object.entries(MOOD_KEYWORDS)) {
    scores[mood] = keywords.filter(k => lower.includes(k)).length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  // Default: epic works well for most historical/documentary content
  return (best && best[1] > 0) ? best[0] : 'epic';
}

// ─── Beat grouping ─────────────────────────────────────────────────────────
function groupIntoBeats(segments, totalDurationMs) {
  const beats = [];
  for (let startMs = 0; startMs < totalDurationMs; startMs += BEAT_SECONDS * 1000) {
    const endMs = Math.min(startMs + BEAT_SECONDS * 1000, totalDurationMs);
    const text  = segments
      .filter(s => s.startMs < endMs && s.endMs > startMs)
      .map(s => s.text)
      .join(' ')
      .trim();
    beats.push({ startMs, endMs, text: text || '(no speech, continue previous scene)' });
  }
  return beats;
}

// ─── Script → synthetic segments (used when no media/audio is provided) ─────
// Splits a script into sentence-ish segments and assigns synthetic timings so
// the rest of the pipeline (beats → images → clips → captions) works unchanged.
//
// When targetMinutes is set (Drama / Movie / Anime fixed runtime):
//   - Total duration is forced to exactly that many minutes.
//   - If the story is too long to fit, excess is dropped and the ending is
//     rewritten as a SHOCKING cliffhanger so viewers expect Part 2.
//   - If the story is short, segment timings are stretched to fill the runtime.
//
// Estimated ~13 characters/second of speech, min 2.2s, max 12s per segment
// (max raised slightly so stretched short stories still look natural).
function segmentsFromScript(script, opts = {}) {
  const {
    charsPerSec = 13,
    minMs = 2200,
    maxMs = 12000,
    targetMinutes = null,
    title = '',
    partNumber = 1,
  } = opts;

  const text = String(script || '').trim();
  if (!text) return [];

  // Strip screenplay scene headings / cues that shouldn't be "spoken".
  const cleaned = text
    .replace(/^\s*(INT\.|EXT\.|INT\/EXT\.|FADE (IN|OUT)|CUT TO:|TO BE CONTINUED|PART\s+\d+).*$/gim, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Split into sentence-like chunks, keeping terminators.
  const rawParts = cleaned.match(/[^.!?\n]+[.!?]?/g) || [cleaned];

  // Merge only tiny fragments (< 12 chars, e.g. "He ran.") into the previous one.
  const parts = [];
  for (const p of rawParts) {
    const s = p.trim();
    if (!s) continue;
    if (parts.length && s.length < 12) parts[parts.length - 1] += ' ' + s;
    else parts.push(s);
  }
  if (!parts.length) return [];

  const targetMs = (Number(targetMinutes) > 0)
    ? Math.round(Number(targetMinutes) * 60 * 1000)
    : null;

  let usedParts = parts.slice();
  let expectsPart2 = false;
  let truncated = false;

  if (targetMs) {
    // Hard cap: each segment needs at least minMs, so max scene count is fixed.
    // Reserve 1 slot for a cliffhanger ending when we must cut the story short.
    const maxPartsFit = Math.max(2, Math.floor(targetMs / minMs));
    // Aim for ~1 visual beat every ~5s so short scripts still feel like a film, not one frozen shot.
    const idealParts = Math.max(3, Math.round(targetMs / 5000));

    if (usedParts.length > maxPartsFit) {
      // Story too long for the chosen minutes → keep what fits, end on shock.
      const keepCount = Math.max(1, maxPartsFit - 1);
      usedParts = usedParts.slice(0, keepCount);
      usedParts.push(buildCliffhangerLine({ title, partNumber, lastLine: usedParts[usedParts.length - 1] }));
      expectsPart2 = true;
      truncated = true;
    } else {
      // Fits or is short — still check natural spoken length vs target.
      // If natural length would overshoot even with min durations, cut + cliffhanger.
      const naturalMs = usedParts.reduce((sum, p) => {
        const d = Math.round((p.length / charsPerSec) * 1000);
        return sum + Math.max(minMs, Math.min(maxMs, d));
      }, 0);
      if (naturalMs > targetMs * 1.15 && usedParts.length >= 3) {
        // Overstuffed: drop the last third of beats and cliffhanger.
        const keepCount = Math.max(2, Math.ceil(usedParts.length * 0.65));
        usedParts = usedParts.slice(0, keepCount);
        usedParts.push(buildCliffhangerLine({ title, partNumber, lastLine: usedParts[usedParts.length - 1] }));
        expectsPart2 = true;
        truncated = true;
      } else if (usedParts.length < idealParts) {
        // Too few beats for the runtime → subdivide long lines, then pad with
        // actable reaction/atmosphere beats so each Grok clip stays ~5–10s.
        usedParts = subdivideParts(usedParts, idealParts);
        usedParts = padAtmosphereBeats(usedParts, idealParts, title);
      }
    }
  }

  // Build raw durations from text length
  let rawDurs = usedParts.map(p => {
    const d = Math.round((p.length / charsPerSec) * 1000);
    return Math.max(minMs, Math.min(maxMs, d));
  });

  // Force exact total when targetMinutes is set
  if (targetMs && usedParts.length > 0) {
    rawDurs = distributeExactDuration(rawDurs, targetMs, minMs, maxMs);
  }

  const segments = [];
  let cursor = 0;
  for (let i = 0; i < usedParts.length; i++) {
    const durMs = rawDurs[i];
    const startMs = cursor;
    const endMs = cursor + durMs;
    segments.push({
      startMs,
      endMs,
      text: usedParts[i],
      ...(i === usedParts.length - 1 && expectsPart2 ? { cliffhanger: true, expectsPart2: true } : {}),
    });
    cursor = endMs;
  }

  // Attach meta on the array for callers (non-enumerable-ish via property)
  segments.expectsPart2 = expectsPart2;
  segments.truncated = truncated;
  segments.targetMinutes = targetMinutes || null;
  segments.totalDurationMs = cursor;
  return segments;
}

/**
 * Scale/adjust an array of durations so they sum exactly to targetMs.
 * Soft-clamps each beat near a natural max, but raises the ceiling so the
 * full runtime can still be shared evenly (no single 2-minute final shot).
 */
function distributeExactDuration(durs, targetMs, minMs, maxMs) {
  const n = durs.length;
  if (n === 0) return [];
  // Allow enough headroom so n clips can cover the whole episode evenly.
  const evenShare = Math.ceil(targetMs / n);
  const softMax = Math.max(maxMs, evenShare + 1000);

  // Floor: n * minMs must not exceed target
  const floorTotal = n * minMs;
  if (targetMs < floorTotal) {
    const each = Math.max(500, Math.floor(targetMs / n));
    const out = Array(n).fill(each);
    out[n - 1] = targetMs - each * (n - 1);
    return out;
  }

  let weights = durs.slice();
  let sum = weights.reduce((a, b) => a + b, 0) || 1;
  // Prefer even distribution when scaling way up from a short script
  const scaleUp = targetMs > sum * 1.4;
  if (scaleUp) weights = weights.map(() => 1);
  sum = weights.reduce((a, b) => a + b, 0) || 1;

  let out = weights.map(w => Math.round((w / sum) * targetMs));
  out = out.map(d => Math.max(minMs, Math.min(softMax, d)));

  let cur = out.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (cur !== targetMs && guard < 10000) {
    guard++;
    if (cur < targetMs) {
      const i = guard % n;
      if (out[i] < softMax) { out[i]++; cur++; }
      else {
        const j = out.findIndex(d => d < softMax);
        if (j < 0) { out[n - 1] += (targetMs - cur); cur = targetMs; break; }
        out[j]++; cur++;
      }
    } else {
      const i = out.findIndex(d => d > minMs);
      if (i < 0) break;
      out[i]--; cur--;
    }
  }
  cur = out.reduce((a, b) => a + b, 0);
  if (cur !== targetMs) out[n - 1] = Math.max(minMs, out[n - 1] + (targetMs - cur));
  return out;
}

/** Split long lines so a short script still yields enough visual beats for the runtime. */
function subdivideParts(parts, targetCount) {
  let out = parts.slice();
  let guard = 0;
  while (out.length < targetCount && guard < 200) {
    guard++;
    // Split the longest remaining part at a mid word boundary
    let longest = 0;
    for (let i = 1; i < out.length; i++) {
      if (out[i].length > out[longest].length) longest = i;
    }
    const s = out[longest];
    if (s.length < 24) break;
    const mid = Math.floor(s.length / 2);
    let splitAt = s.lastIndexOf(' ', mid);
    if (splitAt < 8) splitAt = s.indexOf(' ', mid);
    if (splitAt < 8) break;
    const a = s.slice(0, splitAt).trim();
    const b = s.slice(splitAt).trim();
    if (!a || !b) break;
    out.splice(longest, 1, a, b);
  }
  return out;
}

/** Insert silent acting beats between lines so a short story still fills the runtime. */
function padAtmosphereBeats(parts, targetCount, title) {
  if (parts.length >= targetCount) return parts;
  const fillers = [
    'A long, heavy silence. Eyes search each other for the truth.',
    'Hands tremble. Someone looks away, then forces themselves to look back.',
    'The room feels smaller. Rain taps the window like a countdown.',
    'A breath catches. No one moves. The moment stretches.',
    'Memory flashes across a face — pain, love, regret in a single expression.',
    'Footsteps approach in the distance. Both characters freeze.',
    'A phone screen lights a tear-streaked cheek in the dark.',
    title
      ? `The weight of "${String(title).slice(0, 40)}" hangs in the air between them.`
      : 'The weight of everything unsaid hangs between them.',
  ];
  const out = parts.slice();
  let fi = 0;
  let insertAt = 1;
  let lastFiller = '';
  while (out.length < targetCount && fi < 400) {
    let line = fillers[fi % fillers.length];
    fi++;
    if (line === lastFiller) line = fillers[fi % fillers.length];
    lastFiller = line;
    out.splice(Math.min(insertAt, out.length), 0, line);
    insertAt += 2;
    if (insertAt > out.length) insertAt = 1;
  }
  return out.slice(0, targetCount);
}

/** Shocking Part-2 tease when the full story does not fit the chosen minutes. */
function buildCliffhangerLine({ title, partNumber = 1, lastLine = '' }) {
  const next = Math.max(1, Number(partNumber) || 1) + 1;
  const titleBit = title ? `"${String(title).slice(0, 60)}"` : 'the story';
  // Keep it visual + shocking so acted modes can stage a freeze-frame reveal.
  return (
    `Then everything changes in a single heartbeat — a door opens, a secret is exposed, ` +
    `and someone is not who they seemed. The camera freezes on the shock. ` +
    `TO BE CONTINUED. End of Part ${partNumber || 1} of ${titleBit}. ` +
    `Part ${next} will pick up from this exact moment. ` +
    (lastLine ? `(Beats before the cut: ${String(lastLine).slice(0, 80)})` : '')
  ).trim();
}

// ─── Prompt builder ────────────────────────────────────────────────────────
function buildPrompts(beats, styleSummary, scriptContext, extra = {}) {
  const {
    characters = [], sceneStyle = '', styleReferencePaths = [], screenplay = null,
    videoType = 'documentary', resolution = '16:9',
  } = extra || {};

  const mode = getMode(videoType);

  return beats.map((beat, i) => {
    let mood        = detectMood(beat.text || beat.narration || '');
    let sceneType   = detectSceneType(beat.text || beat.narration || '');
    let shot        = SHOT_TYPES[i % SHOT_TYPES.length];
    let motion      = CAMERA_MOTIONS[i % CAMERA_MOTIONS.length];
    let lighting    = MOOD_LIGHTING[mood];
    let atmosphere  = MOOD_ATMOSPHERE[mood];
    let resolvedCharacters = [];

    // Semantic intensity (replaces pure keyword drama detection).
    const intensityRaw = (beat.emotionalIntensity != null)
      ? Number(beat.emotionalIntensity)
      : scoreIntensity(beat.narration || beat.text || '').score;
    const intensity = Math.max(0, Math.min(1, intensityRaw + mode.actingIntensity * 0.4));

    if (screenplay) {
      const sceneId = beat.sceneId;
      // Override with screenplay values
      if (beat.shotType) shot = { type: beat.shotType, desc: '' };
      if (beat.camera && beat.camera.shotType) shot = { type: beat.camera.shotType, desc: beat.camera.framing || '' };
      if (beat.cameraMovement) motion = beat.cameraMovement;
      if (beat.camera && beat.camera.cameraMovement) motion = beat.camera.cameraMovement;
      if (beat.lighting) lighting = beat.lighting;
      if (beat.timeOfDay || beat.weather) {
        if (!beat.lighting) lighting = `Time of Day: ${beat.timeOfDay || 'Unknown'}.`;
        atmosphere = `Weather/Environment: ${beat.weather || 'Unknown'}.`;
      }
      
      // Resolve characters
      if (beat.charactersPresent && screenplay.productionBible && screenplay.productionBible.characters) {
        resolvedCharacters = beat.charactersPresent.map(cName => {
          const charBible = screenplay.productionBible.characters[cName];
          if (!charBible) return { name: cName, state: 'Unknown' };
          
          let outfit = 'Default outfit';
          if (charBible.outfitHistory) {
             const oh = charBible.outfitHistory.find(h => h.fromScene <= sceneId && (h.toScene === null || h.toScene >= sceneId));
             if (oh) outfit = oh.outfit;
          }
          let injuries = 'None';
          if (charBible.injuryHistory) {
             const ih = charBible.injuryHistory.find(h => h.fromScene <= sceneId && (h.toScene === null || h.toScene >= sceneId));
             if (ih) injuries = ih.injury;
          }
          
          const state = beat.characterStates && beat.characterStates[cName];
          const emotion = state ? state.emotion : 'neutral';
          const activity = state ? state.activity : '';

          // Rich performance direction (from director stack), if present.
          const perf = beat.performance && beat.performance[cName] ? beat.performance[cName] : null;

          return {
            name: cName,
            description: charBible.description,
            outfit,
            injuries,
            emotion,
            activity,
            performance: perf,
            canonicalRefPaths: charBible.canonicalRefPaths || []
          };
        });
      }
    }

    return {
      index:        beat.index !== undefined ? beat.index : i,
      startMs:      beat.startMs,
      endMs:        beat.endMs,
      narration:    beat.narration || beat.text,
      styleSummary,
      scriptContext,
      characters,            // legacy
      resolvedCharacters,    // NEW: rich character state
      sceneStyle,            // user art direction
      styleReferencePaths,   // additional style / environment / prop references
      // Cinematic enrichment — used by grokBatch.js to build the full task prompt
      mood,
      sceneType,
      shotType:     shot.type,
      shotDesc:     shot.desc,
      cameraMotion: motion,
      lighting,
      atmosphere,
      // Acting-first fields
      videoType:    mode.id,
      modeEmphasis: mode.promptEmphasis,
      dialogueDriven: mode.dialogueDriven,
      resolution,
      dialogue:     Array.isArray(beat.dialogue) ? beat.dialogue : [],
      intensity,
      // Legacy field kept for backward compatibility
      prompt:       beat.text,
      emergentDetails: beat.emergentDetails || null
    };
  });
}

// ─── Batch chunking ───────────────────────────────────────────────────────
function chunkIntoBatches(prompts, size = BATCH_SIZE) {
  const batches = [];
  for (let i = 0; i < prompts.length; i += size) {
    batches.push(prompts.slice(i, i + size));
  }
  return batches;
}

module.exports = {
  groupIntoBeats, buildPrompts, chunkIntoBatches, segmentsFromScript,
  buildCliffhangerLine,
  BEAT_SECONDS, BATCH_SIZE,
  detectMood, detectSceneType, // exported for audioMix.js
};
