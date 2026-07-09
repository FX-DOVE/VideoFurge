'use strict';
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { generateAss } = require('./lib/captions');

const JOB_ID  = 'c623fc9b-9a20-43e1-88d7-b905c833559a';
const JOB_DIR = path.resolve('./jobs/' + JOB_ID);

const jobJson      = JSON.parse(fs.readFileSync(path.join(JOB_DIR, 'job.json'), 'utf8'));
const segments     = jobJson.segments;
const audioPath    = jobJson.mediaPath;
const concatVideo  = path.join(JOB_DIR, 'output', 'concat-video.mp4');
const captionsFile = path.join(JOB_DIR, 'output', 'captions.ass');
const outFile      = path.join(JOB_DIR, 'output', 'final.mp4');

console.log(`[captions] Generating ASS from ${segments.length} segments...`);
generateAss(segments, captionsFile);
console.log(`[captions] Written: ${captionsFile}`);

// Escape for ffmpeg filter string: backslashes → forward, C:/ → C\:/
const escapedAss = path.resolve(captionsFile)
  .replace(/\\/g, '/')
  .replace(/^([A-Za-z]):\//, (_, d) => d + '\\:/');

const vfFilter = `ass='${escapedAss}'`;
console.log(`[ffmpeg] filter: ${vfFilter}`);
console.log(`[ffmpeg] burning captions into final.mp4 ...`);

const args = [
  '-i', concatVideo,
  '-i', audioPath,
  '-vf', vfFilter,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  '-map', '0:v:0',
  '-map', '1:a:0',
  '-shortest',
  '-movflags', '+faststart',
  '-y', outFile,
];

const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
proc.on('close', code => {
  if (code !== 0) { console.error(`ffmpeg exited ${code}`); process.exit(code); }
  const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
  console.log(`\n✅ Done! final.mp4 updated (${mb} MB)\n   ${outFile}`);
});
proc.on('error', e => { console.error(e.message); process.exit(1); });
