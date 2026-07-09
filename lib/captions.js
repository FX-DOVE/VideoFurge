// Generates a CapCut-style word-highlight ASS subtitle file from whisper segments.
//
// How it works:
//  - Each whisper segment becomes one karaoke dialogue line.
//  - The segment's duration is distributed across its words proportionally
//    by character count (longer words get slightly more time). This is Option A —
//    no extra whisper pass needed; upgrade to word-level timestamps later with -owts.
//  - ASS \k karaoke tags make each word highlight (yellow) as it's spoken.
//    Upcoming words in the phrase show as white; spoken words stay yellow.
//  - BorderStyle=3 gives a semi-transparent dark pill behind each line.
//
// ASS color format: &HAABBGGRR  (alpha, blue, green, red)
//   AA: 00=opaque FF=transparent
//   Yellow:            &H0000FFFF  (R=FF G=FF B=00)
//   White:             &H00FFFFFF
//   Black:             &H00000000
//   Semi-transparent:  &HAA000000

'use strict';

const fs = require('fs');

const DEFAULTS = {
  fontName:        'Arial',
  fontSize:        58,
  primaryColour:   '&H0000FFFF',   // Yellow  — spoken / currently highlighted word
  secondaryColour: '&H00FFFFFF',   // White   — upcoming words in the phrase
  outlineColour:   '&H00000000',   // Black   — outline
  backColour:      '&HAA000000',   // Dark semi-transparent background box
  bold:            -1,             // -1 = bold in ASS
  marginV:         55,             // px from bottom edge
};

/**
 * Convert milliseconds to ASS timestamp string H:MM:SS.CC
 */
function msToAss(ms) {
  const totalCs = Math.round(ms / 10);
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const c = totalCs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/**
 * Distribute a segment's total duration across its words proportionally by
 * character weight. Returns an array of per-word durations in milliseconds.
 */
function distributeWordTimings(words, totalMs) {
  // Use stripped character count as weight; minimum 1 so punctuation-only
  // tokens still get a time slot.
  const weights = words.map(w => Math.max(w.replace(/\W/g, '').length, 1));
  const total   = weights.reduce((a, b) => a + b, 0);
  // Ensure durations sum to totalMs exactly by adjusting last word
  const durs = weights.map(w => Math.max(Math.round((w / total) * totalMs), 10));
  const sum  = durs.reduce((a, b) => a + b, 0);
  durs[durs.length - 1] += totalMs - sum; // absorb rounding delta into last word
  return durs;
}

/**
 * Generate a CapCut-style karaoke ASS subtitle file from whisper segments.
 *
 * @param {Array<{startMs:number, endMs:number, text:string}>} segments
 * @param {string} outputPath  Absolute path to write the .ass file
 * @param {Object} [opts]      Optional style overrides (see DEFAULTS above)
 */
function generateAss(segments, outputPath, opts = {}) {
  const o = { ...DEFAULTS, ...opts };

  // ---------- ASS header ----------
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,' +
      ' BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing,' +
      ' Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // BorderStyle=3 → opaque background box (the dark pill)
    // Alignment=2   → bottom-center
    `Style: Karaoke,${o.fontName},${o.fontSize},${o.primaryColour},${o.secondaryColour},` +
      `${o.outlineColour},${o.backColour},${o.bold},0,0,0,100,100,0,0,3,0,0,2,` +
      `40,40,${o.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  // ---------- Dialogue lines ----------
  const lines = [];
  for (const seg of segments) {
    const text = (seg.text || '').trim();
    if (!text) continue;

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const totalMs   = Math.max(seg.endMs - seg.startMs, 100);
    const durations = distributeWordTimings(words, totalMs); // ms per word

    // \k<centiseconds> = karaoke tag; word transitions secondary→primary over that duration
    const kText = words
      .map((w, i) => `{\\k${Math.max(Math.round(durations[i] / 10), 1)}}${w}`)
      .join(' ');

    lines.push(
      `Dialogue: 0,${msToAss(seg.startMs)},${msToAss(seg.endMs)},Karaoke,,0,0,0,,${kText}`
    );
  }

  fs.writeFileSync(outputPath, header + '\n' + lines.join('\n') + '\n', 'utf8');
}

module.exports = { generateAss };
