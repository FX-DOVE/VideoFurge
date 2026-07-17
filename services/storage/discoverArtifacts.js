// Discover every durable job artifact that should go to Google Drive.
// Includes: finals, clips, frames, transcript, captions, audio, screenplay, zip, refs.

'use strict';

const fs = require('fs');
const path = require('path');
const { getAssetDef, stitchAssetKeys, editAssetKeys } = require('./assetMap');

const MIN_BYTES_DEFAULT = 32;

function safeStat(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < MIN_BYTES_DEFAULT) return null;
    return st;
  } catch (_) {
    return null;
  }
}

/**
 * @returns {Array<{ assetKey: string, localPath: string, filename: string, driveSubdir: string|null, mimeHint: string|null, kind: string }>}
 */
function discoverJobArtifacts(jobDirPath, { stage = 'stitch' } = {}) {
  const out = [];
  const seen = new Set();

  const add = (assetKey, localPath, opts = {}) => {
    if (!assetKey || !localPath || seen.has(assetKey)) return;
    const st = safeStat(localPath);
    if (!st) return;
    seen.add(assetKey);
    out.push({
      assetKey,
      localPath,
      filename: opts.filename || path.basename(localPath),
      originalFilename: opts.originalFilename || path.basename(localPath),
      driveSubdir: opts.driveSubdir || null,
      mimeHint: opts.mimeHint || null,
      kind: opts.kind || 'file',
      size: st.size,
    });
  };

  // --- Primary deliverables (ASSET_DEFS) ---
  const keys = stage === 'edit' ? editAssetKeys() : stitchAssetKeys();
  // Always also try edited if present after stitch
  const allPrimary = stage === 'edit'
    ? editAssetKeys()
    : [...new Set([...stitchAssetKeys(), 'edited'])];

  for (const key of allPrimary) {
    const def = getAssetDef(key);
    if (!def) continue;
    const lp = path.join(jobDirPath, ...def.localRelative);
    add(key, lp, {
      filename: def.filename,
      originalFilename: def.originalFilename,
      mimeHint: def.mimeType,
      kind: def.isVideo ? 'video' : 'package',
    });
  }

  // --- Per-clip videos ---
  const clipsDir = path.join(jobDirPath, 'output', 'videoclips');
  if (fs.existsSync(clipsDir)) {
    for (const name of fs.readdirSync(clipsDir).filter(f => /^clip_\d{4}\.mp4$/i.test(f)).sort()) {
      add(name.replace(/\.mp4$/i, ''), path.join(clipsDir, name), {
        filename: name,
        driveSubdir: 'clips',
        mimeHint: 'video/mp4',
        kind: 'video',
      });
    }
  }

  // --- Frame images ---
  const imagesDir = path.join(jobDirPath, 'output', 'images');
  if (fs.existsSync(imagesDir)) {
    for (const name of fs.readdirSync(imagesDir).filter(f => /^frame_\d{4}\.(png|jpe?g)$/i.test(f)).sort()) {
      const key = name.replace(/\.(png|jpe?g)$/i, '');
      const ext = path.extname(name).toLowerCase();
      add(key, path.join(imagesDir, name), {
        filename: name,
        driveSubdir: 'images',
        mimeHint: ext === '.png' ? 'image/png' : 'image/jpeg',
        kind: 'image',
      });
    }
  }

  // --- Transcript & captions ---
  add('transcript_json', path.join(jobDirPath, 'output', 'transcript.json'), {
    filename: 'transcript.json',
    driveSubdir: 'docs',
    mimeHint: 'application/json',
    kind: 'transcript',
  });
  // Sometimes transcript is at job root
  add('transcript_json_root', path.join(jobDirPath, 'transcript.json'), {
    filename: 'transcript.json',
    driveSubdir: 'docs',
    mimeHint: 'application/json',
    kind: 'transcript',
  });
  add('captions_ass', path.join(jobDirPath, 'output', 'captions.ass'), {
    filename: 'captions.ass',
    driveSubdir: 'docs',
    mimeHint: 'text/plain',
    kind: 'captions',
  });

  // --- Audio stems ---
  const audioFiles = [
    ['final_audio', 'final_audio.aac', 'audio/aac'],
    ['acted_audio', 'acted_audio.aac', 'audio/aac'],
    ['bgm_composed', 'bgm_composed.aac', 'audio/aac'],
    ['bgm_composed_acted', 'bgm_composed_acted.aac', 'audio/aac'],
    ['sfx_composed', 'sfx_composed.aac', 'audio/aac'],
    ['sfx_composed_acted', 'sfx_composed_acted.aac', 'audio/aac'],
  ];
  for (const [key, name, mime] of audioFiles) {
    add(key, path.join(jobDirPath, 'output', name), {
      filename: name,
      driveSubdir: 'audio',
      mimeHint: mime,
      kind: 'audio',
    });
  }

  // --- Docs / production JSON ---
  add('screenplay', path.join(jobDirPath, 'screenplay.json'), {
    filename: 'screenplay.json',
    driveSubdir: 'docs',
    mimeHint: 'application/json',
    kind: 'doc',
  });
  add('edit_timeline', path.join(jobDirPath, 'output', 'edit_timeline.json'), {
    filename: 'edit_timeline.json',
    driveSubdir: 'docs',
    mimeHint: 'application/json',
    kind: 'doc',
  });

  // --- Character / location refs ---
  const refsDir = path.join(jobDirPath, 'refs');
  if (fs.existsSync(refsDir)) {
    for (const name of fs.readdirSync(refsDir).filter(f => /\.(png|jpe?g|webp)$/i.test(f))) {
      const key = `ref_${name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const ext = path.extname(name).toLowerCase();
      add(key, path.join(refsDir, name), {
        filename: name,
        driveSubdir: 'refs',
        mimeHint: ext === '.png' ? 'image/png' : 'image/jpeg',
        kind: 'ref',
      });
    }
  }

  // Dedupe transcript: prefer output/ over root
  const hasOutTranscript = out.some(a => a.assetKey === 'transcript_json');
  if (hasOutTranscript) {
    return out.filter(a => a.assetKey !== 'transcript_json_root');
  }
  // rename root key for consistency
  return out.map(a => (
    a.assetKey === 'transcript_json_root'
      ? { ...a, assetKey: 'transcript_json' }
      : a
  ));
}

module.exports = {
  discoverJobArtifacts,
};
