const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getMode } = require('./videoModes');
const { runDirectorStack } = require('./directorAgents');
const { normalizeAspectKey } = require('./aspect');

const GROK_BIN = process.env.GROK_BIN || 'grok';
const GROK_TIMEOUT_MS = parseInt(process.env.GROK_TIMEOUT_MS, 10) || 15 * 60 * 1000;

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
 * Runs the pre-production phase:
 * 1. Generates screenplay.json from script and references.
 * 2. Generates canonical character/location references.
 */
async function runPreProduction(job, jobDir, segments) {
  const refsDir = path.join(jobDir, 'refs');
  fs.mkdirSync(refsDir, { recursive: true });

  const screenplayPath = path.join(jobDir, 'screenplay.json');

  const mode = getMode(job.videoType);
  const aspectRatio = normalizeAspectKey(job.resolution || mode.defaultAspect);

  let screenplay;
  if (fs.existsSync(screenplayPath)) {
    try {
      screenplay = JSON.parse(fs.readFileSync(screenplayPath, 'utf8'));
      process.stdout.write(`[preproduction] Loaded existing screenplay.json\n`);
      return screenplay;
    } catch (e) {
      process.stdout.write(`[preproduction] Error reading existing screenplay.json: ${e.message}\n`);
    }
  }

  // 1. Generate Screenplay JSON
  process.stdout.write(
    `[preproduction] Generating screenplay.json (mode=${mode.id}, aspect=${aspectRatio}, beats=${(segments || []).length})...\n`
  );
  process.stdout.write(`[preproduction] Spawning Grok CLI for screenplay (this can take several minutes)…\n`);
  
  const charBlock = (job.characters || []).map(c => `- ${c.name} (${c.gender || 'unspecified'})`).join('\n');
  const styleBlock = job.sceneStyle ? `User Style Guide: ${job.sceneStyle}` : '';
  const segmentList = (segments || []).map((s, idx) => `Beat ${idx}: "${s.text}"`).join('\n');
  const lastSeg = Array.isArray(segments) && segments.length ? segments[segments.length - 1] : null;
  const expectsPart2 = !!(job.expectsPart2 || (lastSeg && (lastSeg.cliffhanger || lastSeg.expectsPart2)));
  const targetMin = job.targetMinutes || job.customOptions?.targetMinutes || null;
  const partNum = job.partNumber || job.customOptions?.partNumber || 1;
  const runtimeNote = targetMin
    ? `\nRUNTIME: This episode is EXACTLY ${targetMin} minute(s) — Part ${partNum}. ` +
      (expectsPart2
        ? `The FINAL beat is a SHOCKING cliffhanger for Part ${Number(partNum) + 1}. Stage it as a freeze-frame reveal (door opens, identity twist, betrayal, life-or-death). Do NOT resolve the full story. Mark high emotionalIntensity on the last beat.`
        : `Fit a complete, satisfying arc into this runtime without rushing past emotional beats.`)
    : '';

  const prompt = `
You are an expert AI Movie Producer working in "${mode.label}" mode. Analyze the following sequence of narration beats (synced to real audio segments) and enrich them into a structured, acting-first screenplay.

MODE DIRECTION: ${mode.promptEmphasis}
${runtimeNote}

NARRATION BEATS:
${segmentList}

USER CHARACTER REQUESTS:
${charBlock}

USER STYLE REQUESTS:
${styleBlock}

OUTPUT JSON ONLY matching this schema exactly:
{
  "productionBible": {
    "style": {
      "medium": "Describe the aesthetic/medium based on user requests (e.g. 'Stylized 3D CGI', 'Hand-drawn anime', 'Photorealistic live-action')",
      "aestheticDetails": "Details about color palettes, line art, shading, etc.",
      "styleClassification": "One line summary of the style"
    },
    "camera": {
      "aspectRatio": "${aspectRatio}",
      "lensLanguage": "e.g., anamorphic, wide-angle",
      "colorGrade": "e.g., warm amber, cool teal",
      "rhythmRules": "e.g., slow pacing, quick cuts"
    },
    "characters": {
      "CharacterName": {
        "description": "Visual description (face, age, hair, eyes)",
        "canonicalRefPaths": [],
        "outfitHistory": [ { "fromScene": 1, "toScene": null, "outfit": "Describe outfit" } ],
        "injuryHistory": []
      }
    },
    "locations": {
      "LocationName": {
        "description": "Visual description of location",
        "canonicalRefPaths": []
      }
    }
  },
  "scenes": [
    {
      "sceneId": 1,
      "location": "LocationName",
      "timeOfDay": "e.g., Late afternoon",
      "weather": "e.g., Overcast",
      "beats": [
        {
          "beatIndex": 0,
          "narration": "The exact text of Beat 0",
          "charactersPresent": ["CharacterName"],
          "characterStates": {
            "CharacterName": { "emotion": "pensive", "activity": "reading", "outfitOverride": null }
          },
          "performance": {
            "CharacterName": {
              "emotion": ["list of emotions"],
              "facialExpression": ["tears forming", "trembling lips"],
              "bodyLanguage": ["hands trembling", "steps back slowly"],
              "eyeDirection": "looking directly at the other character",
              "voicePerformance": "soft broken voice",
              "interaction": "how this character reacts to the others"
            }
          },
          "dialogue": [
            { "speaker": "CharacterName", "line": "spoken words", "performance": ["voice shaking"], "listenerReaction": "the other lowers their head", "emotionTransition": "calm -> anger" }
          ],
          "shotType": "e.g., Medium close-up",
          "cameraMovement": "e.g., Slow push-in",
          "lighting": "lighting that matches the emotion",
          "sfx": ["sound_tag_1"],
          "music": "music_tag",
          "emotionalIntensity": 0.0,
          "emergentDetails": null
        }
      ]
    }
  ]
}

- Populate "performance" for every present character with VISIBLE acting (face, body, eyes, voice, interaction), not just a single emotion word. "characterStates" is kept for backward compatibility; still fill it, but "performance" is the priority.
- For dialogue-driven moments, fill "dialogue" with speaker, delivery performance, and listener reaction so a viewer understands the exchange with the sound off.
- For high-intensity conflict, emotion, or action (quarreling, arguing, crying, fighting, betrayal), specify strong, explicit performance and use close-ups / OTS framing. Make it feel like a high-end acted movie or drama, never a dry documentary.
- Estimate "emotionalIntensity" (0..1) for each beat.
- You MUST maintain the exact order and quantity of the NARRATION BEATS. The total beats array across all scenes must map 1-to-1 sequentially to the NARRATION BEATS list.
- Each beat's "beatIndex" must match the index from the list (0, 1, 2, ...) and its "narration" must match the corresponding beat text exactly.
- Do not output anything outside the JSON structure.
  `.trim();

  // Attach character reference images to the prompt text
  let attachments = '';
  if (job.characters) {
    for (const c of job.characters) {
      if (typeof c.imagePath === 'string' && c.imagePath.trim() && fs.existsSync(c.imagePath)) {
        attachments += `\nCharacter reference image for "${c.name}": @${path.resolve(c.imagePath)}`;
      }
    }
  }

  // Attach style reference images to the prompt text
  if (job.styleReferencePaths) {
    for (const p of job.styleReferencePaths) {
      if (typeof p === 'string' && p.trim() && fs.existsSync(p)) {
        attachments += `\nStyle reference image: @${path.resolve(p)}`;
      }
    }
  }

  const fullPrompt = attachments ? `${prompt}\n\n=== REFERENCE ATTACHMENTS ===${attachments}` : prompt;
  const args = ['-p', fullPrompt, '--always-approve', '--permission-mode', 'bypassPermissions', '--no-plan', '--max-turns', '15', '--output-format', 'json'];
  
  let resultText = '';
  try {
    const res = await runGrokHeadless(args, jobDir);
    resultText = (typeof res === 'string' ? res : (res.text || JSON.stringify(res))).trim();
    
    // Extract JSON if it's wrapped in markdown
    const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      resultText = jsonMatch[1];
    }
    
    screenplay = JSON.parse(resultText);
    fs.writeFileSync(screenplayPath, JSON.stringify(screenplay, null, 2));
    process.stdout.write(`[preproduction] Screenplay generated successfully.\n`);
  } catch (err) {
    throw new Error(`Failed to generate screenplay.json: ${err.message}\nOutput: ${resultText}`);
  }

  // 1b. Director Agent stack — enrich beats with full acting direction.
  // Only for acting modes (drama / movie / cinematic_trailer / anime). Non-fatal.
  if (mode.directorStack) {
    try {
      await runDirectorStack(screenplay, {
        mode,
        characters: job.characters || [],
        sceneStyle: job.sceneStyle || '',
        custom: job.customOptions || {},
        jobDir,
      });
      process.stdout.write(`[preproduction] Director stack enrichment complete.\n`);
    } catch (e) {
      process.stdout.write(`[preproduction] WARN: director stack failed (using base screenplay): ${e.message}\n`);
    }
  }

  // 2. Generate Canonical References
  process.stdout.write(`[preproduction] Generating canonical references...\n`);
  
  const refTasks = [];
  
  // Generate character refs
  if (screenplay && screenplay.productionBible && screenplay.productionBible.characters) {
    for (const charName of Object.keys(screenplay.productionBible.characters)) {
      const charData = screenplay.productionBible.characters[charName];
      if (!charData) continue;
      if (!charData.canonicalRefPaths) charData.canonicalRefPaths = [];
      const outPath = path.join(refsDir, `char_${charName.toLowerCase().replace(/[^a-z0-9]/g, '')}.png`);
      
      if (!fs.existsSync(outPath)) {
        const charObj = (job.characters || []).find(c => c.name.toLowerCase() === charName.toLowerCase());
        let attachments = '';
        let promptRefText = '';
        if (charObj && typeof charObj.imagePath === 'string' && charObj.imagePath.trim() && fs.existsSync(charObj.imagePath)) {
          attachments = `\nCharacter reference photo: @${path.resolve(charObj.imagePath)}`;
          promptRefText = `based on the attached reference image of ${charName}`;
        }
        
        const refPrompt = `
Generate a canonical character reference sheet using Imagine ${promptRefText} for "${charName}" in the style of: ${screenplay.productionBible.style.styleClassification}.
Description: ${charData.description}
Starting Outfit: ${charData.outfitHistory?.[0]?.outfit || 'Standard outfit'}
Create a neutral pose turnaround or simple portrait.
Copy the generated image to exactly: ${outPath}
End with SAVED_OK.
${attachments}
        `.trim();
        refTasks.push({ name: charName, path: outPath, prompt: refPrompt });
      }
      charData.canonicalRefPaths.push(outPath);
    }
  }

  // Generate location refs
  if (screenplay && screenplay.productionBible && screenplay.productionBible.locations) {
    for (const locName of Object.keys(screenplay.productionBible.locations)) {
      const locData = screenplay.productionBible.locations[locName];
      if (!locData) continue;
      if (!locData.canonicalRefPaths) locData.canonicalRefPaths = [];
      const outPath = path.join(refsDir, `loc_${locName.toLowerCase().replace(/[^a-z0-9]/g, '')}.png`);
      
      if (!fs.existsSync(outPath)) {
        let attachments = '';
        let promptRefText = '';
        if (job.styleReferencePaths && job.styleReferencePaths.length > 0) {
          for (const p of job.styleReferencePaths) {
            if (typeof p === 'string' && p.trim() && fs.existsSync(p)) {
              attachments += `\nStyle reference photo: @${path.resolve(p)}`;
            }
          }
          if (attachments) promptRefText = `based on the attached style reference images`;
        }
        
        const refPrompt = `
Generate a canonical location reference using Imagine ${promptRefText} for "${locName}" in the style of: ${screenplay.productionBible.style.styleClassification}.
Description: ${locData.description}
Create a wide establishing shot without characters.
Copy the generated image to exactly: ${outPath}
End with SAVED_OK.
${attachments}
        `.trim();
        refTasks.push({ name: locName, path: outPath, prompt: refPrompt });
      }
      locData.canonicalRefPaths.push(outPath);
    }
  }

  // Execute ref tasks sequentially (or batched)
  for (const task of refTasks) {
    process.stdout.write(`[preproduction] Generating ref for ${task.name}...\n`);
    const taskArgs = [
      '-p', task.prompt,
      '--always-approve', '--permission-mode', 'bypassPermissions', '--no-plan', '--max-turns', '10', '--output-format', 'json'
    ];
    try {
      await runGrokHeadless(taskArgs, jobDir);
    } catch (e) {
      process.stdout.write(`[preproduction] WARN: Failed to generate ref for ${task.name}: ${e.message}\n`);
    }
  }

  // Save updated screenplay with ref paths
  fs.writeFileSync(screenplayPath, JSON.stringify(screenplay, null, 2));
  
  return screenplay;
}

module.exports = { runPreProduction };
