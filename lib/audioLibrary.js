// Local audio library — scans the music/ and sfx/ folders and provides
// keyword-based matching to select the best BGM track and ambient SFX
// for any given narration beat.
//
// Tag matching: each file has a list of scene/mood keywords. When
// selectBGM() or selectSFX() is called with a narration string, it scores
// each file by how many of its tags appear in the narration, and returns
// the highest-scoring match (fallback: first file in list).
//
// To add new files: just drop them in the music/ or sfx/ folder.
// Add entries to MUSIC_TAGS / SFX_TAGS for best matching, or the system
// will auto-derive basic tags from the filename.

'use strict';

const fs   = require('fs');
const path = require('path');

const MUSIC_DIR = process.env.MUSIC_DIR || path.resolve('./music');
const SFX_DIR   = process.env.SFX_DIR   || path.resolve('./sfx');

// ─── Manual tag maps ──────────────────────────────────────────────────────
// Keys are lowercase filename stems (extension stripped, special chars → _)
const MUSIC_TAGS = {
  '01_sentinel_dramatic_scott_buckley': [
    'dramatic', 'battle', 'intense', 'conflict', 'war', 'tension',
    'confrontation', 'danger', 'enemy', 'siege', 'fight', 'struggle',
  ],
  '02_lifeinmotion_scott_buckley': [
    'uplifting', 'hope', 'journey', 'progress', 'life', 'growth',
    'civilization', 'rise', 'begin', 'new', 'flourish', 'prosper', 'achieve',
  ],
  '03_starfire_scott_buckley': [
    'epic', 'wonder', 'discovery', 'grand', 'exploration', 'triumph',
    'glory', 'legend', 'ancient', 'empire', 'vast', 'great', 'mighty',
  ],
  '04_echoes_scott_buckley': [
    'reflective', 'mysterious', 'atmospheric', 'quiet', 'ancient',
    'memory', 'history', 'origin', 'past', 'myth', 'heritage', 'ancestor',
  ],
};

const SFX_TAGS = {
  'brush_dig': [
    'archaeology', 'dig', 'discovery', 'ancient', 'excavation',
    'research', 'artifact', 'ruin', 'buried', 'uncover',
  ],
  'campfire_crackling': [
    'camp', 'fire', 'ancient', 'shelter', 'warmth', 'night',
    'gathering', 'tribe', 'village',
  ],
  'distant_crowd': [
    'city', 'civilization', 'crowd', 'settlement', 'people', 'urban',
    'market', 'rome', 'forum', 'republic', 'senate', 'colosseum', 'plaza',
    'trade', 'commerce', 'festival',
  ],
  'earthquake_rumble': [
    'disaster', 'battle', 'dramatic', 'destruction', 'catastrophe',
    'tremor', 'collapse', 'fall', 'ruin',
  ],
  'fire_burning': [
    'war', 'fire', 'intense', 'destruction', 'burning', 'conflict',
    'attack', 'siege', 'battle', 'inferno',
  ],
  'fire_larger_flames': [
    'war', 'fire', 'intense', 'destruction', 'inferno', 'siege',
    'conflagration', 'burning', 'devastation',
  ],
  'harbor_gulls': [
    'naval', 'harbor', 'coastal', 'trade', 'sea', 'birds', 'port',
    'dock', 'merchant', 'ship',
  ],
  'sea_waves_seagulls': [
    'ocean', 'sea', 'travel', 'coastal', 'waves', 'sailing', 'voyage',
    'mediterranean', 'naval', 'fleet', 'crossing',
  ],
  'seaside_seagulls_boat': [
    'coastal', 'port', 'boat', 'sea', 'harbor', 'voyage', 'dock',
    'landing', 'arrival',
  ],
  'ship_creaking': [
    'ship', 'nautical', 'voyage', 'ancient', 'navy', 'sea', 'travel',
    'fleet', 'galley', 'crossing', 'expedition',
  ],
  'wind_ambient': [
    'outdoor', 'open', 'vast', 'travel', 'plains', 'landscape', 'nature',
    'wilderness', 'hill', 'valley', 'overland', 'march', 'journey',
  ],
  'writing_stylus': [
    'study', 'document', 'history', 'record', 'scholar', 'manuscript',
    'knowledge', 'research', 'evidence', 'chronicle', 'book', 'inscription',
    'law', 'senate', 'decree', 'tradition', 'heritage',
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function stemOf(filename) {
  return path.basename(filename, path.extname(filename))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function scoreMatch(tags, text) {
  const lower = text.toLowerCase();
  return tags.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
}

function scanDir(dir, tagMap) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f))
    .map(f => {
      const stem = stemOf(f);
      // Use manual tags if available; otherwise auto-derive from filename words
      const tags = tagMap[stem] || stem.split('_').filter(w => w.length > 2);
      return { file: path.join(dir, f), stem, tags };
    });
}

// ─── Cached catalog (scanned once per process) ────────────────────────────
let _catalog = null;

function getCatalog() {
  if (_catalog) return _catalog;
  _catalog = {
    music: scanDir(MUSIC_DIR, MUSIC_TAGS),
    sfx:   scanDir(SFX_DIR,   SFX_TAGS),
  };
  process.stdout.write(
    `[audioLibrary] loaded: ${_catalog.music.length} BGM tracks, ${_catalog.sfx.length} SFX files\n`
  );
  return _catalog;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Select the best matching background music track for a narration text.
 * Falls back to the first track in the library if no keywords match.
 * @returns {string|null} Absolute file path, or null if library is empty
 */
function selectBGM(narrationText) {
  const { music } = getCatalog();
  if (!music.length) return null;
  const scored = music
    .map(m => ({ ...m, score: scoreMatch(m.tags, narrationText) }))
    .sort((a, b) => b.score - a.score);
  return scored[0].file; // even score=0 returns first (safe fallback)
}

/**
 * Select up to `maxCount` ambient SFX files for a narration text.
 * Only returns files with at least one keyword match.
 * @returns {string[]} Array of absolute file paths
 */
function selectSFX(narrationText, maxCount = 2) {
  const { sfx } = getCatalog();
  if (!sfx.length) return [];
  return sfx
    .map(s => ({ ...s, score: scoreMatch(s.tags, narrationText) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCount)
    .map(s => s.file);
}

/**
 * Returns library stats for logging / job.json transparency.
 */
function getLibraryInfo() {
  const { music, sfx } = getCatalog();
  return {
    musicDir:   MUSIC_DIR,
    sfxDir:     SFX_DIR,
    musicFiles: music.map(m => ({ file: path.basename(m.file), tags: m.tags })),
    sfxFiles:   sfx.map(s => ({ file: path.basename(s.file), tags: s.tags })),
  };
}

module.exports = { selectBGM, selectSFX, getLibraryInfo, getCatalog };
