// Aspect ratio → pixel dimensions helper.
// Shared by stitch.js, editorRender.js, and grokBatch.js so the chosen
// resolution is respected everywhere (previously hardcoded to 1920x1080).
//
// All presets keep the long edge <= 1920 for VPS-friendly encoding speed.

'use strict';

// Canonical aspect presets. Keys are what the frontend/API send.
const ASPECT_PRESETS = {
  '16:9': { w: 1920, h: 1080, label: 'Landscape (YouTube, TV)' },
  '9:16': { w: 1080, h: 1920, label: 'Vertical (Shorts, TikTok, Reels)' },
  '1:1':  { w: 1080, h: 1080, label: 'Square (Instagram feed)' },
  '4:5':  { w: 1080, h: 1350, label: 'Portrait (Instagram feed tall)' },
  '21:9': { w: 1920, h: 823,  label: 'Cinematic ultra-wide' },
  '4:3':  { w: 1440, h: 1080, label: 'Classic TV / retro' },
};

const DEFAULT_ASPECT = '16:9';

/**
 * Resolve an aspect ratio string OR an explicit "WxH" string to { w, h }.
 * Accepts: '16:9', '9:16', '1:1', '4:5', '21:9', '4:3', or '1920x1080'.
 * Falls back to 1920x1080 on anything unrecognised.
 */
function resolveAspect(input) {
  if (!input) return { ...ASPECT_PRESETS[DEFAULT_ASPECT], ratio: DEFAULT_ASPECT };

  const str = String(input).trim().toLowerCase();

  // Explicit WxH (e.g. "1920x1080")
  const wxh = str.match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/);
  if (wxh) {
    const w = parseInt(wxh[1], 10);
    const h = parseInt(wxh[2], 10);
    if (w > 0 && h > 0) return { w, h, ratio: `${w}x${h}` };
  }

  // Preset ratio
  if (ASPECT_PRESETS[str]) {
    return { ...ASPECT_PRESETS[str], ratio: str };
  }

  // "16-9" or "16_9" style
  const norm = str.replace(/[_-]/g, ':');
  if (ASPECT_PRESETS[norm]) {
    return { ...ASPECT_PRESETS[norm], ratio: norm };
  }

  return { ...ASPECT_PRESETS[DEFAULT_ASPECT], ratio: DEFAULT_ASPECT };
}

/** Validate/normalise an aspect ratio key for storing on the job. */
function normalizeAspectKey(input) {
  const str = String(input || '').trim().toLowerCase().replace(/[_-]/g, ':');
  return ASPECT_PRESETS[str] ? str : DEFAULT_ASPECT;
}

/**
 * Build the standard ffmpeg "fit inside + letterbox/pillarbox" filter fragment
 * for a given aspect, e.g. scale=...:force_original_aspect_ratio=decrease,pad=...
 * Returns the filter string WITHOUT a trailing comma.
 */
function ffmpegScalePad(input) {
  const { w, h } = resolveAspect(input);
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
}

module.exports = {
  ASPECT_PRESETS,
  DEFAULT_ASPECT,
  resolveAspect,
  normalizeAspectKey,
  ffmpegScalePad,
};
