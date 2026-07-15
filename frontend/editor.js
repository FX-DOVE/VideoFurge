// =============================================================
// VideoFurge Clip Editor — CapCut-inspired browser editor
// Loads after app.js (uses apiFetch, mediaUrl, showToast, etc.)
// Clips arrive pre-assembled; user reorders / trims / transitions
// then queues a server render (safe to leave and download later).
// =============================================================

const EDITOR_TRANSITIONS = [
  { id: 'none', label: 'Cut' },
  { id: 'fade', label: 'Fade' },
  { id: 'dissolve', label: 'Dissolve' },
  { id: 'fadeblack', label: 'Fade black' },
  { id: 'slideleft', label: 'Slide ←' },
  { id: 'slideright', label: 'Slide →' },
];

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
  if (!timeline.defaultTransition) timeline.defaultTransition = 'fade';
  if (!timeline.resolution) timeline.resolution = '1920x1080';
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

  app.innerHTML = `
  <div class="ce-root">
    <!-- Top bar -->
    <header class="ce-topbar">
      <a href="#/jobs/${escAttr(_editor.jobId)}" class="ce-back" title="Back to job">←</a>
      <div class="ce-title-block">
        <div class="ce-title">${escHtml(_editor.title)}</div>
        <div class="ce-sub">${enabled.length} clips · ${_fmtEditorDur(total)} · assembled — edit then Render</div>
      </div>
      <div class="ce-top-actions">
        <button type="button" class="ce-icon-btn" id="ce-undo" title="Undo (Ctrl+Z)" ${busy || _editor.historyPos <= 0 ? 'disabled' : ''}>↩</button>
        <button type="button" class="ce-icon-btn" id="ce-redo" title="Redo (Ctrl+Y)" ${busy || _editor.historyPos >= _editor.history.length - 1 ? 'disabled' : ''}>↪</button>
        <button type="button" class="btn btn-ghost btn-sm" id="ce-save" ${busy ? 'disabled' : ''}>💾 Save</button>
        <button type="button" class="btn btn-primary btn-sm" id="ce-render" ${busy ? 'disabled' : ''}>
          ${busy ? 'Rendering…' : '▶ Render'}
        </button>
      </div>
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
          <button type="button" class="ce-nav-btn ce-nav-prev" id="ce-prev" title="Previous clip">‹</button>
          <div class="ce-preview-stage">
            <video id="ed-video" class="ce-video" playsinline preload="metadata"></video>
            <div class="ce-preview-overlay" id="ed-overlay">
              <span>Select a clip · Space to play</span>
            </div>
            <div class="ce-preview-caption" id="ce-live-caption"></div>
          </div>
          <button type="button" class="ce-nav-btn ce-nav-next" id="ce-next" title="Next clip">›</button>
        </div>

        <div class="ce-info-bar">
          <span class="ce-pill">Clip ${selected ? (enabled.findIndex(c => c.id === selected.id) + 1) : '—'} / ${enabled.length}</span>
          <span class="ce-info-text" title="${escAttr(selMeta?.text || '')}">${escHtml((selMeta?.text || 'No clip selected').slice(0, 90))}</span>
          <span class="ce-info-meta">${selected ? _fmtEditorTime(_clipDuration(selected)) : '—'} · Total ${_fmtEditorDur(total)}</span>
        </div>

        ${_ceRenderBannerHtml(er)}

        <!-- Timeline -->
        <div class="ce-timeline">
          <div class="ce-tl-toolbar">
            <button type="button" class="btn btn-sm ${ _editor.playing ? 'btn-danger' : 'btn-primary'}" id="ed-play">
              ${_editor.playing ? '⏸ Pause' : '▶ Play all'}
            </button>
            <button type="button" class="btn btn-sm btn-ghost" id="ed-stop">⏹</button>
            <div class="ce-time-readout">
              <span id="ed-time-cur">${_fmtEditorTime(_editor.playhead)}</span>
              <span>/</span>
              <span id="ed-time-total">${_fmtEditorTime(total)}</span>
            </div>
            <div class="ce-tl-edit-tools" title="Edit selected clip">
              <button type="button" class="btn btn-sm btn-ghost" id="tl-trim-front" ${busy || !selected ? 'disabled' : ''} title="Trim 0.5s from the front">⟸ Front</button>
              <button type="button" class="btn btn-sm btn-ghost" id="tl-trim-back" ${busy || !selected ? 'disabled' : ''} title="Trim 0.5s from the back">Back ⟹</button>
              <button type="button" class="btn btn-sm btn-secondary" id="tl-cut" ${busy || !selected ? 'disabled' : ''} title="Cut/split at playhead (S)">✂ Cut</button>
              <button type="button" class="btn btn-sm btn-danger" id="tl-delete" ${busy || !selected ? 'disabled' : ''} title="Delete selected clip (Del)">🗑 Delete</button>
            </div>
            <div class="ce-zoom">
              <button type="button" class="ce-icon-btn" id="ed-zoom-out">−</button>
              <span>${Math.round((_editor.pxPerSec / 40) * 100)}%</span>
              <button type="button" class="ce-icon-btn" id="ed-zoom-in">+</button>
              <button type="button" class="ce-link" id="ed-zoom-fit">fit</button>
            </div>
            <button type="button" class="btn btn-sm btn-ghost" id="ed-reset-order" ${busy ? 'disabled' : ''}>Reset</button>
          </div>
          <div class="ce-tl-scroll" id="ed-timeline-scroll">
            <div class="ce-tl-inner" id="ed-track" style="width:${Math.max(640, total * _editor.pxPerSec + 48)}px">
              <div class="ce-ruler" id="ed-ruler">${_ceRulerHtml(total)}</div>
              <div class="ce-track-row">
                ${_ceTrackHtml()}
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

  // Restore preview frame for selection
  if (selected) {
    _jumpToClip(selected.id, false);
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
        <input type="search" id="ce-search" class="ce-search" placeholder="Search scenes…" value="${escAttr(_editor.search)}" ${busy ? 'disabled' : ''}/>
      </div>
      <div class="ce-story-list" id="ce-story-list">
        ${list.map((item, i) => {
          const m = _sourceMeta(item.sourceIndex);
          const active = item.id === _editor.selectedId;
          return `
            <div class="ce-story-card ${active ? 'is-active' : ''}" data-id="${escAttr(item.id)}" draggable="${busy ? 'false' : 'true'}">
              <div class="ce-story-top">
                <span>Scene ${i + 1}</span>
                <button type="button" class="ce-mini-x" data-remove="${escAttr(item.id)}" title="Remove" ${busy ? 'disabled' : ''}>×</button>
              </div>
              <p>${escHtml((m?.text || `Clip ${item.sourceIndex + 1}`).slice(0, 120))}</p>
              <div class="ce-story-meta">
                <span class="ce-badge-vid">VID</span>
                <span>${_fmtEditorTime(_clipDuration(item))}</span>
                ${item.transition && item.transition !== 'none' ? `<span class="ce-badge-fx">${escHtml(item.transition)}</span>` : ''}
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
              <button type="button" class="ce-nudge" id="ce-trim-front-minus" title="Cut 0.5s more from front" ${busy ? 'disabled' : ''}>−0.5s</button>
              <input type="range" id="ed-trim-start-range" min="0" max="${Math.max(0.05, maxDur - 0.05)}" step="0.05"
                value="${t0.toFixed(2)}" ${busy ? 'disabled' : ''}/>
              <button type="button" class="ce-nudge" id="ce-trim-front-plus" title="Keep 0.5s more at front" ${busy ? 'disabled' : ''}>+0.5s</button>
              <input type="number" id="ed-trim-start" min="0" max="${maxDur}" step="0.05"
                value="${t0.toFixed(2)}" ${busy ? 'disabled' : ''}/>
            </div>
          </label>

          <label class="ce-trim-row">Trim from <strong>back</strong> (out-point)
            <div class="ce-trim-controls">
              <button type="button" class="ce-nudge" id="ce-trim-back-minus" title="Cut 0.5s more from back" ${busy ? 'disabled' : ''}>−0.5s</button>
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
          <button type="button" class="btn btn-sm btn-primary" id="ed-split" ${busy ? 'disabled' : ''}>✂ Cut / Split</button>
          <button type="button" class="btn btn-sm btn-danger" id="ed-delete" ${busy ? 'disabled' : ''}>🗑 Delete clip</button>
        </div>

        <label>Transition in
          <select id="ed-transition" ${busy ? 'disabled' : ''}>
            ${EDITOR_TRANSITIONS.map(t => `
              <option value="${t.id}" ${selected.transition === t.id ? 'selected' : ''}>${escHtml(t.label)}</option>
            `).join('')}
          </select>
        </label>
        <label>Transition length (s)
          <input type="number" id="ed-trans-dur" min="0" max="2" step="0.05"
            value="${Number(selected.transitionDuration || 0.35).toFixed(2)}"
            ${busy || (selected.transition || 'none') === 'none' ? 'disabled' : ''}/>
        </label>
        <p class="ce-hint">Source ${_fmtEditorTime(maxDur)}. Drag the <strong>left</strong> or <strong>right</strong> edges on the timeline to trim. <kbd>S</kbd> cut · <kbd>Del</kbd> delete.</p>
      </div>`;
  }

  if (tab === 'audio') {
    return `
      <div class="ce-side-head"><h3>Audio</h3><p>Choose the audio bed mixed into the final render.</p></div>
      <div class="ce-fields">
        <label>Audio mode
          <select id="ed-audio-mode" ${busy ? 'disabled' : ''}>
            <option value="acted" ${_editor.timeline.audioMode === 'acted' ? 'selected' : ''}>Acted (BGM + SFX)</option>
            <option value="voice" ${_editor.timeline.audioMode === 'voice' ? 'selected' : ''}>Voice + mix</option>
            <option value="silent" ${_editor.timeline.audioMode === 'silent' ? 'selected' : ''}>Silent / clip audio only</option>
          </select>
        </label>
        <p class="ce-hint">Preview in the browser plays clip video only. The chosen audio bed is applied during Render.</p>
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
        <p class="ce-hint">Uses the job’s caption track (ASS) when present. Position/style are saved for future advanced burn-in.</p>
      </div>`;
  }

  // layout
  return `
    <div class="ce-side-head"><h3>Layout</h3><p>Output resolution and default transitions.</p></div>
    <div class="ce-fields">
      <label>Resolution
        <select id="ce-resolution" ${busy ? 'disabled' : ''}>
          <option value="1920x1080" ${_editor.timeline.resolution === '1920x1080' ? 'selected' : ''}>1080p Full HD</option>
          <option value="1280x720" ${_editor.timeline.resolution === '1280x720' ? 'selected' : ''}>720p HD</option>
          <option value="3840x2160" ${_editor.timeline.resolution === '3840x2160' ? 'selected' : ''}>4K</option>
        </select>
      </label>
      <label>Default transition (new / reset)
        <div class="ce-seg-btns" id="ce-def-trans">
          ${EDITOR_TRANSITIONS.slice(0, 4).map(t => `
            <button type="button" data-tr="${t.id}" class="${_editor.timeline.defaultTransition === t.id ? 'is-on' : ''}" ${busy ? 'disabled' : ''}>${escHtml(t.label)}</button>
          `).join('')}
        </div>
      </label>
      <button type="button" class="btn btn-sm btn-secondary" id="ce-apply-trans-all" ${busy ? 'disabled' : ''}>
        Apply default transition to all cuts
      </button>
      <p class="ce-hint">Space = play/pause · Drag timeline to scrub · Ctrl+Z undo</p>
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
    const transBadge = item.transition && item.transition !== 'none'
      ? `<span class="ce-trans-badge" title="${escAttr(item.transition)}">↝</span>` : '';
    return `
      <div class="ce-clip${selected}" data-id="${escAttr(item.id)}"
        style="left:${left}px;width:${w}px;--clip-color:${color}">
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

function _ceRenderBannerHtml(er) {
  if (!er || !er.status || er.status === 'idle') {
    if (_editor?.assets?.edited) {
      return `<div class="edit-render-banner edit-render-done">
        Last edit ready —
        <a href="${escAttr(mediaUrl(`/api/jobs/${_editor.jobId}/download/edited`))}" download>Download</a>
      </div>`;
    }
    return '';
  }
  if (er.status === 'queued' || er.status === 'rendering') {
    const phase = er.progress?.phase || er.status;
    const done = er.progress?.done ?? 0;
    const total = er.progress?.total ?? 0;
    return `<div class="edit-render-banner edit-render-busy">
      <strong>Rendering on server</strong>
      <span>(${escHtml(String(phase))}${total ? ` · ${done}/${total}` : ''}). Safe to leave — return anytime.</span>
    </div>`;
  }
  if (er.status === 'failed') {
    return `<div class="edit-render-banner edit-render-failed">
      <strong>Render failed:</strong> ${escHtml(er.error || 'Unknown error')}
    </div>`;
  }
  if (er.status === 'done') {
    return `<div class="edit-render-banner edit-render-done">
      <strong>Render complete!</strong>
      <a class="btn btn-sm btn-primary" href="${escAttr(mediaUrl(`/api/jobs/${_editor.jobId}/download/edited`))}" download>⬇ Download</a>
    </div>`;
  }
  return '';
}

function _ceRenderOverlayHtml(er) {
  // Non-blocking strip already shows status; only show modal for active render or result once
  if (er.status === 'queued' || er.status === 'rendering') {
    const pct = er.progress?.total
      ? Math.round(100 * (er.progress.done || 0) / er.progress.total)
      : (er.status === 'rendering' ? 45 : 10);
    return `
      <div class="ce-overlay" id="ce-overlay-modal">
        <div class="ce-modal">
          <div class="ce-spinner"></div>
          <h3>Rendering your video…</h3>
          <p>${escHtml(er.progress?.phase || er.status)} — keep going offline if you want</p>
          <div class="ce-progress"><div style="width:${pct}%"></div></div>
          <p class="ce-hint">You can close this tab. The worker keeps rendering; download when you return.</p>
          <button type="button" class="btn btn-ghost" id="ce-dismiss-overlay">Work in background</button>
        </div>
      </div>`;
  }
  if (er.status === 'done') {
    return `
      <div class="ce-overlay" id="ce-overlay-modal">
        <div class="ce-modal">
          <div class="ce-success-icon">✓</div>
          <h3>Render complete!</h3>
          <video controls class="ce-modal-video" src="${escAttr(mediaUrl(`/api/jobs/${_editor.jobId}/preview/edited`))}"></video>
          <div class="ce-modal-actions">
            <a class="btn btn-primary" href="${escAttr(mediaUrl(`/api/jobs/${_editor.jobId}/download/edited`))}" download>Download MP4</a>
            <button type="button" class="btn btn-ghost" id="ce-dismiss-overlay">Close</button>
          </div>
        </div>
      </div>`;
  }
  if (er.status === 'failed') {
    return `
      <div class="ce-overlay" id="ce-overlay-modal">
        <div class="ce-modal">
          <div class="ce-fail-icon">✕</div>
          <h3>Render failed</h3>
          <p>${escHtml(er.error || 'Unknown error')}</p>
          <button type="button" class="btn btn-ghost" id="ce-dismiss-overlay">Close</button>
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
  document.getElementById('ed-play')?.addEventListener('click', () => _editorTogglePlay());
  document.getElementById('ed-stop')?.addEventListener('click', () => { _editorStop(); _editor.playhead = 0; _editorUpdatePlayheadUi(); });
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
    // soft refresh list only
    _paintEditor();
    const s = document.getElementById('ce-search');
    if (s) { s.focus(); s.selectionStart = s.selectionEnd = s.value.length; }
  });

  document.getElementById('ce-prev')?.addEventListener('click', () => _editorStepClip(-1));
  document.getElementById('ce-next')?.addEventListener('click', () => _editorStepClip(1));

  // Timeline edit tools (always visible)
  document.getElementById('tl-trim-front')?.addEventListener('click', () => _editorNudgeTrim('front', 0.5));
  document.getElementById('tl-trim-back')?.addEventListener('click', () => _editorNudgeTrim('back', 0.5));
  document.getElementById('tl-cut')?.addEventListener('click', () => _editorSplitAtPlayhead());
  document.getElementById('tl-delete')?.addEventListener('click', () => _editorDeleteSelected(true));

  document.getElementById('ed-reset-order')?.addEventListener('click', () => {
    if (busy) return;
    showConfirm('Reset timeline', 'Restore original clip order and full lengths?', () => {
      _editor.timeline.clips = _editor.sourceClips.map((c, i) => ({
        id: `c${i}-${c.index}`,
        sourceIndex: c.index,
        enabled: true,
        trimStart: 0,
        trimEnd: Number((c.duration || 0).toFixed(3)),
        speed: 1,
        transition: i === 0 ? 'none' : (_editor.timeline.defaultTransition || 'fade'),
        transitionDuration: 0.35,
      }));
      _editor.selectedId = _editor.timeline.clips[0]?.id || null;
      _editor.playhead = 0;
      _editorPushHistory();
      _paintEditor();
      showToast('Timeline reset.', 'success');
    });
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
      // live preview while dragging slider (no history until change)
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

    // Front: −0.5s means cut more (increase trimStart)
    document.getElementById('ce-trim-front-minus')?.addEventListener('click', () => _editorNudgeTrim('front', 0.5));
    document.getElementById('ce-trim-front-plus')?.addEventListener('click', () => _editorNudgeTrim('front', -0.5));
    // Back: −0.5s means cut more (decrease trimEnd)
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
      else if (!item.transitionDuration) item.transitionDuration = 0.35;
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
        _editorPushHistory();
        _paintEditor();
      });
    });
    document.getElementById('ce-apply-trans-all')?.addEventListener('click', () => {
      const tr = _editor.timeline.defaultTransition || 'fade';
      _editor.timeline.clips.forEach((c, i) => {
        if (i === 0) { c.transition = 'none'; c.transitionDuration = 0; }
        else { c.transition = tr; c.transitionDuration = tr === 'none' ? 0 : 0.35; }
      });
      _editorPushHistory();
      _paintEditor();
      showToast('Transitions applied to all cuts.', 'success');
    });
  }

  // Timeline clips — handles trim front/back; body reorders
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
          _editor.selectedId = el.dataset.id;
          _editorStartTrimDrag(el.dataset.id, handle.dataset.handle, e);
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
      // select clip under playhead
      const seg = _editorSegAt(_editor.playhead);
      if (seg && seg.item.id !== _editor.selectedId) {
        _editor.selectedId = seg.item.id;
      }
    };

    scroll.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ce-clip-handle')) return;
      if (e.target.closest('.ce-clip') && !e.shiftKey) return; // clip click selects; shift-scrub anywhere
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

/** Nudge trim: amount>0 cuts more from that edge; amount<0 restores. */
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
    // first clip: no transition-in
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
    showConfirm('Delete clip', 'Permanently remove this clip from the timeline? You can Undo (Ctrl+Z).', doDelete);
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
  // Fix first clip transition
  const enabled = clips.filter(c => c.enabled !== false);
  if (enabled[0]) {
    enabled[0].transition = 'none';
    enabled[0].transitionDuration = 0;
  }
  _editorPushHistory();
  _paintEditor();
}

function _editorStartTrimDrag(id, which, e) {
  const item = _editor.timeline.clips.find(c => c.id === id);
  if (!item) return;
  const meta = _sourceMeta(item.sourceIndex);
  const maxDur = meta?.duration || item.trimEnd || 10;
  const startX = e.clientX;
  const origStart = item.trimStart || 0;
  const origEnd = item.trimEnd || maxDur;
  _editor.trimming = true;
  document.body.classList.add('ce-trimming');
  const clipEl = document.querySelector(`.ce-clip[data-id="${CSS.escape(id)}"]`);
  clipEl?.classList.add('is-trimming');

  // Capture pointer so drag stays smooth even outside the handle
  try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch (_) {}

  const onMove = (ev) => {
    const dx = (ev.clientX - startX) / _editor.pxPerSec;
    if (which === 'start') {
      // Drag left handle right → cut front (raise trimStart)
      item.trimStart = Number(Math.max(0, Math.min(origStart + dx, origEnd - 0.1)).toFixed(3));
    } else {
      // Drag right handle left → cut back (lower trimEnd)
      item.trimEnd = Number(Math.min(maxDur, Math.max(origEnd + dx, origStart + 0.1)).toFixed(3));
    }
    _editor.dirty = true;
    _refreshClipGeometry();
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    _editor.trimming = false;
    document.body.classList.remove('ce-trimming');
    clipEl?.classList.remove('is-trimming');
    _editorPushHistory();
    _paintEditor();
    // Preview the new in/out edge
    _jumpToClip(id, true);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function _editorSplitAtPlayhead() {
  // Prefer clip under playhead; fall back to selection
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
  const cutAt = (item.trimStart || 0) + local;
  const right = {
    ...item,
    id: `c${Date.now()}-${item.sourceIndex}`,
    trimStart: Number(cutAt.toFixed(3)),
    transition: item.transition || _editor.timeline.defaultTransition || 'fade',
    transitionDuration: item.transitionDuration || 0.35,
  };
  item.trimEnd = Number(cutAt.toFixed(3));
  const idx = _editor.timeline.clips.findIndex(c => c.id === item.id);
  _editor.timeline.clips.splice(idx + 1, 0, right);
  _editor.selectedId = right.id;
  _editorPushHistory();
  _paintEditor();
  showToast('Cut into two clips. Trim or delete either side.', 'success');
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

  // Auto-scroll timeline
  const scroll = document.getElementById('ed-timeline-scroll');
  if (scroll && _editor.playing) {
    const px = 12 + _editor.playhead * _editor.pxPerSec;
    const { scrollLeft, clientWidth } = scroll;
    if (px < scrollLeft + 60) scroll.scrollLeft = Math.max(0, px - 60);
    else if (px > scrollLeft + clientWidth - 80) scroll.scrollLeft = px - clientWidth + 80;
  }

  // Live caption line from narration
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
  const btn = document.getElementById('ed-play');
  if (btn) { btn.textContent = '⏸ Pause'; btn.classList.add('btn-danger'); btn.classList.remove('btn-primary'); }
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
    _editorUpdatePlayheadUi();
    _editor.raf = requestAnimationFrame(() => { tick(); });
  };

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
  const btn = document.getElementById('ed-play');
  if (btn) {
    btn.textContent = '▶ Play all';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-primary');
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
  const enabled = _editorEnabledClips();
  if (!enabled.length) {
    showToast('Enable at least one clip before rendering.', 'error');
    return;
  }
  showConfirm(
    'Render edited video',
    `Render ${enabled.length} clip(s) on the server?\n\nYou can close this tab — processing continues in the background. Come back later to download.`,
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
        showToast('Render queued. Safe to leave — download when it finishes.', 'success', 6000);
      } catch (e) {
        showToast(e.message, 'error');
      }
    }
  );
}

function _applyEditorJobUpdate(job) {
  if (!_editor || !_editor.jobId || job.id !== _editor.jobId) return;
  if (job.editRender) {
    const prev = _editor.editRender?.status;
    _editor.editRender = job.editRender;
    if (job.assets) _editor.assets = { ..._editor.assets, ...job.assets };
    if (prev !== job.editRender.status || ['queued', 'rendering'].includes(job.editRender.status)) {
      _paintEditor();
    }
    if (prev !== 'done' && job.editRender.status === 'done') {
      showToast('Edited video is ready to download!', 'success', 7000);
    }
    if (prev !== 'failed' && job.editRender.status === 'failed') {
      showToast(`Edit render failed: ${job.editRender.error || 'error'}`, 'error', 7000);
    }
  }
}
