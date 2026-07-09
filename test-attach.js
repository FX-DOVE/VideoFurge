const { spawn } = require('child_process');
const fs = require('fs');
const prompt = 'Look at the attached file @package.json . In one short sentence describe the project name and main purpose from it.';
const args = ['-p', prompt, '--yolo', '--no-plan', '--max-turns', '5', '--output-format', 'json'];
const proc = spawn('grok', args, { cwd: '.' });
let stdout = '';
proc.stdout.on('data', d => stdout += d.toString());
proc.stderr.on('data', d => process.stderr.write(d.toString()));
proc.on('close', code => {
  console.log('EXIT_CODE:', code);
  try {
    const j = JSON.parse(stdout.trim());
    console.log('ATTACH_SUCCESS (saw package info):', /package|name|pipeline|grok/i.test(j.text || ''));
    console.log('TEXT:', (j.text || '').trim().slice(0, 180));
  } catch (e) {
    console.log('PARSE_FAIL, raw tail:', stdout.slice(-200));
  }
});
