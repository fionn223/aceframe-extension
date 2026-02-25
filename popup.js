const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const idleState = document.getElementById('idle-state');
const recordingState = document.getElementById('recording-state');
const stepCountEl = document.getElementById('step-count');

// Check current recording state on popup open
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (response && response.recording) {
    showRecordingUI(response.stepCount);
  }
});

// Listen for step count updates while popup is open
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STEP_CAPTURED') {
    stepCountEl.textContent = message.stepCount;
  }
});

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;

  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Check if this is a page we can't inject into
  if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
    btnStart.disabled = false;
    showError("Can't record on this page. Navigate to a regular web page first.");
    return;
  }

  try {
    // Inject content script programmatically
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    // Tell background to start recording
    chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id });

    showRecordingUI(0);
  } catch (err) {
    btnStart.disabled = false;
    showError("Can't record on this page. Try a different tab.");
    console.error('Aceframe: Failed to start recording', err);
  }
});

btnStop.addEventListener('click', () => {
  btnStop.disabled = true;
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  // The background script will handle opening the web app
  // Close the popup after a short delay
  setTimeout(() => window.close(), 500);
});

function showRecordingUI(count) {
  idleState.style.display = 'none';
  recordingState.style.display = 'block';
  stepCountEl.textContent = count;
}

function showError(msg) {
  // Remove any existing error
  const existing = document.getElementById('aceframe-error');
  if (existing) existing.remove();

  const el = document.createElement('p');
  el.id = 'aceframe-error';
  el.style.cssText = 'color: #F00078; font-size: 11px; margin-top: 12px; line-height: 1.4;';
  el.textContent = msg;
  idleState.appendChild(el);
}
