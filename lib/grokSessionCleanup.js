// Maintenance: delete old Grok CLI session folders under ~/.grok/sessions.
// Default retention: 2 days (48 hours). Never deletes ~/.grok itself — only
// expired children of the sessions directory.
//
// Env:
//   GROK_SESSION_RETENTION_DAYS=2
//   GROK_SESSIONS_DIR=/root/.grok/sessions   (optional override)
//   GROK_SESSION_CLEANUP_INTERVAL_MS=21600000  (default 6h)
//   GROK_SESSION_CLEANUP_ENABLED=true

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function envBool(name, defaultValue = true) {
  const v = process.env[name];
  if (v == null || v === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function envNumber(name, defaultValue) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/**
 * Resolve sessions root. Production VPS (root): /root/.grok/sessions
 * Local dev: <homedir>/.grok/sessions
 */
function getSessionsDir() {
  const override = (process.env.GROK_SESSIONS_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.grok', 'sessions');
}

function getRetentionMs() {
  // Prefer days; allow fractional (e.g. 0.5). Minimum 1 hour safety floor when enabled.
  const days = envNumber('GROK_SESSION_RETENTION_DAYS', 2);
  return Math.max(days * MS_PER_DAY, 60 * 60 * 1000);
}

function logCleanup(msg, extra) {
  const line = `[${new Date().toISOString()}] [grokSessionCleanup] ${msg}${
    extra ? ' ' + JSON.stringify(extra) : ''
  }\n`;
  process.stdout.write(line);
}

/**
 * Recursively remove a directory (session folder).
 * Synchronous so we don't leave half-deleted trees mid-job claim.
 */
function rmDirRecursive(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 2 });
}

/**
 * Run one cleanup pass.
 * @returns {{ scanned: number, deleted: number, errors: number, sessionsDir: string, cutoffIso: string }}
 */
function cleanupOldGrokSessions(options = {}) {
  const sessionsDir = options.sessionsDir || getSessionsDir();
  const retentionMs = options.retentionMs != null ? options.retentionMs : getRetentionMs();
  const now = Date.now();
  const cutoff = now - retentionMs;
  const cutoffIso = new Date(cutoff).toISOString();

  const result = {
    scanned: 0,
    deleted: 0,
    errors: 0,
    sessionsDir,
    cutoffIso,
    retentionDays: retentionMs / MS_PER_DAY,
  };

  try {
    if (!fs.existsSync(sessionsDir)) {
      logCleanup('sessions dir missing — skip', { sessionsDir });
      return result;
    }

    // Safety: only operate if path ends with "sessions" (avoid wiping ~/.grok by misconfig)
    const base = path.basename(path.resolve(sessionsDir)).toLowerCase();
    if (base !== 'sessions') {
      logCleanup('refusing to clean — path must be a "sessions" directory', { sessionsDir });
      result.errors += 1;
      return result;
    }

    let entries;
    try {
      entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch (err) {
      logCleanup('failed to read sessions dir', { sessionsDir, error: String(err.message || err) });
      result.errors += 1;
      return result;
    }

    for (const ent of entries) {
      // Only top-level session folders (Grok stores one dir per session)
      if (!ent.isDirectory()) continue;
      // Never delete . or special entries
      if (ent.name === '.' || ent.name === '..') continue;

      const full = path.join(sessionsDir, ent.name);
      result.scanned += 1;

      let mtimeMs;
      try {
        const st = fs.statSync(full);
        mtimeMs = st.mtimeMs;
      } catch (err) {
        result.errors += 1;
        logCleanup('stat failed — skip entry', {
          path: full,
          error: String(err.message || err),
        });
        continue;
      }

      if (!(mtimeMs < cutoff)) {
        continue; // still within retention / possibly active
      }

      const mtimeIso = new Date(mtimeMs).toISOString();
      try {
        rmDirRecursive(full);
        result.deleted += 1;
        logCleanup('deleted expired session', {
          path: full,
          mtime: mtimeIso,
          cutoff: cutoffIso,
          ageHours: Math.round((now - mtimeMs) / (60 * 60 * 1000) * 10) / 10,
        });
      } catch (err) {
        result.errors += 1;
        logCleanup('delete failed — left in place', {
          path: full,
          mtime: mtimeIso,
          error: String(err.message || err),
        });
      }
    }

    logCleanup('pass complete', {
      scanned: result.scanned,
      deleted: result.deleted,
      errors: result.errors,
      retentionDays: result.retentionDays,
      sessionsDir,
    });
  } catch (err) {
    // Never throw out to worker/server
    result.errors += 1;
    logCleanup('unexpected error (non-fatal)', { error: String(err && err.message || err) });
  }

  return result;
}

/**
 * Schedule periodic cleanup. Runs once soon after start, then on interval.
 * Safe to call from multiple workers — overlapping deletes are force-rm ok.
 *
 * @returns {{ stop: function, sessionsDir: string, intervalMs: number } | null}
 */
function startGrokSessionCleanupScheduler(options = {}) {
  if (!envBool('GROK_SESSION_CLEANUP_ENABLED', true)) {
    logCleanup('scheduler disabled via GROK_SESSION_CLEANUP_ENABLED=false');
    return null;
  }

  const intervalMs = options.intervalMs != null
    ? options.intervalMs
    : envNumber('GROK_SESSION_CLEANUP_INTERVAL_MS', 6 * 60 * 60 * 1000); // 6 hours

  const sessionsDir = getSessionsDir();
  logCleanup('scheduler started', {
    sessionsDir,
    retentionDays: getRetentionMs() / MS_PER_DAY,
    intervalMs,
  });

  // Delay first run slightly so worker finishes boot/recovery first
  const initialDelayMs = options.initialDelayMs != null ? options.initialDelayMs : 30 * 1000;
  let stopped = false;
  let timer = null;
  let initialTimer = null;

  const run = () => {
    if (stopped) return;
    try {
      cleanupOldGrokSessions();
    } catch (err) {
      logCleanup('scheduler run swallowed error', { error: String(err && err.message || err) });
    }
  };

  initialTimer = setTimeout(() => {
    run();
    if (stopped) return;
    timer = setInterval(run, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }, initialDelayMs);
  if (initialTimer && typeof initialTimer.unref === 'function') initialTimer.unref();

  return {
    sessionsDir,
    intervalMs,
    stop() {
      stopped = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (timer) clearInterval(timer);
    },
  };
}

module.exports = {
  cleanupOldGrokSessions,
  startGrokSessionCleanupScheduler,
  getSessionsDir,
  getRetentionMs,
};
