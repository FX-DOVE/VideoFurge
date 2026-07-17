// Screenplay data-model schemas + a tiny zero-dependency validator.
//
// These describe the RICH acting-first structure that upgrades the pipeline
// from "John is sad" to a real production document. Nothing here throws on the
// hot path — validation is advisory and always returns a normalised object so a
// malformed Grok response degrades gracefully instead of failing a whole job.
//
// Schemas:
//   ActorPerformanceSchema  — per-character acting direction
//   DialogueLineSchema      — one spoken line + its performance + listener reaction
//   CameraDirectionSchema   — shot / movement / framing
//   SceneDirectionSchema    — a full enriched beat
//
// Everything is plain data (no classes) so it serialises straight into job.json.

'use strict';

// ─── Defaults / shapes ──────────────────────────────────────────────────────

function toArray(v) {
  if (Array.isArray(v)) return v.filter(x => x != null && String(x).trim()).map(x => String(x).trim());
  if (v == null || v === '') return [];
  return [String(v).trim()];
}

function str(v, fallback = '') {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

// ActorPerformanceSchema — the core of the acting upgrade.
function normActorPerformance(input) {
  const p = input && typeof input === 'object' ? input : {};
  return {
    emotion: toArray(p.emotion).length ? toArray(p.emotion) : (p.emotion ? [str(p.emotion)] : []),
    facialExpression: toArray(p.facialExpression || p.face),
    bodyLanguage: toArray(p.bodyLanguage || p.body),
    eyeDirection: str(p.eyeDirection || p.eyes),
    voicePerformance: str(p.voicePerformance || p.voice),
    interaction: str(p.interaction),
  };
}

// DialogueLineSchema
function normDialogueLine(input) {
  const d = input && typeof input === 'object' ? input : {};
  return {
    speaker: str(d.speaker),
    line: str(d.line || d.text),
    performance: toArray(d.performance),
    listenerReaction: str(d.listenerReaction || d.reaction),
    emotionTransition: str(d.emotionTransition), // e.g. "calm -> anger"
  };
}

// CameraDirectionSchema
function normCameraDirection(input) {
  const c = input && typeof input === 'object' ? input : {};
  return {
    shotType: str(c.shotType || c.shot, 'medium shot'),
    cameraMovement: str(c.cameraMovement || c.movement, 'gentle drift'),
    framing: str(c.framing),
    lensLanguage: str(c.lensLanguage),
    focus: str(c.focus),
  };
}

// SceneDirectionSchema — a fully enriched beat.
function normSceneDirection(input) {
  const s = input && typeof input === 'object' ? input : {};

  // performance is a map of characterName -> ActorPerformance
  const performance = {};
  if (s.performance && typeof s.performance === 'object') {
    for (const [name, val] of Object.entries(s.performance)) {
      performance[name] = normActorPerformance(val);
    }
  }

  return {
    sceneId: Number.isFinite(s.sceneId) ? s.sceneId : (parseInt(s.sceneId, 10) || 1),
    beatIndex: Number.isFinite(s.beatIndex) ? s.beatIndex : (parseInt(s.beatIndex, 10) || 0),
    location: str(s.location, 'Unknown Location'),
    time: str(s.time || s.timeOfDay, 'Daytime'),
    weather: str(s.weather, 'Clear'),
    narration: str(s.narration),
    charactersPresent: toArray(s.charactersPresent),
    dialogue: Array.isArray(s.dialogue) ? s.dialogue.map(normDialogueLine).filter(d => d.line || d.speaker) : [],
    performance,
    camera: normCameraDirection(s.camera),
    lighting: str(s.lighting),
    sound: {
      sfx: toArray(s.sound && s.sound.sfx ? s.sound.sfx : s.sfx),
      music: str(s.sound && s.sound.music ? s.sound.music : s.music),
      ambience: str(s.sound && s.sound.ambience),
    },
    emotionalIntensity: clamp01(s.emotionalIntensity),
    emergentDetails: s.emergentDetails || null,
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

// ─── Advisory validation (never throws) ──────────────────────────────────────

/**
 * Validate a single beat against SceneDirectionSchema.
 * Returns { ok, warnings[], value } where value is always a normalised beat.
 */
function validateSceneDirection(input) {
  const warnings = [];
  const value = normSceneDirection(input);

  if (!value.narration && value.dialogue.length === 0) {
    warnings.push('beat has no narration and no dialogue');
  }
  if (value.charactersPresent.length === 0 && value.dialogue.length > 0) {
    warnings.push('dialogue present but charactersPresent is empty');
  }
  for (const d of value.dialogue) {
    if (d.line && !d.speaker) warnings.push(`dialogue line "${d.line.slice(0, 24)}..." has no speaker`);
  }

  return { ok: warnings.length === 0, warnings, value };
}

/** Validate an array of beats. Returns normalised beats + collected warnings. */
function validateBeats(beats) {
  const out = [];
  const allWarnings = [];
  const list = Array.isArray(beats) ? beats : [];
  for (let i = 0; i < list.length; i++) {
    const { warnings, value } = validateSceneDirection(list[i]);
    out.push(value);
    for (const w of warnings) allWarnings.push(`beat ${i}: ${w}`);
  }
  return { beats: out, warnings: allWarnings };
}

module.exports = {
  normActorPerformance,
  normDialogueLine,
  normCameraDirection,
  normSceneDirection,
  validateSceneDirection,
  validateBeats,
};
