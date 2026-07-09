// Runs ONE Grok CLI process per batch of up to 20 beats.
// Each batch session handles the complete pipeline for all its beats:
//   1. Image generation  → output/images/frame_XXXX.png
//   2. Image-to-video    → output/videoclips/clip_XXXX.mp4
// Both steps happen inside the same Grok session, sequentially across beats.
// After all 20 beats are done, the Grok process exits and RAM is freed.
//
// Verified invocation pattern:
// - Headless single-turn: `grok -p "..." --yolo --no-plan --max-turns N --output-format json`
// - All 20 tasks are described in ONE prompt string — Grok processes them in order.
// - Images saved to output/images/, videos saved to output/videoclips/ (folders created beforehand).
// - File existence + size > threshold is the success criterion for each output.
// - Grok's Imagine skill handles: text-to-image, image-to-video, text-to-video, image-to-image.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const GROK_BIN = process.env.GROK_BIN || 'grok';
// Video gen takes longer; budget 15 min per batch of 20 (image+video for each)
const GROK_BATCH_TIMEOUT_MS = parseInt(process.env.GROK_TIMEOUT_MS, 10) || 15 * 60 * 1000;

function buildStylePrompt(referenceImagePaths) {
  // Attach via @ so the CLI feeds them as vision input for style/character analysis.
  const refList = referenceImagePaths
    .map(p => path.resolve(p))
    .map(abs => `@${abs}`)
    .join(' ');
  const text =
    `Look at the attached reference image(s): ${refList}. ` +
    'In 3-4 sentences, describe the visual art style, color palette, and each distinct ' +
    "character's appearance in enough detail that another prompt could recreate them " +
    'consistently without seeing the images again. Output only the description.';
  return ['-p', text, '--yolo', '--no-plan', '--max-turns', '6', '--output-format', 'json'];
}

function runGrokHeadless(args, cwd, timeoutMs = GROK_BATCH_TIMEOUT_MS) {
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
        // Some edge cases (e.g. max-turns) may still produce usable side effects.
        // Caller decides based on expected artifacts (file presence). Still surface.
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

async function getStyleSummary(referenceImagePaths, jobDir) {
  if (!referenceImagePaths || !referenceImagePaths.length) {
    return 'Generic digital illustration style, consistent character designs.';
  }
  const args = buildStylePrompt(referenceImagePaths);
  const out = await runGrokHeadless(args, jobDir, 5 * 60 * 1000);
  const text = (typeof out === 'string' ? out : (out.text || '')).trim();
  return text || 'Consistent illustrated character style from references.';
}

// Runs one batch: a single Grok session handles ALL beats in the batch.
// For each beat, Grok:
//   1. Generates an image and saves it to output/images/frame_XXXX.png
//   2. Animates that image into a video and saves it to output/videoclips/clip_XXXX.mp4
// The images/ and videoclips/ folders are created before Grok is invoked.
// File existence is the success criterion — checked per-item after the session ends.
async function runBatch(batch, styleSummary, batchIndex, jobDir) {
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

  // Build the task list for this batch session.
  // All tasks are described in ONE prompt — Grok processes them in order.
  const taskLines = pending.map((item, i) => {
    const padded  = String(item.index).padStart(4, '0');
    const imgPath = path.resolve(path.join(imagesDir,    `frame_${padded}.png`));
    const clipPath = path.resolve(path.join(videoclipsDir, `clip_${padded}.mp4`));

    // Build cinematic directives from the enriched prompt fields
    const shotLine    = item.shotType  ? `  SHOT TYPE: ${item.shotType} — ${item.shotDesc}` : '';
    const lightLine   = item.lighting  ? `  LIGHTING: ${item.lighting}`   : '';
    const atmosLine   = item.atmosphere ? `  ATMOSPHERE: ${item.atmosphere}` : '';
    const motionLine  = item.cameraMotion ? `  CAMERA MOTION (Step B): ${item.cameraMotion}` : '';
    const moodLine    = item.mood ? `  MOOD: ${item.mood}` : '';

    return (
      `\n--- TASK ${i + 1} of ${pending.length} (beat index ${item.index}) ---\n` +
      `Narration: "${item.narration}"\n\n` +
      `Step A — Generate image:\n` +
      `  Craft a HIGH-RETENTION cinematic image prompt for this narration beat.\n` +
      `  This image must capture maximum visual interest and emotional impact for YouTube viewers.\n` +
      (shotLine   ? `${shotLine}\n` : '') +
      (lightLine  ? `${lightLine}\n` : '') +
      (atmosLine  ? `${atmosLine}\n` : '') +
      (moodLine   ? `${moodLine}\n` : '') +
      `  The scene must depict EXACTLY what the narration describes.\n` +
      `  Use the imagine/image_gen tool to generate the image.\n` +
      `  Save the result to: ${imgPath}\n` +
      `  (Copy-Item only — do not re-encode)\n\n` +
      `Step B — Animate to video:\n` +
      `  Use the animate/video_gen tool on the image you just generated.\n` +
      (motionLine ? `${motionLine}\n` : '') +
      `  Create a smooth, high-quality video clip (~10 seconds) that feels like a professional documentary.\n` +
      `  Save the result to: ${clipPath}\n` +
      `  (Copy-Item only — do not re-encode)\n\n` +
      `When both files are saved, output: TASK_DONE_${item.index}`
    );
  }).join('\n');

  const fullPrompt =
    `You are an expert AI Movie Director and Producer creating HIGH-RETENTION YouTube documentaries.\n` +
    `Your goal: visuals so compelling that viewers watch 60-80% of the video.\n` +
    `Complete ALL ${pending.length} tasks below in order. Do not stop until every task is done.\n\n` +
    `=== Visual Style & Character Reference ===\n` +
    `${styleSummary}\n\n` +
    `=== Full Script Context ===\n` +
    `${pending[0]?.scriptContext || ''}\n\n` +
    `=== CINEMATIC RULES (follow strictly) ===\n` +
    `- Every image must be ultra-detailed, 8K quality, photorealistic or hyper-realistic cinematic render.\n` +
    `- Follow the SHOT TYPE exactly as specified — this creates visual variety essential for retention.\n` +
    `- Apply the specified LIGHTING and ATMOSPHERE to every scene — mood-matched lighting is critical.\n` +
    `- Every scene must depict what is ACTUALLY happening in that beat's narration.\n` +
    `- Characters and locations must stay visually consistent with the style reference above.\n` +
    `- Each video clip must execute the specified CAMERA MOTION smoothly and naturally.\n` +
    `- Add subtle life to each clip: flowing cloth, flickering torchlight, drifting smoke, etc.\n` +
    `- Use Copy-Item (or copy) to save files. NEVER use ffmpeg or image converters.\n` +
    `- After saving both files for a task, output the TASK_DONE_<index> marker, then move to the next.\n` +
    `- After ALL tasks are done, output: ALL_TASKS_DONE\n\n` +
    `=== TASKS ===\n` +
    taskLines;

  // max-turns: ~8 turns per task (image gen + video gen + copy × 2 + verification)
  const maxTurns = Math.max(20, pending.length * 8);

  const args = [
    '-p', fullPrompt,
    '--yolo',
    '--no-plan',
    '--max-turns', String(maxTurns),
    '--output-format', 'json'
  ];

  let resultText = '';
  try {
    const res = await runGrokHeadless(args, jobDir, GROK_BATCH_TIMEOUT_MS);
    resultText = (typeof res === 'string' ? res : (res.text || JSON.stringify(res))).trim();
  } catch (e) {
    // Check how many files were produced even on error (e.g. max-turns hit)
    const imgsDone  = pending.filter(item =>
      fs.existsSync(path.join(imagesDir, `frame_${String(item.index).padStart(4, '0')}.png`))
    ).length;
    const clipsDone = pending.filter(item =>
      fs.existsSync(path.join(videoclipsDir, `clip_${String(item.index).padStart(4, '0')}.mp4`))
    ).length;
    process.stdout.write(
      `[grokBatch] batch ${batchIndex} error (${e.message.slice(0, 120)}) — images: ${imgsDone}/${pending.length}, clips: ${clipsDone}/${pending.length}\n`
    );
    // Re-throw so the caller can retry or mark failed
    throw e;
  }

  // Verify every item in this batch produced both outputs
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
      `\nAgent output tail: ${resultText.slice(-400)}`
    );
  }
}

module.exports = { getStyleSummary, runBatch };
