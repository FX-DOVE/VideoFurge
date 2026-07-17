// Generates a detailed, ACTED script from a title when the user provides none.
//
// Requirement: "the ai should generate an engaging script, it must make research
// online, learn how others are writing their drama/movie scripts before writing".
//
// Uses the Grok CLI (same headless pattern as the rest of the pipeline) with web
// browsing enabled so it can study real screenplay structure before writing.
//
// Returns a plain narration/dialogue script string. The downstream pipeline
// (transcribe → screenplay → beats) still drives timing from the audio, so this
// script is primarily used when there is no separate script and to steer the
// screenwriter/director stack. Never throws fatally — on failure returns null so
// the caller can fall back to transcript-only behaviour.

'use strict';

const { spawn } = require('child_process');

const GROK_BIN = process.env.GROK_BIN || 'grok';
const GROK_TIMEOUT_MS = parseInt(process.env.GROK_SCRIPT_TIMEOUT_MS, 10) || 10 * 60 * 1000;

function runGrokHeadless(args, cwd, timeoutMs = GROK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn(GROK_BIN, args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error('Grok script-gen timed out'));
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
        return reject(new Error(`Grok script-gen exited ${code}: ${msg}`));
      }
      resolve(parsed ? parsed : trimmed);
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Generate a script from a title.
 * @param {object} opts
 * @param {string} opts.title
 * @param {object} opts.mode        video mode profile (from videoModes.getMode)
 * @param {Array}  opts.characters  [{name, gender}]
 * @param {string} opts.sceneStyle  user art direction
 * @param {object} opts.custom      customOptions (tone, targetMinutes, dialogueLanguage...)
 * @param {string} jobDir
 * @returns {Promise<string|null>}
 */
async function generateScript({ title, mode, characters = [], sceneStyle = '', custom = {} }, jobDir) {
  const modeLabel = mode ? mode.label : 'Video';
  const dialogueDriven = mode ? mode.dialogueDriven : false;
  const fixedRuntime = !!(mode && mode.fixedRuntime);
  const defaultMin = (mode && mode.defaultTargetMinutes) || 3;
  const targetMinutes = clampNum(custom.targetMinutes, 1, 30, defaultMin);
  const partNumber = clampNum(custom.partNumber, 1, 50, 1);
  const tone = str(custom.tone);
  const language = str(custom.dialogueLanguage) || 'English';

  const charBlock = (characters || [])
    .map(c => `- ${c.name} (${c.gender || 'unspecified'})`)
    .join('\n') || '- (no named characters provided; invent a small, consistent cast)';

  const researchLine = dialogueDriven
    ? `First, BROWSE THE WEB to study how professional ${modeLabel.toLowerCase()} / Nollywood / film scripts are actually written today: ` +
      `scene headings (INT./EXT. LOCATION - TIME), action lines, character cues, dialogue formatting, emotional beats, ` +
      `and act structure. Learn current conventions, then apply them.`
    : `First, BROWSE THE WEB to study how engaging ${modeLabel.toLowerCase()} scripts/voiceover narrations are written today, ` +
      `then apply the best current conventions.`;

  const structure = dialogueDriven
    ? `Write it as a proper screenplay:
- Use scene headings: INT./EXT. LOCATION - TIME OF DAY
- Action/description lines in present tense that describe VISIBLE acting (facial expressions, body language, eye direction, movement).
- Character cues in CAPS followed by their dialogue.
- Include parentheticals for delivery, e.g. (voice trembling), (holding back tears), (turning away).
- Show conflict, emotional change, and relationships THROUGH action and dialogue so a viewer understands the story with the sound off.`
    : `Write it as an engaging spoken narration script:
- Short, vivid, well-paced paragraphs meant to be read aloud.
- Each paragraph should map to a clear, filmable visual moment.
- Strong hook in the first lines; satisfying close at the end.`;

  // Fixed-runtime episodic rules (Drama / Movie / Anime)
  const runtimeRules = fixedRuntime
    ? [
        ``,
        `RUNTIME (MANDATORY — the finished video will be EXACTLY ${targetMinutes} minute(s)):`,
        `- Write ONLY what can be performed in ${targetMinutes} minute(s) of screen time. Do NOT write a full feature if it will not fit.`,
        `- This is Part ${partNumber}. Pace like a serialized episode, not a complete novel.`,
        `- If the full story of "${title}" is bigger than ${targetMinutes} minute(s), write ONLY the opening arc that fits, then END on a SHOCKING cliffhanger:`,
        `    * A sudden reveal, betrayal, door opening, identity twist, or life-or-death freeze-frame.`,
        `    * Last lines must make the viewer NEED Part ${partNumber + 1}.`,
        `    * Explicitly end with: TO BE CONTINUED — PART ${partNumber + 1}`,
        `- Do NOT wrap the whole saga up in this part. Leave hunger for the next episode.`,
        `- If the story CAN fully resolve in ${targetMinutes} minute(s), you may give a complete ending (no forced cliffhanger).`,
        `- Aim for roughly ${Math.max(4, Math.round(targetMinutes * 4))}–${Math.max(6, Math.round(targetMinutes * 7))} short playable beats.`,
      ].join('\n')
    : [
        ``,
        `Target spoken length: about ${targetMinutes} minute(s).`,
      ].join('\n');

  const prompt = [
    `You are an award-winning ${modeLabel} screenwriter.`,
    `${researchLine}`,
    ``,
    `TASK: Write a detailed, engaging, well-acted ${modeLabel} script titled: "${title}"${fixedRuntime ? ` (Part ${partNumber})` : ''}.`,
    runtimeRules,
    tone ? `Desired tone: ${tone}.` : ``,
    `Language for dialogue/narration: ${language}.`,
    sceneStyle ? `Visual/style direction to respect: ${sceneStyle}.` : ``,
    custom.customPrompt ? `Extra direction from the creator: ${str(custom.customPrompt)}.` : ``,
    ``,
    `CAST:`,
    charBlock,
    ``,
    structure,
    ``,
    `HARD REQUIREMENTS:`,
    `- The story must be understandable purely by WATCHING (visible acting, expressions, blocking), not only by listening.`,
    `- Keep characters and locations consistent throughout.`,
    `- Make it emotionally engaging and coherent for this part.`,
    fixedRuntime
      ? `- Respect the ${targetMinutes}-minute hard runtime. Prefer a ruthless cliffhanger over a rushed full ending when the story is too big.`
      : `- Make it emotionally engaging and coherent from beginning to end.`,
    ``,
    `OUTPUT: Return ONLY the finished script text. No preamble, no explanations, no markdown code fences.`,
  ].filter(Boolean).join('\n');

  const args = [
    '-p', prompt,
    '--always-approve',
    '--permission-mode', 'bypassPermissions',
    '--no-plan',
    '--max-turns', '20',
    '--output-format', 'json',
  ];

  try {
    process.stdout.write(`[scriptGenerator] Researching + writing "${title}" (${modeLabel})...\n`);
    const res = await runGrokHeadless(args, jobDir);
    let text = (typeof res === 'string' ? res : (res.text || '')).trim();
    // Strip accidental code fences
    const fence = text.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
    if (fence) text = fence[1].trim();
    if (!text || text.length < 40) {
      process.stdout.write(`[scriptGenerator] WARN: generated script too short, ignoring.\n`);
      return null;
    }
    process.stdout.write(`[scriptGenerator] Script generated (${text.length} chars).\n`);
    return text;
  } catch (e) {
    process.stdout.write(`[scriptGenerator] WARN: script generation failed: ${e.message}\n`);
    return null;
  }
}

function str(v) { return v == null ? '' : String(v).trim(); }
function clampNum(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

module.exports = { generateScript };
