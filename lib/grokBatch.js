// Runs ONE Grok CLI process per batch (small batch size to avoid max-turns).
// Each batch session handles image + video for its beats sequentially.
// A fresh grok process per batch keeps RAM low and allows resume (only pending beats are sent).
//
// Verified invocation pattern:
// - Headless: `grok -p "..." --yolo --no-plan --max-turns N --output-format json`
// - All tasks described in ONE prompt; the agent performs sequential image+video steps using tools.
// - Images saved to output/images/, videos saved to output/videoclips/ (folders created beforehand).
// - File existence + size > threshold is the success criterion for each output.
// - Grok's Imagine skill handles: text-to-image, image-to-video, text-to-video, image-to-image.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const GROK_BIN = process.env.GROK_BIN || 'grok';
// Video gen takes longer; budget ~35 min per batch (image+video for several beats)
const GROK_BATCH_TIMEOUT_MS = parseInt(process.env.GROK_TIMEOUT_MS, 10) || 35 * 60 * 1000;

function buildStylePrompt(referenceImagePaths, characters = [], sceneStyle = '', styleReferencePaths = []) {
  // Attach character images
  const charList = referenceImagePaths
    .map(p => path.resolve(p))
    .map(abs => `@${abs}`)
    .join(' ');

  // Attach additional style / environment references
  const styleList = styleReferencePaths && styleReferencePaths.length
    ? styleReferencePaths.map(p => `@${path.resolve(p)}`).join(' ')
    : '';

  let charBlock = '';
  if (characters && characters.length) {
    charBlock = '\n\nNamed character references:\n' +
      characters.map((c, i) => `- "${c.name}" (${c.gender || 'unspecified'})`).join('\n');
  }

  let styleRefBlock = '';
  if (styleList) {
    styleRefBlock = `\n\nAdditional style, environment, lighting, and scene reference images attached: ${styleList}\nThese can be used for backgrounds, atmosphere, props, and overall aesthetic.`;
  }

  const styleHint = sceneStyle ? `\n\nUser-provided scene style direction: "${sceneStyle}"` : '';

  const text =
    `You are analyzing reference images for a video production.\n` +
    `Character reference images attached: ${charList}${charBlock}${styleRefBlock}${styleHint}\n\n` +
    `Carefully examine ALL attached images using your vision capabilities.\n` +
    `Produce a clear "Visual Bible". Start with a one-line STYLE CLASSIFICATION, then 3-5 sentences.\n\n` +
    `STYLE CLASSIFICATION (first line):\n` +
    `Identify the exact rendering style/medium of the images. Examples:\n` +
    `- Photorealistic live-action photography\n` +
    `- Hyper-realistic 3D CGI render\n` +
    `- Stylized 3D animation\n` +
    `- 2D cel-shaded cartoon / anime\n` +
    `- Hand-drawn 2D illustration\n` +
    `- Pixel art / retro game style\n` +
    `- Simple stick figure / minimal illustration\n` +
    `- Mixed media, etc.\n` +
    `Be precise.\n\n` +
    `Then describe:\n` +
    `- Overall art style, rendering technique, and how to combine character + style references\n` +
    `- For EACH named character: exact appearance details\n` +
    `- What the style references contribute (environment, lighting, props, mood)\n` +
    `- How to keep characters consistent while composing rich scenes from multiple references\n` +
    `Output ONLY the Visual Bible (starting with the STYLE CLASSIFICATION line).`;
  return ['-p', text, '--yolo', '--no-plan', '--max-turns', '8', '--output-format', 'json'];
}

function runGrokHeadless(args, cwd, timeoutMs = GROK_BATCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const logFile = path.join(cwd, 'grok_session.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.write(`\n--- NEW GROK SESSION AT ${new Date().toISOString()} ---\n`);
    logStream.write(`Command: grok ${args.join(' ')}\n\n`);

    const proc = spawn(GROK_BIN, args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      logStream.write(`\nERROR: Grok CLI call timed out after ${timeoutMs}ms, killed\n`);
      logStream.end();
      reject(new Error('Grok CLI call timed out, killed'));
    }, timeoutMs);

    proc.stdout.on('data', d => {
      const s = d.toString();
      stdout += s;
      logStream.write(s);
      process.stdout.write(s); // stream directly to worker console
    });
    proc.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      logStream.write(s);
      process.stderr.write(s);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      logStream.write(`\n--- SESSION CLOSED WITH CODE ${code} ---\n`);
      logStream.end();
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
      logStream.write(`\nPROCESS ERROR: ${err.message}\n`);
      logStream.end();
      reject(err);
    });
  });
}

async function getStyleSummary(referenceImagePaths, jobDir, characters = [], sceneStyle = '', styleReferencePaths = []) {
  const hasAnyRefs = (referenceImagePaths && referenceImagePaths.length) || (styleReferencePaths && styleReferencePaths.length);
  if (!hasAnyRefs) {
    return 'STYLE CLASSIFICATION: Photorealistic cinematic\nOverall art style must match the reference images exactly.';
  }
  const args = buildStylePrompt(referenceImagePaths || [], characters, sceneStyle, styleReferencePaths);
  const out = await runGrokHeadless(args, jobDir, 5 * 60 * 1000);
  const text = (typeof out === 'string' ? out : (out.text || '')).trim();
  return text || 'STYLE CLASSIFICATION: Match the attached reference images exactly.\nUse the exact rendering style, level of realism, and artistic technique visible in the references.';
}

// Runs one batch: a single Grok session handles ALL beats in the batch.
// For each beat, Grok:
//   1. Generates an image and saves it to output/images/frame_XXXX.png
//   2. Animates that image into a video and saves it to output/videoclips/clip_XXXX.mp4
// The images/ and videoclips/ folders are created before Grok is invoked.
// File existence is the success criterion — checked per-item after the session ends.
async function runBatch(batch, styleSummary, batchIndex, jobDir, extra = {}) {
  const { characters = [], sceneStyle = '', styleReferencePaths = [] } = extra;

  const imagesDir   = path.join(jobDir, 'output', 'images');
  const videoclipsDir = path.join(jobDir, 'output', 'videoclips');
  fs.mkdirSync(imagesDir,    { recursive: true });
  fs.mkdirSync(videoclipsDir, { recursive: true });

  // Determine which items in this batch still need work (resume support)
  const pending = batch.filter(item => {
    const imgFile  = path.join(imagesDir,    `frame_${String(item.index).padStart(4, '0')}.png`);
    const clipFile = path.join(videoclipsDir, `clip_${String(item.index).padStart(4, '0')}.mp4`);
    const imgDone  = fs.existsSync(imgFile)  && fs.statSync(imgFile).size  > 1000;
    const clipDone = fs.existsSync(clipFile) && fs.statSync(clipFile).size > 10000;
    return !(imgDone && clipDone); // skip fully-complete items
  });

  if (pending.length === 0) {
    process.stdout.write(`[grokBatch] batch ${batchIndex}: all items already complete, skipping.\n`);
    return;
  }

  // === Build strong Visual Bible header with DIRECT image attachments ===
  // Grok can see and combine multiple references via image-to-image / multi-reference.
  let referenceSection = '';
  let referenceInstructions = '';

  const charLines = [];
  if (characters && characters.length > 0) {
    characters.forEach((c) => {
      if (c.imagePath) {
        const abs = path.resolve(c.imagePath);
        charLines.push(`- Character "${c.name}" (${c.gender || 'unspecified'}): @${abs}`);
      }
    });
  }

  const styleLines = [];
  if (styleReferencePaths && styleReferencePaths.length > 0) {
    styleReferencePaths.forEach((p, i) => {
      const abs = path.resolve(p);
      styleLines.push(`- Style / Environment / Scene ref ${i + 1}: @${abs}`);
    });
  }

  if (charLines.length || styleLines.length) {
    referenceSection = 
      (charLines.length ? `\nCHARACTER REFERENCES (preserve identity exactly):\n${charLines.join('\n')}\n` : '') +
      (styleLines.length ? `\nSTYLE & SCENE REFERENCES (use for composition, background, lighting, props, atmosphere):\n${styleLines.join('\n')}\n` : '');

    referenceInstructions =
      `\nMULTI-IMAGE COMPOSITION RULES (very important):\n` +
      `- For EVERY scene, intelligently combine and reference elements from the attached images above to create the single best image for that specific narration beat.\n` +
      `- You can (and should) blend multiple references: place the correct characters into appropriate environments/lighting from the style refs, or mix visual elements as needed for the story moment.\n` +
      `- Use strong image-to-image / multi-reference / reference-image capabilities on the attached files.\n` +
      `- Character faces, bodies, and clothing must stay perfectly consistent with their dedicated reference photos.\n` +
      `- Style references can be used more flexibly for setting, mood, props, and overall aesthetic.\n` +
      `- The goal is a rich, well-composed scene that perfectly suits the spoken words using the visual language of the provided images.\n`;
  }

  const styleBlock = sceneStyle
    ? `\n=== USER-PROVIDED SCENE STYLE / ART DIRECTION ===\n${sceneStyle}\n`
    : '';

  // Build the task list for this batch session.
  const taskLines = pending.map((item, i) => {
    const padded  = String(item.index).padStart(4, '0');
    const imgPath = path.resolve(path.join(imagesDir,    `frame_${padded}.png`));
    const clipPath = path.resolve(path.join(videoclipsDir, `clip_${padded}.mp4`));

    // N-1 Temporal Grounding Image
    let temporalGrounding = '';
    if (item.index > 0) {
      const prevPadded = String(item.index - 1).padStart(4, '0');
      const prevImgPath = path.resolve(path.join(imagesDir, `frame_${prevPadded}.png`));
      if (fs.existsSync(prevImgPath)) {
        temporalGrounding = `\n[PREVIOUS FRAME (Temporal Grounding): @${prevImgPath}]\nMaintain continuity of the background and lighting with this previous frame.\n`;
      }
    }

    // Dynamic Character Context
    let charContext = '';
    if (item.resolvedCharacters && item.resolvedCharacters.length > 0) {
      charContext = '\nCHARACTER DETAILS FOR THIS BEAT:\n' + item.resolvedCharacters.map(rc => {
        let lines = `- ${rc.name}:\n  Outfit: ${rc.outfit}\n  Injuries/State: ${rc.injuries}\n  Emotion: ${rc.emotion}, Activity: ${rc.activity}`;
        if (rc.canonicalRefPaths && rc.canonicalRefPaths.length > 0) {
          lines += `\n  Canonical Ref: @${path.resolve(rc.canonicalRefPaths[0])}`;
        }
        return lines;
      }).join('\n') + '\n';
    }

    const shotLine    = item.shotType  ? `  SHOT TYPE: ${item.shotType} — ${item.shotDesc}` : '';
    const lightLine   = item.lighting  ? `  LIGHTING: ${item.lighting}`   : '';
    const atmosLine   = item.atmosphere ? `  ATMOSPHERE: ${item.atmosphere}` : '';
    const motionLine  = item.cameraMotion ? `  CAMERA MOTION (Step B): ${item.cameraMotion}` : '';
    const moodLine    = item.mood ? `  MOOD: ${item.mood}` : '';

    const dramaKeywords = ['quarrel', 'fight', 'argue', 'sharp words', 'chaos', 'shout', 'angry', 'scream', 'cry', 'wound', 'cut', 'hurt', 'hit', 'strike', 'chase', 'run', 'door slam', 'tense'];
    const lowerNarration = (item.narration || '').toLowerCase();
    const hasDrama = dramaKeywords.some(kw => lowerNarration.includes(kw));
    
    let dramaBlock = '';
    if (hasDrama) {
      dramaBlock = 
        `  DRAMA & ACTING OVERRIDE (High Intensity Action Detected):\n` +
        `  - This is a key emotional conflict moment (e.g. quarrel, argument, or physical action). DO NOT make it a generic or static pose.\n` +
        `  - Depict the characters performing realistic, highly expressive dramatic acting. They should be gesturing dynamically, shouting, displaying clear emotional expressions (anger, frustration, shock, pain, or tears) in their faces and body language.\n` +
        `  - The composition must look like a shot from a real high-end drama film or cinematic movie, capturing active conflict, tension, and emotional intensity.\n`;
    }

    return (
      `\n--- TASK ${i + 1} of ${pending.length} (beat index ${item.index}) ---\n` +
      `NARRATION (this beat's spoken words — the image + video MUST show exactly this):\n` +
      `"${item.narration}"\n` +
      temporalGrounding +
      charContext +
      `\nStep A — Generate image (combine multiple references via image-to-image):\n` +
      `  Create a frame that VISUALLY ACTS OUT the exact situation, actions, expressions, and relationships described in the narration above.\n` +
      (dramaBlock ? `  ${dramaBlock}\n` : '') +
      `  - Combine and reference the attached character images + style/environment images as needed to make the single best, most suitable image for this specific beat.\n` +
      `  - Match the EXACT visual style and rendering technique of the attached reference photos (see STYLE CLASSIFICATION in the Visual Bible).\n` +
      `  - Place the correct characters (using their refs) into a scene that draws from the style references for background, lighting, mood, or props when helpful.\n` +
      `  - The visuals must be faithful to the spoken words — do not add unrelated actions.\n` +
      (shotLine   ? `${shotLine}\n` : '') +
      (lightLine  ? `${lightLine}\n` : '') +
      (atmosLine  ? `${atmosLine}\n` : '') +
      (moodLine   ? `${moodLine}\n` : '') +
      `  Save the result to: ${imgPath}\n` +
      `  (Copy-Item / copy the generated file only — do not re-encode)\n\n` +
      `Step B — Animate to video:\n` +
      `  Use the animate / video_gen tool on the image you just created.\n` +
      (motionLine ? `${motionLine}\n` : '') +
      `  The resulting ~10s clip must feel like the characters are naturally performing the actions described in the narration, while staying in the exact same visual style as the reference images.\n` +
      (hasDrama ? `  - Since this is a high-drama conflict moment, the animation MUST show realistic physical acting, high character movement, active gesturing, or intense motion rather than subtle drift.\n` : '') +
      `  Save the result to: ${clipPath}\n` +
      `  (Copy-Item only — do not re-encode)\n\n` +
      `When both files for this task are saved, output: TASK_DONE_${item.index}`
    );
  }).join('\n');

  const fullPrompt =
    `You are an expert AI Movie Director and Producer creating HIGH-RETENTION YouTube documentaries.\n` +
    `Your goal: visuals so compelling that viewers watch 60-80% of the video.\n` +
    `Complete ALL ${pending.length} tasks below in order. Do not stop until every task is done.\n\n` +
    `=== VISUAL BIBLE (from reference analysis — Grok vision read the actual images) ===\n` +
    `${styleSummary}\n` +
    styleBlock +
    `\n=== REFERENCE IMAGES LIBRARY (Grok can see all of these) ===\n` +
    (referenceSection || 'No reference images attached for this job.\n') +
    referenceInstructions +
    `\n=== FULL SCRIPT CONTEXT (for overall story understanding) ===\n` +
    `${pending[0]?.scriptContext || ''}\n\n` +
    `=== STRICT RULES — FOLLOW THESE FOR EVERY TASK ===\n` +
    `- The generated image for each beat MUST directly depict the precise actions, emotions, objects, and situation being SPOKEN in that beat's Narration quote.\n` +
    `- "Acting what the voice is saying" is the #1 priority. The viewer should be able to understand the story from the pictures alone.\n` +
    `- For every scene: intelligently combine elements from the attached reference images (characters + style refs) to build the single most suitable image for that exact moment.\n` +
    `- STYLE MATCHING IS MANDATORY: Grok's vision can see the attached reference images. You MUST generate in the EXACT same rendering style, medium, and fidelity as the references (photorealistic / 3D CGI / 2D cartoon / pixel art / hand-drawn / stylized / low-fi / whatever is visible in the photos). The first line of the Visual Bible is the STYLE CLASSIFICATION — obey it. Do not upgrade or downgrade the style.\n` +
    `- The Visual Bible above starts with the STYLE CLASSIFICATION — follow it strictly.\n` +
    `- Follow the SHOT TYPE, LIGHTING, ATMOSPHERE and CAMERA MOTION instructions exactly, but always inside the reference style.\n` +
    `- Maintain perfect character consistency + perfect style consistency across the entire video.\n` +
    `- Add subtle life (breathing, cloth movement, eye direction, micro-expressions) that matches the emotional tone of the narration and the reference style.\n` +
    `- Use Copy-Item (or equivalent) to save files. NEVER run ffmpeg or re-encode inside the agent.\n` +
    `- After finishing both image and video for a task, output TASK_DONE_<index> and continue.\n` +
    `- After ALL tasks in this batch: output ALL_TASKS_DONE\n\n` +
    `=== TASKS ===\n` +
    taskLines;

  // max-turns: budget ~10 turns per task (image_gen + video_gen + reasoning + file ops + markers).
  // We tolerate hitting the cap if the side-effect files were written (agent often finishes the
  // heavy work and only gets cancelled before the final ALL_TASKS_DONE text).
  const maxTurns = Math.max(30, pending.length * 10);

  const args = [
    '-p', fullPrompt,
    '--always-approve',
    '--permission-mode', 'bypassPermissions',
    '--no-plan',
    '--max-turns', String(maxTurns),
    '--output-format', 'json'
  ];

  let resultText = '';
  let grokErr = null;
  try {
    const res = await runGrokHeadless(args, jobDir, GROK_BATCH_TIMEOUT_MS);
    resultText = (typeof res === 'string' ? res : (res.text || JSON.stringify(res))).trim();
  } catch (e) {
    grokErr = e;
    resultText = (resultText || (typeof e.message === 'string' ? e.message : '')).slice(0, 2000);
    const imgsDone  = pending.filter(item =>
      fs.existsSync(path.join(imagesDir, `frame_${String(item.index).padStart(4, '0')}.png`))
    ).length;
    const clipsDone = pending.filter(item =>
      fs.existsSync(path.join(videoclipsDir, `clip_${String(item.index).padStart(4, '0')}.mp4`))
    ).length;
    process.stdout.write(
      `[grokBatch] batch ${batchIndex} Grok error (will verify files) (${e.message.slice(0, 100)}) — images: ${imgsDone}/${pending.length}, clips: ${clipsDone}/${pending.length}\n`
    );
    // fall through to verify — many "max turns reached" cases still produced all artifacts
  }

  // Verify every pending item produced both outputs (this is the real success signal)
  const failures = [];
  for (const item of pending) {
    const padded  = String(item.index).padStart(4, '0');
    const imgFile  = path.join(imagesDir,    `frame_${padded}.png`);
    const clipFile = path.join(videoclipsDir, `clip_${padded}.mp4`);
    const imgOk   = fs.existsSync(imgFile)  && fs.statSync(imgFile).size  > 1000;
    const clipOk  = fs.existsSync(clipFile) && fs.statSync(clipFile).size > 10000;
    if (!imgOk || !clipOk) {
      failures.push(`beat ${item.index}: image=${imgOk}, clip=${clipOk}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Batch ${batchIndex} incomplete — ${failures.length} beat(s) missing outputs:\n` +
      failures.join('\n') +
      (grokErr ? `\nGrok error: ${grokErr.message}` : '') +
      `\nAgent output tail: ${resultText.slice(-400)}`
    );
  }

  if (grokErr) {
    // All files present despite non-zero exit (common with max-turns at the very end)
    process.stdout.write(`[grokBatch] batch ${batchIndex}: all artifacts present despite Grok exit (${grokErr.message.slice(0,80)}). Treating as success.\n`);
  }
}

module.exports = { getStyleSummary, runBatch };
