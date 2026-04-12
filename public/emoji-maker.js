(() => {
  const state = {
    sessionId: '',
    mode: 'static',
    selectedPreviewSize: 112,
    selection: { x: 0.25, y: 0.2, w: 0.5, h: 0.5 },
    drag: null,
  };

  const el = {
    intro: document.getElementById('emoji-intro'),
    form: document.getElementById('emoji-clip-form'),
    urlInput: document.getElementById('emoji-clip-url'),
    loadBtn: document.getElementById('emoji-load-btn'),
    reload: document.getElementById('emoji-reload'),
    reloadForm: document.getElementById('emoji-reload-form'),
    reloadUrlInput: document.getElementById('emoji-reload-url'),
    reloadBtn: document.getElementById('emoji-reload-btn'),
    status: document.getElementById('emoji-status'),
    workspaceStatus: document.getElementById('emoji-workspace-status'),
    backLinks: Array.from(document.querySelectorAll('.emoji-back-link, .emoji-landing-back-link')),
    workspace: document.getElementById('emoji-workspace'),
    videoStage: document.getElementById('emoji-video-stage'),
    video: document.getElementById('emoji-video'),
    playToggle: document.getElementById('emoji-play-toggle'),
    seek: document.getElementById('emoji-seek'),
    volume: document.getElementById('emoji-volume'),
    timeReadout: document.getElementById('emoji-time-readout'),
    selection: document.getElementById('emoji-selection'),
    previewCards: Array.from(document.querySelectorAll('.emoji-preview-card[data-preview-size]')),
    markStartBtn: document.getElementById('emoji-mark-start'),
    markEndBtn: document.getElementById('emoji-mark-end'),
    modeSwitch: document.getElementById('emoji-mode-switch'),
    modeSlider: document.getElementById('emoji-mode-slider'),
    modeStaticBtn: document.getElementById('emoji-mode-static'),
    modeAnimatedBtn: document.getElementById('emoji-mode-animated'),
    gifOnlyControls: Array.from(document.querySelectorAll('.emoji-gif-only')),
    animatedControls: document.getElementById('emoji-animated-controls'),
    emoteNameInput: document.getElementById('emoji-emote-name'),
    startSec: document.getElementById('emoji-start-sec'),
    endSec: document.getElementById('emoji-end-sec'),
    renderBtn: document.getElementById('emoji-render-btn'),
    results: document.getElementById('emoji-results'),
    specNote: document.getElementById('emoji-spec-note'),
    preview112: document.getElementById('emoji-preview-112'),
    preview56: document.getElementById('emoji-preview-56'),
    preview28: document.getElementById('emoji-preview-28'),
  };

  function setLoadedMode(isLoaded) {
    document.body.classList.toggle('emoji-loaded', !!isLoaded);
    document.body.classList.toggle('emoji-landing', !isLoaded);
    if (el.intro instanceof HTMLElement) el.intro.hidden = !!isLoaded;
    if (el.reload instanceof HTMLElement) el.reload.hidden = !isLoaded;
    if (el.workspace instanceof HTMLElement) el.workspace.hidden = !isLoaded;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function normalizeSelection(selection) {
    const minSize = 0.04;
    const w = clamp(Number(selection.w) || 0.5, minSize, 1);
    const h = clamp(Number(selection.h) || 0.5, minSize, 1);
    const x = clamp(Number(selection.x) || 0, 0, 1 - w);
    const y = clamp(Number(selection.y) || 0, 0, 1 - h);
    return { x, y, w, h };
  }

  function formatSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '0';
    return String(Math.round(n * 10) / 10);
  }

  function formatClock(value) {
    const n = Math.max(0, Number(value) || 0);
    const totalSec = Math.floor(n);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round((n / 1024) * 10) / 10} KB`;
    return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
  }

  function sanitizeEmoteName(rawName) {
    const cleaned = String(rawName || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    return cleaned || 'emote';
  }

  function getSelectedEmoteName() {
    if (!(el.emoteNameInput instanceof HTMLInputElement)) return 'emote';
    return sanitizeEmoteName(el.emoteNameInput.value);
  }

  function getAssetExtension(asset) {
    const mime = String(asset?.mime_type || '').toLowerCase();
    if (mime === 'image/gif') return 'gif';
    if (mime === 'image/png') return 'png';
    const byName = String(asset?.name || '').toLowerCase();
    const dotIndex = byName.lastIndexOf('.');
    if (dotIndex >= 0 && dotIndex < byName.length - 1) return byName.slice(dotIndex + 1);
    return 'png';
  }

  function buildDownloadFileName(asset) {
    const base = getSelectedEmoteName();
    const size = Number(asset?.width) || 112;
    const ext = getAssetExtension(asset);
    return `${base}_${size}.${ext}`;
  }

  function setStatus(message, tone = 'neutral') {
    const text = String(message || '').trim();
    const statusNodes = [el.status, el.workspaceStatus].filter((node) => node instanceof HTMLElement);
    statusNodes.forEach((node) => {
      if (!text) {
        node.textContent = '';
        node.dataset.tone = 'neutral';
        node.hidden = true;
        return;
      }
      node.hidden = false;
      node.textContent = text;
      node.dataset.tone = tone;
    });
  }

  function handleUrlInputState(inputEl) {
    if (!(inputEl instanceof HTMLInputElement)) return;
    const value = inputEl.value.trim();
    if (!value) {
      setStatus('');
      return;
    }
    setStatus('Press Enter to load clip.', 'neutral');
  }

  function setBusyLoading(isBusy) {
    if (el.loadBtn instanceof HTMLButtonElement) el.loadBtn.disabled = !!isBusy;
    if (el.urlInput instanceof HTMLInputElement) el.urlInput.disabled = !!isBusy;
    if (el.reloadBtn instanceof HTMLButtonElement) el.reloadBtn.disabled = !!isBusy;
    if (el.reloadUrlInput instanceof HTMLInputElement) el.reloadUrlInput.disabled = !!isBusy;
  }

  function setBusyRendering(isBusy) {
    if (el.renderBtn instanceof HTMLButtonElement) {
      el.renderBtn.disabled = !!isBusy;
      el.renderBtn.textContent = isBusy ? 'Rendering...' : 'Render Emote';
    }
  }

  async function fetchJson(url, init) {
    const response = await fetch(url, init);
    if (response.status === 401) {
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Request failed');
    }
    return payload;
  }

  async function syncAccessContext() {
    let isAuthenticated = false;
    try {
      const response = await fetch('/api/auth', { credentials: 'same-origin' });
      const payload = await response.json().catch(() => ({}));
      isAuthenticated = !!payload.authenticated;
    } catch {
      isAuthenticated = false;
    }
    const backHref = isAuthenticated ? '/app' : '/';
    const backLabel = isAuthenticated ? 'Back to Reviewer' : 'Back to Homepage';
    el.backLinks.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      node.hidden = false;
      if (node instanceof HTMLAnchorElement) {
        node.href = backHref;
      }
      const label = node.querySelector('span');
      if (label) label.textContent = backLabel;
    });
  }

  function syncModeControls() {
    const isAnimated = state.mode === 'animated';
    el.gifOnlyControls.forEach((node) => {
      if (node instanceof HTMLElement) node.hidden = !isAnimated;
    });
    if (el.animatedControls instanceof HTMLElement) {
      el.animatedControls.hidden = !isAnimated;
    }
    if (el.modeSlider instanceof HTMLElement) {
      el.modeSlider.style.transform = isAnimated ? 'translateX(100%)' : 'translateX(0%)';
    }
    if (el.modeStaticBtn instanceof HTMLButtonElement) {
      el.modeStaticBtn.classList.toggle('is-active', !isAnimated);
      el.modeStaticBtn.setAttribute('aria-pressed', String(!isAnimated));
    }
    if (el.modeAnimatedBtn instanceof HTMLButtonElement) {
      el.modeAnimatedBtn.classList.toggle('is-active', isAnimated);
      el.modeAnimatedBtn.setAttribute('aria-pressed', String(isAnimated));
    }
  }

  function setMode(nextMode) {
    state.mode = nextMode === 'animated' ? 'animated' : 'static';
    syncModeControls();
  }

  function syncPreviewPresetUI() {
    el.previewCards.forEach((card) => {
      if (!(card instanceof HTMLElement)) return;
      const size = Number(card.dataset.previewSize || '0');
      const active = size === state.selectedPreviewSize;
      card.classList.toggle('is-selected', active);
      card.setAttribute('aria-pressed', String(active));
    });
  }

  function applyPreviewPreset(size) {
    const parsed = Number(size);
    const validSize = parsed === 56 || parsed === 28 ? parsed : 112;
    state.selectedPreviewSize = validSize;
    syncPreviewPresetUI();

    const current = normalizeSelection(state.selection);
    const centerX = current.x + (current.w / 2);
    const centerY = current.y + (current.h / 2);
    const vw = Math.max(1, Number(el.video instanceof HTMLVideoElement ? el.video.videoWidth : 0) || Number(el.video instanceof HTMLVideoElement ? el.video.clientWidth : 0) || 16);
    const vh = Math.max(1, Number(el.video instanceof HTMLVideoElement ? el.video.videoHeight : 0) || Number(el.video instanceof HTMLVideoElement ? el.video.clientHeight : 0) || 9);
    const shortSidePx = Math.min(vw, vh);

    const presetScale = validSize === 112 ? 0.56 : (validSize === 56 ? 0.34 : 0.2);
    const targetSidePx = clamp(shortSidePx * presetScale, 24, shortSidePx);
    const targetW = clamp(targetSidePx / vw, 0.04, 1);
    const targetH = clamp(targetSidePx / vh, 0.04, 1);

    state.selection = normalizeSelection({
      x: centerX - (targetW / 2),
      y: centerY - (targetH / 2),
      w: targetW,
      h: targetH,
    });
    renderSelection();
  }

  function renderSelection() {
    if (!(el.selection instanceof HTMLElement)) return;
    state.selection = normalizeSelection(state.selection);
    el.selection.style.left = `${state.selection.x * 100}%`;
    el.selection.style.top = `${state.selection.y * 100}%`;
    el.selection.style.width = `${state.selection.w * 100}%`;
    el.selection.style.height = `${state.selection.h * 100}%`;
    drawLivePreviews();
  }

  function drawCanvasFromVideo(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    if (!(el.video instanceof HTMLVideoElement)) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (el.video.readyState < 2 || !el.video.videoWidth || !el.video.videoHeight) return;

    const vw = el.video.videoWidth;
    const vh = el.video.videoHeight;
    const sx = Math.round(state.selection.x * vw);
    const sy = Math.round(state.selection.y * vh);
    const sw = Math.max(1, Math.round(state.selection.w * vw));
    const sh = Math.max(1, Math.round(state.selection.h * vh));

    const targetSize = canvas.width;
    const scale = Math.min(targetSize / sw, targetSize / sh);
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    const dx = Math.floor((targetSize - dw) / 2);
    const dy = Math.floor((targetSize - dh) / 2);

    ctx.drawImage(el.video, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  function drawLivePreviews() {
    drawCanvasFromVideo(el.preview112);
    drawCanvasFromVideo(el.preview56);
    drawCanvasFromVideo(el.preview28);
  }

  function updateTimelineFromVideo() {
    if (!(el.video instanceof HTMLVideoElement)) return;
    const duration = Number.isFinite(el.video.duration) ? Math.max(0, el.video.duration) : 0;
    const current = Math.max(0, Number(el.video.currentTime) || 0);
    if (el.seek instanceof HTMLInputElement) {
      const ratio = duration > 0 ? clamp(current / duration, 0, 1) : 0;
      el.seek.value = String(Math.round(ratio * 1000));
    }
    if (el.timeReadout instanceof HTMLElement) {
      el.timeReadout.textContent = `${formatClock(current)} / ${formatClock(duration)}`;
    }
    if (el.playToggle instanceof HTMLButtonElement) {
      el.playToggle.textContent = el.video.paused ? 'Play' : 'Pause';
    }
    if (el.volume instanceof HTMLInputElement) {
      const volume = clamp(Number(el.video.volume) || 0, 0, 1);
      el.volume.value = String(Math.round(volume * 100));
    }
  }

  function clearResults() {
    if (el.results instanceof HTMLElement) {
      el.results.innerHTML = '';
    }
  }

  function renderResults(payload) {
    if (!(el.results instanceof HTMLElement)) return;
    clearResults();

    if (Array.isArray(payload.warnings)) {
      payload.warnings.forEach((warning) => {
        const node = document.createElement('div');
        node.className = 'emoji-warning';
        node.textContent = String(warning || '');
        el.results.appendChild(node);
      });
    }

    if (!Array.isArray(payload.assets)) return;

    payload.assets.forEach((asset) => {
      const row = document.createElement('div');
      row.className = 'emoji-result-item';

      const img = document.createElement('img');
      img.alt = asset.name || 'Emote output';
      img.loading = 'lazy';
      img.src = `${asset.url}${String(asset.url).includes('?') ? '&' : '?'}preview=1`;
      row.appendChild(img);

      const copy = document.createElement('div');
      copy.className = 'emoji-result-copy';
      const title = document.createElement('div');
      title.className = 'emoji-result-name';
      const downloadFileName = buildDownloadFileName(asset);
      title.textContent = downloadFileName;
      const meta = document.createElement('div');
      meta.className = 'emoji-result-meta';
      meta.textContent = `${asset.width}x${asset.height} | ${String(asset.mime_type || '').replace('image/', '').toUpperCase()} | ${formatBytes(asset.bytes)}`;
      copy.appendChild(title);
      copy.appendChild(meta);
      row.appendChild(copy);

      const link = document.createElement('a');
      link.className = 'emoji-result-link';
      link.href = String(asset.url || '#');
      link.textContent = 'Download';
      link.download = downloadFileName;
      row.appendChild(link);

      el.results.appendChild(row);
    });
  }

  function markAnimatedStartFromCurrent() {
    if (!(el.video instanceof HTMLVideoElement)) return;
    setMode('animated');
    const now = Math.max(0, Number(el.video.currentTime) || 0);
    if (el.startSec instanceof HTMLInputElement) el.startSec.value = formatSeconds(now);
    if (el.endSec instanceof HTMLInputElement) {
      const currentEnd = Number(el.endSec.value);
      if (!Number.isFinite(currentEnd) || currentEnd < now + 0.35) {
        el.endSec.value = formatSeconds(now + 0.35);
      }
    }
    setStatus('First GIF point set from current time.', 'neutral');
  }

  function markAnimatedEndFromCurrent() {
    if (!(el.video instanceof HTMLVideoElement)) return;
    setMode('animated');
    const now = Math.max(0, Number(el.video.currentTime) || 0);
    const start = Number(el.startSec instanceof HTMLInputElement ? el.startSec.value : '0');
    const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
    const safeEnd = Math.max(now, safeStart + 0.35);
    if (el.endSec instanceof HTMLInputElement) el.endSec.value = formatSeconds(safeEnd);
    setStatus('Second GIF point set from current time.', 'neutral');
  }

  async function loadClipFromUrl(clipUrl) {
    setBusyLoading(true);
    clearResults();
    setStatus('Resolving Twitch clip URL...', 'neutral');

    try {
      const payload = await fetchJson('/api/emoji/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clip_url: clipUrl }),
      });

      state.sessionId = String(payload.session_id || '');
      if (!state.sessionId) throw new Error('Missing session id from server.');
      if (!(el.video instanceof HTMLVideoElement)) throw new Error('Missing preview video element.');

      if (el.urlInput instanceof HTMLInputElement) {
        el.urlInput.value = clipUrl;
      }
      if (el.reloadUrlInput instanceof HTMLInputElement) {
        el.reloadUrlInput.value = clipUrl;
      }
      setLoadedMode(true);
      applyPreviewPreset(state.selectedPreviewSize);
      syncModeControls();

      el.video.pause();
      el.video.removeAttribute('src');
      el.video.src = `${String(payload.video_url || '')}${String(payload.video_url || '').includes('?') ? '&' : '?'}v=${Date.now()}`;
      el.video.load();
      updateTimelineFromVideo();
      setStatus('Clip loaded. Move the selection box, then render your emote set.', 'success');
      return true;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not load this clip.', 'error');
      return false;
    } finally {
      setBusyLoading(false);
    }
  }

  async function onLoadClip(event) {
    event.preventDefault();
    if (!(el.urlInput instanceof HTMLInputElement)) return;
    const clipUrl = el.urlInput.value.trim();
    if (!clipUrl) return;
    await loadClipFromUrl(clipUrl);
  }

  async function onReloadClip(event) {
    event.preventDefault();
    if (!(el.reloadUrlInput instanceof HTMLInputElement)) return;
    const clipUrl = el.reloadUrlInput.value.trim();
    if (!clipUrl) {
      setStatus('Paste another Twitch clip link first.', 'neutral');
      el.reloadUrlInput.focus();
      return;
    }
    await loadClipFromUrl(clipUrl);
  }

  function onTogglePlay() {
    if (!(el.video instanceof HTMLVideoElement)) return;
    if (el.video.paused) {
      void el.video.play().catch(() => {});
    } else {
      el.video.pause();
    }
    updateTimelineFromVideo();
  }

  function onSeekInput() {
    if (!(el.video instanceof HTMLVideoElement)) return;
    if (!(el.seek instanceof HTMLInputElement)) return;
    const duration = Number.isFinite(el.video.duration) ? Math.max(0, el.video.duration) : 0;
    if (duration <= 0) return;
    const ratio = clamp((Number(el.seek.value) || 0) / 1000, 0, 1);
    el.video.currentTime = ratio * duration;
    drawLivePreviews();
    updateTimelineFromVideo();
  }

  function onVolumeInput() {
    if (!(el.video instanceof HTMLVideoElement)) return;
    if (!(el.volume instanceof HTMLInputElement)) return;
    const ratio = clamp((Number(el.volume.value) || 0) / 100, 0, 1);
    el.video.volume = ratio;
    el.video.muted = ratio <= 0;
    updateTimelineFromVideo();
  }

  function onSelectionPointerDown(event) {
    if (!(el.videoStage instanceof HTMLElement)) return;
    if (!(el.selection instanceof HTMLElement)) return;
    if (!state.sessionId) return;

    const target = event.target;
    if (!(target instanceof Node) || !el.selection.contains(target)) return;
    const handleEl = target instanceof Element ? target.closest('[data-handle]') : null;
    const handle = (handleEl instanceof HTMLElement) ? String(handleEl.dataset.handle || '').toLowerCase() : '';
    const mode = handle ? 'resize' : 'move';

    const rect = el.videoStage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    event.preventDefault();
    state.drag = {
      mode,
      rect,
      startX: event.clientX,
      startY: event.clientY,
      handle,
      selection: { ...state.selection },
    };

    document.addEventListener('pointermove', onSelectionPointerMove);
    document.addEventListener('pointerup', onSelectionPointerUp, { once: true });
  }

  function onSelectionPointerMove(event) {
    if (!state.drag) return;
    const dx = (event.clientX - state.drag.startX) / state.drag.rect.width;
    const dy = (event.clientY - state.drag.startY) / state.drag.rect.height;

    if (state.drag.mode === 'move') {
      state.selection.x = clamp(state.drag.selection.x + dx, 0, 1 - state.selection.w);
      state.selection.y = clamp(state.drag.selection.y + dy, 0, 1 - state.selection.h);
    } else {
      const minSize = 0.04;
      const base = state.drag.selection;
      let left = base.x;
      let right = base.x + base.w;
      let top = base.y;
      let bottom = base.y + base.h;
      const handle = String(state.drag.handle || 'se');

      if (handle.includes('w')) {
        left = clamp(base.x + dx, 0, right - minSize);
      }
      if (handle.includes('e')) {
        right = clamp(base.x + base.w + dx, left + minSize, 1);
      }
      if (handle.includes('n')) {
        top = clamp(base.y + dy, 0, bottom - minSize);
      }
      if (handle.includes('s')) {
        bottom = clamp(base.y + base.h + dy, top + minSize, 1);
      }

      state.selection.x = left;
      state.selection.y = top;
      state.selection.w = clamp(right - left, minSize, 1);
      state.selection.h = clamp(bottom - top, minSize, 1);
    }
    renderSelection();
  }

  function onSelectionPointerUp() {
    state.drag = null;
    document.removeEventListener('pointermove', onSelectionPointerMove);
  }

  async function onRenderEmoji() {
    if (!state.sessionId) {
      setStatus('Load a clip first.', 'error');
      return;
    }

    const payload = {
      session_id: state.sessionId,
      mode: state.mode,
      crop: normalizeSelection(state.selection),
    };

    if (state.mode === 'animated') {
      const start = Number(el.startSec instanceof HTMLInputElement ? el.startSec.value : '0');
      const end = Number(el.endSec instanceof HTMLInputElement ? el.endSec.value : '1.6');
      payload.start_sec = Number.isFinite(start) ? Math.max(0, start) : 0;
      payload.end_sec = Number.isFinite(end) ? Math.max(0.35, end) : 1.6;
    } else {
      const current = (el.video instanceof HTMLVideoElement) ? Number(el.video.currentTime) : 0;
      payload.time_sec = Number.isFinite(current) ? Math.max(0, current) : 0;
    }

    setBusyRendering(true);
    setStatus('Rendering emote outputs...', 'neutral');

    try {
      const response = await fetchJson('/api/emoji/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      renderResults(response);
      if (el.specNote instanceof HTMLElement && response.specs) {
        el.specNote.textContent = `Target emote sizes: ${String(response.specs.sizes || []).replaceAll(',', ' / ')} (${response.specs.format || ''}, ${response.specs.background || ''}).`;
      }
      setStatus('Render complete. Download whichever emote size you need for Twitch.', 'success');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Render failed.', 'error');
    } finally {
      setBusyRendering(false);
    }
  }

  function attachEvents() {
    if (el.form instanceof HTMLFormElement) {
      el.form.addEventListener('submit', onLoadClip);
    }

    if (el.urlInput instanceof HTMLInputElement) {
      el.urlInput.addEventListener('input', () => handleUrlInputState(el.urlInput));
      el.urlInput.addEventListener('change', () => handleUrlInputState(el.urlInput));
    }

    if (el.reloadForm instanceof HTMLFormElement) {
      el.reloadForm.addEventListener('submit', onReloadClip);
    }

    if (el.reloadUrlInput instanceof HTMLInputElement) {
      el.reloadUrlInput.addEventListener('input', () => handleUrlInputState(el.reloadUrlInput));
      el.reloadUrlInput.addEventListener('change', () => handleUrlInputState(el.reloadUrlInput));
    }

    if (el.selection instanceof HTMLElement) {
      el.selection.addEventListener('pointerdown', onSelectionPointerDown);
    }

    if (el.playToggle instanceof HTMLButtonElement) {
      el.playToggle.addEventListener('click', onTogglePlay);
    }

    if (el.seek instanceof HTMLInputElement) {
      el.seek.addEventListener('input', onSeekInput);
      el.seek.addEventListener('change', onSeekInput);
    }

    if (el.volume instanceof HTMLInputElement) {
      el.volume.addEventListener('input', onVolumeInput);
      el.volume.addEventListener('change', onVolumeInput);
    }

    if (el.markStartBtn instanceof HTMLButtonElement) {
      el.markStartBtn.addEventListener('click', markAnimatedStartFromCurrent);
    }

    if (el.markEndBtn instanceof HTMLButtonElement) {
      el.markEndBtn.addEventListener('click', markAnimatedEndFromCurrent);
    }

    if (el.renderBtn instanceof HTMLButtonElement) {
      el.renderBtn.addEventListener('click', onRenderEmoji);
    }

    if (el.modeStaticBtn instanceof HTMLButtonElement) {
      el.modeStaticBtn.addEventListener('click', () => {
        setMode('static');
      });
    }

    if (el.modeAnimatedBtn instanceof HTMLButtonElement) {
      el.modeAnimatedBtn.addEventListener('click', () => {
        setMode('animated');
      });
    }

    if (el.modeSwitch instanceof HTMLElement) {
      el.modeSwitch.addEventListener('click', (event) => {
        if (event.target === el.modeStaticBtn || event.target === el.modeAnimatedBtn) return;
        const rect = el.modeSwitch.getBoundingClientRect();
        const x = event.clientX - rect.left;
        setMode(x < rect.width / 2 ? 'static' : 'animated');
      });

      el.modeSwitch.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setMode('static');
          return;
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          setMode('animated');
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setMode(state.mode === 'animated' ? 'static' : 'animated');
        }
      });
    }

    el.previewCards.forEach((card) => {
      if (!(card instanceof HTMLElement)) return;
      card.addEventListener('click', () => {
        applyPreviewPreset(card.dataset.previewSize);
      });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          applyPreviewPreset(card.dataset.previewSize);
        }
      });
    });

    if (el.video instanceof HTMLVideoElement) {
      ['loadeddata', 'loadedmetadata', 'seeked', 'timeupdate'].forEach((eventName) => {
        el.video.addEventListener(eventName, drawLivePreviews);
      });
      el.video.addEventListener('loadedmetadata', () => {
        if (!state.sessionId) return;
        applyPreviewPreset(state.selectedPreviewSize);
      });
      ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked', 'play', 'pause', 'ended'].forEach((eventName) => {
        el.video.addEventListener(eventName, updateTimelineFromVideo);
      });
      el.video.addEventListener('click', (event) => {
        if (event.target instanceof Node && el.selection instanceof HTMLElement && el.selection.contains(event.target)) return;
        onTogglePlay();
      });
    }
  }

  attachEvents();
  setLoadedMode(false);
  setStatus('');
  applyPreviewPreset(state.selectedPreviewSize);
  syncPreviewPresetUI();
  syncModeControls();
  updateTimelineFromVideo();
  void syncAccessContext();
})();
