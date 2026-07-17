// Video-type profiles. Turns the pipeline from single-mode ("AI narrated story")
// into a multi-mode engine: documentary / drama / movie / explainer / commercial /
// music_video / cinematic_trailer / anime.
//
// Each profile controls:
//   - directorStack:   run the Screenwriter→Character→Actor→Camera director passes
//   - actingIntensity: baseline acting/performance push (0 = none, 1 = max drama)
//   - captions:        burn karaoke captions into final.mp4 by default
//   - allowScriptGen:  if user gives no script, generate one (title required)
//   - pacing:          hint for beat length / camera rhythm
//   - promptEmphasis:  extra instruction injected into the generation prompt
//   - defaultAspect:   sensible default aspect ratio for that format
//
// Backward compatibility: the default mode is "documentary", which reproduces
// the original behaviour (no director stack, keyword drama, captions on).

'use strict';

const VIDEO_MODES = {
  documentary: {
    id: 'documentary',
    label: 'Documentary',
    description: 'Factual, narration-driven. Cinematic B-roll that illustrates the voiceover. Karaoke captions.',
    directorStack: false,
    actingIntensity: 0.15,
    captions: true,
    allowScriptGen: true,
    dialogueDriven: false,
    mediaRequired: true,
    pacing: 'measured',
    defaultAspect: '16:9',
    promptEmphasis:
      'Authoritative documentary look. Each shot should clearly illustrate the narrated fact. ' +
      'Prioritise clarity, real-world plausibility, and informative composition over theatrical acting.',
  },

  drama: {
    id: 'drama',
    label: 'Drama',
    description: 'Nollywood/soap-style emotional acting. Characters cry, argue, love, betray. Dialogue performance. Understandable without narration.',
    directorStack: true,
    actingIntensity: 0.95,
    captions: false,
    allowScriptGen: true,
    dialogueDriven: true,
    mediaRequired: false,
    // User picks exact runtime; overlong stories end on a Part-2 cliffhanger.
    fixedRuntime: true,
    defaultTargetMinutes: 3,
    pacing: 'emotional',
    defaultAspect: '16:9',
    promptEmphasis:
      'This is an ACTED DRAMA. Characters must visibly perform emotion: facial expressions, body language, ' +
      'eye contact, tears, tension. Dialogue scenes must show the speaker talking and the listener reacting. ' +
      'A viewer must understand who is hurt, angry, in love, or betrayed WITHOUT any narration.',
  },

  movie: {
    id: 'movie',
    label: 'Movie / Film',
    description: 'Full cinematic production. Three-act structure, blocking, coverage, emotional arcs. Script-first.',
    directorStack: true,
    actingIntensity: 0.9,
    captions: false,
    allowScriptGen: true,
    dialogueDriven: true,
    mediaRequired: false,
    fixedRuntime: true,
    defaultTargetMinutes: 5,
    pacing: 'cinematic',
    defaultAspect: '21:9',
    promptEmphasis:
      'Feature-film quality. Use deliberate blocking, shot coverage (wide/OTS/close-up), motivated camera moves, ' +
      'and continuity of performance. Every scene advances character and story through visible acting.',
  },

  explainer: {
    id: 'explainer',
    label: 'Explainer / Tutorial',
    description: 'Clear, friendly teaching video. Clean neutral lighting, focus on the subject/concept.',
    directorStack: false,
    actingIntensity: 0.2,
    captions: true,
    allowScriptGen: true,
    dialogueDriven: false,
    mediaRequired: true,
    pacing: 'brisk',
    defaultAspect: '16:9',
    promptEmphasis:
      'Explainer style. Clean, well-lit, uncluttered compositions that make the concept easy to follow. ' +
      'Friendly, approachable tone. Highlight the key idea of each beat visually.',
  },

  commercial: {
    id: 'commercial',
    label: 'Commercial / Ad',
    description: 'Short, punchy, product-hero visuals. High polish, strong call-to-action energy.',
    directorStack: false,
    actingIntensity: 0.5,
    captions: true,
    allowScriptGen: true,
    dialogueDriven: false,
    mediaRequired: true,
    pacing: 'punchy',
    defaultAspect: '9:16',
    promptEmphasis:
      'Advertising look. Glossy, aspirational, high-contrast hero shots. Every frame should feel premium and ' +
      'make the product/subject desirable. Quick, energetic rhythm.',
  },

  music_video: {
    id: 'music_video',
    label: 'Music Video',
    description: 'Beat-synced, stylised, performance + abstract visuals driven by the music.',
    directorStack: false,
    actingIntensity: 0.7,
    captions: false,
    allowScriptGen: true,
    dialogueDriven: false,
    mediaRequired: true,
    pacing: 'rhythmic',
    defaultAspect: '16:9',
    promptEmphasis:
      'Music-video aesthetic. Bold, stylised, rhythmic visuals that match the energy and mood of the track. ' +
      'Performance shots mixed with evocative imagery. Strong color grading and motion.',
  },

  cinematic_trailer: {
    id: 'cinematic_trailer',
    label: 'Cinematic Trailer',
    description: 'High-tension montage. Epic pacing, dramatic reveals, big emotional beats.',
    directorStack: true,
    actingIntensity: 0.85,
    captions: false,
    allowScriptGen: true,
    dialogueDriven: true,
    mediaRequired: false,
    pacing: 'escalating',
    defaultAspect: '21:9',
    promptEmphasis:
      'Movie-trailer intensity. Escalating tension, dramatic reveals, powerful hero moments and emotional peaks. ' +
      'Large-scale, high-impact cinematography.',
  },

  anime: {
    id: 'anime',
    label: 'Anime / Cartoon',
    description: 'Style-locked animated performance. Expressive, stylised character acting.',
    directorStack: true,
    actingIntensity: 0.9,
    captions: false,
    allowScriptGen: true,
    dialogueDriven: true,
    mediaRequired: false,
    fixedRuntime: true,
    defaultTargetMinutes: 3,
    pacing: 'emotional',
    defaultAspect: '16:9',
    promptEmphasis:
      'Animated (anime/cartoon) performance. Expressive, exaggerated facial expressions and body language typical ' +
      'of the reference art style. Keep the exact drawn/animated look of the character references.',
  },
};

const DEFAULT_MODE = 'documentary';

/** Get a mode profile by id, falling back to the default (documentary). */
function getMode(id) {
  const key = String(id || '').trim().toLowerCase();
  return VIDEO_MODES[key] || VIDEO_MODES[DEFAULT_MODE];
}

/** Normalise a mode id for storing on the job. */
function normalizeModeId(id) {
  const key = String(id || '').trim().toLowerCase();
  return VIDEO_MODES[key] ? key : DEFAULT_MODE;
}

/** List modes for the frontend picker. */
function listModes() {
  return Object.values(VIDEO_MODES).map(m => ({
    id: m.id,
    label: m.label,
    description: m.description,
    dialogueDriven: m.dialogueDriven,
    mediaRequired: m.mediaRequired !== false, // default to required if unset
    fixedRuntime: !!m.fixedRuntime,
    defaultTargetMinutes: m.defaultTargetMinutes || null,
    defaultAspect: m.defaultAspect,
  }));
}

/** Whether this mode must hit an exact user-chosen runtime (minutes). */
function hasFixedRuntime(id) {
  return !!getMode(id).fixedRuntime;
}

/** Whether a media/audio file is mandatory for this mode. */
function isMediaRequired(id) {
  return getMode(id).mediaRequired !== false;
}

module.exports = {
  VIDEO_MODES,
  DEFAULT_MODE,
  getMode,
  normalizeModeId,
  listModes,
  isMediaRequired,
  hasFixedRuntime,
};
