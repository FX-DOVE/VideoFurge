// Generates a CapCut-style word-highlight ASS subtitle file from whisper segments.
//
// Enhanced for engaging documentary style:
//  - Normal karaoke highlighting for spoken words.
//  - Special emphasis styling (larger, thicker border, bold, color) for key words like numbers of years, "DANGER", war, death, etc.
//  - "Impact" big centered bordered text cards (black box + heavy outline) for strong emphasis moments — gives "black screen + border text" effect.
//  - Research-backed: big high-contrast text, timed to narration, thick borders for readability, synced with dramatic SFX.
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

// Emphasis detection for key words that need visual punch (years, danger, etc.)
const EMPHASIS_REGEX = /\b(\d+[\s-]?(year|years|day|days|month|months|century|centuries)|danger|dangerous|deadly|death|die|kill|blood|war|battle|attack|destroy|crisis|emergency|disaster|horrible|terrible|tragic|important|crucial|vital|must|never|always|only|first|last|1000|million|billion|thousand)\b/i;

function isEmphasisWord(word) {
  return EMPHASIS_REGEX.test(word);
}

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
    // Impact style: large centered text with thick border for emphasis moments (black bg feel via heavy outline + box)
    // Big bold bordered text for "black + border text" emphasis on years, danger etc.
    `Style: Impact,${o.fontName},110,&H0000FFFF,&H00000000,&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,3,8,3,5,40,40,80,1`,
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
      .map((w, i) => {
        const kTag = `{\\k${Math.max(Math.round(durations[i] / 10), 1)}}`;
        if (isEmphasisWord(w)) {
          // Emphasis: bigger, bold, thicker border, more prominent color (strong yellow or red-ish for danger)
          const isDanger = /(danger|deadly|death|kill|blood|war|battle|attack|destroy|crisis|emergency|disaster|horrible|terrible|tragic)/i.test(w);
          const color = isDanger ? '&H0000AAFF' : '&H0000FFFF'; // brighter / slightly redder for danger
          return `${kTag}{\\fs72\\bord4\\b1\\c${color}}${w}{\\r}`;
        }
        return `${kTag}${w}`;
      })
      .join(' ');

    lines.push(
      `Dialogue: 0,${msToAss(seg.startMs)},${msToAss(seg.endMs)},Karaoke,,0,0,0,,${kText}`
    );

    // For segments with strong emphasis content, add a big "border text" impact overlay (centered, thick border)
    const emphasisMatches = text.match(EMPHASIS_REGEX);
    if (emphasisMatches && emphasisMatches.length > 0) {
      // Extract the most prominent emphasis phrase (first match or the whole if short)
      const emphasisPhrase = emphasisMatches[0].toUpperCase().slice(0, 40);
      // Show big impact text for ~1.5-2.5 seconds around the middle of the segment or start
      const impactStart = seg.startMs + Math.min(400, Math.floor((seg.endMs - seg.startMs) * 0.2));
      const impactEnd = Math.min(seg.endMs, impactStart + 2200);
      const impactText = `{\\an5\\bord8\\shad3\\b1}${emphasisPhrase}`;
      lines.push(
        `Dialogue: 1,${msToAss(impactStart)},${msToAss(impactEnd)},Impact,,0,0,0,,${impactText}`
      );
    }
  }

  fs.writeFileSync(outputPath, header + '\n' + lines.join('\n') + '\n', 'utf8');
}

module.exports = { generateAss };
