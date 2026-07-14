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
            <label class="form-label" for="f-script">Script / Narration <span class="required">*</span></label>
            <textarea id="f-script" class="form-input form-textarea"
              placeholder="The spoken words. The AI will generate visuals that literally act out what is being said in each moment. Be specific about actions, emotions, and who is doing what."
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
          <h2 class="form-section-title">Characters <span class="required">*</span></h2>
          <p class="form-section-desc">
            Add the main people who appear in your story. <strong>The AI (Grok) will actually "see" these photos</strong> through its vision when we attach them (using @image paths). It will detect the exact style — real photograph, 3D render, cartoon, pixel art, stick figure, painted, etc. — and match that style in the generated scenes.
            We use image-to-image so characters stay visually consistent. Give them names.
          </p>

          <div id="characters-container"></div>
          <button type="button" class="btn btn-secondary" id="add-character-btn" style="margin-top: 4px;">+ Add Character</button>
          <div class="field-error hidden" id="e-characters"></div>

          <div class="form-field" style="margin-top: var(--sp-5);">
            <label class="form-label">Additional Style References (optional)</label>
            <p class="form-section-desc" style="margin-bottom: 6px; font-size: 12px;">
              Upload extra images (environments, backgrounds, lighting refs, props, architecture, etc.).
              For every scene the AI will intelligently combine your character photos + these style refs via image-to-image to create the perfect composition.
            </p>
            <div class="file-drop-zone" id="style-refs-zone" style="padding: 12px;">
              <input type="file" id="f-style-refs" class="file-input" accept="image/png,image/jpeg,image/webp" multiple />
              <div class="file-drop-content" id="style-refs-content">
                <div class="file-drop-text">Click or drop style refs (backgrounds, lighting, props...)</div>
              </div>
            </div>
            <div class="image-previews hidden" id="style-refs-previews" style="margin-top: 6px;"></div>
          </div>

          <div class="form-field" style="margin-top: var(--sp-6);">
            <label class="form-label" for="f-scene-style">Scene Style &amp; Visual Direction (optional but recommended)</label>
            <textarea id="f-scene-style" class="form-input form-textarea" rows="3"
              placeholder="e.g. Warm cinematic realism with golden hour sunlight... OR 'Keep the exact same cartoon style as the character drawings' OR 'Match the pixel art look of the references'"></textarea>
            <div class="field-hint">You can reinforce or correct the style. Grok vision reads the actual uploaded images to classify the style (real / 3D / cartoon / pixel / etc.) and will follow it.</div>
          </div>
        </div>

        <div class="upload-progress-section hidden" id="upload-progress">
          <div class="upload-progress-label">
            <span id="upload-status-text">Uploading…</span>
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

  // === NEW STRUCTURED CHARACTERS SYSTEM ===
  let characters = []; // {id, name, gender, file}
  let styleRefFiles = []; // additional style / environment images

  function createCharacter() {
    if (characters.length >= 8) {
      showToast('Maximum 8 characters recommended for best results.', 'info');
      return;
    }
    characters.push({
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2),
      name: '',
      gender: 'male',
      file: null,
    });
    _renderCharacters();
  }

  function removeCharacter(id) {
    characters = characters.filter(c => c.id !== id);
    _renderCharacters();
  }

  function updateCharacter(id, patch) {
    const c = characters.find(x => x.id === id);
    if (c) Object.assign(c, patch);
  }

  function handleCharacterFile(id, file) {
    const c = characters.find(x => x.id === id);
    if (!c) return;
    c.file = file;
    _renderCharacters();
  }

  window._addCharacter = createCharacter; // for button

  function _renderCharacters() {
    const container = document.getElementById('characters-container');
    if (!container) return;

    if (characters.length === 0) {
      container.innerHTML = `
        <div class="char-empty-state">
          No characters added yet. Click "+ Add Character" above.
        </div>`;
      return;
    }

    container.innerHTML = characters.map((c, idx) => {
      const previewUrl = c.file ? URL.createObjectURL(c.file) : null;
      return `
      <div class="character-row" data-id="${c.id}">
        <div class="char-index">#${idx + 1}</div>

        <div class="char-fields">
          <div class="char-field">
            <label class="char-label">Name</label>
            <input type="text" class="form-input char-name" value="${escAttr(c.name)}"
                   placeholder="e.g. Emeka" data-field="name" />
          </div>

          <div class="char-field">
            <label class="char-label">Gender</label>
            <select class="form-input char-gender" data-field="gender">
              <option value="male" ${c.gender === 'male' ? 'selected' : ''}>Male</option>
              <option value="female" ${c.gender === 'female' ? 'selected' : ''}>Female</option>
              <option value="nonbinary" ${c.gender === 'nonbinary' ? 'selected' : ''}>Non-binary</option>
              <option value="unspecified" ${c.gender === 'unspecified' ? 'selected' : ''}>Unspecified</option>
            </select>
          </div>

          <div class="char-field char-photo-field">
            <label class="char-label">Photo</label>
            <div class="char-photo-controls">
              <button type="button" class="btn btn-sm btn-secondary char-choose-btn">Choose Photo</button>
              <input type="file" accept="image/png,image/jpeg,image/webp" class="char-file-input hidden" />
              ${previewUrl ? `
                <div class="char-thumb">
                  <img src="${previewUrl}" alt="${escAttr(c.name || 'character')}" />
                  <button type="button" class="thumb-remove char-remove-photo" title="Remove photo">✕</button>
                </div>` : ''}
            </div>
          </div>
        </div>

        <button type="button" class="btn btn-sm btn-danger-ghost char-remove-btn" title="Remove character">Remove</button>
      </div>`;
    }).join('');

    // Bind events
    container.querySelectorAll('.character-row').forEach(row => {
      const id = row.dataset.id;

      // Name + Gender
      row.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('input', () => {
          const field = el.dataset.field;
          if (field === 'name') updateCharacter(id, { name: el.value });
          if (field === 'gender') updateCharacter(id, { gender: el.value });
        });
      });

      // Choose photo
      const chooseBtn = row.querySelector('.char-choose-btn');
      const fileInput = row.querySelector('.char-file-input');
      if (chooseBtn && fileInput) {
        chooseBtn.onclick = () => fileInput.click();
        fileInput.onchange = () => {
          const f = fileInput.files[0];
          if (f) handleCharacterFile(id, f);
          fileInput.value = '';
        };
      }

      // Remove photo
      const removePhoto = row.querySelector('.char-remove-photo');
      if (removePhoto) {
        removePhoto.onclick = () => {
          updateCharacter(id, { file: null });
          _renderCharacters();
        };
      }

      // Remove entire character
      const removeBtn = row.querySelector('.char-remove-btn');
      if (removeBtn) {
        removeBtn.onclick = () => removeCharacter(id);
      }
    });
  }

  // Add character button
  const addBtn = document.getElementById('add-character-btn');
  if (addBtn) {
    addBtn.onclick = () => {
      createCharacter();
    };
  }

  // Start with one empty character slot
  characters.push({ id: 'c_' + Date.now(), name: '', gender: 'male', file: null });
  _renderCharacters();

  // === Additional Style References handling ===
  function _paintStyleRefs() {
    const container = document.getElementById('style-refs-previews');
    const zoneContent = document.getElementById('style-refs-content');
    if (!container || !zoneContent) return;

    if (styleRefFiles.length === 0) {
      container.classList.add('hidden');
      zoneContent.innerHTML = `<div class="file-drop-text">Click or drop style refs (backgrounds, lighting, props...)</div>`;
      return;
    }

    container.classList.remove('hidden');
    zoneContent.innerHTML = `<div class="file-drop-text">${styleRefFiles.length} style reference(s) — click to add more</div>`;

    container.innerHTML = styleRefFiles.map((f, i) => `
      <div class="image-thumb-wrap" style="width:70px;height:70px;">
        <img src="${URL.createObjectURL(f)}" alt="${escAttr(f.name)}" class="image-thumb" />
        <button type="button" class="thumb-remove" data-style-idx="${i}" aria-label="Remove">✕</button>
      </div>`).join('');

    container.querySelectorAll('.thumb-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.styleIdx, 10);
        styleRefFiles.splice(idx, 1);
        _paintStyleRefs();
      });
    });
  }

  const styleInput = document.getElementById('f-style-refs');
  if (styleInput) {
    styleInput.addEventListener('change', () => {
      const added = Array.from(styleInput.files).slice(0, 10);
      styleRefFiles = [...styleRefFiles, ...added].slice(0, 10);
      _paintStyleRefs();
      styleInput.value = '';
    });
  }

  // Local submit function defined *inside* _initNewJobForm so it has direct
  // lexical access to `characters` and `styleRefFiles` (both declared in this scope).
  // This prevents any possibility of "xxx is not defined" ReferenceErrors caused
  // by forgetting to pass closure variables to a top-level helper.
  function submitNewJob() {
    if (!hasApiKey()) { showApiKeyModal(true); return; }

    const title = document.getElementById('f-title').value.trim();
    const script = document.getElementById('f-script').value.trim();
    const mediaFile = document.getElementById('f-media').files[0];
    const sceneStyle = (document.getElementById('f-scene-style')?.value || '').trim();

    const validChars = (characters || []).filter(c => c.name && c.name.trim() && c.file);

    const fd = new FormData();
    fd.append('title', title);
    fd.append('script', script);
    fd.append('media', mediaFile);
    if (sceneStyle) fd.append('sceneStyle', sceneStyle);

    // Structured characters
    const meta = validChars.map(c => ({ name: c.name.trim(), gender: c.gender || 'unspecified' }));
    fd.append('characters', JSON.stringify(meta));

    validChars.forEach(c => {
      fd.append('characterImages', c.file);
    });

    // Additional style references — direct access to the array from this scope
    (styleRefFiles || []).forEach(f => {
      fd.append('styleReferences', f);
    });

    // Show upload progress bar
    const progressSec = document.getElementById('upload-progress');
    const submitBtn = document.getElementById('submit-btn');
    const statusText = document.getElementById('upload-status-text');
    const pctEl = document.getElementById('upload-pct');
    const fillEl = document.getElementById('upload-fill');

    progressSec.classList.remove('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Uploading…';
    if (statusText) statusText.textContent = 'Uploading…';

    const xhr = new XMLHttpRequest();

    // Long timeout because large media files + server-side work (storage scan, writes) can take time
    xhr.timeout = 15 * 60 * 1000; // 15 minutes

    let uploadComplete = false;

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      if (pctEl) pctEl.textContent = `${pct}%`;
      if (fillEl) fillEl.style.width = `${pct}%`;

      if (pct >= 100 && !uploadComplete) {
        uploadComplete = true;
        if (statusText) statusText.textContent = 'Finalizing on server…';
        if (pctEl) pctEl.textContent = '100%';
        if (fillEl) fillEl.style.width = '100%';
      }
    });

    const resetBtn = () => {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start Processing';
      progressSec.classList.add('hidden');
      if (statusText) statusText.textContent = 'Uploading…';
      if (pctEl) pctEl.textContent = '0%';
      if (fillEl) fillEl.style.width = '0%';
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

  // Submit handler — calls the local function that has closure access to everything
  document.getElementById('new-job-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (_validateNewJobForm(characters)) submitNewJob();
  });
}

function _validateNewJobForm(characters) {
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

  // Characters validation
  const validChars = (characters || []).filter(c => c.name && c.name.trim() && c.file);
  if (validChars.length === 0) {
    setErr('e-characters', 'Add at least one character with a name and photo. These are used for image-to-image consistency.');
  } else {
    setErr('e-characters', '');
  }

  // style refs are optional — no error

  return ok;
}

// _submitNewJob was moved inside _initNewJobForm() (as `submitNewJob`)
// so it always has direct access to the `characters` and `styleRefFiles`
// variables declared in that scope. The old top-level function is intentionally
// removed to prevent any future "xxx is not defined" errors from scope mistakes.
// (The new job form is the only caller.)

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

  // Prefer server-reported assets; if missing (old server), assume final exists.
  const assets = job.assets || { video: true, acted: true, concat: true, images: true };
  const finalSrc = mediaUrl(`/api/jobs/${job.id}/preview/video`);
  const actedSrc = mediaUrl(`/api/jobs/${job.id}/preview/acted`);

  const videoSection = isDone ? `
    <div class="card detail-card" id="d-video-card">
      ${assets.video !== false ? `
      <h2 class="card-section-title">🎬 Final Video (Documentary Style)</h2>
      <div class="video-player-wrap" data-player="final">
        <video id="result-video" class="result-video" controls playsinline
          preload="metadata" src="${escAttr(finalSrc)}">
          Your browser does not support HTML5 video playback.
        </video>
        <div class="video-toolbar">
          <button type="button" class="btn btn-primary" id="btn-play-final" data-play-for="result-video">▶ Play / Pause</button>
          <button type="button" class="btn btn-ghost" id="btn-reload-final" data-reload-for="result-video">↻ Reload</button>
          <span class="video-status" id="status-result-video">Ready</span>
        </div>
        <div class="video-error hidden" id="result-video-error"></div>
      </div>` : `
      <p class="error-hint">Final video file is not available for this job.</p>`}

      ${assets.acted !== false ? `
      <h2 class="card-section-title" style="margin-top: 2rem;">🎬 Acted Video (Full Drama Scene)</h2>
      <div class="video-player-wrap" data-player="acted">
        <video id="result-acted-video" class="result-video" controls playsinline
          preload="none" data-src="${escAttr(actedSrc)}">
          Your browser does not support HTML5 video playback.
        </video>
        <div class="video-toolbar">
          <button type="button" class="btn btn-primary" id="btn-play-acted" data-play-for="result-acted-video">▶ Play / Pause</button>
          <button type="button" class="btn btn-ghost" id="btn-reload-acted" data-reload-for="result-acted-video">↻ Reload</button>
          <span class="video-status" id="status-result-acted-video">Click Play to load (~60–90 MB)</span>
        </div>
        <div class="video-error hidden" id="result-acted-video-error"></div>
      </div>` : `
      <h2 class="card-section-title" style="margin-top: 2rem;">🎬 Acted Video (Full Drama Scene)</h2>
      <p class="error-hint">Acted video was not generated for this job (file missing). Download Final instead, or re-run the job.</p>`}

      <div class="download-actions" style="margin-top: 1.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
        ${assets.video !== false ? `<a href="${escAttr(mediaUrl(`/api/jobs/${job.id}/download/video`))}"
          class="btn btn-primary" download>⬇ Download Final Video (Voice + BGM + SFX)</a>` : ''}
        ${assets.acted !== false ? `<a href="${escAttr(mediaUrl(`/api/jobs/${job.id}/download/acted`))}"
          class="btn btn-secondary" download>⬇ Download Acted Video (BGM + SFX, no Voice)</a>` : ''}
        ${assets.concat !== false ? `<a href="${escAttr(mediaUrl(`/api/jobs/${job.id}/download/concat`))}"
          class="btn btn-ghost" download>⬇ Download Stitched Video (No Audio)</a>` : ''}
        ${assets.images !== false ? `<a href="${escAttr(mediaUrl(`/api/jobs/${job.id}/download/images`))}"
          class="btn btn-ghost" download>⬇ Download CapCut Assets (ZIP)</a>` : ''}
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

    ${job.characters && job.characters.length ? `
    <div class="card detail-card">
      <h2 class="card-section-title">👤 Characters (for consistency)</h2>
      <div class="characters-summary">
        ${job.characters.map(c => `
          <div class="char-pill">
            <span class="char-name">${escHtml(c.name)}</span>
            <span class="char-gender">${escHtml(c.gender || '')}</span>
          </div>
        `).join('')}
      </div>
      ${job.sceneStyle ? `<div class="scene-style-note"><strong>Style:</strong> ${escHtml(job.sceneStyle)}</div>` : ''}
      ${job.styleRefCount ? `<div style="font-size:12px; color:var(--clr-text-2); margin-top:4px;">+ ${job.styleRefCount} additional style references (used for multi-image scene composition)</div>` : ''}
    </div>` : ''}

    ${videoSection}
    ${errorSection}

    <div class="card detail-card detail-card-danger">
      <h2 class="card-section-title">Danger Zone</h2>
      <p class="danger-desc">
        Permanently delete all files for this job: uploaded media, character photos,
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

  // Wire reliable external Play buttons (native controls alone can be unclickable
  // when a parent uses overflow:hidden / stacking quirks).
  _wireVideoPlayer('result-video', 'result-video-error', 'Final');
  _wireVideoPlayer('result-acted-video', 'result-acted-video-error', 'Acted');
}

function _setVideoStatus(videoId, text) {
  const el = document.getElementById(`status-${videoId}`);
  if (el) el.textContent = text;
}

function _ensureVideoSrc(video) {
  // Acted uses data-src + preload=none so we don't block the smaller final video.
  if (!video) return;
  const pending = video.getAttribute('data-src');
  if (pending && !video.getAttribute('src')) {
    video.setAttribute('src', pending);
    video.removeAttribute('data-src');
    try { video.load(); } catch (_) {}
  }
}

function _wireVideoPlayer(videoId, errorId, label) {
  const video = document.getElementById(videoId);
  const errEl = document.getElementById(errorId);
  if (!video) return;

  const showErr = (msg) => {
    if (!errEl) return;
    errEl.classList.remove('hidden');
    errEl.textContent = msg;
  };
  const hideErr = () => { if (errEl) errEl.classList.add('hidden'); };

  // Kick metadata load only when a src is already present (final video).
  if (video.getAttribute('src')) {
    try { video.load(); } catch (_) {}
  }

  video.addEventListener('error', () => {
    const code = video.error?.code;
    const map = {
      1: 'playback aborted',
      2: 'network error while loading',
      3: 'video decode failed (file may be corrupted or use an unsupported codec)',
      4: 'format/source not supported or file missing (404)',
    };
    const reason = map[code] || 'unknown playback error';
    _setVideoStatus(videoId, 'Error');
    showErr(`${label} video could not play: ${reason}. Use the Download button below, or hard-refresh (Ctrl+F5).`);
    console.warn(`[video] ${label} error`, video.error, video.currentSrc || video.getAttribute('data-src'));
  });

  video.addEventListener('loadstart', () => _setVideoStatus(videoId, 'Loading…'));
  video.addEventListener('waiting', () => _setVideoStatus(videoId, 'Buffering…'));
  video.addEventListener('canplay', () => {
    hideErr();
    _setVideoStatus(videoId, video.paused ? 'Ready' : 'Playing');
  });
  video.addEventListener('playing', () => {
    hideErr();
    _setVideoStatus(videoId, 'Playing');
  });
  video.addEventListener('pause', () => {
    if (!video.ended) _setVideoStatus(videoId, 'Paused');
  });
  video.addEventListener('ended', () => _setVideoStatus(videoId, 'Ended'));
  video.addEventListener('loadedmetadata', () => {
    hideErr();
    const dur = isFinite(video.duration) ? `${Math.round(video.duration)}s` : '';
    _setVideoStatus(videoId, dur ? `Ready (${dur})` : 'Ready');
  });

  // Explicit toolbar buttons — always clickable (outside the media element)
  const playBtn = document.querySelector(`[data-play-for="${videoId}"]`);
  const reloadBtn = document.querySelector(`[data-reload-for="${videoId}"]`);

  if (playBtn) {
    playBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideErr();
      _ensureVideoSrc(video);
      try {
        if (video.paused || video.ended) {
          _setVideoStatus(videoId, 'Starting…');
          // Pause the other player so only one stream is active
          document.querySelectorAll('video.result-video').forEach(v => {
            if (v !== video && !v.paused) v.pause();
          });
          await video.play();
          _setVideoStatus(videoId, 'Playing');
        } else {
          video.pause();
          _setVideoStatus(videoId, 'Paused');
        }
      } catch (err) {
        _setVideoStatus(videoId, 'Play blocked');
        showErr(`${label}: could not start playback (${err.message || err}). Try Reload, or Download the file.`);
      }
    });
  }

  if (reloadBtn) {
    reloadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideErr();
      _ensureVideoSrc(video);
      // Bust browser cache on reload
      const base = (video.currentSrc || video.getAttribute('src') || '').split('#')[0];
      if (base) {
        const joiner = base.includes('?') ? '&' : '?';
        video.src = `${base}${joiner}_r=${Date.now()}`;
      }
      try { video.load(); } catch (_) {}
      _setVideoStatus(videoId, 'Reloading…');
    });
  }
}

// Called by socket 'job:update' event — partial in-place DOM update for active jobs.
// When the job reaches a terminal state (done/failed), does a full repaint once.
function _applyJobDetailUpdate(job) {
  _detailJob = job;
  const titleEl = document.getElementById('d-title');
  if (titleEl) titleEl.textContent = job.title;

  if (job.status === 'done' || job.status === 'failed') {
    // Do NOT full-repaint if the terminal UI is already showing — destroying <video>
    // elements mid-load/play is a common reason the second (acted) player never works.
    const alreadyDone = job.status === 'done' && document.getElementById('d-video-card');
    const alreadyFailed = job.status === 'failed' && document.querySelector('.detail-card-error');
    if (!alreadyDone && !alreadyFailed) {
      _paintJobDetail(job);
    }
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

