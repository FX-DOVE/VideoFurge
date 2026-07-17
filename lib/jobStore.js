// Simple file-based job store. No Redis, no database server —
// on a 4GB VPS every extra daemon is RAM you don't have.
// Each job is one JSON file: jobs/<id>/job.json
//
// Supports multiple workers via claimNextQueuedJob() — a worker claims a
// job by moving status away from 'queued' before processing it.
const fs = require('fs');
const path = require('path');

const JOBS_DIR = path.join(__dirname, '..', 'jobs');

function jobDir(id) {
  return path.join(JOBS_DIR, id);
}

function jobPath(id) {
  return path.join(jobDir(id), 'job.json');
}

function createJob(id, initial) {
  fs.mkdirSync(jobDir(id), { recursive: true });
  const job = {
    id,
    // queued -> processing -> transcribing|building_prompts -> generating -> mixing_audio -> stitching -> done|failed
    status: 'queued',
    createdAt: new Date().toISOString(),
    progress: { batchesDone: 0, batchesTotal: null },
    error: null,
    ...initial,
  };
  fs.writeFileSync(jobPath(id), JSON.stringify(job, null, 2));
  return job;
}

function readJob(id) {
  if (!fs.existsSync(jobPath(id))) return null;
  return JSON.parse(fs.readFileSync(jobPath(id), 'utf8'));
}

function updateJob(id, patch) {
  const job = readJob(id);
  if (!job) throw new Error(`Job ${id} not found`);
  const updated = { ...job, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(jobPath(id), JSON.stringify(updated, null, 2));
  return updated;
}

// Returns the oldest job that is still in 'queued' state (pure read, no claim).
// Use claimNextQueuedJob() from workers to safely take ownership.
function nextQueuedJob() {
  if (!fs.existsSync(JOBS_DIR)) return null;
  const ids = fs.readdirSync(JOBS_DIR);
  const queued = ids
    .map(id => { try { return readJob(id); } catch (_) { return null; } })
    .filter(j => j && j.status === 'queued')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return queued[0] || null;
}

/**
 * Safely claim the next oldest 'queued' job for processing.
 * Uses a claim token (pid + timestamp) so that in a race between workers,
 * only the worker whose token "won" the last write will proceed with the job.
 * Other workers that lost the race will detect it and skip.
 */
function claimNextQueuedJob() {
  if (!fs.existsSync(JOBS_DIR)) return null;

  let ids;
  try {
    ids = fs.readdirSync(JOBS_DIR);
  } catch (_) {
    return null;
  }

  // Collect candidates
  const candidates = [];
  for (const id of ids) {
    let j;
    try { j = readJob(id); } catch (_) { continue; }
    if (j && j.status === 'queued') {
      candidates.push(j);
    }
  }

  // Oldest first
  candidates.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const myClaimToken = `${process.pid}-${Date.now()}`;

  for (const cand of candidates) {
    // Re-read to minimize race window
    let current;
    try { current = readJob(cand.id); } catch (_) { continue; }
    if (current && current.status === 'queued') {
      try {
        // Claim by writing our token
        // Neutral claim status — worker will move to transcribing / building_prompts
        // as appropriate (drama jobs with no media never transcribe).
        updateJob(cand.id, {
          status: 'processing',
          error: null,
          claimedBy: myClaimToken,
          // recovery note is preserved by updateJob spread
        });

        // Verify we won the claim
        const verify = readJob(cand.id);
        if (verify && verify.status === 'processing' && verify.claimedBy === myClaimToken) {
          // We are the owner
          return verify;
        }
        // else: another worker's claim overwrote ours — we lost the race
      } catch (_) {
        continue;
      }
    }
  }

  return null;
}

/**
 * Claim a completed job that has a queued edit re-render.
 * Edit renders are nested under job.editRender so the main pipeline status
 * stays "done" and users can still download previous outputs.
 */
function claimNextEditRenderJob() {
  if (!fs.existsSync(JOBS_DIR)) return null;

  let ids;
  try {
    ids = fs.readdirSync(JOBS_DIR);
  } catch (_) {
    return null;
  }

  const candidates = [];
  for (const id of ids) {
    let j;
    try { j = readJob(id); } catch (_) { continue; }
    if (j && j.status === 'done' && j.editRender && j.editRender.status === 'queued') {
      candidates.push(j);
    }
  }

  candidates.sort((a, b) => {
    const ta = new Date(a.editRender?.queuedAt || a.updatedAt || 0).getTime();
    const tb = new Date(b.editRender?.queuedAt || b.updatedAt || 0).getTime();
    return ta - tb;
  });

  const myClaimToken = `edit-${process.pid}-${Date.now()}`;

  for (const cand of candidates) {
    let current;
    try { current = readJob(cand.id); } catch (_) { continue; }
    if (!current || current.status !== 'done') continue;
    if (!current.editRender || current.editRender.status !== 'queued') continue;

    try {
      updateJob(cand.id, {
        editRender: {
          ...current.editRender,
          status: 'rendering',
          claimedBy: myClaimToken,
          startedAt: new Date().toISOString(),
          error: null,
          progress: {
            ...(current.editRender.progress || { done: 0, total: 0 }),
            phase: 'prepare',
            percent: Math.max(1, Number(current.editRender.progress?.percent) || 1),
          },
        },
      });
      const verify = readJob(cand.id);
      if (
        verify &&
        verify.editRender &&
        verify.editRender.status === 'rendering' &&
        verify.editRender.claimedBy === myClaimToken
      ) {
        return verify;
      }
    } catch (_) {
      continue;
    }
  }

  return null;
}

function deleteJob(id) {
  const dir = jobDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function jobStorageBytes(id) {
  const dir = jobDir(id);
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = p => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

module.exports = {
  JOBS_DIR,
  jobDir,
  createJob,
  readJob,
  updateJob,
  nextQueuedJob,
  claimNextQueuedJob,
  claimNextEditRenderJob,
  deleteJob,
  jobStorageBytes,
};
