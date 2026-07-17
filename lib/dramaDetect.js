// Semantic drama / emotional-intensity detection.
//
// Replaces the old pure-keyword lists (which missed things like "Leave me alone").
// We combine several weak signals into a 0..1 intensity score:
//   - conflict lexicon (direct + implied)
//   - emotional-change / relationship lexicon
//   - imperative / confrontational sentence shape ("Leave!", "Get out")
//   - second-person address ("you"/"your") which usually means interpersonal tension
//   - punctuation energy (! and ?) and ALL-CAPS shouting
//   - quoted dialogue (drama tends to be spoken)
//
// The result is a smooth score, so mode profiles can scale it (documentary damps
// it, drama/movie amplify it). A boolean helper is provided for legacy call-sites.

'use strict';

// Strong explicit conflict / emotion words (each adds weight)
const STRONG = [
  'quarrel', 'fight', 'argue', 'argument', 'scream', 'shout', 'yell', 'cry', 'crying', 'tears',
  'betray', 'betrayed', 'cheat', 'divorce', 'hate', 'kill', 'die', 'death', 'blood', 'wound',
  'hurt', 'pain', 'slap', 'hit', 'strike', 'attack', 'threaten', 'revenge', 'curse', 'beg',
  'heartbroken', 'furious', 'rage', 'terrified', 'desperate', 'weep', 'sob', 'grief', 'mourning',
];

// Softer relationship / emotional-change words
const SOFT = [
  'love', 'loved', 'sorry', 'forgive', 'please', 'promise', 'leave', 'goodbye', 'alone',
  'trust', 'lie', 'lied', 'secret', 'afraid', 'scared', 'worried', 'jealous', 'ashamed',
  'confess', 'admit', 'regret', 'miss', 'need', 'want', 'fault', 'blame', 'why', 'never', 'always',
];

// Implied-conflict phrases that keyword scans miss
const PHRASES = [
  'leave me alone', 'get out', 'go away', 'i can\'t', 'i cannot', 'how could you', 'i trusted you',
  'you promised', 'don\'t touch me', 'look at me', 'listen to me', 'i\'m done', 'it\'s over',
  'i hate you', 'i love you', 'why did you', 'you did this', 'stay away', 'let me go',
];

function countHits(text, list) {
  let n = 0;
  for (const w of list) {
    // word-ish boundary match, case-insensitive
    const re = new RegExp(`(^|[^a-z])${escapeRe(w)}([^a-z]|$)`, 'i');
    if (re.test(text)) n++;
  }
  return n;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Score the dramatic/emotional intensity of a piece of text on 0..1.
 * @param {string} text
 * @returns {{ score: number, signals: object }}
 */
function scoreIntensity(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  if (!lower.trim()) return { score: 0, signals: {} };

  const strongHits = countHits(lower, STRONG);
  const softHits = countHits(lower, SOFT);
  const phraseHits = PHRASES.filter(p => lower.includes(p)).length;

  // Second-person interpersonal address
  const youHits = (lower.match(/(^|[^a-z])(you|your|you're|yourself)([^a-z]|$)/g) || []).length;

  // Punctuation / shouting energy
  const bangs = (raw.match(/!/g) || []).length;
  const questions = (raw.match(/\?/g) || []).length;
  const capsWords = (raw.match(/\b[A-Z]{3,}\b/g) || []).length;

  // Quoted dialogue is a strong drama signal
  const hasQuotes = /["“”'']/.test(raw) && /["“”'']\s*[A-Za-z]/.test(raw);

  // Imperative / short confrontational sentence
  const shortImperative = raw.trim().length < 60 && /^[A-Z][a-z]+.*(!|\.)$/.test(raw.trim());

  // Weighted sum → normalise with a soft curve
  let s = 0;
  s += strongHits * 0.30;
  s += phraseHits * 0.50;
  s += softHits * 0.10;
  s += Math.min(youHits, 3) * 0.06;
  s += Math.min(bangs, 3) * 0.10;
  s += Math.min(questions, 2) * 0.05;
  s += Math.min(capsWords, 3) * 0.08;
  s += hasQuotes ? 0.12 : 0;
  s += shortImperative ? 0.10 : 0;

  // saturate to 0..1
  const score = 1 - Math.exp(-s);

  return {
    score: Math.max(0, Math.min(1, score)),
    signals: { strongHits, softHits, phraseHits, youHits, bangs, questions, capsWords, hasQuotes, shortImperative },
  };
}

/**
 * Semantic drama flag. `threshold` defaults to 0.45.
 * `bias` (from a mode's actingIntensity) nudges the effective threshold so
 * drama/movie modes trigger more easily and documentary less easily.
 */
function isDramatic(text, { threshold = 0.45, bias = 0 } = {}) {
  const { score } = scoreIntensity(text);
  const effective = Math.max(0.1, threshold - bias * 0.35);
  return score >= effective;
}

module.exports = { scoreIntensity, isDramatic, STRONG, SOFT, PHRASES };
