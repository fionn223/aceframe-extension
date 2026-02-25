// Aceframe background service worker
// All state persisted to chrome.storage.local to survive service worker restarts.
// Each screenshot stored as a separate key to avoid per-call size limits.
// Requires "unlimitedStorage" permission in manifest.

const DEFAULT_APP_URL = 'https://aceframe.ai';

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

async function setRecording(value) {
  await chrome.storage.local.set({ recording: value });
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

async function clearSteps() {
  const count = await getStepCount();
  const keys = ['stepCount', 'pendingStepCount'];
  for (let i = 0; i < count + 5; i++) {
    keys.push(`step_${i}`);
  }
  await chrome.storage.local.remove(keys);
  console.log(`Aceframe: Cleared ${count} steps from storage`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_STATE':
      (async () => {
        const recording = await isRecording();
        const stepCount = await getStepCount();
        sendResponse({ recording, stepCount });
      })();
      return true;

    case 'START_RECORDING':
      (async () => {
        console.log('Aceframe: Starting recording...');
        await clearSteps();
        await setRecording(true);
        console.log('Aceframe: Recording started');
        sendResponse({ ok: true });
      })();
      return true;

    case 'STOP_RECORDING':
      (async () => {
        console.log('Aceframe: Stopping recording...');
        await setRecording(false);
        sendResponse({ ok: true });
        await doStopRecording();
      })();
      return true;

    case 'CAPTURE_CLICK':
      (async () => {
        const recording = await isRecording();
        if (!recording) {
          console.log('Aceframe: CAPTURE_CLICK received but not recording');
          sendResponse({ ok: false });
          return;
        }
        try {
          const stepCount = await handleCaptureClick(message.data);
          sendResponse({ ok: true, stepCount });
        } catch (err) {
          console.error('Aceframe: Capture failed:', err);
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
  }
});

// Re-inject content script when pages load during recording
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const recording = await isRecording();
  if (!recording) return;
  if (changeInfo.status !== 'complete') return;

  chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  }).catch(() => {});
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const recording = await isRecording();
  if (!recording) return;

  if (tab.id && tab.status === 'complete') {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    }).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const recording = await isRecording();
  if (!recording) return;

  chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  }).catch(() => {});
});

async function handleCaptureClick(clickData) {
  // Capture as JPEG quality 85 — much smaller than PNG (200-500KB vs 2-4MB)
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
    annotation: '',
    zoomLevel: 1.5
  };

  const stepCount = await addStep(step);

  chrome.runtime.sendMessage({
    type: 'STEP_CAPTURED',
    stepCount
  }).catch(() => {});

  return stepCount;
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
  console.log(`Aceframe: doStopRecording — stepCount is ${count}`);

  if (count === 0) {
    console.log('Aceframe: No steps captured, not opening editor');
    return;
  }

  try {
    await chrome.storage.local.set({ pendingStepCount: count });
    console.log(`Aceframe: Set pendingStepCount=${count}, opening editor...`);
    const appUrl = await getAppUrl();
    const url = `${appUrl}/new?source=extension`;
    console.log(`Aceframe: Opening ${url}`);
    await chrome.tabs.create({ url });
  } catch (err) {
    console.error('Aceframe: Failed to open editor:', err);
  }
}
