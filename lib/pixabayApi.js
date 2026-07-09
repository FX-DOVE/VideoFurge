// Optional Pixabay API client for searching and downloading copyright-free
// background music and SFX when the local library doesn't have a match.
//
// Requires: PIXABAY_API_KEY=your_key in .env
// Free key: https://pixabay.com/api/  (account registration, instant)
//
// Downloaded files are cached in cache/audio/bgm/ and cache/audio/sfx/
// so the same search never downloads twice across jobs.
//
// Without a key: all functions return null/[] immediately — the pipeline
// falls back to the local music/ and sfx/ library seamlessly.

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const API_KEY   = process.env.PIXABAY_API_KEY || '';
const CACHE_DIR = process.env.AUDIO_CACHE_DIR || path.resolve('./cache/audio');

function ensureCache() {
  ['bgm', 'sfx'].forEach(sub =>
    fs.mkdirSync(path.join(CACHE_DIR, sub), { recursive: true })
  );
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────
function getJson(reqUrl) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(reqUrl);
    const client  = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      headers:  { 'User-Agent': 'GrokVideoPipeline/1.0' },
    };
    client.get(options, res => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse error: ${raw.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function downloadFile(fileUrl, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) return resolve(dest);
    if (redirects <= 0) return reject(new Error('Too many redirects'));
    const parsed  = new url.URL(fileUrl);
    const client  = parsed.protocol === 'https:' ? https : http;
    const req = client.get(fileUrl, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return downloadFile(res.headers.location, dest, redirects - 1)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const tmp = dest + '.tmp';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => {
        out.close();
        fs.renameSync(tmp, dest);
        resolve(dest);
      });
      out.on('error', err => { fs.unlink(tmp, () => {}); reject(err); });
    });
    req.on('error', reject);
  });
}

// ─── Pixabay search ───────────────────────────────────────────────────────

/**
 * Search Pixabay for background music matching a query.
 * @returns {Array<{title,audioUrl,duration}>}  Empty if no key or no results
 */
async function searchMusic(query, limit = 5) {
  if (!API_KEY) return [];
  const endpoint = `https://pixabay.com/api/videos/music/?key=${API_KEY}&q=${encodeURIComponent(query)}&per_page=${limit}`;
  try {
    const data = await getJson(endpoint);
    return (data.hits || [])
      .filter(h => h.audio)
      .map(h => ({ title: h.tags || query, audioUrl: h.audio, duration: h.duration || 0 }));
  } catch (e) {
    process.stdout.write(`[pixabayApi] music search failed (${query}): ${e.message}\n`);
    return [];
  }
}

/**
 * Search Pixabay for sound effects matching a query.
 */
async function searchSFX(query, limit = 5) {
  return searchMusic(`${query} sound effect`, limit);
}

// ─── Download + cache ─────────────────────────────────────────────────────

/**
 * Download a Pixabay audio URL and cache it locally.
 * @param {string} audioUrl  Direct audio URL from Pixabay
 * @param {'bgm'|'sfx'} type
 * @returns {string|null}    Local cached file path, or null on failure
 */
async function downloadAndCache(audioUrl, type = 'bgm') {
  ensureCache();
  const ext  = path.extname(new url.URL(audioUrl).pathname) || '.mp3';
  const hash = Buffer.from(audioUrl).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 48);
  const dest = path.join(CACHE_DIR, type, `${hash}${ext}`);
  try {
    return await downloadFile(audioUrl, dest);
  } catch (e) {
    process.stdout.write(`[pixabayApi] download failed: ${e.message}\n`);
    return null;
  }
}

/**
 * High-level: search Pixabay for query, download the best result, return local path.
 * Returns null if no API key, no results, or download fails.
 */
async function fetchBestMatch(query, type = 'bgm') {
  if (!API_KEY) return null;
  const results = type === 'sfx' ? await searchSFX(query) : await searchMusic(query);
  if (!results.length) return null;
  const best = results[0];
  if (!best.audioUrl) return null;
  process.stdout.write(`[pixabayApi] downloading: "${best.title}" for query "${query}"\n`);
  return downloadAndCache(best.audioUrl, type);
}

module.exports = { searchMusic, searchSFX, downloadAndCache, fetchBestMatch };
