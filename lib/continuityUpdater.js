const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const GROK_BIN = process.env.GROK_BIN || 'grok';
const GROK_TIMEOUT_MS = parseInt(process.env.GROK_TIMEOUT_MS, 10) || 5 * 60 * 1000;

function runGrokHeadless(args, cwd, timeoutMs = GROK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn(GROK_BIN, args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error('Grok CLI call timed out, killed'));
    }, timeoutMs);

    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      let parsed = null;
      try { parsed = JSON.parse(trimmed); } catch (_) {}
      if (parsed && parsed.type === 'error') {
        return reject(new Error(`Grok error: ${parsed.message || trimmed}`));
      }
      if (code !== 0) {
        const msg = (parsed && parsed.text) ? parsed.text : (stderr || trimmed).slice(-600);
        return reject(new Error(`Grok CLI exited ${code}: ${msg}`));
      }
      resolve(parsed ? parsed : trimmed);
    });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Validates the generated frames in the batch and extracts emergent details
 * (ruined clothes, new injuries) to update the screenplay timelines.
 */
async function updateContinuity(batch, jobDir, screenplay) {
  if (!screenplay || !screenplay.productionBible) return screenplay;

  const imagesDir = path.join(jobDir, 'output', 'images');
  let screenplayModified = false;

  for (const item of batch) {
    const padded = String(item.index).padStart(4, '0');
    const imgPath = path.resolve(path.join(imagesDir, `frame_${padded}.png`));

    if (!fs.existsSync(imgPath)) continue;

    const chars = item.resolvedCharacters || [];
    if (chars.length === 0) continue;

    const charNames = chars.map(c => c.name).join(', ');
    const prompt = `
Analyze this generated movie frame.
The intended narration was: "${item.narration}"
Characters present: ${charNames}

Look closely at the characters. Have any PERMANENT changes occurred to their state that must be remembered for the rest of the movie?
Examples: 
- A character gets a cut on their face.
- A character's shirt gets ripped, burned, or completely soaked in mud/blood.
- A character puts on a new prominent accessory (like a stolen hat or glasses) that they keep.

Do NOT report temporary actions (like "holding a sword" or "smiling"). Only report persistent state changes to OUTFIT or INJURIES.

Output JSON ONLY matching this schema exactly:
{
  "updates": [
    {
      "character": "CharacterName",
      "type": "outfit" | "injury",
      "description": "Describe the new state (e.g. 'Blue shirt is now ripped at the shoulder and covered in mud', 'Deep scratch on left cheek')"
    }
  ]
}
    `.trim();

    const fullPrompt = `${prompt}\n\n[Frame to analyze: @${imgPath}]`;
    const args = [
      '-p', fullPrompt,
      '--always-approve', '--permission-mode', 'bypassPermissions', '--no-plan', '--max-turns', '5', '--output-format', 'json'
    ];

    try {
      process.stdout.write(`[continuity] Analyzing frame ${item.index} for emergent state...\n`);
      const res = await runGrokHeadless(args, jobDir);
      let resultText = (typeof res === 'string' ? res : (res.text || JSON.stringify(res))).trim();
      
      const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) resultText = jsonMatch[1];
      
      const parsed = JSON.parse(resultText);
      if (parsed.updates && Array.isArray(parsed.updates)) {
        for (const update of parsed.updates) {
          const charBible = screenplay.productionBible.characters[update.character];
          if (charBible) {
            // Apply from the *next* scene onwards
            const nextSceneId = (item.sceneId || 1) + 1;
            
            if (update.type === 'outfit' && charBible.outfitHistory) {
              const prev = charBible.outfitHistory.find(h => h.toScene === null);
              if (prev) {
                prev.toScene = nextSceneId - 1;
              }
              charBible.outfitHistory.push({ fromScene: nextSceneId, toScene: null, outfit: update.description });
              screenplayModified = true;
              process.stdout.write(`[continuity] UPDATE: ${update.character} outfit -> ${update.description}\n`);
            } else if (update.type === 'injury' && charBible.injuryHistory) {
              const prev = charBible.injuryHistory.find(h => h.toScene === null);
              if (prev) {
                prev.toScene = nextSceneId - 1;
              }
              charBible.injuryHistory.push({ fromScene: nextSceneId, toScene: null, injury: update.description });
              screenplayModified = true;
              process.stdout.write(`[continuity] UPDATE: ${update.character} injury -> ${update.description}\n`);
            }
          }
        }
      }
    } catch (e) {
      process.stdout.write(`[continuity] WARN: Failed to analyze frame ${item.index}: ${e.message}\n`);
    }
  }

  if (screenplayModified) {
    const screenplayPath = path.join(jobDir, 'screenplay.json');
    fs.writeFileSync(screenplayPath, JSON.stringify(screenplay, null, 2));
    process.stdout.write(`[continuity] Saved updated screenplay.json\n`);
  }

  return screenplay;
}

module.exports = { updateContinuity };
