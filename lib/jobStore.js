// Simple file-based job store. No Redis, no database server —
// on a 4GB VPS every extra daemon is RAM you don't have.
// Each job is one JSON file: jobs/<id>/job.json
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
    status: 'queued', // queued -> transcribing -> building_prompts -> generating -> stitching -> done -> failed
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

// Picks the oldest queued job. The worker calls this in a loop so only
// ONE job (and therefore one Grok CLI process) ever runs at a time.
function nextQueuedJob() {
  if (!fs.existsSync(JOBS_DIR)) return null;
  const ids = fs.readdirSync(JOBS_DIR);
  const queued = ids
    .map(id => readJob(id))
    .filter(j => j && j.status === 'queued')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return queued[0] || null;
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

module.exports = { JOBS_DIR, jobDir, createJob, readJob, updateJob, nextQueuedJob, deleteJob, jobStorageBytes };
