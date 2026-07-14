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

// ─── Prompt builder ────────────────────────────────────────────────────────
function buildPrompts(beats, styleSummary, scriptContext, extra = {}) {
  const { characters = [], sceneStyle = '', styleReferencePaths = [], screenplay = null } = extra || {};

  return beats.map((beat, i) => {
    let mood        = detectMood(beat.text || beat.narration || '');
    let sceneType   = detectSceneType(beat.text || beat.narration || '');
    let shot        = SHOT_TYPES[i % SHOT_TYPES.length];
    let motion      = CAMERA_MOTIONS[i % CAMERA_MOTIONS.length];
    let lighting    = MOOD_LIGHTING[mood];
    let atmosphere  = MOOD_ATMOSPHERE[mood];
    let resolvedCharacters = [];

    if (screenplay) {
      const sceneId = beat.sceneId;
      // Override with screenplay values
      if (beat.shotType) shot = { type: beat.shotType, desc: '' };
      if (beat.cameraMovement) motion = beat.cameraMovement;
      if (beat.timeOfDay || beat.weather) {
        lighting = `Time of Day: ${beat.timeOfDay || 'Unknown'}.`;
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
          
          return {
            name: cName,
            description: charBible.description,
            outfit,
            injuries,
            emotion,
            activity,
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
  groupIntoBeats, buildPrompts, chunkIntoBatches,
  BEAT_SECONDS, BATCH_SIZE,
  detectMood, detectSceneType, // exported for audioMix.js
};
