'use strict';

// =============================================================
// CONSTANTS
// =============================================================
const STATUS_LABELS = {
  queued:           'Queued',
  transcribing:     'Transcribing',
  building_prompts: 'Building Prompts',
  generating:       'Generating',
  mixing_audio:     'Mixing Audio',
  stitching:        'Stitching',
  done:             'Done',
  failed:           'Failed',
};

const STATUS_STEPS = ['queued', 'transcribing', 'building_prompts', 'generating', 'mixing_audio', 'stitching', 'done'];

const STATUS_BADGE_CLASS = {
  queued:           'badge-queued',
  transcribing:     'badge-transcribing',
  building_prompts: 'badge-building',
  generating:       'badge-generating',
  mixing_audio:     'badge-mixing',
  stitching:        'badge-stitching',
  done:             'badge-done',
  failed:           'badge-failed',
};

// =============================================================
// API KEY MANAGEMENT
// NOTE: API key is stored in sessionStorage (browser memory only, cleared when tab closes).
// This is a TEMPORARY auth mechanism; sessionStorage was chosen over localStorage to avoid
// persisting credentials to disk. TODO: Replace with server-side session auth when a proper
// auth system is built into the backend.
// =============================================================
function getApiKey() {
  return sessionStorage.getItem('gvp_api_key') || '';
}
function setApiKey(key) {
  sessionStorage.setItem('gvp_api_key', key.trim());
}
function hasApiKey() {
  return Boolean(getApiKey());
}

// =============================================================
// API CLIENT
// Wraps fetch() to always attach X-API-Key, handle 401 globally.
// =============================================================
async function apiFetch(url, opts = {}) {
  const key = getApiKey();
  const resp = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), 'X-API-Key': key },
  });
  if (resp.status === 401) {
    showApiKeyModal(true); // re-prompt
    throw new Error('Authentication required — please enter your API key.');
  }
  return resp;
}

// Build a URL that includes the API key as a ?k= query param.
// Used for <video src> and <a download> where the browser cannot send custom headers.
// ASSUMPTION: The server's requireAuth() also accepts ?k= as a fallback for these
// browser-native requests. See server.js requireAuth for the corresponding logic.
function mediaUrl(path) {
  return `${path}?k=${encodeURIComponent(getApiKey())}`;
}

// =============================================================
// CONNECTION BANNER (shown on socket disconnect)
// =============================================================
function showBanner(msg) {
  const b = document.getElementById('connection-banner');
  const t = document.getElementById('connection-banner-text');
  if (b) b.classList.remove('hidden');
  if (t) t.textContent = msg;
}
function hideBanner() {
  document.getElementById('connection-banner')?.classList.add('hidden');
}

// =============================================================
// TOAST NOTIFICATIONS
// =============================================================
function showToast(msg, type = 'info', duration = 4500) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  // Animate in on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('toast-visible'));
  });
  setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => el.remove(), 400);
  }, duration);
}

// =============================================================
// MODAL SYSTEM
// =============================================================
function openModal(contentHtml, { onClose } = {}) {
  const overlay = document.getElementById('modal-overlay');
  const box = document.getElementById('modal-box');
  box.innerHTML = contentHtml;
  overlay.classList.remove('hidden');
  // Click-outside closes (unless there's no cancel button, i.e. modal is required)
  overlay.onclick = (e) => {
    if (e.target === overlay && document.getElementById('modal-cancel')) {
      closeModal();
      onClose?.();
    }
  };
}
function closeModal() {
  document.getElementById('modal-overlay')?.classList.add('hidden');
}

// Confirmation dialog (irreversible actions)
function showConfirm(title, message, onConfirm) {
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">${escHtml(title)}</h2>
    </div>
    <div class="modal-body">
      <p>${escHtml(message)}</p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="modal-cancel">Cancel</button>
      <button class="btn btn-danger" id="modal-confirm">Delete</button>
    </div>
  `);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-confirm').onclick = () => { closeModal(); onConfirm(); };
}

// API Key entry/update modal
function showApiKeyModal(required = false) {
  const current = getApiKey();
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">🔑 API Key</h2>
    </div>
    <div class="modal-body">
      <p class="modal-desc">Enter your API key to connect to the pipeline server.
        It is stored in <strong>session memory only</strong> — cleared when you close this tab.</p>
      <div class="form-field">
        <label class="form-label" for="modal-api-key-input">API Key</label>
        <input
          type="password"
          id="modal-api-key-input"
          class="form-input"
          placeholder="enter-your-key-here"
          value="${escAttr(current)}"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    </div>
    <div class="modal-footer">
      ${required ? '' : '<button class="btn btn-ghost" id="modal-cancel">Cancel</button>'}
      <button class="btn btn-primary" id="modal-save-key">Connect</button>
    </div>
  `);
  if (!required) {
    document.getElementById('modal-cancel').onclick = closeModal;
  }
  const saveBtn = document.getElementById('modal-save-key');
  const input = document.getElementById('modal-api-key-input');
  const save = () => {
    const val = input.value.trim();
    if (!val) { showToast('Please enter an API key.', 'error'); return; }
    setApiKey(val);
    closeModal();
    initSocket(); // reconnect with new key
    Router.refresh();
  };
  saveBtn.onclick = save;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  setTimeout(() => input.focus(), 50);
}

// =============================================================
// SOCKET.IO CLIENT
// =============================================================
let socket = null;
let _currentJobSub = null; // jobId currently subscribed to for detail-page updates

function initSocket() {
  const key = getApiKey();
  if (!key) return; // will be initialized when user enters key

  if (socket) {
    socket.off(); // remove all listeners from old instance
    socket.disconnect();
    socket = null;
  }

  socket = io({
    auth: { apiKey: key },
    // socket.io defaults: reconnectionDelay=1000, reconnectionDelayMax=5000, randomizationFactor=0.5
    // Those defaults give exponential backoff with jitter up to ~5s — fine for our use case.
  });

  socket.on('connect', () => {
    hideBanner();
    // Re-subscribe to job detail room after reconnect so we don't miss updates
    if (_currentJobSub) {
      socket.emit('job:subscribe', { jobId: _currentJobSub });
    }
  });

  socket.on('connect_error', (err) => {
    if (/API key required|invalid API key/i.test(err.message)) {
      showApiKeyModal(true);
    } else {
      showBanner(`Socket error: ${err.message} — retrying…`);
    }
  });

  socket.on('disconnect', (reason) => {
    // 'io client disconnect' means we called socket.disconnect() intentionally — not a real error
    if (reason !== 'io client disconnect') {
      showBanner('Connection lost — reconnecting…');
    }
  });

  socket.on('reconnect', () => {
    hideBanner();
    if (_currentJobSub) socket.emit('job:subscribe', { jobId: _currentJobSub });
    // Fetch a fresh HTTP snapshot to fill any gap during the disconnection window
    Router.refresh();
  });

  // Real-time update for the job currently shown in detail view
  socket.on('job:update', (job) => {
    if (job?.id && job.id === _currentJobSub) {
      _applyJobDetailUpdate(job);
    }
  });

  // Real-time update for the jobs list (one job delta — client merges)
  socket.on('jobs:update', (updatedJob) => {
    _mergeJobInList(updatedJob);
  });
}

function _subscribeToJob(jobId) {
  _currentJobSub = jobId;
  if (socket?.connected) socket.emit('job:subscribe', { jobId });
}

function _unsubscribeFromJob() {
  if (_currentJobSub && socket?.connected) {
    socket.emit('job:unsubscribe', { jobId: _currentJobSub });
  }
  _currentJobSub = null;
}

// =============================================================
// ROUTER (hash-based)
// =============================================================
const Router = {
  _current: null,

  navigate(hash) {
    const raw = (hash || '#/').replace(/^#/, '') || '/';
    // Teardown: leave job detail room on navigate-away
    if (this._current?.type === 'detail') _unsubscribeFromJob();
    this._current = null;

    if (raw === '/' || raw === '/jobs') {
      this._current = { type: 'list' };
      _renderJobsList();
    } else if (raw === '/new') {
      this._current = { type: 'new' };
      _renderNewJob();
    } else {
      const m = raw.match(/^\/jobs\/([a-zA-Z0-9-]+)$/);
      if (m) {
        this._current = { type: 'detail', jobId: m[1] };
        _renderJobDetail(m[1]);
      } else {
        // Unknown route → list
        this._current = { type: 'list' };
        _renderJobsList();
      }
    }
  },

  refresh() { this.navigate(location.hash); },
  go(hash) { location.hash = hash; },
  init() {
    window.addEventListener('hashchange', () => this.navigate(location.hash));
    this.navigate(location.hash);
  },
};

// =============================================================
// UTILITIES
// =============================================================
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escAttr(str) { return escHtml(str); }

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(secs) {
  if (!secs || isNaN(secs)) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtRelative(iso) {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function badgeHtml(status) {
  const label = STATUS_LABELS[status] || status;
  const cls = STATUS_BADGE_CLASS[status] || '';
  return `<span class="badge ${cls}">${escHtml(label)}</span>`;
}

function updateNavActive(active) {
  document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
  if (active) document.getElementById(`nav-${active}`)?.classList.add('active');
}

function stepIndicatorHtml(status, progress) {
  const steps = [
    { key: 'queued',           label: 'Queued' },
    { key: 'transcribing',     label: 'Transcribing' },
    { key: 'building_prompts', label: 'Building<br>Prompts' },
    { key: 'generating',       label: 'Generating<br>Images & Clips' },
    { key: 'mixing_audio',     label: '🎵 Mixing<br>Audio' },
    { key: 'stitching',        label: 'Stitching' },
    { key: 'done',             label: 'Done' },
  ];

  const isFailed = status === 'failed';
  const currentIdx = isFailed ? -1 : STATUS_STEPS.indexOf(status);

  return `<div class="steps">${steps.map((step, i) => {
    let cls = 'step';
    if (!isFailed && i < currentIdx) cls += ' step-done';
    if (!isFailed && i === currentIdx) cls += ' step-active';

    const genProgress = step.key === 'generating' && status === 'generating' && progress?.batchesTotal
      ? `<span class="step-progress">${progress.batchesDone}/${progress.batchesTotal}</span>` : '';

    const dotInner = (i < currentIdx && !isFailed) ? '✓' : '';

    return `
      <div class="${cls}">
        <div class="step-dot">${dotInner}</div>
        <div class="step-label">${step.label}${genProgress}</div>
        ${i < steps.length - 1 ? '<div class="step-line"></div>' : ''}
      </div>`;
  }).join('')}</div>`;
}

// =============================================================
// SCREEN 1: JOBS LIST
// =============================================================
let _jobsListData = []; // local cache, kept fresh by socket events

async function _renderJobsList() {
  updateNavActive('jobs');
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="screen-header">
      <h1 class="screen-title">Your Jobs</h1>
      <a href="#/new" class="btn btn-primary">+ New Job</a>
    </div>
    <div id="jobs-list-root">
      <div class="skeleton-list">
        <div class="skeleton-card"></div>
        <div class="skeleton-card"></div>
        <div class="skeleton-card"></div>
      </div>
    </div>`;

  if (!hasApiKey()) { showApiKeyModal(true); return; }

  try {
    const resp = await apiFetch('/api/jobs');
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    _jobsListData = await resp.json();
    _paintJobsList();
  } catch (e) {
    document.getElementById('jobs-list-root').innerHTML = `
      <div class="error-state">
        <div class="error-icon">⚠️</div>
        <p>${escHtml(e.message)}</p>
        <button class="btn btn-primary" id="retry-list">Retry</button>
      </div>`;
    document.getElementById('retry-list')?.addEventListener('click', _renderJobsList);
  }
}

function _paintJobsList() {
  const root = document.getElementById('jobs-list-root');
  if (!root) return; // navigated away

  if (_jobsListData.length === 0) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎬</div>
        <h2 class="empty-title">No jobs yet</h2>
        <p class="empty-desc">Create your first job to turn audio narration into an AI-generated animated video.</p>
        <a href="#/new" class="btn btn-primary">+ Create First Job</a>
      </div>`;
    return;
  }

  root.innerHTML = `<div class="jobs-grid">${_jobsListData.map(_jobCardHtml).join('')}</div>`;

  // Event delegation: one listener for all delete buttons
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delete-job]');
    if (!btn) return;
    e.preventDefault();
    const id = btn.dataset.deleteJob;
    const job = _jobsListData.find(j => j.id === id);
    showConfirm(
      'Delete Job',
      `Permanently delete "${job?.title || id}"?\n\nAll files (uploaded media, reference images, generated frames, final video) will be erased. This cannot be undone.`,
      async () => {
        try {
          await apiFetch(`/api/jobs/${id}`, { method: 'DELETE' });
          _jobsListData = _jobsListData.filter(j => j.id !== id);
          _paintJobsList();
          showToast('Job deleted.', 'success');
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, 'error');
        }
      }
    );
  });
}

function _jobCardHtml(job) {
  const genProgress = job.status === 'generating' && job.progress?.batchesTotal
    ? `<div class="job-progress">
        <div class="progress-bar-mini">
          <div class="progress-bar-fill" style="width:${Math.round(100 * job.progress.batchesDone / job.progress.batchesTotal)}%"></div>
        </div>
        <span class="progress-text">Batch ${job.progress.batchesDone}/${job.progress.batchesTotal}</span>
      </div>` : '';

  const errorRow = job.error
    ? `<div class="job-card-error">${escHtml(job.error)}</div>` : '';

  return `
    <div class="job-card" id="jcard-${job.id}">
      <div class="job-card-header">
        <div class="job-card-title-row">
          <h3 class="job-card-title">${escHtml(job.title)}</h3>
          ${badgeHtml(job.status)}
        </div>
        <div class="job-card-meta">${fmtDate(job.createdAt)} · ${fmtRelative(job.createdAt)}</div>
      </div>
      ${genProgress}${errorRow}
      <div class="job-card-actions">
        <a href="#/jobs/${job.id}" class="btn btn-sm btn-secondary">View</a>
        <button class="btn btn-sm btn-danger-ghost" data-delete-job="${job.id}">Delete</button>
      </div>
    </div>`;
}

// Called by socket 'jobs:update' event — merges one job delta into the cached list + DOM
function _mergeJobInList(updatedJob) {
  if (!updatedJob?.id) return;
  const idx = _jobsListData.findIndex(j => j.id === updatedJob.id);
  if (idx >= 0) {
    _jobsListData[idx] = updatedJob;
  } else {
    _jobsListData.unshift(updatedJob); // brand-new job (e.g. created in another tab)
  }
  // Only touch DOM if the list is currently rendered
  if (Router._current?.type !== 'list') return;
  const card = document.getElementById(`jcard-${updatedJob.id}`);
  if (card) {
    card.outerHTML = _jobCardHtml(updatedJob);
  } else {
    _paintJobsList(); // new card — re-render entire list (rare)
  }
}

// =============================================================
// SCREEN 2: NEW JOB
// =============================================================
function _renderNewJob() {
  updateNavActive('new');
  document.getElementById('app').innerHTML = `
    <div class="screen-header">
      <a href="#/" class="btn btn-ghost btn-back">← Back</a>
      <h1 class="screen-title">New Job</h1>
    </div>

    <div class="card form-card">
      <form id="new-job-form" novalidate>

        <div class="form-section">
          <h2 class="form-section-title">Job Details</h2>
          <div class="form-field">
            <label class="form-label" for="f-title">Title <span class="required">*</span></label>
            <input type="text" id="f-title" class="form-input" placeholder="e.g. Product Launch Intro"
              maxlength="200" autocomplete="off" />
            <div class="field-hint"><span id="title-count">0</span>/200</div>
            <div class="field-error hidden" id="e-title"></div>
          </div>
          <div class="form-field">
            <label class="form-label" for="f-script">Script / Scene Context <span class="required">*</span></label>
            <textarea id="f-script" class="form-input form-textarea"
              placeholder="Describe the story, characters, and visual style. This guides image generation for every scene."
              maxlength="8000" rows="7"></textarea>
            <div class="field-hint"><span id="script-count">0</span>/8,000</div>
            <div class="field-error hidden" id="e-script"></div>
          </div>
        </div>

        <div class="form-section">
          <h2 class="form-section-title">Media File</h2>
          <p class="form-section-desc">The audio or video narration (up to ~2 hours). Supported: MP3, WAV, M4A, AAC, OGG, FLAC, MP4, MOV, MKV, WebM, AVI.</p>
          <div class="form-field">
            <div class="file-drop-zone" id="media-zone">
              <input type="file" id="f-media" class="file-input"
                accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.mov,.mkv,.webm,.avi" />
              <div class="file-drop-content" id="media-zone-content">
                <div class="file-drop-icon">🎵</div>
                <div class="file-drop-text">Click to select or drag & drop</div>
                <div class="file-drop-hint">Audio or video file, up to 3 GB</div>
              </div>
            </div>
            <div class="field-error hidden" id="e-media"></div>
          </div>
        </div>

        <div class="form-section">
          <h2 class="form-section-title">Reference Images</h2>
          <p class="form-section-desc">Upload 1–20 images (PNG, JPG, WebP) that define the visual style and characters. VideoFurge analyses these once to produce a style description reused across all generated frames.</p>
          <div class="form-field">
            <div class="file-drop-zone" id="images-zone">
              <input type="file" id="f-images" class="file-input"
                accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple />
              <div class="file-drop-content" id="images-zone-content">
                <div class="file-drop-icon">🖼️</div>
                <div class="file-drop-text">Click to select images (1–20)</div>
                <div class="file-drop-hint">PNG, JPG, or WebP</div>
              </div>
            </div>
            <div class="image-previews hidden" id="image-previews"></div>
            <div class="field-error hidden" id="e-images"></div>
          </div>
        </div>

        <div class="upload-progress-section hidden" id="upload-progress">
          <div class="upload-progress-label">
            <span>Uploading…</span>
            <span id="upload-pct">0%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-bar-fill" id="upload-fill" style="width:0%"></div>
          </div>
          <p class="upload-hint">Please keep this tab open until the upload finishes.</p>
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary btn-large" id="submit-btn">
            Start Processing
          </button>
          <p class="submit-hint">
            ⏱ Processing a 2-hour video can take <strong>several hours</strong>.
            Once the upload completes, you can safely close this tab and check back later —
            your job continues running on the server.
          </p>
        </div>

      </form>
    </div>`;

  _initNewJobForm();
}

function _initNewJobForm() {
  // Character counters
  document.getElementById('f-title').addEventListener('input', function () {
    document.getElementById('title-count').textContent = this.value.length;
  });
  document.getElementById('f-script').addEventListener('input', function () {
    document.getElementById('script-count').textContent = this.value.length.toLocaleString();
  });

  // Media file selection
  const mediaInput = document.getElementById('f-media');
  const mediaContent = document.getElementById('media-zone-content');
  mediaInput.addEventListener('change', () => {
    const file = mediaInput.files[0];
    if (!file) return;
    mediaContent.innerHTML = `
      <div class="file-selected">
        <div class="file-icon">🎬</div>
        <div class="file-info">
          <div class="file-name">${escHtml(file.name)}</div>
          <div class="file-size" id="media-size">${formatBytes(file.size)}</div>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" id="clear-media">✕</button>
      </div>`;
    document.getElementById('clear-media').onclick = () => {
      mediaInput.value = '';
      mediaContent.innerHTML = `
        <div class="file-drop-icon">🎵</div>
        <div class="file-drop-text">Click to select or drag & drop</div>
        <div class="file-drop-hint">Audio or video file, up to 3 GB</div>`;
    };
    // Try to read duration via a detached media element
    const objUrl = URL.createObjectURL(file);
    const tag = document.createElement(file.type.startsWith('video') ? 'video' : 'audio');
    tag.src = objUrl;
    tag.onloadedmetadata = () => {
      const dur = formatDuration(tag.duration);
      const el = document.getElementById('media-size');
      if (el && dur) el.textContent = `${formatBytes(file.size)} · ${dur}`;
      URL.revokeObjectURL(objUrl);
    };
    tag.onerror = () => URL.revokeObjectURL(objUrl);
  });

  // Reference images
  let selectedImages = [];
  const imagesInput = document.getElementById('f-images');
  imagesInput.addEventListener('change', () => {
    const added = Array.from(imagesInput.files);
    selectedImages = [...selectedImages, ...added].slice(0, 20);
    _paintImagePreviews(selectedImages);
    // Reset so same file can be re-added after remove (and to allow change event to fire again)
    imagesInput.value = '';
  });

  // Submit
  document.getElementById('new-job-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (_validateNewJobForm(selectedImages)) _submitNewJob(selectedImages);
  });
}

function _paintImagePreviews(images) {
  const container = document.getElementById('image-previews');
  const zoneContent = document.getElementById('images-zone-content');
  if (!container || !zoneContent) return;

  if (images.length === 0) {
    container.classList.add('hidden');
    zoneContent.innerHTML = `
      <div class="file-drop-icon">🖼️</div>
      <div class="file-drop-text">Click to select images (1–20)</div>
      <div class="file-drop-hint">PNG, JPG, or WebP</div>`;
    return;
  }

  container.classList.remove('hidden');
  zoneContent.innerHTML = `<div class="file-drop-text">${images.length}/20 images — click to add more</div>`;
  container.innerHTML = images.map((f, i) => `
    <div class="image-thumb-wrap" id="it-${i}">
      <img src="${URL.createObjectURL(f)}" alt="${escAttr(f.name)}" class="image-thumb" />
      <button type="button" class="thumb-remove" data-img-idx="${i}" aria-label="Remove">✕</button>
    </div>`).join('');

  container.querySelectorAll('.thumb-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.imgIdx, 10);
      images.splice(idx, 1);
      _paintImagePreviews(images);
    });
  });
}

function _validateNewJobForm(selectedImages) {
  let ok = true;
  const setErr = (id, msg) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
    if (msg) ok = false;
  };

  const title = document.getElementById('f-title').value.trim();
  const script = document.getElementById('f-script').value.trim();
  const media = document.getElementById('f-media').files[0];

  setErr('e-title', !title ? 'Title is required.'
    : title.length > 200 ? 'Title too long (max 200 characters).' : '');
  setErr('e-script', !script ? 'Script is required.'
    : script.length > 8000 ? 'Script too long (max 8,000 characters).' : '');
  setErr('e-media', !media ? 'Please select a media file.' : '');
  setErr('e-images', selectedImages.length === 0 ? 'At least one reference image is required.'
    : selectedImages.length > 20 ? 'Maximum 20 reference images.' : '');
  return ok;
}

function _submitNewJob(selectedImages) {
  if (!hasApiKey()) { showApiKeyModal(true); return; }

  const title = document.getElementById('f-title').value.trim();
  const script = document.getElementById('f-script').value.trim();
  const mediaFile = document.getElementById('f-media').files[0];

  const fd = new FormData();
  fd.append('title', title);
  fd.append('script', script);
  fd.append('media', mediaFile);
  selectedImages.forEach(img => fd.append('referenceImages', img));

  // Show upload progress bar
  const progressSec = document.getElementById('upload-progress');
  const submitBtn = document.getElementById('submit-btn');
  progressSec.classList.remove('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading…';

  const xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    document.getElementById('upload-pct').textContent = `${pct}%`;
    document.getElementById('upload-fill').style.width = `${pct}%`;
  });

  const resetBtn = () => {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Start Processing';
    progressSec.classList.add('hidden');
  };

  xhr.addEventListener('load', () => {
    if (xhr.status === 202) {
      let id;
      try { id = JSON.parse(xhr.responseText).id; } catch (_) { }
      if (id) {
        showToast('Job created! Redirecting to progress…', 'success');
        Router.go(`#/jobs/${id}`);
      } else {
        showToast('Job created (could not read ID — check the jobs list).', 'info');
        Router.go('#/');
      }
    } else {
      let msg = `Upload failed — server returned ${xhr.status}.`;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) { }
      showToast(msg, 'error', 7000);
      resetBtn();
    }
  });

  xhr.addEventListener('error', () => {
    showToast('Network error during upload. Check your connection and try again.', 'error');
    resetBtn();
  });

  xhr.addEventListener('timeout', () => {
    showToast('Upload timed out. Try again or check your connection.', 'error');
    resetBtn();
  });

  xhr.open('POST', '/api/jobs');
  xhr.setRequestHeader('X-API-Key', getApiKey());
  // NOTE: Do NOT set Content-Type manually — the browser must set it with the multipart boundary.
  xhr.send(fd);
}

// =============================================================
// SCREEN 3: JOB DETAIL
// =============================================================
let _detailJob = null;

async function _renderJobDetail(jobId) {
  updateNavActive(null);
  document.getElementById('app').innerHTML = `
    <div class="screen-header">
      <a href="#/" class="btn btn-ghost btn-back">← All Jobs</a>
      <h1 class="screen-title" id="d-title">Loading…</h1>
    </div>
    <div id="detail-root"><div class="skeleton-detail"></div></div>`;

  if (!hasApiKey()) { showApiKeyModal(true); return; }

  try {
    const resp = await apiFetch(`/api/jobs/${jobId}`);
    if (resp.status === 404) {
      document.getElementById('detail-root').innerHTML = `
        <div class="error-state">
          <div class="error-icon">🔍</div>
          <p>Job not found — it may have been deleted.</p>
          <a href="#/" class="btn btn-primary">← Back to Jobs</a>
        </div>`;
      return;
    }
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    _detailJob = await resp.json();
    _paintJobDetail(_detailJob);
  } catch (e) {
    document.getElementById('detail-root').innerHTML = `
      <div class="error-state">
        <div class="error-icon">⚠️</div>
        <p>${escHtml(e.message)}</p>
        <button class="btn btn-primary" id="retry-detail">Retry</button>
      </div>`;
    document.getElementById('retry-detail')?.addEventListener('click', () => _renderJobDetail(jobId));
    return;
  }

  // Subscribe to real-time updates via socket
  _subscribeToJob(jobId);
}

function _paintJobDetail(job) {
  const titleEl = document.getElementById('d-title');
  if (titleEl) titleEl.textContent = job.title;

  const isDone = job.status === 'done';
  const isFailed = job.status === 'failed';
  const isActive = !isDone && !isFailed;

  const videoSection = isDone ? `
    <div class="card detail-card">
      <h2 class="card-section-title">🎬 Output Video</h2>
      <div class="video-player-wrap">
        <video id="result-video" class="result-video" controls preload="metadata"
          src="${escAttr(mediaUrl(`/api/jobs/${job.id}/preview/video`))}">
          Your browser does not support HTML5 video playback.
        </video>
      </div>
      <div class="download-actions">
        <a href="${escAttr(mediaUrl(`/api/jobs/${job.id}/download/video`))}"
          class="btn btn-primary" download>⬇ Download Video (MP4)</a>
        <a href="${escAttr(mediaUrl(`/api/jobs/${job.id}/download/images`))}"
          class="btn btn-secondary" download>⬇ Download Assets for CapCut (ZIP)</a>
      </div>
    </div>` : '';

  const errorSection = isFailed ? `
    <div class="card detail-card detail-card-error">
      <h2 class="card-section-title">❌ Job Failed</h2>
      <div class="error-message">${escHtml(job.error || 'Unknown error')}</div>
      <p class="error-hint">If the error persists, check the worker logs.</p>
      <div class="download-actions" style="margin-top: 1rem;">
        <button class="btn btn-secondary" id="d-retry-btn">🔄 Retry Failed Job</button>
      </div>
    </div>` : '';

  const processingNote = isActive ? `
    <div class="processing-note">
      ⏱ Processing a 2-hour video can take <strong>several hours</strong>.
      This job is running on the server. <strong>You can safely close this tab and come back later</strong> —
      the status updates here automatically  when you return.
    </div>` : '';

  const root = document.getElementById('detail-root');
  if (!root) return;

  root.innerHTML = `
    ${processingNote}

    <div class="card detail-card">
      <div class="detail-meta-row">
        <div>
          <div class="detail-meta-label">Status</div>
          ${badgeHtml(job.status)}
        </div>
        <div>
          <div class="detail-meta-label">Created</div>
          <div class="detail-meta-value">${fmtDate(job.createdAt)}</div>
        </div>
        ${job.updatedAt ? `<div>
          <div class="detail-meta-label">Last Update</div>
          <div class="detail-meta-value">${fmtRelative(job.updatedAt)}</div>
        </div>` : ''}
        ${job.recovery ? `<div>
          <div class="detail-meta-label">Recovery</div>
          <div class="detail-meta-value">${escHtml(job.recovery)}</div>
        </div>` : ''}
      </div>
    </div>

    <div class="card detail-card">
      <h2 class="card-section-title">Pipeline Progress</h2>
      <div id="d-steps">${stepIndicatorHtml(job.status, job.progress)}</div>
      <div id="d-gen-detail" style="display:${job.status === 'generating' && job.progress?.batchesTotal ? 'block' : 'none'}">
        <div class="generating-detail">
          <div class="progress-bar">
            <div class="progress-bar-fill" id="d-gen-bar"
              style="width:${job.progress?.batchesTotal ? Math.round(100 * job.progress.batchesDone / job.progress.batchesTotal) : 0}%">
            </div>
          </div>
          <div class="generating-label" id="d-gen-label">
            Generating batch <strong>${job.progress?.batchesDone ?? 0}</strong>
            of <strong>${job.progress?.batchesTotal ?? '?'}</strong>
            — batches of 20 images, sequential, to stay within the 4 GB RAM limit.
          </div>
        </div>
      </div>
    </div>

    ${videoSection}
    ${errorSection}

    <div class="card detail-card detail-card-danger">
      <h2 class="card-section-title">Danger Zone</h2>
      <p class="danger-desc">
        Permanently delete all files for this job: uploaded media, reference images,
        all generated frames, and the final video. This cannot be undone.
      </p>
      <button class="btn btn-danger" id="d-delete-btn">🗑 Delete This Job</button>
    </div>`;

  document.getElementById('d-delete-btn').addEventListener('click', () => {
    showConfirm(
      'Delete Job',
      `Permanently delete "${job.title}"?\n\nAll files (audio, reference images, generated frames, final video) will be erased. This cannot be undone.`,
      async () => {
        try {
          await apiFetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
          showToast('Job deleted.', 'success');
          Router.go('#/');
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, 'error');
        }
      }
    );
  });

  document.getElementById('d-retry-btn')?.addEventListener('click', async () => {
    try {
      await apiFetch(`/api/jobs/${job.id}/retry`, { method: 'POST' });
      showToast('Job queued for retry.', 'success');
      _renderJobDetail(job.id); // re-fetch and paint
    } catch (err) {
      showToast(`Retry failed: ${err.message}`, 'error');
    }
  });
}

// Called by socket 'job:update' event — partial in-place DOM update for active jobs.
// When the job reaches a terminal state (done/failed), does a full repaint.
function _applyJobDetailUpdate(job) {
  _detailJob = job;
  const titleEl = document.getElementById('d-title');
  if (titleEl) titleEl.textContent = job.title;

  if (job.status === 'done' || job.status === 'failed') {
    // Full repaint to show video player / error section
    _paintJobDetail(job);
    return;
  }

  // Incremental update: step indicator + progress bar
  const stepsEl = document.getElementById('d-steps');
  if (stepsEl) stepsEl.innerHTML = stepIndicatorHtml(job.status, job.progress);

  const genDetail = document.getElementById('d-gen-detail');
  if (genDetail) {
    if (job.status === 'generating' && job.progress?.batchesTotal) {
      genDetail.style.display = 'block';
      const pct = Math.round(100 * job.progress.batchesDone / job.progress.batchesTotal);
      const bar = document.getElementById('d-gen-bar');
      const lbl = document.getElementById('d-gen-label');
      if (bar) bar.style.width = `${pct}%`;
      if (lbl) lbl.innerHTML = `
        Generating batch <strong>${job.progress.batchesDone}</strong>
        of <strong>${job.progress.batchesTotal}</strong>
        — batches of 20 images, sequential, to stay within the 4 GB RAM limit.`;
    } else {
      genDetail.style.display = 'none';
    }
  }
}

// =============================================================
// INIT
// =============================================================

// Fetch the API key from the server's /api/config endpoint so the user doesn't have
// to enter it manually. The server returns the first key from API_KEYS env (or "dev"
// when API_KEYS is empty, which the server accepts for all keys in that mode).
async function _autoConnect() {
  // If we already have a key in this session (e.g. user refreshed the tab), reuse it.
  if (hasApiKey()) return true;

  try {
    const resp = await fetch('/api/config');
    if (!resp.ok) throw new Error(`/api/config returned ${resp.status}`);
    const { apiKey } = await resp.json();
    if (apiKey) {
      setApiKey(apiKey);
      return true;
    }
  } catch (e) {
    console.warn('[auto-connect] Could not fetch /api/config:', e.message);
  }
  return false;
}

async function init() {
  // Gear icon → manual API key override (always available)
  document.getElementById('api-key-btn')?.addEventListener('click', () => showApiKeyModal(false));

  // Try to auto-connect using the key advertised by the server (API_KEYS env var).
  // This avoids the manual "enter your API key" modal in normal operation.
  const connected = await _autoConnect();

  // Start socket (will use whichever key _autoConnect resolved)
  if (hasApiKey()) initSocket();

  // Start the router (renders the first screen)
  Router.init();

  // Only show the manual key entry modal if auto-connect failed and we have no key at all.
  // This covers the edge case where /api/config is unreachable for some reason.
  if (!connected && !hasApiKey()) {
    showApiKeyModal(true);
  }
}

document.addEventListener('DOMContentLoaded', init);

