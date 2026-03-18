// Aceframe background service worker
// All state persisted to chrome.storage.local to survive service worker restarts.
// Each screenshot stored as a separate key to avoid per-call size limits.
// Requires "unlimitedStorage" permission in manifest.

const DEFAULT_APP_URL = 'https://aceframe.ai';

// In-memory cache to avoid storage reads on every tab event
let _isRecordingCached = false;
let _captureModeCached = 'screenshot';
// Track last HTML snapshot URL for same-page deduplication
let _lastHtmlSnapshotPageUrl = null;
let _lastHtmlSnapshotIndex = -1;
// Video recording state
let _videoRecordingTabId = null;
let _pendingStreamId = null;
let _videoRecordingStartedAt = null; // timestamp when actual recording started (post-countdown)

async function getAppUrl() {
  try {
    const result = await chrome.storage.sync.get('appUrl');
    return result.appUrl || DEFAULT_APP_URL;
  } catch {
    return DEFAULT_APP_URL;
  }
}

async function isRecording() {
  const result = await chrome.storage.local.get('recording');
  return result.recording || false;
}

async function isPaused() {
  const result = await chrome.storage.local.get('paused');
  return result.paused || false;
}

async function setRecording(value) {
  _isRecordingCached = value;
  await chrome.storage.local.set({ recording: value });
}

async function getCaptureMode() {
  const result = await chrome.storage.local.get('captureMode');
  return result.captureMode || 'screenshot';
}

async function setCaptureMode(mode) {
  _captureModeCached = mode;
  await chrome.storage.local.set({ captureMode: mode });
}

async function setPaused(value) {
  await chrome.storage.local.set({ paused: value });
}

async function getStepCount() {
  const result = await chrome.storage.local.get('stepCount');
  return result.stepCount || 0;
}

async function addStep(step) {
  const count = await getStepCount();
  const key = `step_${count}`;
  try {
    await chrome.storage.local.set({
      [key]: step,
      stepCount: count + 1
    });
    console.log(`Aceframe: Saved ${key} (stepCount now ${count + 1})`);
    return count + 1;
  } catch (err) {
    console.error(`Aceframe: Failed to save ${key}:`, err);
    throw err;
  }
}

async function getHtmlStepCount() {
  const result = await chrome.storage.local.get('htmlStepCount');
  return result.htmlStepCount || 0;
}

async function addHtmlStep(snapshot) {
  const count = await getHtmlStepCount();
  const key = `htmlStep_${count}`;
  try {
    await chrome.storage.local.set({
      [key]: snapshot,
      htmlStepCount: count + 1
    });
    console.log(`Aceframe: Saved ${key} (htmlStepCount now ${count + 1})`);
    return count + 1;
  } catch (err) {
    console.error(`Aceframe: Failed to save ${key}:`, err);
    throw err;
  }
}

async function clearSteps() {
  const count = await getStepCount();
  const htmlCount = await getHtmlStepCount();
  const keys = ['stepCount', 'pendingStepCount', 'htmlStepCount', 'pendingHtmlStepCount', 'captureMode', 'paused', 'videoData', 'videoDuration', 'cursorTrack', 'videoRecordingStartedAt'];
  for (let i = 0; i < count + 5; i++) {
    keys.push(`step_${i}`);
  }
  for (let i = 0; i < htmlCount + 5; i++) {
    keys.push(`htmlStep_${i}`);
  }
  await chrome.storage.local.remove(keys);
  _lastHtmlSnapshotPageUrl = null;
  _lastHtmlSnapshotIndex = -1;
  console.log(`Aceframe: Cleared ${count} steps + ${htmlCount} HTML steps from storage`);
}

// ── Offscreen document management ──

let _offscreenReady = false;

async function ensureOffscreen() {
  if (_offscreenReady) return;
  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length > 0) {
    _offscreenReady = true;
    return;
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Recording tab video via MediaRecorder',
  });
  _offscreenReady = true;
  console.log('Aceframe: Offscreen document created');
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {}
  _offscreenReady = false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_STATE':
      (async () => {
        // Batch all state reads into a single storage call
        const state = await chrome.storage.local.get(['recording', 'paused', 'stepCount', 'captureMode', 'videoRecordingStartedAt']);
        sendResponse({
          recording: state.recording || false,
          paused: state.paused || false,
          stepCount: state.stepCount || 0,
          captureMode: state.captureMode || 'screenshot',
          videoRecordingStartedAt: state.videoRecordingStartedAt || null,
        });
      })();
      return true;

    case 'START_RECORDING':
      (async () => {
        console.log('Aceframe: Starting recording...');
        await clearSteps();
        await setRecording(true);
        await setPaused(false);
        await setCaptureMode(message.captureMode || 'screenshot');
        console.log('Aceframe: Recording started (mode: ' + (message.captureMode || 'screenshot') + ')');
        sendResponse({ ok: true });
      })();
      return true;

    case 'START_VIDEO_RECORDING':
      (async () => {
        console.log('Aceframe: Starting video recording (with countdown)...');
        try {
          await clearSteps();
          await setRecording(true);
          await setPaused(false);
          await setCaptureMode('video');
          _videoRecordingTabId = message.tabId;

          // Pre-create offscreen document and get stream ID while countdown runs
          const streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: message.tabId,
          });
          await ensureOffscreen();

          // Store stream ID for when countdown completes
          _pendingStreamId = streamId;

          // Inject cursor tracking + countdown into the tab
          await chrome.scripting.executeScript({
            target: { tabId: message.tabId },
            files: ['video-cursor.js'],
          });

          sendResponse({ ok: true });
        } catch (err) {
          console.error('Aceframe: Failed to start video recording', err);
          await setRecording(false);
          await setCaptureMode('screenshot');
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;

    case 'VIDEO_COUNTDOWN_DONE':
      (async () => {
        // Countdown finished in content script - now start actual MediaRecorder
        if (_pendingStreamId) {
          _videoRecordingStartedAt = Date.now();
          await chrome.storage.local.set({ videoRecordingStartedAt: _videoRecordingStartedAt });
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_START_RECORDING',
            streamId: _pendingStreamId,
          }, (response) => {
            if (response && response.ok) {
              console.log('Aceframe: Video recording started (post-countdown)');
            } else {
              console.error('Aceframe: Offscreen recording failed', response);
            }
          });
          _pendingStreamId = null;
        }
        sendResponse({ ok: true });
      })();
      return true;

    case 'STOP_VIDEO_RECORDING':
      (async () => {
        console.log('Aceframe: Stopping video recording...');
        try {
          // Stop cursor tracking in the tab
          if (_videoRecordingTabId) {
            chrome.tabs.sendMessage(_videoRecordingTabId, { type: 'STOP_CURSOR_TRACKING' }).catch(() => {});
          }

          // Stop the offscreen recorder and get the video data
          const result = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_RECORDING' }, resolve);
          });

          if (result && result.ok) {
            // Get cursor track and click events from content script
            let cursorTrack = [];
            let videoClicks = [];
            if (_videoRecordingTabId) {
              try {
                const trackResults = await chrome.scripting.executeScript({
                  target: { tabId: _videoRecordingTabId },
                  func: () => ({
                    cursorTrack: window.__aceframeCursorTrack || [],
                    videoClicks: window.__aceframeVideoClicks || [],
                  }),
                });
                const data = (trackResults && trackResults[0] && trackResults[0].result) || {};
                cursorTrack = data.cursorTrack || [];
                videoClicks = data.videoClicks || [];
              } catch {}
            }

            // Capture a poster frame (screenshot for thumbnail)
            let posterDataUrl = '';
            try {
              posterDataUrl = await chrome.tabs.captureVisibleTab(null, {
                format: 'jpeg',
                quality: 85,
              });
            } catch {}

            // Store as pendingVideoStep (matches bridge.js expected format)
            await chrome.storage.local.set({
              pendingVideoStep: {
                videoBase64: result.videoDataUrl,
                videoMimeType: result.mimeType,
                videoDuration: result.duration,
                posterDataUrl: posterDataUrl,
                cursorTrack,
                videoClicks,
              },
              pendingStepCount: 0,
            });

            console.log(`Aceframe: Video saved (${result.duration.toFixed(1)}s, ${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB)`);
          }

          await setRecording(false);
          await closeOffscreen();
          _videoRecordingStartedAt = null;
          await chrome.storage.local.remove('videoRecordingStartedAt');

          // Broadcast stop to tabs
          await broadcastToTabs({ type: 'STOP' });

          // Open editor
          const appUrl = await getAppUrl();
          const url = `${appUrl}/new?source=extension&captureMode=video`;
          await chrome.tabs.create({ url });

          _videoRecordingTabId = null;
          sendResponse({ ok: true });
        } catch (err) {
          console.error('Aceframe: Failed to stop video recording', err);
          await setRecording(false);
          await closeOffscreen();
          _videoRecordingTabId = null;
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;

    case 'CANCEL_VIDEO_RECORDING':
      (async () => {
        console.log('Aceframe: Cancelling video recording...');
        try {
          if (_videoRecordingTabId) {
            chrome.tabs.sendMessage(_videoRecordingTabId, { type: 'STOP_CURSOR_TRACKING' }).catch(() => {});
          }
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_CANCEL_RECORDING' }, () => {});
          await closeOffscreen();
        } catch {}
        await setRecording(false);
        await setPaused(false);
        await clearSteps();
        _videoRecordingTabId = null;
        _pendingStreamId = null;
        _videoRecordingStartedAt = null;
        await chrome.storage.local.remove('videoRecordingStartedAt');
        sendResponse({ ok: true });
        await broadcastToTabs({ type: 'STOP' });
      })();
      return true;

    case 'STOP_RECORDING':
      (async () => {
        console.log('Aceframe: Stopping recording...');
        const mode = await getCaptureMode();
        if (mode === 'video') {
          // Delegate to video stop handler
          chrome.runtime.sendMessage({ type: 'STOP_VIDEO_RECORDING' });
          sendResponse({ ok: true });
          return;
        }
        await setRecording(false);
        await setPaused(false);
        sendResponse({ ok: true });
        await doStopRecording();
      })();
      return true;

    case 'PAUSE_RECORDING':
      (async () => {
        console.log('Aceframe: Pausing recording...');
        await setPaused(true);
        sendResponse({ ok: true });
        await broadcastToTabs({ type: 'PAUSE' });
      })();
      return true;

    case 'RESUME_RECORDING':
      (async () => {
        console.log('Aceframe: Resuming recording...');
        await setPaused(false);
        sendResponse({ ok: true });
        await broadcastToTabs({ type: 'RESUME' });
      })();
      return true;

    case 'CANCEL_RECORDING':
      (async () => {
        console.log('Aceframe: Cancelling recording...');
        const mode = await getCaptureMode();
        if (mode === 'video') {
          chrome.runtime.sendMessage({ type: 'CANCEL_VIDEO_RECORDING' });
          sendResponse({ ok: true });
          return;
        }
        await setRecording(false);
        await setPaused(false);
        await clearSteps();
        sendResponse({ ok: true });
        await broadcastToTabs({ type: 'STOP' });
      })();
      return true;

    case 'CAPTURE_CLICK':
      (async () => {
        // Batch state reads
        const clickState = await chrome.storage.local.get(['recording', 'paused', 'captureMode']);
        if (!clickState.recording || clickState.paused) {
          console.log('Aceframe: CAPTURE_CLICK received but not recording or paused');
          sendResponse({ ok: false });
          return;
        }
        try {
          const mode = clickState.captureMode || 'screenshot';
          const stepCount = await handleCaptureClick(message.data);

          // If in HTML capture mode, capture DOM snapshot or store pan reference
          if (mode === 'html' && sender.tab && sender.tab.id) {
            try {
              const pageUrl = message.data.pageUrl || '';
              // Compare without hash/query for more reliable same-page detection
              const stripParams = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; } };
              const isSamePage = _lastHtmlSnapshotPageUrl && stripParams(pageUrl) === stripParams(_lastHtmlSnapshotPageUrl);

              if (isSamePage && _lastHtmlSnapshotIndex >= 0) {
                // Same page - store a lightweight pan reference instead of full snapshot
                await addHtmlStep({
                  type: 'pan',
                  refIndex: _lastHtmlSnapshotIndex,
                  scrollX: message.data.scrollX || 0,
                  scrollY: message.data.scrollY || 0,
                });
                console.log(`Aceframe: Pan step stored (ref: htmlStep_${_lastHtmlSnapshotIndex})`);
              } else {
                // New page - capture full snapshot
                await captureHtmlSnapshot(sender.tab.id);
                const newIndex = (await getHtmlStepCount()) - 1;
                _lastHtmlSnapshotPageUrl = pageUrl;
                _lastHtmlSnapshotIndex = newIndex;
              }
            } catch (htmlErr) {
              console.error('Aceframe: HTML capture failed (screenshot still saved):', htmlErr);
            }
          }

          sendResponse({ ok: true, stepCount });
        } catch (err) {
          console.error('Aceframe: Capture failed:', err);
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
  }
});

async function broadcastToTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  } catch {}
}

// Re-inject content script when pages load during recording
// Uses in-memory cache to avoid storage reads on every tab event
function getRecordingFiles() {
  if (_captureModeCached === 'video') return ['video-cursor.js'];
  const files = ['content.js'];
  if (_captureModeCached === 'html') files.push('html-capture.js');
  return files;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!_isRecordingCached || changeInfo.status !== 'complete') return;
  // Don't re-inject video-cursor.js - it has its own guard and re-injection causes double countdown
  if (_captureModeCached === 'video') return;
  chrome.scripting.executeScript({
    target: { tabId },
    files: getRecordingFiles()
  }).catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!_isRecordingCached) return;
  if (_captureModeCached === 'video') return;
  if (tab.id && tab.status === 'complete') {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: getRecordingFiles()
    }).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!_isRecordingCached) return;
  if (_captureModeCached === 'video') return;
  chrome.scripting.executeScript({
    target: { tabId },
    files: getRecordingFiles()
  }).catch(() => {});
});

async function handleCaptureClick(clickData) {
  // Capture as JPEG quality 85 - much smaller than PNG (200-500KB vs 2-4MB)
  const dataUrl = await chrome.tabs.captureVisibleTab(null, {
    format: 'jpeg',
    quality: 85
  });

  console.log(`Aceframe: Captured screenshot (${Math.round(dataUrl.length / 1024)}KB base64)`);

  const step = {
    screenshot: dataUrl,
    click: { x: clickData.x, y: clickData.y },
    viewportWidth: clickData.viewportWidth,
    viewportHeight: clickData.viewportHeight,
    pageUrl: clickData.pageUrl,
    pageTitle: clickData.pageTitle || '',
    timestamp: clickData.timestamp,
    scrollX: clickData.scrollX || 0,
    scrollY: clickData.scrollY || 0,
    annotation: '',
    zoomLevel: 1,
    elementText: clickData.elementText || '',
    elementTag: clickData.elementTag || '',
    elementSelector: clickData.elementSelector || '',
    elementAriaLabel: clickData.elementAriaLabel || ''
  };

  const stepCount = await addStep(step);

  chrome.runtime.sendMessage({
    type: 'STEP_CAPTURED',
    stepCount
  }).catch(() => {});

  return stepCount;
}

/**
 * Inject html-capture.js into a tab and run the capture function.
 * Returns the snapshot object and stores it as an HTML step.
 */
async function captureHtmlSnapshot(tabId) {
  // First, inject the html-capture.js script
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['html-capture.js']
  });

  // Then execute the capture function and get the result
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      if (typeof window.__aceframeHTMLCapture === 'function') {
        return await window.__aceframeHTMLCapture();
      }
      return null;
    }
  });

  const snapshot = results && results[0] && results[0].result;
  if (!snapshot) {
    throw new Error('HTML capture returned no data');
  }

  const htmlStepCount = await addHtmlStep(snapshot);
  console.log(`Aceframe: HTML snapshot captured (${htmlStepCount} total)`);
  return htmlStepCount;
}

async function doStopRecording() {
  // Send STOP to ALL tabs
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'STOP' }).catch(() => {});
      }
    }
  } catch {}

  const count = await getStepCount();
  console.log(`Aceframe: doStopRecording - stepCount is ${count}`);

  if (count === 0) {
    console.log('Aceframe: No steps captured, not opening editor');
    return;
  }

  try {
    const htmlCount = await getHtmlStepCount();
    const mode = await getCaptureMode();
    const storageData = { pendingStepCount: count };

    if (htmlCount > 0) {
      storageData.pendingHtmlStepCount = htmlCount;
    }

    await chrome.storage.local.set(storageData);
    console.log(`Aceframe: Set pendingStepCount=${count}, pendingHtmlStepCount=${htmlCount}, opening editor...`);

    const appUrl = await getAppUrl();
    const urlParams = new URLSearchParams({ source: 'extension' });
    if (mode === 'html') {
      urlParams.set('captureMode', 'html');
    }
    const url = `${appUrl}/new?${urlParams.toString()}`;
    console.log(`Aceframe: Opening ${url}`);
    await chrome.tabs.create({ url });
  } catch (err) {
    console.error('Aceframe: Failed to open editor:', err);
  }
}
