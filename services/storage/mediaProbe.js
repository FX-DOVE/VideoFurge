// Probe local media with ffprobe (same approach as stitch/editor). Streams only.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function runFfprobe(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = execFile('ffprobe', args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr && String(stderr).slice(0, 400)) || err.message;
        return reject(new Error(`ffprobe failed: ${msg}`));
      }
      resolve(String(stdout || ''));
    });
    proc.on('error', reject);
  });
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.zip': 'application/zip',
    '.aac': 'audio/aac',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * @returns {Promise<{ size: number, mimeType: string, duration: number|null, width: number|null, height: number|null }>}
 */
async function probeLocalFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`probe: file not found: ${filePath}`);
  }
  const st = fs.statSync(filePath);
  const size = st.size;
  const mimeType = guessMime(filePath);

  if (mimeType === 'application/zip' || !mimeType.startsWith('video/')) {
    return { size, mimeType, duration: null, width: null, height: null };
  }

  try {
    const out = await runFfprobe([
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      filePath,
    ]);
    const json = JSON.parse(out || '{}');
    const stream = Array.isArray(json.streams) && json.streams[0] ? json.streams[0] : {};
    const duration = json.format && json.format.duration != null
      ? parseFloat(json.format.duration)
      : null;
    return {
      size,
      mimeType,
      duration: Number.isFinite(duration) ? duration : null,
      width: stream.width != null ? Number(stream.width) : null,
      height: stream.height != null ? Number(stream.height) : null,
    };
  } catch (_) {
    // Non-fatal: still return size + mime
    return { size, mimeType, duration: null, width: null, height: null };
  }
}

module.exports = { probeLocalFile, guessMime };
