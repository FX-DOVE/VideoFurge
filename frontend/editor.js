// =============================================================
// VideoFurge Clip Editor — CapCut-inspired browser editor
// Loads after app.js (uses apiFetch, mediaUrl, showToast, etc.)
// Clips arrive pre-assembled; user reorders / trims / transitions
// then queues a server render (safe to leave and download later).
// =============================================================

// CapCut-style join / transition options.
// cut  = hard cut · mix = opacity blend (clips dissolve into each other) · xfade = fancy styles
// Mix is NOT fade-through-black — that is "Fade black".
const EDITOR_TRANSITIONS = [
  { id: 'none',        label: 'Cut',          kind: 'cut',   hint: 'Hard cut — no blend' },
  { id: 'mix',         label: 'Mix',          kind: 'mix',   hint: 'Opacity blend — clips dissolve into each other (recommended for acted)' },
  { id: 'fade',        label: 'Crossfade',    kind: 'xfade', hint: 'Overlapping crossfade (same visual as Mix)' },
  { id: 'dissolve',    label: 'Dissolve',     kind: 'xfade', hint: 'Classic dissolve' },
  { id: 'fadeblack',   label: 'Fade black',   kind: 'xfade', hint: 'Fade through black (dips to black between clips)' },
  { id: 'fadewhite',   label: 'Fade white',   kind: 'xfade', hint: 'Fade through white' },
  { id: 'slideleft',   label: 'Slide ←',      kind: 'xfade', hint: 'Slide from right' },
  { id: 'slideright',  label: 'Slide →',      kind: 'xfade', hint: 'Slide from left' },
  { id: 'slideup',     label: 'Slide ↑',      kind: 'xfade', hint: 'Slide from bottom' },
  { id: 'slidedown',   label: 'Slide ↓',      kind: 'xfade', hint: 'Slide from top' },
  { id: 'wipeleft',    label: 'Wipe ←',       kind: 'xfade', hint: 'Wipe left' },
  { id: 'wiperight',   label: 'Wipe →',       kind: 'xfade', hint: 'Wipe right' },
  { id: 'circleopen',  label: 'Circle open',  kind: 'xfade', hint: 'Expanding circle' },
  { id: 'circleclose', label: 'Circle close', kind: 'xfade', hint: 'Closing circle' },
  { id: 'distance',    label: 'Distance',     kind: 'xfade', hint: 'Zoom distance blend' },
  { id: 'pixelize',    label: 'Pixelize',     kind: 'xfade', hint: 'Pixel dissolve' },
];

const DEFAULT_TRANSITION = 'mix';
const DEFAULT_TRANSITION_DURATION = 0.5;

function _editorTransDef(id) {
  return EDITOR_TRANSITIONS.find(t => t.id === id) || EDITOR_TRANSITIONS[0];
}

function _editorDefaultTransDur(timeline) {
  const d = Number(timeline?.defaultTransitionDuration);
  return Number.isFinite(d) ? Math.max(0, Math.min(2, d)) : DEFAULT_TRANSITION_DURATION;
}

const EDITOR_SIDE_TABS = [
  { key: 'story', label: 'Story', icon: 'story' },
  { key: 'clip', label: 'Clip', icon: 'visuals' },
  { key: 'audio', label: 'Audio', icon: 'audio' },
  { key: 'text', label: 'Text', icon: 'text' },
  { key: 'layout', label: 'Layout', icon: 'elements' },
];

const EDITOR_COLORS = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#3b82f6', '#a855f7'];

let _editor = null;

// ── helpers ──────────────────────────────────────────────────
function _teardownEditor() {
  document.getElementById('app')?.classList.remove('container-wide', 'editor-active');
  document.body.classList.remove('editor-open');
  if (_editor?.onKey) {
    window.removeEventListener('keydown', _editor.onKey);
  }
  if (!_editor) return;
  try {
    if (_editor.raf) cancelAnimationFrame(_editor.raf);
    if (_editor.video) {
      _editor.video.pause();
      _editor.video.removeAttribute('src');
      try { _editor.video.load(); } catch (_) {}
    }
  } catch (_) {}
  _editor = null;
}

function _fmtEditorTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 10);
  return `${m}:${String(sec).padStart(2, '0')}.${cs}`;
}

function _fmtEditorDur(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function _clipDuration(item) {
  return Math.max(0.05, (Number(item.trimEnd) || 0) - (Number(item.trimStart) || 0));
}

function _timelineTotal(timeline) {
  if (!timeline?.clips) return 0;
  return timeline.clips.filter(c => c.enabled !== false).reduce((sum, c) => sum + _clipDuration(c), 0);
}

function _sourceMeta(sourceIndex) {
  return _editor?.clipsByIndex?.get(sourceIndex) || null;
}

function _editorSelected() {
  return _editor?.timeline.clips.find(c => c.id === _editor.selectedId) || null;
}

function _editorEnabledClips() {
  return (_editor?.timeline.clips || []).filter(c => c.enabled !== false);
}

function _getAudioElement(key) {
  if (!_editor) return null;
  const track = _editor.timeline[key];
  if (!track || !track.enabled || !track.filename) {
    if (_editor[key + 'Element']) {
      try { _editor[key + 'Element'].pause(); } catch (_) {}
      _editor[key + 'Element'] = null;
    }
    return null;
  }
  
  if (!_editor[key + 'Element']) {
    const aud = new Audio();
    aud.preload = 'auto';
    _editor[key + 'Element'] = aud;
  }
  
  const aud = _editor[key + 'Element'];
  const url = track.url.startsWith('blob:') ? track.url : mediaUrl(track.url);
  
  // Resolve cross-origin / local url correctly
  let absoluteUrl = url;
  if (url.startsWith('/')) {
    // Make sure we have the full origin so browser treats it as a fresh stream
    absoluteUrl = window.location.origin + url;
  }

  if (aud.src !== absoluteUrl) {
    aud.src = absoluteUrl;
    aud.load();
  }
  aud.volume = Number(track.volume ?? 1.0);
  return aud;
}

function _safePlayAudio(aud, time) {
  if (!aud) return;
  const playAudio = () => {
    try {
      aud.play().catch((e) => console.warn('Audio play blocked:', e));
    } catch (_) {}
  };
  if (aud.readyState >= 1) {
    try { aud.currentTime = time; } catch (_) {}
    playAudio();
  } else {
    const onMeta = () => {
      aud.removeEventListener('loadedmetadata', onMeta);
      try { aud.currentTime = time; } catch (_) {}
      playAudio();
    };
    aud.addEventListener('loadedmetadata', onMeta);
  }
}

function _safeSeekAudio(aud, time) {
  if (!aud) return;
  if (aud.readyState >= 1) {
    try { aud.currentTime = time; } catch (_) {}
  } else {
    const onMeta = () => {
      aud.removeEventListener('loadedmetadata', onMeta);
      try { aud.currentTime = time; } catch (_) {}
    };
    aud.addEventListener('loadedmetadata', onMeta);
  }
}


function _editorPushHistory() {
  if (!_editor) return;
  const snap = JSON.stringify(_editor.timeline);
  if (_editor.history[_editor.historyPos] === snap) {
    _editor.dirty = true;
    return;
  }
  _editor.history = _editor.history.slice(0, _editor.historyPos + 1);
  _editor.history.push(snap);
  if (_editor.history.length > 40) {
    _editor.history.shift();
    _editor.historyPos = Math.max(0, _editor.historyPos - 1);
  }
  _editor.historyPos = _editor.history.length - 1;
  _editor.dirty = true;
}

function _editorUndo() {
  if (!_editor || _editor.historyPos <= 0) return;
  _editor.historyPos--;
  _editor.timeline = JSON.parse(_editor.history[_editor.historyPos]);
  _editor.dirty = true;
  _paintEditor();
}

function _editorRedo() {
  if (!_editor || _editor.historyPos >= _editor.history.length - 1) return;
  _editor.historyPos++;
  _editor.timeline = JSON.parse(_editor.history[_editor.historyPos]);
  _editor.dirty = true;
  _paintEditor();
}

function _editorIsBusy() {
  return ['queued', 'rendering'].includes(_editor?.editRender?.status);
}

// ── boot ─────────────────────────────────────────────────────
async function _renderEditor(jobId) {
  updateNavActive(null);
  document.body.classList.add('editor-open');
  const app = document.getElementById('app');
  app.classList.add('container-wide', 'editor-active');
  app.innerHTML = `
    <div class="ce-root">
      <div class="ce-loading">
        <div class="ce-spinner"></div>
        <p>Loading assembled clips…</p>
      </div>
    </div>`;

  if (!hasApiKey()) { showApiKeyModal(true); return; }

  try {
    const resp = await apiFetch(`/api/jobs/${jobId}/editor`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server returned ${resp.status}`);
    }
    const data = await resp.json();
    _initEditorState(jobId, data);
    _paintEditor();
    _subscribeToJob(jobId);
  } catch (e) {
    app.innerHTML = `
      <div class="error-state">
        <div class="error-icon">⚠️</div>
        <p>${escHtml(e.message)}</p>
        <a href="#/jobs/${escAttr(jobId)}" class="btn btn-primary">← Back to Job</a>
      </div>`;
  }
}

function _initEditorState(jobId, data) {
  _teardownEditor();
  document.body.classList.add('editor-open');
  document.getElementById('app')?.classList.add('container-wide', 'editor-active');

  const clipsByIndex = new Map((data.clips || []).map(c => [c.index, c]));
  const timeline = JSON.parse(JSON.stringify(data.timeline || { version: 1, clips: [], audioMode: 'acted' }));
  if (!timeline.captions) {
    timeline.captions = {
      enabled: false, font: 'Arial', fontSize: 48,
      color: '#ffffff', bgColor: '#000000', position: 'bottom', style: 'shadow',
    };
  }
  if (!timeline.defaultTransition) timeline.defaultTransition = DEFAULT_TRANSITION;
  if (timeline.defaultTransitionDuration == null || !Number.isFinite(Number(timeline.defaultTransitionDuration))) {
    timeline.defaultTransitionDuration = DEFAULT_TRANSITION_DURATION;
  }
  // Migrate older timelines that used "fade" as the soft default → Mix @ 0.5s
  // (only when every non-first clip still has the old stock fade@0.35)
  if (timeline.defaultTransition === 'fade' && !timeline._transMigrated) {
    const allOldFade = (timeline.clips || []).every((c, i) =>
      i === 0 || (c.transition === 'fade' && Math.abs(Number(c.transitionDuration) - 0.35) < 0.02)
    );
    if (allOldFade) {
      timeline.defaultTransition = DEFAULT_TRANSITION;
      timeline.defaultTransitionDuration = DEFAULT_TRANSITION_DURATION;
      (timeline.clips || []).forEach((c, i) => {
        if (i === 0) { c.transition = 'none'; c.transitionDuration = 0; }
        else { c.transition = DEFAULT_TRANSITION; c.transitionDuration = DEFAULT_TRANSITION_DURATION; }
      });
    }
    timeline._transMigrated = true;
  }
  if (!timeline.resolution) timeline.resolution = '1920x1080';
  // Audio tracks
  if (!timeline.bgMusic)    timeline.bgMusic    = { enabled: false, filename: '', volume: 0.4, url: '' };
  if (!timeline.voiceTrack) timeline.voiceTrack = { enabled: false, filename: '', volume: 1.0, url: '' };
  timeline.clips.forEach((c, i) => { if (!c.id) c.id = `c${i}-${c.sourceIndex}`; });

  _editor = {
    jobId,
    title: data.title || 'Untitled',
    sourceClips: data.clips || [],
    clipsByIndex,
    timeline,
    editRender: data.editRender || { status: 'idle' },
    assets: data.assets || {},
    selectedId: timeline.clips.find(c => c.enabled !== false)?.id || timeline.clips[0]?.id || null,
    sideTab: 'story',
    sideOpen: true,
    search: '',
    dirty: false,
    playing: false,
    playhead: 0,
    video: null,
    raf: null,
    dragId: null,
    pxPerSec: 40,
    history: [JSON.stringify(timeline)],
    historyPos: 0,
    scrubbing: false,
    onKey: null,
  };

  _editor.onKey = (e) => {
    if (!_editor) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      _editorTogglePlay();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      _editorUndo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      _editorRedo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      _editorSave();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!_editorIsBusy() && _editorSelected()) {
        e.preventDefault();
        _editorDeleteSelected(true);
      }
    } else if (e.key === 's' || e.key === 'S') {
      if (!_editorIsBusy()) {
        e.preventDefault();
        _editorSplitAtPlayhead();
      }
    } else if (e.key === '[' && !_editorIsBusy()) {
      e.preventDefault();
      _editorNudgeTrim('front', 0.5);
    } else if (e.key === ']' && !_editorIsBusy()) {
      e.preventDefault();
      _editorNudgeTrim('back', 0.5);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const enabled = _editorEnabledClips();
      const cur = enabled.findIndex(c => c.id === _editor.selectedId);
      const next = enabled[Math.max(0, Math.min(enabled.length - 1, (cur < 0 ? 0 : cur) + dir))];
      if (next) {
        _editor.selectedId = next.id;
        _jumpToClip(next.id);
        _paintEditor();
      }
    }
  };
  window.addEventListener('keydown', _editor.onKey);
}

// ── paint ────────────────────────────────────────────────────
function _paintEditor() {
  const app = document.getElementById('app');
  if (!app || !_editor) return;
  const busy = _editorIsBusy();
  const total = _timelineTotal(_editor.timeline);
  const enabled = _editorEnabledClips();
  const selected = _editorSelected();
  const selMeta = selected ? _sourceMeta(selected.sourceIndex) : null;
  const er = _editor.editRender || {};

  const done = er.progress?.done ?? 0;
  const renderTotal = er.progress?.total ?? 0;
  const pct = (typeof _editRenderPercent === 'function')
    ? _editRenderPercent(er)
    : (renderTotal ? Math.min(100, Math.round((done / renderTotal) * 100)) : (er.status === 'rendering' ? 45 : 10));

  app.innerHTML = `
  <div class="ce-root">
    <!-- Top bar -->
    <header class="ce-topbar" style="position: relative;">
      <a href="#/jobs/${escAttr(_editor.jobId)}" class="ce-back" title="Back to job">←</a>
      <div class="ce-title-block">
        <div class="ce-title">${escHtml(_editor.title)}</div>
        <div class="ce-sub">${enabled.length} clips · ${_fmtEditorDur(total)} · edit timeline, then <strong>Render</strong> / <strong>Re-render</strong></div>
      </div>
      <div class="ce-top-actions" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
        ${busy ? `
          <div class="ce-render-status" style="font-size: 0.8rem; color: #a5b4fc; display: flex; align-items: center; gap: 0.35rem; font-weight: 500; margin-right: 0.5rem;">
            <span class="ce-render-spinner" style="width: 12px; height: 12px; border: 1.8px solid #a5b4fc; border-top-color: transparent; border-radius: 50%; display: inline-block; animation: ce-spin 0.8s linear infinite;"></span>
            <span id="ce-top-render-pct">Rendering (${pct}%)</span>
          </div>
        ` : ''}
        <button type="button" class="ce-icon-btn" id="ce-undo" title="Undo (Ctrl+Z)" ${busy || _editor.historyPos <= 0 ? 'disabled' : ''}>↩</button>
        <button type="button" class="ce-icon-btn" id="ce-redo" title="Redo (Ctrl+Y)" ${busy || _editor.historyPos >= _editor.history.length - 1 ? 'disabled' : ''}>↪</button>
        <button type="button" class="btn btn-ghost btn-sm" id="ce-save" ${busy ? 'disabled' : ''}>💾 Save</button>
        ${(er.status === 'done' || _editor.assets?.edited) ? `
          <a class="btn btn-sm" href="${escAttr(mediaUrl(`/api/jobs/${_editor.jobId}/download/edited`))}" download style="background: #10b981; border-color: #10b981; color: white;">
            ⬇ Download MP4
          </a>
        ` : ''}
        <button type="button" class="btn btn-primary btn-sm" id="ce-render" ${busy ? 'disabled' : ''}
          title="${er.status === 'done' || _editor.assets?.edited ? 'Re-render the full video with current timeline & transitions (e.g. Mix)' : 'Render the edited video on the server'}">
          ${busy
            ? 'Rendering…'
            : (er.status === 'done' || _editor.assets?.edited
              ? '🔄 Re-render'
              : (er.status === 'failed' ? '▶ Retry render' : '▶ Render'))}
        </button>
      </div>
      ${busy ? `<div class="ce-topbar-progress-line" style="position: absolute; bottom: 0; left: 0; height: 3px; background: linear-gradient(90deg, #6366f1, #8b5cf6); width: ${pct}%; transition: width 0.4s ease;"></div>` : ''}
    </header>

    <div class="ce-body ${_editor.sideOpen ? 'side-open' : ''}">
      <!-- Icon rail -->
      <nav class="ce-rail" aria-label="Editor panels">
        ${EDITOR_SIDE_TABS.map(t => `
          <button type="button" class="ce-rail-btn ${_editor.sideTab === t.key ? 'is-active' : ''}"
            data-tab="${t.key}" title="${escAttr(t.label)}">
            ${_ceRailIcon(t.icon)}
            <span>${escHtml(t.label)}</span>
          </button>
        `).join('')}
      </nav>

      <!-- Side panel -->
      <aside class="ce-side">
        ${_ceSidePanelHtml(selected, selMeta, busy)}
      </aside>

      <!-- Main stage -->
      <section class="ce-main">
        <div class="ce-preview-wrap">
          <button type="button" class="ce-nav-btn ce-nav-prev" id="ce-prev" title="Previous clip">&#8249;</button>
          <div class="ce-preview-stage">
            <video id="ed-video" class="ce-video" playsinline preload="metadata"></video>
            <div class="ce-preview-overlay" id="ed-overlay">
              <span>Select a clip &middot; Space to play</span>
            </div>
            <div class="ce-preview-caption" id="ce-live-caption"></div>
          </div>
          <button type="button" class="ce-nav-btn ce-nav-next" id="ce-next" title="Next clip">&#8250;</button>
        </div>

        <div class="ce-info-bar">
          <span class="ce-pill">Clip ${selected ? (enabled.findIndex(c => c.id === selected.id) + 1) : '&#8212;'} / ${enabled.length}</span>
          <span class="ce-info-text" title="${escAttr(selMeta?.text || '')}">${escHtml((selMeta?.text || 'No clip selected').slice(0, 90))}</span>
          <span class="ce-info-meta">${selected ? _fmtEditorTime(_clipDuration(selected)) : '&#8212;'} &middot; Total ${_fmtEditorDur(total)}</span>
        </div>

        ${_ceRenderBannerHtml(er)}

        <!-- Timeline -->
        <div class="ce-timeline">
          <div class="ce-tl-toolbar">
            <!-- CapCut-style transport controls -->
            <div class="ce-transport">
              <button type="button" class="ce-transport-btn ce-transport-restart" id="ed-restart" title="Restart &amp; Play from beginning">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
              </button>
              <button type="button" class="ce-transport-btn ce-transport-play ${_editor.playing ? 'is-playing' : ''}" id="ed-play"
                title="${_editor.playing ? 'Pause (Space)' : 'Play from here (Space)'}">
                ${_editor.playing
                  ? '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>'
                  : '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>'
                }
              </button>
              <button type="button" class="ce-transport-btn ce-transport-stop" id="ed-stop" title="Stop">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
              </button>
            </div>

            <div class="ce-time-readout">
              <span id="ed-time-cur" class="ce-time-cur">${_fmtEditorTime(_editor.playhead)}</span>
              <span class="ce-time-sep">/</span>
              <span id="ed-time-total" class="ce-time-total">${_fmtEditorTime(total)}</span>
            </div>

            <div class="ce-tl-divider"></div>

            <div class="ce-tl-edit-tools" title="Edit selected clip">
              <button type="button" class="btn btn-sm btn-ghost" id="tl-trim-front" ${busy || !selected ? 'disabled' : ''} title="Trim 0.5s from front [">&#8656; Front</button>
              <button type="button" class="btn btn-sm btn-ghost" id="tl-trim-back"  ${busy || !selected ? 'disabled' : ''} title="Trim 0.5s from back ]">Back &#8658;</button>
              <button type="button" class="ce-cut-btn" id="tl-cut" ${busy || !selected ? 'disabled' : ''} title="Cut/split at playhead (S)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
                Split
              </button>
              <button type="button" class="btn btn-sm btn-danger" id="tl-delete" ${busy || !selected ? 'disabled' : ''} title="Delete selected (Del)">&#128465; Delete</button>
            </div>

            <div class="ce-zoom">
              <button type="button" class="ce-icon-btn" id="ed-zoom-out">&#8722;</button>
              <span>${Math.round((_editor.pxPerSec / 40) * 100)}%</span>
              <button type="button" class="ce-icon-btn" id="ed-zoom-in">+</button>
              <button type="button" class="ce-link" id="ed-zoom-fit">fit</button>
            </div>
            <button type="button" class="btn btn-sm btn-ghost" id="ed-reset-order" ${busy ? 'disabled' : ''}>Reset</button>
          </div>
          <div class="ce-timeline-multi">
            <!-- Left track headers -->
            <div class="ce-timeline-headers">
              <div class="ce-tl-header-spacer"></div>
              <div class="ce-tl-track-header ce-header-video">
                <span class="ce-hdr-icon">🎬</span>
                <span class="ce-hdr-label">Video</span>
              </div>
              <div class="ce-tl-track-header ce-header-bgm">
                <span class="ce-hdr-icon">🎵</span>
                <span class="ce-hdr-label">BGM</span>
              </div>
              <div class="ce-tl-track-header ce-header-voice">
                <span class="ce-hdr-icon">🎤</span>
                <span class="ce-hdr-label">Voice</span>
              </div>
              <div class="ce-tl-track-header ce-header-captions">
                <span class="ce-hdr-icon">💬</span>
                <span class="ce-hdr-label">Texts</span>
              </div>
            </div>

            <!-- Right timeline scroll area -->
            <div class="ce-tl-scroll" id="ed-timeline-scroll">
              <div class="ce-tl-inner" id="ed-track" style="width:${Math.max(640, total * _editor.pxPerSec + 48)}px">
                <div class="ce-ruler" id="ed-ruler">${_ceRulerHtml(total)}</div>
                
                <!-- Track 1: Video clips -->
                <div class="ce-track-row ce-row-video">
                  ${_ceTrackHtml()}
                </div>
                
                <!-- Track 2: BGM -->
                <div class="ce-track-row ce-row-bgm">
                  ${_ceBgmTrackHtml(total)}
                </div>
                
                <!-- Track 3: Voice -->
                <div class="ce-track-row ce-row-voice">
                  ${_ceVoiceTrackHtml(total)}
                </div>
                
                <!-- Track 4: Captions -->
                <div class="ce-track-row ce-row-captions">
                  ${_ceCaptionsTrackHtml()}
                </div>
                
                <div class="ce-playhead" id="ed-playhead" style="left:${12 + _editor.playhead * _editor.pxPerSec}px"></div>
              </div>
            </div>
          </div>
          ${(_editor.timeline.clips.some(c => c.enabled === false)) ? `
          <div class="ce-disabled-row">
            <span class="ce-disabled-label">Removed clips (click to restore):</span>
            ${_editor.timeline.clips.filter(c => c.enabled === false).map(item => {
              const m = _sourceMeta(item.sourceIndex);
              return `<button type="button" class="ce-disabled-chip" data-id="${escAttr(item.id)}">+ #${item.sourceIndex + 1} ${escHtml((m?.text || '').slice(0, 28))}</button>`;
            }).join('')}
          </div>` : ''}
        </div>
      </section>
    </div>

    ${busy || er.status === 'done' || er.status === 'failed' ? _ceRenderOverlayHtml(er) : ''}
  </div>`;

  _editor.video = document.getElementById('ed-video');
  _wireEditorEvents(busy);

  // Restore preview frame for current playhead (no jump-to-clip-start)
  if (selected) {
    _editorUpdatePlayheadUi();
    _editorSeekPreview(_editor.playhead);
  }
}

function _ceRailIcon(name) {
  const icons = {
    story: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
    visuals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>',
    elements: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>',
  };
  return icons[name] || icons.story;
}

function _ceSidePanelHtml(selected, selMeta, busy) {
  const tab = _editor.sideTab;
  if (tab === 'story') {
    const q = (_editor.search || '').toLowerCase();
    const list = _editor.timeline.clips.filter(c => {
      if (c.enabled === false) return false;
      if (!q) return true;
      const m = _sourceMeta(c.sourceIndex);
      return (m?.text || '').toLowerCase().includes(q) || String(c.sourceIndex + 1).includes(q);
    });
    return `
      <div class="ce-side-head">
        <h3>Story</h3>
        <p>All clips are assembled. Drag to re-order, click to select.</p>
        <div class="ce-story-header-row">
          <input type="search" id="ce-search" class="ce-search" placeholder="Search scenes&hellip;" value="${escAttr(_editor.search)}" ${busy ? 'disabled' : ''}/>
          <button type="button" class="btn btn-sm btn-primary ce-import-btn" id="ce-import-trigger" ${busy ? 'disabled' : ''} title="Import image or video">
            ➕ Import
          </button>
          <input type="file" id="ce-import-file" accept="image/*,video/*" style="display:none;" />
        </div>
      </div>
      <div class="ce-story-list" id="ce-story-list">
        ${list.map((item, i) => {
          const m = _sourceMeta(item.sourceIndex);
          const active = item.id === _editor.selectedId;
          return `
            <div class="ce-story-card ${active ? 'is-active' : ''}" data-id="${escAttr(item.id)}" draggable="${busy ? 'false' : 'true'}">
              <div class="ce-story-top">
                <span>Scene ${i + 1}</span>
                <button type="button" class="ce-mini-x" data-remove="${escAttr(item.id)}" title="Remove" ${busy ? 'disabled' : ''}>&times;</button>
              </div>
              <p>${escHtml((m?.text || `Clip ${item.sourceIndex + 1}`).slice(0, 120))}</p>
              <div class="ce-story-meta">
                <span class="ce-badge-vid">VID</span>
                <span>${_fmtEditorTime(_clipDuration(item))}</span>
                ${item.transition && item.transition !== 'none' ? `<span class="ce-badge-fx" title="${escAttr(_editorTransDef(item.transition).hint)}">${escHtml(_editorTransDef(item.transition).label)}${item.transitionDuration ? ` ${Number(item.transitionDuration).toFixed(1)}s` : ''}</span>` : ''}
              </div>
            </div>`;
        }).join('') || '<p class="ce-empty">No matching clips.</p>'}
      </div>`;
  }

  if (tab === 'clip') {
    if (!selected) return `<div class="ce-side-head"><h3>Clip</h3><p class="ce-empty">Select a clip on the timeline.</p></div>`;
    const maxDur = selMeta?.duration || selected.trimEnd || 10;
    const t0 = Number(selected.trimStart || 0);
    const t1 = Number(selected.trimEnd || maxDur);
    const used = _clipDuration(selected);
    const frontCut = t0;
    const backCut = Math.max(0, maxDur - t1);
    return `
      <div class="ce-side-head">
        <h3>Clip #${selected.sourceIndex + 1}</h3>
        <p>${escHtml((selMeta?.text || '').slice(0, 140))}</p>
      </div>
      <div class="ce-fields">
        <div class="ce-trim-card">
          <div class="ce-trim-title">Trim this clip</div>
          <div class="ce-trim-visual" aria-hidden="true">
            <div class="ce-trim-unused ce-trim-unused-l" style="width:${maxDur > 0 ? (frontCut / maxDur) * 100 : 0}%"></div>
            <div class="ce-trim-used" style="width:${maxDur > 0 ? (used / maxDur) * 100 : 100}%"></div>
            <div class="ce-trim-unused ce-trim-unused-r" style="width:${maxDur > 0 ? (backCut / maxDur) * 100 : 0}%"></div>
          </div>
          <div class="ce-trim-labels">
            <span>Front cut: ${_fmtEditorTime(frontCut)}</span>
            <span>Keep: ${_fmtEditorTime(used)}</span>
            <span>Back cut: ${_fmtEditorTime(backCut)}</span>
          </div>

          <label class="ce-trim-row">Trim from <strong>front</strong> (in-point)
            <div class="ce-trim-controls">
              <button type="button" class="ce-nudge" id="ce-trim-front-minus" title="Cut 0.5s more from front" ${busy ? 'disabled' : ''}>-0.5s</button>
              <input type="range" id="ed-trim-start-range" min="0" max="${Math.max(0.05, maxDur - 0.05)}" step="0.05"
                value="${t0.toFixed(2)}" ${busy ? 'disabled' : ''}/>
              <button type="button" class="ce-nudge" id="ce-trim-front-plus" title="Keep 0.5s more at front" ${busy ? 'disabled' : ''}>+0.5s</button>
              <input type="number" id="ed-trim-start" min="0" max="${maxDur}" step="0.05"
                value="${t0.toFixed(2)}" ${busy ? 'disabled' : ''}/>
            </div>
          </label>

          <label class="ce-trim-row">Trim from <strong>back</strong> (out-point)
            <div class="ce-trim-controls">
              <button type="button" class="ce-nudge" id="ce-trim-back-minus" title="Cut 0.5s more from back" ${busy ? 'disabled' : ''}>-0.5s</button>
              <input type="range" id="ed-trim-end-range" min="0.05" max="${maxDur}" step="0.05"
                value="${t1.toFixed(2)}" ${busy ? 'disabled' : ''}/>
              <button type="button" class="ce-nudge" id="ce-trim-back-plus" title="Keep 0.5s more at back" ${busy ? 'disabled' : ''}>+0.5s</button>
              <input type="number" id="ed-trim-end" min="0" max="${maxDur}" step="0.05"
                value="${t1.toFixed(2)}" ${busy ? 'disabled' : ''}/>
            </div>
          </label>

          <div class="ce-trim-actions">
            <button type="button" class="btn btn-sm btn-ghost" id="ce-trim-reset" ${busy ? 'disabled' : ''}>Reset full length</button>
            <button type="button" class="btn btn-sm btn-secondary" id="ce-trim-to-playhead-in" ${busy ? 'disabled' : ''}>Set in @ playhead</button>
            <button type="button" class="btn btn-sm btn-secondary" id="ce-trim-to-playhead-out" ${busy ? 'disabled' : ''}>Set out @ playhead</button>
          </div>
        </div>

        <div class="ce-edit-actions">
          <button type="button" class="btn btn-sm btn-primary" id="ed-split" ${busy ? 'disabled' : ''}>&#9986; Cut / Split</button>
          <button type="button" class="btn btn-sm btn-danger" id="ed-delete" ${busy ? 'disabled' : ''}>&#128465; Delete clip</button>
        </div>

        <label>Transition in
          <select id="ed-transition" ${busy ? 'disabled' : ''}>
            <optgroup label="Basic">
              ${EDITOR_TRANSITIONS.filter(t => t.kind === 'cut' || t.kind === 'mix').map(t => `
                <option value="${t.id}" ${selected.transition === t.id ? 'selected' : ''} title="${escAttr(t.hint)}">${escHtml(t.label)}</option>
              `).join('')}
            </optgroup>
            <optgroup label="Crossfade / xfade">
              ${EDITOR_TRANSITIONS.filter(t => t.kind === 'xfade').map(t => `
                <option value="${t.id}" ${selected.transition === t.id ? 'selected' : ''} title="${escAttr(t.hint)}">${escHtml(t.label)}</option>
              `).join('')}
            </optgroup>
          </select>
        </label>
        <label>Transition length (s)
          <input type="number" id="ed-trans-dur" min="0" max="2" step="0.05"
            value="${Number(selected.transitionDuration ?? _editorDefaultTransDur(_editor.timeline)).toFixed(2)}"
            ${busy || (selected.transition || 'none') === 'none' ? 'disabled' : ''}/>
        </label>
        <p class="ce-hint">${escHtml(_editorTransDef(selected.transition || 'none').hint)}. <strong>Mix @ 0.5s</strong> blends clips together (no black dip). Use <strong>Fade black</strong> only if you want a fade through black. Source ${_fmtEditorTime(maxDur)}. <kbd>S</kbd> cut &middot; <kbd>Del</kbd> delete.</p>
      </div>`;
  }

  if (tab === 'audio') {
    const bgm = _editor.timeline.bgMusic || {};
    const vt  = _editor.timeline.voiceTrack || {};
    return `
      <div class="ce-side-head">
        <h3>Audio</h3>
        <p>Add background music or a voice track to your video.</p>
      </div>
      <div class="ce-fields">
        <label>Audio mode
          <select id="ed-audio-mode" ${busy ? 'disabled' : ''}>
            <option value="acted" ${_editor.timeline.audioMode === 'acted' ? 'selected' : ''}>Acted — lip-synced clip talking + BGM + SFX (like Acted video)</option>
            <option value="voice" ${_editor.timeline.audioMode === 'voice' ? 'selected' : ''}>Voice — narration + mix (no clip talking)</option>
            <option value="silent" ${_editor.timeline.audioMode === 'silent' ? 'selected' : ''}>Clip talking only (no BGM / SFX / voiceover)</option>
          </select>
        </label>

        <!-- Background Music card -->
        <div class="ce-audio-card">
          <div class="ce-audio-card-header">
            <div class="ce-audio-card-icon ce-audio-icon-music">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
              </svg>
            </div>
            <div class="ce-audio-card-info">
              <div class="ce-audio-card-title">Background Music</div>
              <div class="ce-audio-card-sub">${bgm.filename ? escHtml(bgm.filename) : 'No file selected'}</div>
            </div>
            <label class="ce-audio-toggle" title="${bgm.enabled ? 'Disable BGM' : 'Enable BGM'}">
              <input type="checkbox" id="ce-bgm-enabled" ${bgm.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}/>
              <span class="ce-toggle-pill"></span>
            </label>
          </div>
          <div class="ce-audio-drop-zone ${bgm.filename ? 'has-file' : ''}" id="ce-bgm-drop">
            <input type="file" id="ce-bgm-file" accept="audio/*" class="ce-audio-file-input" ${busy ? 'disabled' : ''}/>
            <div class="ce-audio-drop-content">
              ${bgm.filename
                ? `<div class="ce-audio-file-name">&#127925; ${escHtml(bgm.filename)}</div>`
                : `<div class="ce-audio-drop-icon">&#127925;</div>
                   <div class="ce-audio-drop-text">Drop MP3 / AAC / WAV here</div>
                   <div class="ce-audio-drop-sub">or click to browse</div>`
              }
            </div>
          </div>
          ${bgm.filename ? `
          <div class="ce-audio-vol-row">
            <label class="ce-audio-vol-label">Volume</label>
            <input type="range" id="ce-bgm-vol" min="0" max="1" step="0.05" value="${Number(bgm.volume ?? 0.4).toFixed(2)}" ${busy ? 'disabled' : ''}/>
            <span id="ce-bgm-vol-val" class="ce-audio-vol-val">${Math.round(Number(bgm.volume ?? 0.4) * 100)}%</span>
          </div>
          <button type="button" class="ce-audio-remove-btn" id="ce-bgm-remove" ${busy ? 'disabled' : ''}>&times; Remove track</button>
          ` : ''}
        </div>

        <!-- Voice / Narration card -->
        <div class="ce-audio-card">
          <div class="ce-audio-card-header">
            <div class="ce-audio-card-icon ce-audio-icon-voice">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
              </svg>
            </div>
            <div class="ce-audio-card-info">
              <div class="ce-audio-card-title">Voice / Narration</div>
              <div class="ce-audio-card-sub">${vt.filename ? escHtml(vt.filename) : 'No file selected'}</div>
            </div>
            <label class="ce-audio-toggle" title="${vt.enabled ? 'Disable voice track' : 'Enable voice track'}">
              <input type="checkbox" id="ce-vt-enabled" ${vt.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}/>
              <span class="ce-toggle-pill"></span>
            </label>
          </div>
          <div class="ce-audio-drop-zone ${vt.filename ? 'has-file' : ''}" id="ce-vt-drop">
            <input type="file" id="ce-vt-file" accept="audio/*" class="ce-audio-file-input" ${busy ? 'disabled' : ''}/>
            <div class="ce-audio-drop-content">
              ${vt.filename
                ? `<div class="ce-audio-file-name">&#127908; ${escHtml(vt.filename)}</div>`
                : `<div class="ce-audio-drop-icon">&#127908;</div>
                   <div class="ce-audio-drop-text">Drop MP3 / AAC / WAV here</div>
                   <div class="ce-audio-drop-sub">or click to browse</div>`
              }
            </div>
          </div>
          ${vt.filename ? `
          <div class="ce-audio-vol-row">
            <label class="ce-audio-vol-label">Volume</label>
            <input type="range" id="ce-vt-vol" min="0" max="1" step="0.05" value="${Number(vt.volume ?? 1.0).toFixed(2)}" ${busy ? 'disabled' : ''}/>
            <span id="ce-vt-vol-val" class="ce-audio-vol-val">${Math.round(Number(vt.volume ?? 1.0) * 100)}%</span>
          </div>
          <button type="button" class="ce-audio-remove-btn" id="ce-vt-remove" ${busy ? 'disabled' : ''}>&times; Remove track</button>
          ` : ''}
        </div>

        <p class="ce-hint">Audio files are uploaded and mixed during Render. Preview plays clip video only.</p>
      </div>`;
  }

  if (tab === 'text') {
    const cap = _editor.timeline.captions || {};
    return `
      <div class="ce-side-head"><h3>Captions</h3><p>Burn job captions into the edited export when available.</p></div>
      <div class="ce-fields">
        <label class="ce-toggle-row">
          <span>Show captions on export</span>
          <input type="checkbox" id="ce-cap-enabled" ${cap.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}/>
        </label>
        <label>Position
          <div class="ce-seg-btns" id="ce-cap-pos">
            ${['top', 'center', 'bottom'].map(p => `
              <button type="button" data-pos="${p}" class="${cap.position === p ? 'is-on' : ''}" ${busy ? 'disabled' : ''}>${p}</button>
            `).join('')}
          </div>
        </label>
        <label>Style
          <div class="ce-seg-btns" id="ce-cap-style">
            ${['normal', 'bold', 'shadow', 'outline', 'box'].map(s => `
              <button type="button" data-style="${s}" class="${cap.style === s ? 'is-on' : ''}" ${busy ? 'disabled' : ''}>${s}</button>
            `).join('')}
          </div>
        </label>
        <p class="ce-hint">Uses the job's caption track (ASS) when present.</p>
      </div>`;
  }

  // layout
  const defTr = _editor.timeline.defaultTransition || DEFAULT_TRANSITION;
  const defDur = _editorDefaultTransDur(_editor.timeline);
  return `
    <div class="ce-side-head"><h3>Layout</h3><p>Output resolution and default transitions between clips.</p></div>
    <div class="ce-fields">
      <label>Resolution
        <select id="ce-resolution" ${busy ? 'disabled' : ''}>
          <option value="1920x1080" ${_editor.timeline.resolution === '1920x1080' ? 'selected' : ''}>1080p Full HD</option>
          <option value="1280x720" ${_editor.timeline.resolution === '1280x720' ? 'selected' : ''}>720p HD</option>
          <option value="3840x2160" ${_editor.timeline.resolution === '3840x2160' ? 'selected' : ''}>4K</option>
        </select>
      </label>
      <label>Default transition
        <div class="ce-seg-btns ce-trans-btns" id="ce-def-trans">
          ${EDITOR_TRANSITIONS.filter(t => t.kind === 'cut' || t.kind === 'mix' || t.id === 'fade' || t.id === 'fadeblack' || t.id === 'slideleft').map(t => `
            <button type="button" data-tr="${t.id}" class="${defTr === t.id ? 'is-on' : ''}" ${busy ? 'disabled' : ''} title="${escAttr(t.hint)}">${escHtml(t.label)}</button>
          `).join('')}
        </div>
      </label>
      <label>More transitions
        <select id="ce-def-trans-more" ${busy ? 'disabled' : ''}>
          ${EDITOR_TRANSITIONS.map(t => `
            <option value="${t.id}" ${defTr === t.id ? 'selected' : ''}>${escHtml(t.label)} — ${escHtml(t.hint)}</option>
          `).join('')}
        </select>
      </label>
      <label>Default length (s)
        <input type="number" id="ce-def-trans-dur" min="0" max="2" step="0.05"
          value="${defDur.toFixed(2)}"
          ${busy || defTr === 'none' ? 'disabled' : ''}/>
      </label>
      <button type="button" class="btn btn-sm btn-secondary" id="ce-apply-trans-all" ${busy ? 'disabled' : ''}>
        Apply default transition to all cuts
      </button>
      <p class="ce-hint">
        <strong>Cut</strong> = hard cut · <strong>Mix</strong> = opacity dissolve between clips (recommended for acted, try 0.5s) ·
        <strong>Fade black</strong> = dips through black ·
        <strong>Slides / wipes</strong> = fancy xfade (Voice mode; Acted auto-converts them to Mix).
      </p>
      <p class="ce-hint">Space = play/pause &middot; Drag timeline to scrub &middot; Ctrl+Z undo</p>
    </div>`;
}

function _ceRulerHtml(total) {
  const step = _editor.pxPerSec >= 60 ? 1 : _editor.pxPerSec >= 30 ? 2 : 5;
  const marks = [];
  for (let t = 0; t <= total + step; t += step) {
    marks.push(`<span class="ce-ruler-mark" style="left:${12 + t * _editor.pxPerSec}px">${t}s</span>`);
  }
  return marks.join('');
}

function _ceTrackHtml() {
  let x = 12;
  return _editor.timeline.clips.map((item) => {
    if (item.enabled === false) return '';
    const dur = _clipDuration(item);
    const w = Math.max(40, dur * _editor.pxPerSec);
    const left = x;
    x += w + 2;
    const meta = _sourceMeta(item.sourceIndex);
    const label = meta?.text || `Clip ${item.sourceIndex + 1}`;
    const selected = item.id === _editor.selectedId ? ' is-selected' : '';
    const color = EDITOR_COLORS[item.sourceIndex % EDITOR_COLORS.length];
    const maxDur = meta?.duration || item.trimEnd || dur;
    const frontPct = maxDur > 0 ? Math.min(40, ((item.trimStart || 0) / maxDur) * 100) : 0;
    const backPct = maxDur > 0 ? Math.min(40, (Math.max(0, maxDur - (item.trimEnd || maxDur)) / maxDur) * 100) : 0;
    const trLabel = item.transition && item.transition !== 'none'
      ? `${_editorTransDef(item.transition).label}${item.transitionDuration ? ` ${Number(item.transitionDuration).toFixed(1)}s` : ''}`
      : '';
    const transBadge = trLabel
      ? `<span class="ce-trans-badge" title="${escAttr(trLabel + ' — ' + _editorTransDef(item.transition).hint)}">&#8631; ${escHtml(_editorTransDef(item.transition).label)}</span>` : '';
    
    // Resolve cache-busted AI-generated thumbnail url for clip
    const frameUrl = mediaUrl(`/api/jobs/${_editor.jobId}/preview/frame/${item.sourceIndex}`);

    return `
      <div class="ce-clip${selected}" data-id="${escAttr(item.id)}"
        style="left:${left}px;width:${w}px;--clip-color:${color};background-image:linear-gradient(rgba(0,0,0,0.52), rgba(0,0,0,0.72)), url('${frameUrl}');background-size:cover;background-position:center;">
        ${transBadge}
        <div class="ce-clip-handle ce-clip-handle-l" data-handle="start" title="Drag to trim from FRONT">
          <span class="ce-handle-grip"></span>
        </div>
        <div class="ce-clip-body" data-drag-body="1" draggable="true" title="Drag middle to reorder">
          <span class="ce-clip-num">#${item.sourceIndex + 1}</span>
          <span class="ce-clip-name">${escHtml(label.slice(0, 40))}</span>
          <span class="ce-clip-dur">${escHtml(_fmtEditorTime(dur))}</span>
          ${(frontPct > 0.5 || backPct > 0.5) ? `<span class="ce-clip-trim-tag">trimmed</span>` : ''}
        </div>
        <div class="ce-clip-handle ce-clip-handle-r" data-handle="end" title="Drag to trim from BACK">
          <span class="ce-handle-grip"></span>
        </div>
      </div>`;
  }).join('');
}

function _ceBgmTrackHtml(total) {
  const bgm = _editor.timeline.bgMusic;
  if (!bgm || !bgm.filename || bgm.enabled === false) return '';
  const w = total * _editor.pxPerSec;
  return `
    <div class="ce-audio-track-bar ce-bgm-bar" style="left:12px;width:${w}px">
      <span class="ce-audio-track-icon">🎵</span>
      <span class="ce-audio-track-name">${escHtml(bgm.filename)}</span>
      <span class="ce-audio-track-vol">Volume: ${Math.round((bgm.volume ?? 0.4) * 100)}%</span>
    </div>`;
}

function _ceVoiceTrackHtml(total) {
  const vt = _editor.timeline.voiceTrack;
  if (!vt || !vt.filename || vt.enabled === false) return '';
  const w = total * _editor.pxPerSec;
  return `
    <div class="ce-audio-track-bar ce-voice-bar" style="left:12px;width:${w}px">
      <span class="ce-audio-track-icon">🎤</span>
      <span class="ce-audio-track-name">${escHtml(vt.filename)}</span>
      <span class="ce-audio-track-vol">Volume: ${Math.round((vt.volume ?? 1.0) * 100)}%</span>
    </div>`;
}

function _ceCaptionsTrackHtml() {
  if (!_editor.timeline.captions?.enabled) return '';
  let x = 12;
  return _editor.timeline.clips.map((item) => {
    if (item.enabled === false) return '';
    const dur = _clipDuration(item);
    const w = Math.max(40, dur * _editor.pxPerSec);
    const left = x;
    x += w + 2;
    const meta = _sourceMeta(item.sourceIndex);
    if (!meta?.text) return '';
    return `
      <div class="ce-caption-track-bar" style="left:${left}px;width:${w}px" title="${escAttr(meta.text)}">
        <span>${escHtml(meta.text.slice(0, 30))}</span>
      </div>`;
  }).join('');
}


function _ceRenderPercent(er) {
  if (typeof _editRenderPercent === 'function') return _editRenderPercent(er);
  if (!er) return 0;
  if (er.status === 'done') return 100;
  const p = er.progress || {};
  if (typeof p.percent === 'number') return Math.max(0, Math.min(100, Math.round(p.percent)));
  if (p.total) return Math.min(100, Math.round(100 * (p.done || 0) / p.total));
  return er.status === 'rendering' ? 45 : 10;
}

function _cePhaseLabel(phase) {
  if (typeof _editRenderPhaseLabel === 'function') return _editRenderPhaseLabel(phase);
  return phase || 'Working';
}

function _ceRenderBannerHtml(er) {
  if (!er || !er.status || er.status === 'idle') {
    if (_editor?.assets?.edited) {
      return `<div class="edit-render-banner edit-render-done" id="ce-render-banner">
        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem;">
          <strong>Last edit ready</strong>
          <a class="btn btn-sm btn-primary" href="${escAttr(mediaUrl(`/api/jobs/${_editor.jobId}/download/edited`))}" download>⬇ Download MP4</a>
          <button type="button" class="btn btn-sm btn-secondary" id="ce-render-banner-btn">🔄 Re-render</button>
        </div>
        <span class="ce-hint" style="display:block; margin-top:0.35rem;">Re-render applies current transitions (Mix), trims, and audio to a new edited.mp4.</span>
      </div>`;
    }
    return `<div class="edit-render-banner" id="ce-render-banner" style="opacity:0.9;">
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem;">
        <strong>Ready to render</strong>
        <button type="button" class="btn btn-sm btn-primary" id="ce-render-banner-btn">▶ Render video</button>
      </div>
      <span class="ce-hint" style="display:block; margin-top:0.35rem;">Assembles all clips with your Mix transitions into one downloadable MP4.</span>
    </div>`;
  }
  if (er.status === 'queued' || er.status === 'rendering') {
    const phase = er.progress?.phase || er.status;
    const done = er.progress?.done ?? 0;
    const total = er.progress?.total ?? 0;
    const pct = _ceRenderPercent(er);
    return `<div class="edit-render-banner edit-render-busy edit-render-banner-progress" id="ce-render-banner">
      <div class="edit-render-progress-head">
        <strong>Rendering on server</strong>
        <span class="edit-render-pct">${pct}%</span>
      </div>
      <div class="edit-render-progress-track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="edit-render-progress-fill" id="ce-banner-bar" style="width:${pct}%"></div>
      </div>
      <div class="edit-render-progress-meta">
        <span id="ce-banner-phase">${escHtml(_cePhaseLabel(phase))}${total ? ` · ${done}/${total} clips` : ''}</span>
        <span>Safe to leave — download when finished</span>
      </div>
    </div>`;
  }
  if (er.status === 'failed') {
    return `<div class="edit-render-banner edit-render-failed" id="ce-render-banner">
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem;">
        <strong>Render failed:</strong> ${escHtml(er.error || 'Unknown error')}
        <button type="button" class="btn btn-sm btn-primary" id="ce-render-banner-btn">▶ Retry render</button>
      </div>
    </div>`;
  }
  if (er.status === 'done') {
    return `<div class="edit-render-banner edit-render-done" id="ce-render-banner">
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem;">
        <strong>Render complete!</strong>
        <a class="btn btn-sm btn-primary" href="${escAttr(mediaUrl(`/api/jobs/${_editor.jobId}/download/edited`))}" download>⬇ Download MP4</a>
        <button type="button" class="btn btn-sm btn-secondary" id="ce-render-banner-btn">🔄 Re-render</button>
      </div>
      <span class="ce-hint" style="display:block; margin-top:0.35rem;">Changed Mix / trims / audio? Re-render to rebuild the full video.</span>
    </div>`;
  }
  return '';
}

function _ceRenderOverlayHtml(er) {
  if (er.status === 'queued' || er.status === 'rendering') {
    const pct = _ceRenderPercent(er);
    const phase = er.progress?.phase || er.status;
    const done = er.progress?.done ?? 0;
    const total = er.progress?.total ?? 0;
    return `
      <div class="ce-overlay" id="ce-overlay-modal">
        <div class="ce-modal">
          <div class="ce-spinner"></div>
          <h3>Rendering your video&hellip;</h3>
          <p id="ce-overlay-phase">${escHtml(_cePhaseLabel(phase))}${total ? ` · ${done}/${total} clips` : ''}</p>
          <div class="ce-progress"><div id="ce-overlay-bar" style="width:${pct}%"></div></div>
          <p class="ce-overlay-pct" id="ce-overlay-pct">${pct}%</p>
          <p class="ce-hint">You can close this tab. The worker keeps rendering; download when you return.</p>
          <button type="button" class="btn btn-ghost" id="ce-dismiss-overlay">Work in background</button>
        </div>
      </div>`;
  }
  if (er.status === 'done') {
    return `
      <div class="ce-overlay" id="ce-overlay-modal">
        <div class="ce-modal">
          <div class="ce-success-icon">&#10003;</div>
          <h3>Render complete!</h3>
          <p>Your edited video is ready to download.</p>
          <video controls class="ce-modal-video" src="${escAttr(mediaUrl(`/api/jobs/${_editor.jobId}/preview/edited`))}&_t=${Date.now()}"></video>
          <div class="ce-modal-actions">
            <a class="btn btn-primary" href="${escAttr(mediaUrl(`/api/jobs/${_editor.jobId}/download/edited`))}" download>⬇ Download MP4</a>
            <button type="button" class="btn btn-secondary" id="ce-overlay-rerender">🔄 Re-render</button>
            <button type="button" class="btn btn-ghost" id="ce-dismiss-overlay">Close</button>
          </div>
        </div>
      </div>`;
  }
  if (er.status === 'failed') {
    return `
      <div class="ce-overlay" id="ce-overlay-modal">
        <div class="ce-modal">
          <div class="ce-fail-icon">&#10007;</div>
          <h3>Render failed</h3>
          <p>${escHtml(er.error || 'Unknown error')}</p>
          <div class="ce-modal-actions">
            <button type="button" class="btn btn-primary" id="ce-overlay-rerender">▶ Retry render</button>
            <button type="button" class="btn btn-ghost" id="ce-dismiss-overlay">Close</button>
          </div>
        </div>
      </div>`;
  }
  return '';
}

// ── events ───────────────────────────────────────────────────
function _wireEditorEvents(busy) {
  if (!_editor) return;

  document.getElementById('ce-undo')?.addEventListener('click', () => _editorUndo());
  document.getElementById('ce-redo')?.addEventListener('click', () => _editorRedo());
  document.getElementById('ce-save')?.addEventListener('click', () => _editorSave());
  document.getElementById('ce-render')?.addEventListener('click', () => _editorRender());
  document.getElementById('ce-render-banner-btn')?.addEventListener('click', () => _editorRender());
  document.getElementById('ce-overlay-rerender')?.addEventListener('click', () => {
    document.getElementById('ce-overlay-modal')?.remove();
    _editorRender();
  });

  // Transport controls
  document.getElementById('ed-play')?.addEventListener('click', () => _editorTogglePlay());
  document.getElementById('ed-stop')?.addEventListener('click', () => {
    _editorStop();
    // Stop leaves playhead where it is — does NOT reset to 0
  });
  document.getElementById('ed-restart')?.addEventListener('click', () => {
    _editorStop();
    _editor.playhead = 0;
    _editorUpdatePlayheadUi();
    _editorSeekPreview(0);
    setTimeout(() => _editorTogglePlay(), 80);
  });

  document.getElementById('ed-zoom-in')?.addEventListener('click', () => { _editor.pxPerSec = Math.min(140, _editor.pxPerSec + 12); _paintEditor(); });
  document.getElementById('ed-zoom-out')?.addEventListener('click', () => { _editor.pxPerSec = Math.max(14, _editor.pxPerSec - 12); _paintEditor(); });
  document.getElementById('ed-zoom-fit')?.addEventListener('click', () => {
    const total = Math.max(1, _timelineTotal(_editor.timeline));
    const w = document.getElementById('ed-timeline-scroll')?.clientWidth || 800;
    _editor.pxPerSec = Math.max(14, Math.min(100, (w - 48) / total));
    _paintEditor();
  });
  document.getElementById('ce-dismiss-overlay')?.addEventListener('click', () => {
    document.getElementById('ce-overlay-modal')?.remove();
  });

  document.querySelectorAll('.ce-rail-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _editor.sideTab = btn.dataset.tab;
      _editor.sideOpen = true;
      _paintEditor();
    });
  });

  document.getElementById('ce-search')?.addEventListener('input', (e) => {
    _editor.search = e.target.value;
    _paintEditor();
    const s = document.getElementById('ce-search');
    if (s) { s.focus(); s.selectionStart = s.selectionEnd = s.value.length; }
  });

  // Wire import media trigger
  document.getElementById('ce-import-trigger')?.addEventListener('click', () => {
    document.getElementById('ce-import-file')?.click();
  });
  document.getElementById('ce-import-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) _editorImportMedia(file);
  });

  document.getElementById('ce-prev')?.addEventListener('click', () => _editorStepClip(-1));
  document.getElementById('ce-next')?.addEventListener('click', () => _editorStepClip(1));

  // Timeline edit tools
  document.getElementById('tl-trim-front')?.addEventListener('click', () => _editorNudgeTrim('front', 0.5));
  document.getElementById('tl-trim-back')?.addEventListener('click', () => _editorNudgeTrim('back', 0.5));
  document.getElementById('tl-cut')?.addEventListener('click', () => _editorSplitAtPlayhead());
  document.getElementById('tl-delete')?.addEventListener('click', () => _editorDeleteSelected(true));

  document.getElementById('ed-reset-order')?.addEventListener('click', () => {
    if (busy) return;
    showConfirm(
      'Reset timeline',
      'Restore original clip order and full lengths?',
      () => {
        _editor.timeline.clips = _editor.sourceClips.map((c, i) => ({
          id: `c${i}-${c.index}`,
          sourceIndex: c.index,
          enabled: true,
          trimStart: 0,
          trimEnd: Number((c.duration || 0).toFixed(3)),
          speed: 1,
          transition: i === 0 ? 'none' : (_editor.timeline.defaultTransition || DEFAULT_TRANSITION),
          transitionDuration: i === 0 ? 0 : _editorDefaultTransDur(_editor.timeline),
        }));
        _editor.selectedId = _editor.timeline.clips[0]?.id || null;
        _editor.playhead = 0;
        _editorPushHistory();
        _paintEditor();
        showToast('Timeline reset.', 'success');
      },
      'Reset',
      true
    );
  });

  // Story list
  document.querySelectorAll('.ce-story-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.ce-mini-x')) return;
      _editor.selectedId = card.dataset.id;
      _editor.sideTab = 'clip';
      _jumpToClip(card.dataset.id);
      _paintEditor();
    });
    card.addEventListener('dragstart', (e) => {
      if (busy) { e.preventDefault(); return; }
      _editor.dragId = card.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', card.dataset.id); } catch (_) {}
    });
    card.addEventListener('dragover', (e) => { e.preventDefault(); });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromId = _editor.dragId || e.dataTransfer.getData('text/plain');
      if (fromId && fromId !== card.dataset.id) {
        _editorReorder(fromId, card.dataset.id);
      }
    });
  });
  document.querySelectorAll('.ce-mini-x').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = _editor.timeline.clips.find(c => c.id === btn.dataset.remove);
      if (!item) return;
      item.enabled = false;
      _editorPushHistory();
      _paintEditor();
    });
  });
  document.querySelectorAll('.ce-disabled-chip').forEach(el => {
    el.addEventListener('click', () => {
      const item = _editor.timeline.clips.find(c => c.id === el.dataset.id);
      if (!item) return;
      item.enabled = true;
      _editor.selectedId = item.id;
      _editorPushHistory();
      _paintEditor();
    });
  });

  // Clip fields
  if (!busy) {
    document.getElementById('ed-audio-mode')?.addEventListener('change', (e) => {
      _editor.timeline.audioMode = e.target.value;
      _editorPushHistory();
    });

    // ── Audio track events ──────────────────────────────────────
    // BGM toggle
    document.getElementById('ce-bgm-enabled')?.addEventListener('change', (e) => {
      _editor.timeline.bgMusic = _editor.timeline.bgMusic || {};
      _editor.timeline.bgMusic.enabled = e.target.checked;
      _editorPushHistory();
    });
    // BGM file pick
    document.getElementById('ce-bgm-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) _editorUploadAudioTrack('bgMusic', file);
    });
    document.getElementById('ce-bgm-drop')?.addEventListener('click', (e) => {
      if (!e.target.closest('input')) document.getElementById('ce-bgm-file')?.click();
    });
    document.getElementById('ce-bgm-drop')?.addEventListener('dragover', (e) => {
      e.preventDefault(); e.currentTarget.classList.add('drag-over');
    });
    document.getElementById('ce-bgm-drop')?.addEventListener('dragleave', (e) => {
      e.currentTarget.classList.remove('drag-over');
    });
    document.getElementById('ce-bgm-drop')?.addEventListener('drop', (e) => {
      e.preventDefault(); e.currentTarget.classList.remove('drag-over');
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith('audio/')) _editorUploadAudioTrack('bgMusic', file);
    });
    document.getElementById('ce-bgm-vol')?.addEventListener('input', (e) => {
      _editor.timeline.bgMusic = _editor.timeline.bgMusic || {};
      _editor.timeline.bgMusic.volume = Number(e.target.value);
      const val = document.getElementById('ce-bgm-vol-val');
      if (val) val.textContent = `${Math.round(Number(e.target.value) * 100)}%`;
    });
    document.getElementById('ce-bgm-vol')?.addEventListener('change', () => _editorPushHistory());
    document.getElementById('ce-bgm-remove')?.addEventListener('click', () => {
      _editor.timeline.bgMusic = { enabled: false, filename: '', volume: 0.4, url: '' };
      _editorPushHistory();
      _paintEditor();
    });

    // Voice track
    document.getElementById('ce-vt-enabled')?.addEventListener('change', (e) => {
      _editor.timeline.voiceTrack = _editor.timeline.voiceTrack || {};
      _editor.timeline.voiceTrack.enabled = e.target.checked;
      _editorPushHistory();
    });
    document.getElementById('ce-vt-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) _editorUploadAudioTrack('voiceTrack', file);
    });
    document.getElementById('ce-vt-drop')?.addEventListener('click', (e) => {
      if (!e.target.closest('input')) document.getElementById('ce-vt-file')?.click();
    });
    document.getElementById('ce-vt-drop')?.addEventListener('dragover', (e) => {
      e.preventDefault(); e.currentTarget.classList.add('drag-over');
    });
    document.getElementById('ce-vt-drop')?.addEventListener('dragleave', (e) => {
      e.currentTarget.classList.remove('drag-over');
    });
    document.getElementById('ce-vt-drop')?.addEventListener('drop', (e) => {
      e.preventDefault(); e.currentTarget.classList.remove('drag-over');
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith('audio/')) _editorUploadAudioTrack('voiceTrack', file);
    });
    document.getElementById('ce-vt-vol')?.addEventListener('input', (e) => {
      _editor.timeline.voiceTrack = _editor.timeline.voiceTrack || {};
      _editor.timeline.voiceTrack.volume = Number(e.target.value);
      const val = document.getElementById('ce-vt-vol-val');
      if (val) val.textContent = `${Math.round(Number(e.target.value) * 100)}%`;
    });
    document.getElementById('ce-vt-vol')?.addEventListener('change', () => _editorPushHistory());
    document.getElementById('ce-vt-remove')?.addEventListener('click', () => {
      _editor.timeline.voiceTrack = { enabled: false, filename: '', volume: 1.0, url: '' };
      _editorPushHistory();
      _paintEditor();
    });

    const bindTrimStart = (raw) => {
      const item = _editorSelected();
      if (!item) return;
      const meta = _sourceMeta(item.sourceIndex);
      const max = meta?.duration || item.trimEnd || 10;
      const end = item.trimEnd ?? max;
      let v = Math.max(0, Math.min(Number(raw) || 0, end - 0.05));
      item.trimStart = Number(v.toFixed(3));
      _editorPushHistory();
      _paintEditor();
    };
    const bindTrimEnd = (raw) => {
      const item = _editorSelected();
      if (!item) return;
      const meta = _sourceMeta(item.sourceIndex);
      const max = meta?.duration || 9999;
      const start = item.trimStart || 0;
      let v = Math.min(max, Math.max(Number(raw) || 0, start + 0.05));
      item.trimEnd = Number(v.toFixed(3));
      _editorPushHistory();
      _paintEditor();
    };

    document.getElementById('ed-trim-start')?.addEventListener('change', (e) => bindTrimStart(e.target.value));
    document.getElementById('ed-trim-end')?.addEventListener('change', (e) => bindTrimEnd(e.target.value));
    document.getElementById('ed-trim-start-range')?.addEventListener('input', (e) => {
      const item = _editorSelected();
      if (!item) return;
      const meta = _sourceMeta(item.sourceIndex);
      const max = meta?.duration || item.trimEnd || 10;
      const end = item.trimEnd ?? max;
      item.trimStart = Number(Math.max(0, Math.min(Number(e.target.value) || 0, end - 0.05)).toFixed(3));
      _editor.dirty = true;
      _refreshClipGeometry();
      const num = document.getElementById('ed-trim-start');
      if (num) num.value = item.trimStart.toFixed(2);
    });
    document.getElementById('ed-trim-start-range')?.addEventListener('change', () => {
      _editorPushHistory();
      _paintEditor();
    });
    document.getElementById('ed-trim-end-range')?.addEventListener('input', (e) => {
      const item = _editorSelected();
      if (!item) return;
      const meta = _sourceMeta(item.sourceIndex);
      const max = meta?.duration || 9999;
      const start = item.trimStart || 0;
      item.trimEnd = Number(Math.min(max, Math.max(Number(e.target.value) || 0, start + 0.05)).toFixed(3));
      _editor.dirty = true;
      _refreshClipGeometry();
      const num = document.getElementById('ed-trim-end');
      if (num) num.value = item.trimEnd.toFixed(2);
    });
    document.getElementById('ed-trim-end-range')?.addEventListener('change', () => {
      _editorPushHistory();
      _paintEditor();
    });

    document.getElementById('ce-trim-front-minus')?.addEventListener('click', () => _editorNudgeTrim('front', 0.5));
    document.getElementById('ce-trim-front-plus')?.addEventListener('click', () => _editorNudgeTrim('front', -0.5));
    document.getElementById('ce-trim-back-minus')?.addEventListener('click', () => _editorNudgeTrim('back', 0.5));
    document.getElementById('ce-trim-back-plus')?.addEventListener('click', () => _editorNudgeTrim('back', -0.5));

    document.getElementById('ce-trim-reset')?.addEventListener('click', () => {
      const item = _editorSelected();
      if (!item) return;
      const meta = _sourceMeta(item.sourceIndex);
      item.trimStart = 0;
      item.trimEnd = Number((meta?.duration || item.trimEnd || 0).toFixed(3));
      _editorPushHistory();
      _paintEditor();
      showToast('Clip restored to full length.', 'success');
    });
    document.getElementById('ce-trim-to-playhead-in')?.addEventListener('click', () => _editorSetTrimAtPlayhead('in'));
    document.getElementById('ce-trim-to-playhead-out')?.addEventListener('click', () => _editorSetTrimAtPlayhead('out'));

    document.getElementById('ed-transition')?.addEventListener('change', (e) => {
      const item = _editorSelected();
      if (!item) return;
      item.transition = e.target.value;
      if (item.transition === 'none') item.transitionDuration = 0;
      else if (!item.transitionDuration) item.transitionDuration = _editorDefaultTransDur(_editor.timeline);
      _editorPushHistory();
      _paintEditor();
    });
    document.getElementById('ed-trans-dur')?.addEventListener('change', (e) => {
      const item = _editorSelected();
      if (!item) return;
      item.transitionDuration = Math.max(0, Math.min(2, Number(e.target.value) || 0));
      _editorPushHistory();
    });
    document.getElementById('ed-delete')?.addEventListener('click', () => _editorDeleteSelected(true));
    document.getElementById('ed-split')?.addEventListener('click', () => _editorSplitAtPlayhead());

    document.getElementById('ce-cap-enabled')?.addEventListener('change', (e) => {
      _editor.timeline.captions = _editor.timeline.captions || {};
      _editor.timeline.captions.enabled = e.target.checked;
      _editorPushHistory();
    });
    document.querySelectorAll('#ce-cap-pos button').forEach(b => {
      b.addEventListener('click', () => {
        _editor.timeline.captions.position = b.dataset.pos;
        _editorPushHistory();
        _paintEditor();
      });
    });
    document.querySelectorAll('#ce-cap-style button').forEach(b => {
      b.addEventListener('click', () => {
        _editor.timeline.captions.style = b.dataset.style;
        _editorPushHistory();
        _paintEditor();
      });
    });
    document.getElementById('ce-resolution')?.addEventListener('change', (e) => {
      _editor.timeline.resolution = e.target.value;
      _editorPushHistory();
    });
    document.querySelectorAll('#ce-def-trans button').forEach(b => {
      b.addEventListener('click', () => {
        _editor.timeline.defaultTransition = b.dataset.tr;
        if (b.dataset.tr === 'none') _editor.timeline.defaultTransitionDuration = 0;
        else if (!_editor.timeline.defaultTransitionDuration) {
          _editor.timeline.defaultTransitionDuration = DEFAULT_TRANSITION_DURATION;
        }
        _editorPushHistory();
        _paintEditor();
      });
    });
    document.getElementById('ce-def-trans-more')?.addEventListener('change', (e) => {
      _editor.timeline.defaultTransition = e.target.value;
      if (e.target.value === 'none') _editor.timeline.defaultTransitionDuration = 0;
      else if (!_editor.timeline.defaultTransitionDuration) {
        _editor.timeline.defaultTransitionDuration = DEFAULT_TRANSITION_DURATION;
      }
      _editorPushHistory();
      _paintEditor();
    });
    document.getElementById('ce-def-trans-dur')?.addEventListener('change', (e) => {
      _editor.timeline.defaultTransitionDuration = Math.max(0, Math.min(2, Number(e.target.value) || 0));
      _editorPushHistory();
    });
    document.getElementById('ce-apply-trans-all')?.addEventListener('click', () => {
      const tr = _editor.timeline.defaultTransition || DEFAULT_TRANSITION;
      const dur = tr === 'none' ? 0 : _editorDefaultTransDur(_editor.timeline);
      _editor.timeline.clips.forEach((c, i) => {
        if (i === 0) { c.transition = 'none'; c.transitionDuration = 0; }
        else { c.transition = tr; c.transitionDuration = dur; }
      });
      _editorPushHistory();
      _paintEditor();
      const label = _editorTransDef(tr).label;
      showToast(`Applied ${label}${dur ? ` @ ${dur}s` : ''} to all cuts.`, 'success');
    });
  }

  // Timeline clips
  const track = document.getElementById('ed-track');
  const scroll = document.getElementById('ed-timeline-scroll');
  if (track) {
    track.querySelectorAll('.ce-clip').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.ce-clip-handle')) return;
        e.stopPropagation();
        _editor.selectedId = el.dataset.id;
        _editor.sideTab = 'clip';
        _jumpToClip(el.dataset.id);
        _paintEditor();
      });

      const body = el.querySelector('.ce-clip-body');
      if (body) {
        body.addEventListener('dragstart', (e) => {
          if (busy || _editor.trimming) { e.preventDefault(); return; }
          _editor.dragId = el.dataset.id;
          el.classList.add('is-dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', el.dataset.id); } catch (_) {}
        });
        body.addEventListener('dragend', () => el.classList.remove('is-dragging'));
      }
      el.addEventListener('dragover', (e) => { e.preventDefault(); });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const fromId = _editor.dragId || e.dataTransfer.getData('text/plain');
        if (fromId && fromId !== el.dataset.id) _editorReorder(fromId, el.dataset.id);
      });

      el.querySelectorAll('.ce-clip-handle').forEach(handle => {
        handle.addEventListener('pointerdown', (e) => {
          if (busy) return;
          e.preventDefault();
          e.stopPropagation();
          // Capture pointer on the handle itself before handing off,
          // so pointermove keeps firing even when the cursor leaves the element
          try { handle.setPointerCapture(e.pointerId); } catch (_) {}
          _editor.selectedId = el.dataset.id;
          _editorStartTrimDrag(el.dataset.id, handle.dataset.handle, e, handle);
        });
      });
    });
  }

  // Scrub timeline
  if (scroll) {
    scroll.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        scroll.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    const scrub = (clientX) => {
      const rect = scroll.getBoundingClientRect();
      const x = clientX - rect.left + scroll.scrollLeft - 12;
      const total = _timelineTotal(_editor.timeline);
      _editor.playhead = Math.max(0, Math.min(total, x / _editor.pxPerSec));
      _editorUpdatePlayheadUi();
      _editorSeekPreview(_editor.playhead);
      const seg = _editorSegAt(_editor.playhead);
      if (seg && seg.item.id !== _editor.selectedId) {
        _editor.selectedId = seg.item.id;
      }
    };

    scroll.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ce-clip-handle')) return;
      if (e.target.closest('.ce-clip') && !e.shiftKey) return;
      _editor.scrubbing = true;
      scrub(e.clientX);
      scroll.setPointerCapture?.(e.pointerId);
    });
    scroll.addEventListener('pointermove', (e) => {
      if (!_editor.scrubbing) return;
      scrub(e.clientX);
    });
    scroll.addEventListener('pointerup', () => { _editor.scrubbing = false; });
    scroll.addEventListener('pointerleave', () => { _editor.scrubbing = false; });
  }
}

async function _editorImportMedia(file) {
  if (!file || !_editor) return;
  const maxSize = 300 * 1024 * 1024; // 300 MB
  if (file.size > maxSize) {
    showToast('Import file too large (max 300 MB).', 'error');
    return;
  }

  // Show loading indicator in place of the story cards
  const listEl = document.getElementById('ce-story-list');
  const originalListHtml = listEl ? listEl.innerHTML : '';
  if (listEl) {
    listEl.innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:var(--clr-text-3);">
        <div class="ce-spinner" style="width:28px;height:28px;margin:0 auto 12px;"></div>
        <p style="font-size:12px;font-weight:600;color:var(--clr-text-2);margin-bottom:4px;">Importing media...</p>
        <span style="font-size:10px;color:var(--clr-text-3);">Transcoding to 1080p 24fps on server</span>
      </div>`;
  }

  try {
    const formData = new FormData();
    formData.append('importFile', file);

    const resp = await apiFetch(`/api/jobs/${_editor.jobId}/editor/import`, {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Import failed (${resp.status})`);
    }

    const data = await resp.json();
    _editor.sourceClips = data.clips || [];
    _editor.clipsByIndex = new Map((data.clips || []).map(c => [c.index, c]));
    _editor.timeline = data.timeline;

    const newClip = data.timeline.clips[data.timeline.clips.length - 1];
    if (newClip) {
      _editor.selectedId = newClip.id;
      _jumpToClip(newClip.id, true);
    }

    _editorPushHistory();
    showToast('Media imported and converted successfully!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    if (listEl) listEl.innerHTML = originalListHtml;
  }
  _paintEditor();
}

// ── Audio upload ────────────────────────────────────────────
async function _editorUploadAudioTrack(trackKey, file) {
  if (!file || !_editor) return;
  if (file.size > 300 * 1024 * 1024) {
    showToast('Audio file too large (max 300 MB).', 'error');
    return;
  }

  const dropId = trackKey === 'bgMusic' ? 'ce-bgm-drop' : 'ce-vt-drop';
  const dropEl = document.getElementById(dropId);
  if (dropEl) {
    dropEl.innerHTML = `<div class="ce-audio-drop-content"><div class="ce-spinner" style="width:24px;height:24px;margin:0 auto 6px"></div><div class="ce-audio-drop-sub">Uploading&hellip;</div></div>`;
  }

  try {
    const formData = new FormData();
    formData.append('audioTrack', file);
    formData.append('trackType', trackKey);
    const resp = await apiFetch(`/api/jobs/${_editor.jobId}/editor/audio`, {
      method: 'POST',
      body: formData,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Upload failed (${resp.status})`);
    }
    const data = await resp.json();
    _editor.timeline[trackKey] = {
      ..._editor.timeline[trackKey],
      enabled: true,
      filename: file.name,
      url: data.url || '',
      serverPath: data.path || '',
    };
    showToast(`${trackKey === 'bgMusic' ? 'Background music' : 'Voice track'} uploaded!`, 'success');
  } catch (err) {
    // Graceful fallback: store a local blob URL (preview only, server upload TBD)
    const localUrl = URL.createObjectURL(file);
    _editor.timeline[trackKey] = {
      ..._editor.timeline[trackKey],
      enabled: true,
      filename: file.name,
      url: localUrl,
      serverPath: '',
    };
    showToast(`${trackKey === 'bgMusic' ? 'Music' : 'Voice'} loaded locally. Server upload endpoint not yet configured — will apply at render when available.`, 'info', 5000);
  }
  _editorPushHistory();
  _paintEditor();
}

function _editorStepClip(dir) {
  const enabled = _editorEnabledClips();
  if (!enabled.length) return;
  let idx = enabled.findIndex(c => c.id === _editor.selectedId);
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(enabled.length - 1, idx + dir));
  _editor.selectedId = enabled[idx].id;
  _jumpToClip(enabled[idx].id);
  _paintEditor();
}

function _editorNudgeTrim(edge, amount) {
  const item = _editorSelected();
  if (!item || item.enabled === false) {
    showToast('Select a clip first.', 'info');
    return;
  }
  const meta = _sourceMeta(item.sourceIndex);
  const max = meta?.duration || item.trimEnd || 10;
  let start = Number(item.trimStart || 0);
  let end = Number(item.trimEnd ?? max);
  if (edge === 'front') {
    start = Math.max(0, Math.min(start + amount, end - 0.1));
  } else {
    end = Math.min(max, Math.max(end - amount, start + 0.1));
  }
  item.trimStart = Number(start.toFixed(3));
  item.trimEnd = Number(end.toFixed(3));
  _editorPushHistory();
  _paintEditor();
}

function _editorSetTrimAtPlayhead(which) {
  const item = _editorSelected();
  if (!item || item.enabled === false) {
    showToast('Select a clip first.', 'info');
    return;
  }
  let t = 0;
  let startAt = 0;
  for (const c of _editor.timeline.clips) {
    if (c.enabled === false) continue;
    if (c.id === item.id) { startAt = t; break; }
    t += _clipDuration(c);
  }
  const local = _editor.playhead - startAt;
  if (local < 0 || local > _clipDuration(item)) {
    showToast('Move the playhead inside this clip first.', 'info');
    return;
  }
  const meta = _sourceMeta(item.sourceIndex);
  const max = meta?.duration || item.trimEnd || 10;
  const srcTime = (item.trimStart || 0) + local;
  if (which === 'in') {
    item.trimStart = Number(Math.min(srcTime, (item.trimEnd || max) - 0.1).toFixed(3));
  } else {
    item.trimEnd = Number(Math.max(srcTime, (item.trimStart || 0) + 0.1).toFixed(3));
  }
  _editorPushHistory();
  _paintEditor();
  showToast(which === 'in' ? 'In-point set.' : 'Out-point set.', 'success');
}

function _editorDeleteSelected(hard) {
  const item = _editorSelected();
  if (!item) {
    showToast('Select a clip to delete.', 'info');
    return;
  }
  const doDelete = () => {
    if (hard) {
      _editor.timeline.clips = _editor.timeline.clips.filter(c => c.id !== item.id);
    } else {
      item.enabled = false;
    }
    const next = _editorEnabledClips()[0];
    _editor.selectedId = next?.id || null;
    const en = _editorEnabledClips();
    if (en[0]) {
      en[0].transition = 'none';
      en[0].transitionDuration = 0;
    }
    _editorPushHistory();
    _paintEditor();
    showToast(hard ? 'Clip deleted.' : 'Clip removed.', 'success');
  };
  if (hard) {
    showConfirm('Delete clip', 'Permanently remove this clip from the timeline? You can Undo (Ctrl+Z).', doDelete, 'Delete', true);
  } else {
    doDelete();
  }
}

function _refreshClipGeometry() {
  if (!_editor) return;
  let x = 12;
  for (const c of _editor.timeline.clips) {
    if (c.enabled === false) continue;
    const el = document.querySelector(`.ce-clip[data-id="${CSS.escape(c.id)}"]`);
    const dur = _clipDuration(c);
    const w = Math.max(40, dur * _editor.pxPerSec);
    if (el) {
      el.style.left = `${x}px`;
      el.style.width = `${w}px`;
      const d = el.querySelector('.ce-clip-dur');
      if (d) d.textContent = _fmtEditorTime(dur);
    }
    x += w + 2;
  }
  const tot = document.getElementById('ed-time-total');
  if (tot) tot.textContent = _fmtEditorTime(_timelineTotal(_editor.timeline));
  const track = document.getElementById('ed-track');
  if (track) track.style.width = `${Math.max(640, _timelineTotal(_editor.timeline) * _editor.pxPerSec + 48)}px`;
  _editorUpdatePlayheadUi();
}

function _editorReorder(fromId, toId) {
  const clips = _editor.timeline.clips;
  const from = clips.findIndex(c => c.id === fromId);
  const to = clips.findIndex(c => c.id === toId);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = clips.splice(from, 1);
  clips.splice(to, 0, moved);
  const enabled = clips.filter(c => c.enabled !== false);
  if (enabled[0]) {
    enabled[0].transition = 'none';
    enabled[0].transitionDuration = 0;
  }
  _editorPushHistory();
  _paintEditor();
}

function _editorStartTrimDrag(id, which, e, handleEl) {
  const item = _editor.timeline.clips.find(c => c.id === id);
  if (!item) return;
  const meta = _sourceMeta(item.sourceIndex);
  const maxDur = meta?.duration || item.trimEnd || 10;
  const startX = e.clientX;
  // Snapshot trim values at drag-start so delta math is always relative to origin
  const origStart = Number(item.trimStart || 0);
  const origEnd   = Number(item.trimEnd   || maxDur);

  _editor.trimming = true;
  document.body.classList.add('ce-trimming');
  const clipEl = document.querySelector(`.ce-clip[data-id="${CSS.escape(id)}"]`);
  clipEl?.classList.add('is-trimming');

  // Pointer capture was already set on handleEl before calling this function.
  // Attach move/up to window so we never miss events even if cursor races ahead.
  const onMove = (ev) => {
    // Guard: only respond to the same pointer that started the drag
    const dx = (ev.clientX - startX) / _editor.pxPerSec;
    if (which === 'start') {
      // Left handle → move in-point (trimStart)
      item.trimStart = Number(
        Math.max(0, Math.min(origStart + dx, origEnd - 0.1)).toFixed(3)
      );
    } else {
      // Right handle → move out-point (trimEnd)
      item.trimEnd = Number(
        Math.min(maxDur, Math.max(origEnd + dx, origStart + 0.1)).toFixed(3)
      );
    }
    _editor.dirty = true;
    _refreshClipGeometry();
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup',   onUp);
    window.removeEventListener('pointercancel', onUp);
    _editor.trimming = false;
    document.body.classList.remove('ce-trimming');
    clipEl?.classList.remove('is-trimming');
    _editorPushHistory();
    _paintEditor();
    _jumpToClip(id, true);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup',   onUp);
  window.addEventListener('pointercancel', onUp);
}

function _editorSplitAtPlayhead() {
  let item = _editorSegAt(_editor.playhead)?.item || _editorSelected();
  if (!item || item.enabled === false) {
    showToast('Select a clip (or put the playhead on one) to cut.', 'info');
    return;
  }
  _editor.selectedId = item.id;

  let t = 0;
  let startAt = 0;
  for (const c of _editor.timeline.clips) {
    if (c.enabled === false) continue;
    if (c.id === item.id) { startAt = t; break; }
    t += _clipDuration(c);
  }
  const local = _editor.playhead - startAt;
  if (local <= 0.12 || local >= _clipDuration(item) - 0.12) {
    showToast('Move the red playhead inside the clip, then Cut.', 'info');
    return;
  }

  // ── KEY FIX: save playhead before any repaint ──────────────
  const savedPlayhead = _editor.playhead;

  const cutAt = (item.trimStart || 0) + local;
  const right = {
    ...item,
    id: `c${Date.now()}-${item.sourceIndex}`,
    trimStart: Number(cutAt.toFixed(3)),
    transition: item.transition || _editor.timeline.defaultTransition || DEFAULT_TRANSITION,
    transitionDuration: item.transitionDuration || _editorDefaultTransDur(_editor.timeline),
  };
  item.trimEnd = Number(cutAt.toFixed(3));
  const idx = _editor.timeline.clips.findIndex(c => c.id === item.id);
  _editor.timeline.clips.splice(idx + 1, 0, right);
  _editor.selectedId = right.id;
  _editorPushHistory();

  // Repaint (which re-renders DOM) then restore exact playhead position
  _paintEditor();
  _editor.playhead = savedPlayhead;
  _editorUpdatePlayheadUi();
  // Do NOT re-seek video here — keep the current frame in view

  showToast('Split! Trim or delete either side.', 'success');
}

function _jumpToClip(id, seekVideo = true) {
  let t = 0;
  for (const c of _editor.timeline.clips) {
    if (c.enabled === false) continue;
    if (c.id === id) {
      _editor.playhead = t;
      _editorUpdatePlayheadUi();
      if (seekVideo) _editorSeekPreview(t + 0.01);
      return;
    }
    t += _clipDuration(c);
  }
}

function _editorUpdatePlayheadUi() {
  const ph = document.getElementById('ed-playhead');
  if (ph) ph.style.left = `${12 + _editor.playhead * _editor.pxPerSec}px`;
  const cur = document.getElementById('ed-time-cur');
  if (cur) cur.textContent = _fmtEditorTime(_editor.playhead);

  // Auto-scroll timeline to keep playhead visible during playback
  const scroll = document.getElementById('ed-timeline-scroll');
  if (scroll && _editor.playing) {
    const px = 12 + _editor.playhead * _editor.pxPerSec;
    const { scrollLeft, clientWidth } = scroll;
    if (px < scrollLeft + 60) scroll.scrollLeft = Math.max(0, px - 60);
    else if (px > scrollLeft + clientWidth - 80) scroll.scrollLeft = px - clientWidth + 80;
  }

  // Live caption
  const cap = document.getElementById('ce-live-caption');
  const seg = _editorSegAt(_editor.playhead);
  if (cap) {
    if (_editor.timeline.captions?.enabled && seg) {
      const meta = _sourceMeta(seg.item.sourceIndex);
      cap.textContent = meta?.text || '';
      cap.className = `ce-preview-caption pos-${_editor.timeline.captions.position || 'bottom'}`;
      cap.style.display = 'block';
    } else {
      cap.style.display = 'none';
    }
  }
}

function _editorTimelineSegments() {
  const segs = [];
  let t = 0;
  for (const c of _editor.timeline.clips) {
    if (c.enabled === false) continue;
    const dur = _clipDuration(c);
    const meta = _sourceMeta(c.sourceIndex);
    segs.push({
      item: c,
      start: t,
      end: t + dur,
      url: mediaUrl(`/api/jobs/${_editor.jobId}/preview/clip/${c.sourceIndex}`),
      trimStart: c.trimStart || 0,
      trimEnd: c.trimEnd || meta?.duration || dur,
      duration: dur,
    });
    t += dur;
  }
  return segs;
}

function _editorSegAt(time) {
  const segs = _editorTimelineSegments();
  for (const s of segs) {
    if (time >= s.start && time < s.end - 0.001) return s;
  }
  return segs[segs.length - 1] || null;
}

async function _editorSeekPreview(time) {
  const video = _editor.video;
  if (!video) return;
  const seg = _editorSegAt(time);
  if (!seg) return;
  const local = Math.max(0, time - seg.start);
  const srcTime = seg.trimStart + local;
  if (video.dataset.clipUrl !== seg.url) {
    video.dataset.clipUrl = seg.url;
    video.src = seg.url;
    await new Promise((resolve) => {
      const onMeta = () => { video.removeEventListener('loadedmetadata', onMeta); resolve(); };
      video.addEventListener('loadedmetadata', onMeta);
      try { video.load(); } catch (_) { resolve(); }
      setTimeout(resolve, 800);
    });
  }
  try {
    if (Math.abs((video.currentTime || 0) - srcTime) > 0.04) {
      video.currentTime = Math.min(srcTime, Math.max(0, (video.duration || srcTime) - 0.05));
    }
  } catch (_) {}
  
  // Sync custom BGM/Voice playhead on scrub/seek
  if (_editor?.bgMusicElement) {
    _safeSeekAudio(_editor.bgMusicElement, time);
  }
  if (_editor?.voiceTrackElement) {
    _safeSeekAudio(_editor.voiceTrackElement, time);
  }

  document.getElementById('ed-overlay')?.classList.add('hidden');
}

async function _editorTogglePlay() {
  if (!_editor) return;
  if (_editor.playing) { _editorStop(); return; }

  const segs = _editorTimelineSegments();
  if (!segs.length) {
    showToast('No enabled clips to preview.', 'info');
    return;
  }
  _editor.playing = true;

  // Immediately flip the button to pause (don't wait for full repaint)
  const btn = document.getElementById('ed-play');
  if (btn) {
    btn.classList.add('is-playing');
    btn.title = 'Pause (Space)';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>';
  }
  document.getElementById('ed-overlay')?.classList.add('hidden');

  const video = _editor.video;
  if (!video) return;

  const tick = async () => {
    if (!_editor?.playing) return;
    const total = _timelineTotal(_editor.timeline);
    if (_editor.playhead >= total - 0.02) {
      _editorStop();
      return;
    }
    const seg = _editorSegAt(_editor.playhead);
    if (!seg) { _editorStop(); return; }

    if (video.dataset.clipUrl !== seg.url) {
      video.dataset.clipUrl = seg.url;
      video.src = seg.url;
      await new Promise((resolve) => {
        const done = () => { video.removeEventListener('canplay', done); resolve(); };
        video.addEventListener('canplay', done);
        try { video.load(); } catch (_) { resolve(); }
        setTimeout(resolve, 1000);
      });
      const local = _editor.playhead - seg.start;
      try { video.currentTime = seg.trimStart + local; } catch (_) {}
      try { await video.play(); } catch (_) {}
      _editor.selectedId = seg.item.id;
    }

    if (!video.paused && isFinite(video.currentTime)) {
      const local = video.currentTime - seg.trimStart;
      _editor.playhead = Math.min(seg.end, seg.start + Math.max(0, local));
      if (video.currentTime >= seg.trimEnd - 0.04 || local >= seg.duration - 0.04) {
        _editor.playhead = seg.end;
        video.pause();
        video.dataset.clipUrl = '';
      }
    } else {
      _editor.playhead += 0.04;
    }

    // Dynamic BGM/Voice synchronization checks
    if (bgmAud && bgmAud.readyState >= 1 && Math.abs(bgmAud.currentTime - _editor.playhead) > 0.22) {
      try { bgmAud.currentTime = _editor.playhead; } catch (_) {}
    }
    if (voiceAud && voiceAud.readyState >= 1 && Math.abs(voiceAud.currentTime - _editor.playhead) > 0.22) {
      try { voiceAud.currentTime = _editor.playhead; } catch (_) {}
    }

    _editorUpdatePlayheadUi();
    _editor.raf = requestAnimationFrame(() => { tick(); });
  };

  // Play BGM and Voice tracks if enabled
  const bgmAud = _getAudioElement('bgMusic');
  const voiceAud = _getAudioElement('voiceTrack');
  if (bgmAud) {
    bgmAud.loop = true;
    _safePlayAudio(bgmAud, _editor.playhead);
  }
  if (voiceAud) {
    voiceAud.loop = false;
    _safePlayAudio(voiceAud, _editor.playhead);
  }

  // Play from current playhead position
  const first = _editorSegAt(_editor.playhead) || segs[0];
  video.dataset.clipUrl = first.url;
  video.src = first.url;
  try {
    await new Promise((resolve) => {
      const done = () => { video.removeEventListener('canplay', done); resolve(); };
      video.addEventListener('canplay', done);
      video.load();
      setTimeout(resolve, 1000);
    });
    video.currentTime = first.trimStart + Math.max(0, _editor.playhead - first.start);
    await video.play();
  } catch (err) {
    showToast(`Preview blocked: ${err.message || err}`, 'error');
    _editorStop();
    return;
  }
  _editor.raf = requestAnimationFrame(() => { tick(); });
}

function _editorStop() {
  if (!_editor) return;
  _editor.playing = false;
  if (_editor.raf) { cancelAnimationFrame(_editor.raf); _editor.raf = null; }
  try { _editor.video?.pause(); } catch (_) {}

  // Pause BGM and Voice tracks
  if (_editor.bgMusicElement) {
    try { _editor.bgMusicElement.pause(); } catch (_) {}
  }
  if (_editor.voiceTrackElement) {
    try { _editor.voiceTrackElement.pause(); } catch (_) {}
  }

  const btn = document.getElementById('ed-play');
  if (btn) {
    btn.classList.remove('is-playing');
    btn.title = 'Play from here (Space)';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>';
  }
  _editorUpdatePlayheadUi();
}

async function _editorSave() {
  if (!_editor) return;
  try {
    const resp = await apiFetch(`/api/jobs/${_editor.jobId}/editor`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeline: _editor.timeline }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Save failed (${resp.status})`);
    }
    const data = await resp.json();
    if (data.timeline) _editor.timeline = data.timeline;
    _editor.dirty = false;
    showToast('Timeline saved.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function _editorRender() {
  if (!_editor) return;
  if (_editorIsBusy()) {
    showToast('A render is already in progress.', 'info');
    return;
  }
  const enabled = _editorEnabledClips();
  if (!enabled.length) {
    showToast('Enable at least one clip before rendering.', 'error');
    return;
  }
  const er = _editor.editRender || {};
  const isRerender = er.status === 'done' || er.status === 'failed' || !!_editor.assets?.edited;
  const title = isRerender
    ? (er.status === 'failed' ? 'Retry render' : 'Re-render video')
    : 'Render edited video';
  const body = isRerender
    ? `Re-render ${enabled.length} clip(s) with the current timeline?\n\n• Transitions (Mix / cut / etc.)\n• Trims, order, and audio settings\n\nThis rebuilds edited.mp4 on the server. You can close this tab — come back later to download.`
    : `Render ${enabled.length} clip(s) on the server?\n\nYou can close this tab — processing continues in the background. Come back later to download.`;
  const confirmLabel = isRerender
    ? (er.status === 'failed' ? 'Retry render' : 'Re-render')
    : 'Render';

  showConfirm(
    title,
    body,
    async () => {
      try {
        const resp = await apiFetch(`/api/jobs/${_editor.jobId}/editor/render`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeline: _editor.timeline }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || `Render failed (${resp.status})`);
        }
        const data = await resp.json();
        _editor.editRender = data.editRender || { status: 'queued' };
        _editor.dirty = false;
        _paintEditor();
        showToast(
          isRerender
            ? 'Re-render queued. Safe to leave — download when it finishes.'
            : 'Render queued. Safe to leave — download when it finishes.',
          'success',
          6000
        );
      } catch (e) {
        showToast(e.message, 'error');
      }
    },
    confirmLabel
  );
}

function _applyEditorJobUpdate(job) {
  if (!_editor || !_editor.jobId || job.id !== _editor.jobId) return;
  if (!job.editRender) return;

  const prev = _editor.editRender?.status;
  const prevPct = _ceRenderPercent(_editor.editRender || {});
  _editor.editRender = job.editRender;
  if (job.assets) _editor.assets = { ..._editor.assets, ...job.assets };

  const status = job.editRender.status;
  const statusChanged = prev !== status;

  // Full paint on status transitions (queued→rendering→done/failed) so overlay/buttons swap
  if (statusChanged) {
    _paintEditor();
    if (prev !== 'done' && status === 'done') {
      showToast('Edited video is ready — download it now!', 'success', 8000);
    }
    if (prev !== 'failed' && status === 'failed') {
      showToast(`Edit render failed: ${job.editRender.error || 'error'}`, 'error', 7000);
    }
    return;
  }

  // Same status (queued/rendering): update progress bars in-place without rebuilding the editor
  if (status === 'queued' || status === 'rendering') {
    const pct = _ceRenderPercent(job.editRender);
    const phase = job.editRender.progress?.phase || status;
    const done = job.editRender.progress?.done ?? 0;
    const total = job.editRender.progress?.total ?? 0;
    const phaseText = `${_cePhaseLabel(phase)}${total ? ` · ${done}/${total} clips` : ''}`;

    const overlayBar = document.getElementById('ce-overlay-bar');
    const overlayPct = document.getElementById('ce-overlay-pct');
    const overlayPhase = document.getElementById('ce-overlay-phase');
    if (overlayBar) overlayBar.style.width = `${pct}%`;
    if (overlayPct) overlayPct.textContent = `${pct}%`;
    if (overlayPhase) overlayPhase.textContent = phaseText;

    const bannerBar = document.getElementById('ce-banner-bar');
    const bannerPhase = document.getElementById('ce-banner-phase');
    if (bannerBar) bannerBar.style.width = `${pct}%`;
    if (bannerPhase) bannerPhase.textContent = phaseText;
    const bannerPct = document.querySelector('#ce-render-banner .edit-render-pct');
    if (bannerPct) bannerPct.textContent = `${pct}%`;

    const topLine = document.querySelector('.ce-topbar-progress-line');
    if (topLine) topLine.style.width = `${pct}%`;
    const topPct = document.getElementById('ce-top-render-pct');
    if (topPct) topPct.textContent = `Rendering (${pct}%)`;

    // If overlay was dismissed, keep banner progress visible; if neither exists, repaint once
    if (!overlayBar && !bannerBar && pct !== prevPct) {
      _paintEditor();
    }
  }
}
