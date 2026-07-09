// Temporary experiment script to discover/verify Grok CLI headless image gen syntax.
// Run with node test-grok-invoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const outDir = path.resolve('test-artifacts');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'test-simple2.png');
if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

const promptText = 
  'Use your Imagine capability to generate a minimal simple test image: a solid blue square on a black background. ' +
  `After the image is created, copy it to exactly this path: ${outFile} . ` +
  'Stop as soon as the file is at the target location. Output a final message containing exactly the text SAVED_OK followed by the target path.';

const args = [
  '-p', promptText,
  '--yolo',
  '--no-plan',
  '--max-turns', '15',
  '--output-format', 'json'
];

console.log('=== Starting experimental headless Grok image gen (json) ===');
console.log('Target:', outFile);

const proc = spawn('grok', args, { cwd: process.cwd() });

let stdout = '';
let stderr = '';

proc.stdout.on('data', (d) => { stdout += d.toString(); });
proc.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(d); });

proc.on('close', (code) => {
  console.log('\n=== EXIT CODE:', code, '===');
  const exists = fs.existsSync(outFile);
  console.log('Target file exists?', exists);
  if (exists) {
    console.log('File size:', fs.statSync(outFile).size);
  }
  console.log('stdout tail:\n' + stdout.slice(-800));
  if (stderr.trim()) console.log('stderr tail:\n' + stderr.slice(-400));
  // Try parse json
  try {
    const data = JSON.parse(stdout.trim());
    console.log('Parsed response keys:', Object.keys(data));
    if (data.text) console.log('text preview:', data.text.slice(0,200));
  } catch (e) {
    console.log('Not valid json or empty stdout');
  }
  console.log('=== Experiment complete ===');
});

proc.on('error', (err) => { console.error('Spawn err', err); });
