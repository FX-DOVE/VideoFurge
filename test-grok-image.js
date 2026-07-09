/**
 * Integration test: real single-image headless Grok CLI generation end-to-end.
 *
 * Run: npm run test:grok   (or node test-grok-image.js)
 *
 * This confirms:
 * - Correct headless invocation syntax after `grok --help` verification.
 * - Attaching references not needed here (style summary separate).
 * - Image produced via Imagine + saved to caller path.
 * - Exit code handling + file-existence as success signal.
 * - Error path surface (non-zero vs file missing).
 *
 * IMPORTANT: requires GROK_BIN (grok in PATH) authenticated, and will consume
 * one image generation quota / credits. Do not run in CI without allowance.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const GROK_BIN = process.env.GROK_BIN || 'grok';
const OUT_DIR = path.resolve('test-artifacts');
const OUT_FILE = path.join(OUT_DIR, 'integration-frame-0000.png');

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(OUT_FILE)) fs.unlinkSync(OUT_FILE);

  const target = path.resolve(OUT_FILE);
  const prompt =
    'Generate a minimal clean test image using Imagine: a small solid green triangle centered on a light gray background. ' +
    `Copy the generated image file to exactly: ${target}. Stop right after the copy succeeds. ` +
    'End with a line containing exactly SAVED_OK.';

  const args = [
    '-p', prompt,
    '--yolo',
    '--no-plan',
    '--max-turns', '12',
    '--output-format', 'json'
  ];

  console.log('[test:grok] spawning', GROK_BIN, 'for single image gen...');
  console.log('[test:grok] target will be', target);

  const start = Date.now();
  const result = await new Promise((resolve, reject) => {
    const proc = spawn(GROK_BIN, args, { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error('timeout in integration test'));
    }, 4 * 60 * 1000);

    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => {
      clearTimeout(t);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.on('error', reject);
  });

  const dur = ((Date.now() - start) / 1000).toFixed(1);
  console.log('[test:grok] exit:', result.code, 'duration:', dur, 's');

  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch (_) {}

  const fileOk = fs.existsSync(OUT_FILE) && fs.statSync(OUT_FILE).size > 2000;
  console.log('[test:grok] image file present + non-tiny?', fileOk, fileOk ? fs.statSync(OUT_FILE).size : 0);

  if (!fileOk) {
    console.error('[test:grok] FAIL: image not written. stdout tail:', (parsed && parsed.text || result.stdout).slice(-400));
    console.error('stderr tail:', result.stderr.slice(-300));
    process.exit(1);
  }

  // Success even if exit !=0 in rare cases, but prefer 0
  if (result.code !== 0) {
    console.warn('[test:grok] WARN: non-zero exit but file present (tolerated for image side-effect).');
  }

  console.log('[test:grok] SUCCESS: single-image headless generation completed and file written.');
  console.log('[test:grok] saved to', OUT_FILE);
  // leave the artifact for inspection; real runs would clean in CI
}

run().catch(err => {
  console.error('[test:grok] FATAL:', err.message);
  process.exit(1);
});
