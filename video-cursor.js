// Aceframe video cursor tracker + click step recorder + recording controls
// Injected during video recording. Tracks mouse positions for cursor overlay
// and records clicks with metadata for auto-splitting video into demo steps.

(function () {
  if (window.__aceframeCursorTracking) return;
  window.__aceframeCursorTracking = true;
  if (!window.__aceframeCursorTrack) window.__aceframeCursorTrack = [];
  if (!window.__aceframeVideoClicks) window.__aceframeVideoClicks = [];

  let startTime = null;
  let isRecording = false;
  let isPillPaused = false;
  let lastX = 0;
  let lastY = 0;
  let throttleTimer = null;
  let timerInterval = null;

  // ── Countdown overlay ──
  function showCountdown(onComplete) {
    const overlay = document.createElement('div');
    overlay.id = 'aceframe-countdown';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.5);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: opacity 0.3s ease;
    `;

    const counter = document.createElement('div');
    counter.style.cssText = `
      font-size: 120px; font-weight: 800; color: white;
      text-shadow: 0 4px 40px rgba(0,0,0,0.3);
      transition: transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.3s ease;
    `;
    counter.textContent = '3';
    overlay.appendChild(counter);
    document.documentElement.appendChild(overlay);

    let count = 3;
    const tick = () => {
      if (count <= 0) {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 300);
        onComplete();
        return;
      }
      counter.textContent = count.toString();
      counter.style.transform = 'scale(1.3)';
      counter.style.opacity = '0.5';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          counter.style.transform = 'scale(1)';
          counter.style.opacity = '1';
        });
      });
      count--;
      setTimeout(tick, 1000);
    };
    tick();
  }

  // ── Recording indicator with controls ──
  function createPill(elapsedOffset) {
    const indicator = document.createElement('div');
    indicator.id = 'aceframe-video-indicator';
    indicator.innerHTML = `
      <div id="aceframe-video-pill" style="
        position: fixed;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 6px;
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: #fff;
        padding: 6px 10px;
        border-radius: 24px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 11px;
        font-weight: 600;
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
        user-select: none;
        cursor: grab;
        letter-spacing: -0.1px;
        transition: opacity 0.3s ease, transform 0.3s ease;
        animation: aceframeVideoSlideIn 0.4s cubic-bezier(0.25, 0.1, 0.25, 1) forwards;
        opacity: 0.4;
      ">
        <div style="position: relative; width: 6px; height: 6px; flex-shrink: 0;">
          <div id="aceframe-video-dot" style="
            width: 6px; height: 6px;
            background: #EF4444;
            border-radius: 50%;
            animation: aceframeVideoPulse 1.5s ease-in-out infinite;
          "></div>
        </div>
        <span id="aceframe-video-timer" style="min-width: 28px; font-variant-numeric: tabular-nums;">0:00</span>
        <div style="width: 1px; height: 14px; background: rgba(255,255,255,0.2); flex-shrink: 0;"></div>
        <div id="aceframe-video-pause" style="
          width: 22px; height: 22px;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; opacity: 0.7;
          border-radius: 6px;
          transition: opacity 0.2s ease, background 0.2s ease;
          flex-shrink: 0;
        " title="Pause recording">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="white">
            <rect x="1" y="0.5" width="3" height="9" rx="0.5"/>
            <rect x="6" y="0.5" width="3" height="9" rx="0.5"/>
          </svg>
        </div>
        <div id="aceframe-video-stop" style="
          width: 22px; height: 22px;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; opacity: 0.7;
          background: rgba(239, 68, 68, 0.6);
          border-radius: 6px;
          transition: opacity 0.2s ease, background 0.2s ease;
          flex-shrink: 0;
        " title="Stop recording">
          <div style="width: 8px; height: 8px; background: #fff; border-radius: 1.5px;"></div>
        </div>
        <div id="aceframe-video-cancel" style="
          width: 22px; height: 22px;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; opacity: 0.5;
          transition: opacity 0.2s ease;
          flex-shrink: 0;
        " title="Cancel recording">
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round">
            <line x1="1" y1="1" x2="9" y2="9"/>
            <line x1="9" y1="1" x2="1" y2="9"/>
          </svg>
        </div>
      </div>
    `;
    document.documentElement.appendChild(indicator);

    const pill = document.getElementById('aceframe-video-pill');
    const pauseBtn = document.getElementById('aceframe-video-pause');
    const stopBtn = document.getElementById('aceframe-video-stop');
    const cancelBtn = document.getElementById('aceframe-video-cancel');
    const timerLabel = document.getElementById('aceframe-video-timer');

    // Show initial elapsed time if resuming after navigation
    if (elapsedOffset > 0) {
      const mins = Math.floor(elapsedOffset / 60);
      const secs = elapsedOffset % 60;
      timerLabel.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    // Show pill fully on hover, fade when not hovered
    pill.addEventListener('mouseenter', () => { pill.style.opacity = '1'; });
    pill.addEventListener('mouseleave', () => { if (!isPillPaused) pill.style.opacity = '0.4'; });

    pauseBtn.addEventListener('mouseenter', () => { pauseBtn.style.opacity = '1'; pauseBtn.style.background = 'rgba(255,255,255,0.15)'; });
    pauseBtn.addEventListener('mouseleave', () => { pauseBtn.style.opacity = '0.7'; pauseBtn.style.background = 'transparent'; });
    stopBtn.addEventListener('mouseenter', () => { stopBtn.style.opacity = '1'; stopBtn.style.background = 'rgba(239,68,68,0.8)'; });
    stopBtn.addEventListener('mouseleave', () => { stopBtn.style.opacity = '0.7'; stopBtn.style.background = 'rgba(239,68,68,0.6)'; });
    cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.opacity = '0.9'; });
    cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.opacity = '0.5'; });

    // ── Draggable ──
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0, pillStartX = 0, pillStartY = 0, hasMoved = false;

    pill.addEventListener('mousedown', (e) => {
      if (e.target.closest('#aceframe-video-stop') || e.target.closest('#aceframe-video-cancel') || e.target.closest('#aceframe-video-pause')) return;
      isDragging = true;
      hasMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = pill.getBoundingClientRect();
      pillStartX = rect.left;
      pillStartY = rect.top;
      pill.style.cursor = 'grabbing';
      pill.style.transition = 'box-shadow 0.3s ease, background 0.25s ease';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
      if (!hasMoved) return;
      const newX = Math.max(0, Math.min(window.innerWidth - pill.offsetWidth, pillStartX + dx));
      const newY = Math.max(0, Math.min(window.innerHeight - pill.offsetHeight, pillStartY + dy));
      pill.style.bottom = 'auto';
      pill.style.left = newX + 'px';
      pill.style.top = newY + 'px';
      pill.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      pill.style.cursor = 'grab';
      pill.style.transition = 'box-shadow 0.3s ease, background 0.25s ease, transform 0.25s ease, opacity 0.3s ease';
    });

    // Pause/resume
    let pausedAt = null;
    let pausedElapsed = 0;
    pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      isPillPaused = !isPillPaused;
      if (isPillPaused) {
        pausedAt = Date.now();
        pill.style.opacity = '1';
        pill.style.background = 'rgba(0, 0, 0, 0.85)';
        pauseBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="white"><path d="M2 0.5l7 4.5-7 4.5z"/></svg>';
        pauseBtn.title = 'Resume recording';
      } else {
        if (pausedAt) pausedElapsed += Date.now() - pausedAt;
        pausedAt = null;
        pill.style.background = 'rgba(0, 0, 0, 0.75)';
        pill.style.opacity = '0.4';
        pauseBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="white"><rect x="1" y="0.5" width="3" height="9" rx="0.5"/><rect x="6" y="0.5" width="3" height="9" rx="0.5"/></svg>';
        pauseBtn.title = 'Pause recording';
      }
    });

    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'STOP_VIDEO_RECORDING' });
      pill.style.opacity = '0';
      pill.style.transform = 'translateY(8px) scale(0.95)';
      setTimeout(cleanup, 300);
    });

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!window.confirm('Cancel video recording? The recording will be discarded.')) return;
      chrome.runtime.sendMessage({ type: 'CANCEL_VIDEO_RECORDING' });
      pill.style.opacity = '0';
      pill.style.transform = 'translateY(-8px) scale(0.95)';
      setTimeout(cleanup, 300);
    });

    timerInterval = setInterval(() => {
      if (!startTime) return;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      timerLabel.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }, 1000);

    return { indicator };
  }

  // ── Cursor tracking (for smooth cursor overlay during playback) ──
  function recordPosition(x, y) {
    if (!startTime) return;
    const t = Date.now() - startTime;
    const normX = x / window.innerWidth;
    const normY = y / window.innerHeight;
    if (
      window.__aceframeCursorTrack.length > 0 &&
      Math.abs(normX - lastX) < 0.01 &&
      Math.abs(normY - lastY) < 0.01
    ) return;
    lastX = normX;
    lastY = normY;
    window.__aceframeCursorTrack.push({ t, x: normX, y: normY });
  }

  function handleMouseMove(e) {
    if (!isRecording || isPillPaused) return;
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => { throttleTimer = null; }, 50);
    recordPosition(e.clientX, e.clientY);
  }

  // ── Click tracking (for step splitting + cursor track) ──
  function handleClick(e) {
    if (!isRecording || isPillPaused) return;
    if (e.target.closest('#aceframe-video-indicator')) return;

    const t = Date.now() - startTime;
    const clickTarget = e.target;

    // Record in cursor track
    window.__aceframeCursorTrack.push({
      t,
      x: e.clientX / window.innerWidth,
      y: e.clientY / window.innerHeight,
    });

    // Record as a step-splitting click event with full metadata
    let elementSelector = '';
    try {
      if (clickTarget.id) {
        elementSelector = '#' + clickTarget.id;
      } else if (clickTarget.className && typeof clickTarget.className === 'string') {
        const classes = clickTarget.className.trim().split(/\s+/).slice(0, 3).join('.');
        if (classes) elementSelector = (clickTarget.tagName?.toLowerCase() || '') + '.' + classes;
      }
    } catch {}

    window.__aceframeVideoClicks.push({
      t,
      x: e.clientX / window.innerWidth,
      y: e.clientY / window.innerHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageUrl: window.location.href,
      pageTitle: document.title,
      elementText: (clickTarget.textContent || '').trim().substring(0, 200),
      elementTag: clickTarget.tagName?.toLowerCase() || '',
      elementSelector,
      elementAriaLabel: clickTarget.getAttribute('aria-label') || '',
    });

    // Visual click feedback
    showClickFeedback(e.clientX, e.clientY);
  }

  function showClickFeedback(x, y) {
    const flash = document.createElement('div');
    flash.style.cssText = `
      position: fixed;
      left: ${x - 16}px;
      top: ${y - 16}px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(28, 106, 230, 0.15);
      border: 2px solid rgba(28, 106, 230, 0.3);
      pointer-events: none;
      z-index: 2147483646;
      animation: aceframeClickFlash 0.4s ease forwards;
    `;
    document.documentElement.appendChild(flash);
    setTimeout(() => flash.remove(), 400);
  }

  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);

  // Styles
  const style = document.createElement('style');
  style.id = 'aceframe-video-styles';
  style.textContent = `
    @keyframes aceframeVideoPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    @keyframes aceframeVideoSlideIn {
      0% { opacity: 0; transform: translateX(-50%) translateY(12px); }
      100% { opacity: 0.4; transform: translateX(-50%) translateY(0); }
    }
    @keyframes aceframeClickFlash {
      0% { opacity: 0.6; transform: scale(1); }
      100% { opacity: 0; transform: scale(2); }
    }
  `;
  document.documentElement.appendChild(style);

  // ── Check if recording already started (page navigation during recording) ──
  let pillElements = null;

  chrome.storage.local.get('videoRecordingStartedAt', (result) => {
    if (result.videoRecordingStartedAt) {
      // Recording already in progress - skip countdown, just show pill
      isRecording = true;
      startTime = result.videoRecordingStartedAt;
      const elapsedSecs = Math.floor((Date.now() - startTime) / 1000);
      pillElements = createPill(elapsedSecs);
      // No need to send VIDEO_COUNTDOWN_DONE - already sent on first page
    } else {
      // First injection - show countdown
      showCountdown(() => {
        isRecording = true;
        startTime = Date.now();
        pillElements = createPill(0);
        chrome.runtime.sendMessage({ type: 'VIDEO_COUNTDOWN_DONE' });
      });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STOP' || message.type === 'STOP_CURSOR_TRACKING') {
      cleanup();
    }
  });

  function cleanup() {
    isRecording = false;
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    if (timerInterval) clearInterval(timerInterval);
    if (pillElements && pillElements.indicator.parentNode) pillElements.indicator.remove();
    if (style.parentNode) style.remove();
    if (throttleTimer) clearTimeout(throttleTimer);
    const countdown = document.getElementById('aceframe-countdown');
    if (countdown) countdown.remove();
    window.__aceframeCursorTracking = false;
    // Keep __aceframeCursorTrack and __aceframeVideoClicks for background to read
  }
})();
