// Uses whisper.cpp instead of the python openai-whisper package.
// whisper.cpp is a compiled C++ binary with quantized models — it will
// transcribe a 2 hour file on a 4GB VPS without swapping. The python
// package pulls in torch and typically wants 4-8GB just to load the model.
//
// Install once on the VPS:
//   git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp
//   make
//   ./models/download-ggml-model.sh base.en    (or small.en for better accuracy)
//
// A 2 hour file will still take real wall-clock time on a small VPS —
// budget roughly 0.3-0.6x realtime on 2 vCPUs with the base model,
// so ~40-70 minutes of transcription time is realistic. Surface that
// in the job status so the frontend can show honest progress.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WHISPER_BIN = process.env.WHISPER_BIN || '/opt/whisper.cpp/main';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/opt/whisper.cpp/models/ggml-base.en.bin';

function transcribe(mediaPath, outDir) {
  return new Promise((resolve, reject) => {
    // Guard: never call path.resolve(null) — throws TypeError "paths[0] must be of type string"
    if (typeof mediaPath !== 'string' || !mediaPath.trim()) {
      return reject(new Error(
        'transcribe() requires a media file path, but none was provided. ' +
        'Drama/Movie jobs without audio should use script segments instead of Whisper.'
      ));
    }
    if (typeof outDir !== 'string' || !outDir.trim()) {
      return reject(new Error('transcribe() requires a valid outDir'));
    }

    // Resolve paths to absolute to prevent relative CWD issues on Windows
    const binPath = path.resolve(WHISPER_BIN || '/opt/whisper.cpp/main');
    const modelPath = path.resolve(WHISPER_MODEL || '/opt/whisper.cpp/models/ggml-base.en.bin');
    const outBase = path.resolve(path.join(outDir, 'transcript'));
    const absMediaPath = path.resolve(mediaPath);

    const args = [
      '-m', modelPath,
      '-f', absMediaPath,
      '-of', outBase,
      '-oj',       // output JSON with per-segment timestamps
      '-nt',       // no timestamps in stdout text, we use the JSON
      '-ml', '45', // limit segment length for granular timestamps
      '-sow',      // split on words
    ];

    console.log(`[transcribe] Spawning: ${binPath} ${args.join(' ')}`);
    const proc = spawn(binPath, args);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));

    proc.on('close', code => {
      if (code !== 0) {
        const fullOutput = (stdout + '\n' + stderr).trim();
        return reject(new Error(`whisper.cpp exited ${code}: ${fullOutput.slice(-800)}`));
      }
      const jsonPath = `${outBase}.json`;
      if (!fs.existsSync(jsonPath)) return reject(new Error('whisper.cpp did not produce a transcript JSON'));
      const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      // Normalize to [{ startMs, endMs, text }]
      const segments = (raw.transcription || []).map(seg => ({
        startMs: toMs(seg.offsets.from),
        endMs: toMs(seg.offsets.to),
        text: seg.text.trim(),
      }));
      resolve(segments);
    });
    proc.on('error', reject);
  });
}

function toMs(v) {
  return typeof v === 'number' ? v : Number(v);
}

module.exports = { transcribe };
