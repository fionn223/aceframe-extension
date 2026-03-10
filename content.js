// Aceframe content script — injected into the active tab during recording
// Captures screenshot BEFORE replaying the click, hides indicator from screenshots.

(function () {
  if (window.__aceframeRecording) return;
  window.__aceframeRecording = true;

  let replaying = false;
  let paused = false;

  // ── Recording indicator with controls ──
  const indicator = document.createElement('div');
  indicator.id = 'aceframe-indicator';
  indicator.innerHTML = `
    <div id="aceframe-pill" style="
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 8px;
      background: #1C6AE6;
      color: #fff;
      padding: 7px 14px;
      border-radius: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      font-weight: 600;
      box-shadow: 0 2px 16px rgba(28, 106, 230, 0.3);
      user-select: none;
      cursor: grab;
      letter-spacing: -0.1px;
      transition: box-shadow 0.3s cubic-bezier(0.25, 0.1, 0.25, 1),
                  background 0.25s cubic-bezier(0.25, 0.1, 0.25, 1),
                  transform 0.25s cubic-bezier(0.25, 0.1, 0.25, 1),
                  opacity 0.3s ease;
      transform: translateY(0);
      opacity: 1;
    ">
      <!-- Icon container: fixed size, dot and stop overlap in same space -->
      <div style="position: relative; width: 16px; height: 16px; flex-shrink: 0;">
        <div id="aceframe-dot" style="
          position: absolute;
          top: 50%;
          left: 50%;
          width: 7px;
          height: 7px;
          background: #fff;
          border-radius: 50%;
          animation: aceframePulse 1.5s ease-in-out infinite;
          transform: translate(-50%, -50%) scale(1);
          transition: opacity 0.25s cubic-bezier(0.25, 0.1, 0.25, 1),
                      transform 0.25s cubic-bezier(0.25, 0.1, 0.25, 1);
          opacity: 1;
        "></div>
        <div id="aceframe-stop-btn" style="
          position: absolute;
          top: 0;
          left: 0;
          width: 16px;
          height: 16px;
          background: #fff;
          border-radius: 3px;
          cursor: pointer;
          opacity: 0;
          transform: scale(0.6);
          transition: opacity 0.25s cubic-bezier(0.25, 0.1, 0.25, 1),
                      transform 0.25s cubic-bezier(0.25, 0.1, 0.25, 1);
        " title="Stop Recording"></div>
      </div>
      <span id="aceframe-label" style="transition: opacity 0.2s ease;">Recording</span>
      <!-- Pause button -->
      <div id="aceframe-pause-btn" style="
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0.7;
        transition: opacity 0.2s ease;
        flex-shrink: 0;
      " title="Pause">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="white">
          <rect x="1" y="1" width="3.5" height="10" rx="0.5"/>
          <rect x="7.5" y="1" width="3.5" height="10" rx="0.5"/>
        </svg>
      </div>
      <!-- Cancel button -->
      <div id="aceframe-cancel-btn" style="
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0.7;
        transition: opacity 0.2s ease;
        flex-shrink: 0;
      " title="Cancel recording">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round">
          <line x1="1" y1="1" x2="9" y2="9"/>
          <line x1="9" y1="1" x2="1" y2="9"/>
        </svg>
      </div>
    </div>
  `;
  document.documentElement.appendChild(indicator);

  const pill = document.getElementById('aceframe-pill');
  const stopBtn = document.getElementById('aceframe-stop-btn');
  const dot = document.getElementById('aceframe-dot');
  const label = document.getElementById('aceframe-label');
  const pauseBtn = document.getElementById('aceframe-pause-btn');
  const cancelBtn = document.getElementById('aceframe-cancel-btn');

  // Hover: crossfade between dot and stop button (no layout shift)
  pill.addEventListener('mouseenter', () => {
    if (isDragging) return;
    stopBtn.style.opacity = '0.9';
    stopBtn.style.transform = 'scale(1)';
    dot.style.opacity = '0';
    dot.style.transform = 'translate(-50%, -50%) scale(0.5)';
    pill.style.boxShadow = '0 4px 24px rgba(28, 106, 230, 0.45)';
    pill.style.transform = pill.style.transform === 'none' ? 'scale(1.03)' : 'translateY(-1px) scale(1.03)';
  });
  pill.addEventListener('mouseleave', () => {
    if (isDragging) return;
    stopBtn.style.opacity = '0';
    stopBtn.style.transform = 'scale(0.6)';
    dot.style.opacity = paused ? '0' : '1';
    dot.style.transform = 'translate(-50%, -50%) scale(1)';
    pill.style.boxShadow = paused
      ? '0 2px 16px rgba(156, 163, 175, 0.3)'
      : '0 2px 16px rgba(28, 106, 230, 0.3)';
    pill.style.transform = pill.style.transform.includes('none') ? 'none' : 'translateY(0) scale(1)';
  });

  // Hover effects on control buttons
  pauseBtn.addEventListener('mouseenter', () => { pauseBtn.style.opacity = '1'; });
  pauseBtn.addEventListener('mouseleave', () => { pauseBtn.style.opacity = '0.7'; });
  cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.opacity = '1'; });
  cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.opacity = '0.7'; });

  // ── Draggable pill ──
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let pillStartX = 0;
  let pillStartY = 0;
  let hasMoved = false;

  pill.addEventListener('mousedown', (e) => {
    if (e.target === stopBtn || e.target === pauseBtn || e.target === cancelBtn || e.target.closest('#aceframe-pause-btn') || e.target.closest('#aceframe-cancel-btn')) return;
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

    const newX = pillStartX + dx;
    const newY = pillStartY + dy;
    const maxX = window.innerWidth - pill.offsetWidth;
    const maxY = window.innerHeight - pill.offsetHeight;
    const clampedX = Math.max(0, Math.min(maxX, newX));
    const clampedY = Math.max(0, Math.min(maxY, newY));

    pill.style.right = 'auto';
    pill.style.left = clampedX + 'px';
    pill.style.top = clampedY + 'px';
    pill.style.transform = 'none';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    pill.style.cursor = 'grab';
    pill.style.transition = 'box-shadow 0.3s cubic-bezier(0.25, 0.1, 0.25, 1), background 0.25s cubic-bezier(0.25, 0.1, 0.25, 1), transform 0.25s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.3s ease';
  });

  // Click stop button
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    pill.style.opacity = '0';
    pill.style.transform = 'translateY(-8px) scale(0.95)';
    setTimeout(cleanup, 300);
  });

  // Click pause/resume button
  pauseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (paused) {
      chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' });
    } else {
      chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' });
    }
  });

  // Click cancel button — confirm before discarding steps
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!window.confirm('Cancel recording? All captured steps will be discarded.')) {
      return;
    }
    chrome.runtime.sendMessage({ type: 'CANCEL_RECORDING' });
    pill.style.opacity = '0';
    pill.style.transform = 'translateY(-8px) scale(0.95)';
    setTimeout(cleanup, 300);
  });

  // ── Pause/Resume UI state ──
  function setPausedUI(isPaused) {
    paused = isPaused;
    if (isPaused) {
      pill.style.background = '#6B7280';
      pill.style.boxShadow = '0 2px 16px rgba(156, 163, 175, 0.3)';
      dot.style.animation = 'none';
      dot.style.opacity = '0';
      label.textContent = 'Paused';
      // Switch pause icon to play (triangle)
      pauseBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 12 12" fill="white">
          <polygon points="2,1 11,6 2,11"/>
        </svg>
      `;
      pauseBtn.title = 'Resume';
    } else {
      pill.style.background = '#1C6AE6';
      pill.style.boxShadow = '0 2px 16px rgba(28, 106, 230, 0.3)';
      dot.style.animation = 'aceframePulse 1.5s ease-in-out infinite';
      dot.style.opacity = '1';
      label.textContent = 'Recording';
      // Switch play icon back to pause (two bars)
      pauseBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 12 12" fill="white">
          <rect x="1" y="1" width="3.5" height="10" rx="0.5"/>
          <rect x="7.5" y="1" width="3.5" height="10" rx="0.5"/>
        </svg>
      `;
      pauseBtn.title = 'Pause';
    }
  }

  // Styles
  const style = document.createElement('style');
  style.id = 'aceframe-styles';
  style.textContent = `
    @keyframes aceframePulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    @keyframes aceframeFlash {
      0% { opacity: 0.4; transform: scale(1); }
      100% { opacity: 0; transform: scale(1.8); }
    }
    @keyframes aceframeSlideIn {
      0% { opacity: 0; transform: translateY(-12px) scale(0.95); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    #aceframe-pill {
      animation: aceframeSlideIn 0.4s cubic-bezier(0.25, 0.1, 0.25, 1) forwards;
    }
  `;
  document.documentElement.appendChild(style);

  // ── Click handler ──
  function handleClick(e) {
    if (replaying) return;
    if (paused) return;
    if (e.target.closest('#aceframe-indicator')) return;
    if (hasMoved) { hasMoved = false; return; }

    e.preventDefault();
    e.stopImmediatePropagation();

    const clickTarget = e.target;
    const clickX = e.clientX;
    const clickY = e.clientY;

    // Capture element metadata for Guided Mode
    const elementText = (clickTarget.textContent || '').trim().substring(0, 200);
    const elementTag = clickTarget.tagName?.toLowerCase() || '';
    const elementAriaLabel = clickTarget.getAttribute('aria-label') || '';
    let elementSelector = '';
    try {
      if (clickTarget.id) {
        elementSelector = '#' + clickTarget.id;
      } else if (clickTarget.className && typeof clickTarget.className === 'string') {
        const classes = clickTarget.className.trim().split(/\s+/).slice(0, 3).join('.');
        if (classes) elementSelector = elementTag + '.' + classes;
      }
    } catch {}

    const clickData = {
      x: clickX / window.innerWidth,
      y: clickY / window.innerHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageUrl: window.location.href,
      pageTitle: document.title,
      timestamp: Date.now(),
      elementText,
      elementTag,
      elementSelector,
      elementAriaLabel
    };

    // Hide indicator so it doesn't appear in screenshot
    indicator.style.visibility = 'hidden';

    requestAnimationFrame(() => {
      chrome.runtime.sendMessage(
        { type: 'CAPTURE_CLICK', data: clickData },
        () => {
          indicator.style.visibility = 'visible';
          showClickFeedback(clickX, clickY);
          replaying = true;
          const replayEvent = new MouseEvent('click', {
            bubbles: true, cancelable: true, view: window,
            clientX: clickX, clientY: clickY,
            screenX: e.screenX, screenY: e.screenY,
            button: e.button, buttons: e.buttons,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
            altKey: e.altKey, metaKey: e.metaKey,
          });
          clickTarget.dispatchEvent(replayEvent);
          replaying = false;
        }
      );
    });
  }

  function showClickFeedback(x, y) {
    const flash = document.createElement('div');
    flash.style.cssText = `
      position: fixed;
      left: ${x - 20}px;
      top: ${y - 20}px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(28, 106, 230, 0.2);
      border: 2px solid rgba(28, 106, 230, 0.4);
      pointer-events: none;
      z-index: 2147483646;
      animation: aceframeFlash 0.5s cubic-bezier(0.25, 0.1, 0.25, 1) forwards;
    `;
    document.documentElement.appendChild(flash);
    setTimeout(() => flash.remove(), 500);
  }

  document.addEventListener('click', handleClick, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STOP') {
      pill.style.opacity = '0';
      pill.style.transform = 'translateY(-8px) scale(0.95)';
      setTimeout(cleanup, 300);
    }
    if (message.type === 'PAUSE') {
      setPausedUI(true);
    }
    if (message.type === 'RESUME') {
      setPausedUI(false);
    }
  });

  // Check if we were paused before re-injection (e.g. page navigated)
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (response && response.paused) {
      setPausedUI(true);
    }
  });

  function cleanup() {
    document.removeEventListener('click', handleClick, true);
    indicator.remove();
    style.remove();
    window.__aceframeRecording = false;
  }
})();
