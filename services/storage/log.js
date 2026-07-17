// Structured storage logging. No secrets. Works with worker logForJob or stdout.

'use strict';

/**
 * @param {object} opts
 * @param {string} opts.event  e.g. upload.started
 * @param {string} [opts.jobId]
 * @param {object} [opts.fields]
 * @param {function} [opts.appendJobLog]  (jobId, line) => void
 */
function logStorage({ event, jobId, fields = {}, appendJobLog = null }) {
  const safe = { ...fields };
  // Never log credentials
  delete safe.credentials;
  delete safe.credentialsPath;
  delete safe.mongoUri;
  delete safe.private_key;
  delete safe.client_email;

  const payload = {
    ts: new Date().toISOString(),
    event,
    jobId: jobId || undefined,
    ...safe,
  };
  const line = `[storage] ${event}${jobId ? ` job=${jobId}` : ''} ${JSON.stringify(safe)}\n`;
  process.stdout.write(line);
  if (jobId && typeof appendJobLog === 'function') {
    try {
      appendJobLog(jobId, `[${payload.ts}] [${jobId}] ${line.trim()}\n`);
    } catch (_) {}
  }
  return payload;
}

module.exports = { logStorage };
