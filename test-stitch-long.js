/**
 * Synthetic long-form stitch test (item 5 verification).
 *
 * Run: npm run test:stitch
 *
 * Creates 720+ tiny distinct frames + matching-length audio, runs the NEW
 * subclip+concat stitch, verifies:
 *   - completes without hitting open-file / filter limits
 *   - final video duration matches audio duration within tolerance
 *
 * Uses scaled-down beatSeconds so wall time is reasonable (~minutes not hours)
 * while proving the 700-frame code path.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { stitch } = require('./lib/stitch');

const TEST_DIR = path.resolve('test-artifacts/long-stitch');
const IMAGES_DIR = path.join(TEST_DIR, 'output', 'images');
const AUDIO_PATH = path.join(TEST_DIR, 'audio.wav');
const NUM_FRAMES = 720; // >700 for 2hr simulation at 10s, here scaled
const BEAT_SECONDS = 0.1; // 720 * 0.1s = 72s total timeline (fast test)
const TOLERANCE_SEC = 0.25;

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('close', c => (c === 0 ? res() : rej(new Error(`${cmd} ${args[0]} failed ${c}: ${err.slice(-300)}`))));
    p.on('error', rej);
  });
}

async function makeFrames() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  // clean any previous
  for (const f of fs.readdirSync(IMAGES_DIR).filter(f => f.endsWith('.png'))) {
    try { fs.unlinkSync(path.join(IMAGES_DIR, f)); } catch (_) {}
  }
  // Generate N tiny pngs via ffmpeg testsrc (no drawtext to avoid fontconfig issues on this env)
  const args = [
    '-f', 'lavfi',
    '-i', 'testsrc=size=128x72:rate=1',
    '-start_number', '0',
    '-frames:v', String(NUM_FRAMES),
    '-y', path.join(IMAGES_DIR, 'frame_%04d.png')
  ];
  console.log('[test:stitch] generating', NUM_FRAMES, 'frames...');
  await run('ffmpeg', args);
  // Verify count
  const files = fs.readdirSync(IMAGES_DIR).filter(f => f.endsWith('.png')).length;
  if (files < NUM_FRAMES) throw new Error('frame gen short: ' + files);
  console.log('[test:stitch] frames ready:', files);
}

async function makeAudio(totalSec) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // 440Hz tone for easy duration, or anullsrc for pure silent
  const args = [
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${totalSec}`,
    '-ac', '1',
    '-ar', '44100',
    '-y', AUDIO_PATH
  ];
  console.log('[test:stitch] generating audio of', totalSec, 'seconds...');
  await run('ffmpeg', args);
}

async function probeDuration(file) {
  // Use ffprobe for precise duration
  return new Promise((res, rej) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file];
    const p = spawn('ffprobe', args);
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', c => {
      if (c !== 0) return rej(new Error('ffprobe failed'));
      const d = parseFloat(out.trim());
      if (!isFinite(d)) return rej(new Error('bad duration'));
      res(d);
    });
    p.on('error', rej);
  });
}

async function main() {
  console.log('[test:stitch] === LONG FORM STITCH VERIFICATION (700+ frames) ===');
  const totalTimeline = NUM_FRAMES * BEAT_SECONDS;
  await makeFrames();
  await makeAudio(totalTimeline);

  const beats = Array.from({ length: NUM_FRAMES }, (_, i) => ({
    startMs: Math.round(i * BEAT_SECONDS * 1000),
    endMs: Math.round((i + 1) * BEAT_SECONDS * 1000),
  }));

  const jobDir = TEST_DIR;
  // Ensure output/images exists as stitch expects
  fs.mkdirSync(path.join(jobDir, 'output', 'images'), { recursive: true });
  // The frames are already in IMAGES_DIR which == output/images for this test dir layout
  // (we set IMAGES_DIR = .../output/images)

  console.log('[test:stitch] running stitch with', beats.length, 'beats...');
  const t0 = Date.now();
  const final = await stitch({ jobDir, beats, audioPath: AUDIO_PATH, beatSeconds: BEAT_SECONDS });
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('[test:stitch] stitch done in', took, 's ->', final);

  const [vidDur, audDur] = await Promise.all([
    probeDuration(final),
    probeDuration(AUDIO_PATH)
  ]);
  console.log('[test:stitch] final video duration:', vidDur.toFixed(3), 's');
  console.log('[test:stitch] audio duration:', audDur.toFixed(3), 's');
  console.log('[test:stitch] diff:', Math.abs(vidDur - audDur).toFixed(3), 's (tol', TOLERANCE_SEC, ')');

  const diff = Math.abs(vidDur - audDur);
  if (diff > TOLERANCE_SEC) {
    throw new Error(`Audio sync FAIL: diff ${diff}s exceeds tolerance`);
  }

  // Also basic sanity: final should exist and be reasonable size
  const sz = fs.statSync(final).size;
  if (sz < 100 * 1024) throw new Error('final mp4 too small');

  console.log('[test:stitch] SUCCESS: 700+ frame stitch completed and durations match within tolerance.');
  console.log('[test:stitch] (Intermediate clips left in', path.join(TEST_DIR, 'output', 'clips'), ')');
}

main().catch(e => {
  console.error('[test:stitch] FAILED:', e.message);
  process.exit(1);
});
