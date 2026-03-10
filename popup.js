// ── Element References ──
const btnStart = document.getElementById('btn-start');
const btnHtml = document.getElementById('btn-html');
const btnVideo = document.getElementById('btn-video');
const btnStop = document.getElementById('btn-stop');
const btnPause = document.getElementById('btn-pause');
const btnCancel = document.getElementById('btn-cancel');
const btnVideoStop = document.getElementById('btn-video-stop');
const btnVideoCancel = document.getElementById('btn-video-cancel');
const btnSignin = document.getElementById('btn-signin');
const btnSignup = document.getElementById('btn-signup');
const btnDashboard = document.getElementById('btn-dashboard');
const btnWelcomeDismiss = document.getElementById('btn-welcome-dismiss');

const welcomeState = document.getElementById('welcome-state');
const signinState = document.getElementById('signin-state');
const idleState = document.getElementById('idle-state');
const recordingState = document.getElementById('recording-state');
const videoState = document.getElementById('video-state');
const popupFooter = document.getElementById('popup-footer');

const recordingStatus = document.getElementById('recording-status');
const recDot = document.getElementById('rec-dot');
const stepCountEl = document.getElementById('step-count');
const videoTimerEl = document.getElementById('video-timer');
const progressFill = document.getElementById('progress-fill');

let isPaused = false;
let videoTimerInterval = null;
let videoStartTime = null;
let appUrl = 'https://aceframe.ai';

// ── Initialization ──

async function init() {
  // Load appUrl from storage
  try {
    const data = await chrome.storage.sync.get('appUrl');
    if (data.appUrl) appUrl = data.appUrl;
  } catch (e) {
    // Use default
  }

  // Check current recording state first
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, async (response) => {
    if (response && response.videoRecording) {
      showState('video');
      chrome.storage.local.get('videoStartTime', (data) => {
        if (data.videoStartTime) {
          videoStartTime = data.videoStartTime;
          startVideoTimer();
        }
      });
      return;
    }

    if (response && response.recording) {
      showState('recording');
      stepCountEl.textContent = response.stepCount;
      if (response.paused) {
        setPausedUI(true);
      }
      return;
    }

    // Not recording - check welcome / auth state
    try {
      const welcomeData = await chrome.storage.local.get('welcomeDismissed');
      if (!welcomeData.welcomeDismissed) {
        showState('welcome');
        return;
      }
    } catch (e) {
      // Continue to auth check
    }

    // Check auth state
    await checkAuth();
  });
}

async function checkAuth() {
  try {
    const response = await fetch(`${appUrl}/api/auth/session`, {
      credentials: 'include',
      signal: AbortSignal.timeout(3000)
    });
    if (response.ok) {
      const session = await response.json();
      if (session && session.user) {
        showState('idle');
      } else {
        showState('signin');
      }
    } else {
      // Non-OK response - assume signed in to avoid blocking
      showState('idle');
    }
  } catch (e) {
    // Fetch failed (CORS, network, timeout) - assume signed in
    showState('idle');
  }
}

function showState(state) {
  welcomeState.style.display = 'none';
  signinState.style.display = 'none';
  idleState.style.display = 'none';
  recordingState.style.display = 'none';
  videoState.style.display = 'none';

  // Footer visible in idle, signin, welcome states
  const showFooter = ['idle', 'signin', 'welcome'].includes(state);
  popupFooter.style.display = showFooter ? 'flex' : 'none';

  switch (state) {
    case 'welcome':
      welcomeState.style.display = 'block';
      break;
    case 'signin':
      signinState.style.display = 'block';
      break;
    case 'idle':
      idleState.style.display = 'block';
      break;
    case 'recording':
      recordingState.style.display = 'block';
      break;
    case 'video':
      videoState.style.display = 'block';
      break;
  }
}

// Listen for step count updates while popup is open
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STEP_CAPTURED') {
    stepCountEl.textContent = message.stepCount;
  }
});

// ── Welcome ──

btnWelcomeDismiss.addEventListener('click', async () => {
  await chrome.storage.local.set({ welcomeDismissed: true });
  await checkAuth();
});

// ── Sign In / Sign Up ──

btnSignin.addEventListener('click', () => {
  chrome.tabs.create({ url: `${appUrl}/sign-in` });
  window.close();
});

btnSignup.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${appUrl}/sign-in` });
  window.close();
});

// ── Dashboard ──

btnDashboard.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${appUrl}/dashboard` });
  window.close();
});

// ── Helpers ──

function isCapturablePage(url) {
  return url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('about:');
}

// ── HTML Capture (Primary Action) ──

btnHtml.addEventListener('click', async () => {
  btnHtml.style.opacity = '0.6';
  btnHtml.style.pointerEvents = 'none';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!isCapturablePage(tab?.url)) {
    btnHtml.style.opacity = '1';
    btnHtml.style.pointerEvents = 'auto';
    showError("Can't capture on this page. Navigate to a regular web page first.");
    return;
  }

  try {
    // Inject both content.js and html-capture.js for HTML capture mode
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['html-capture.js']
    });

    chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id, captureMode: 'html' });
    showState('recording');
    stepCountEl.textContent = '0';
  } catch (err) {
    btnHtml.style.opacity = '1';
    btnHtml.style.pointerEvents = 'auto';
    showError("Can't capture on this page. Try a different tab.");
    console.error('Aceframe: Failed to start HTML capture', err);
  }
});

// ── Screenshot Recording ──

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!isCapturablePage(tab?.url)) {
    btnStart.disabled = false;
    showError("Can't record on this page. Navigate to a regular web page first.");
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id });
    showState('recording');
    stepCountEl.textContent = '0';
  } catch (err) {
    btnStart.disabled = false;
    showError("Can't record on this page. Try a different tab.");
    console.error('Aceframe: Failed to start recording', err);
  }
});

btnStop.addEventListener('click', () => {
  btnStop.disabled = true;
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  setTimeout(() => window.close(), 500);
});

btnPause.addEventListener('click', () => {
  if (isPaused) {
    chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' });
    setPausedUI(false);
  } else {
    chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' });
    setPausedUI(true);
  }
});

btnCancel.addEventListener('click', () => {
  const count = stepCountEl.textContent || '0';
  if (parseInt(count) > 0 && !confirm(`Cancel recording? This will discard ${count} captured step${count === '1' ? '' : 's'}.`)) {
    return;
  }
  chrome.runtime.sendMessage({ type: 'CANCEL_RECORDING' });
  showState('idle');
  isPaused = false;
});

// ── Video Recording ──

btnVideo.addEventListener('click', async () => {
  btnVideo.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!isCapturablePage(tab?.url)) {
    btnVideo.disabled = false;
    showError("Can't record on this page. Navigate to a regular web page first.");
    return;
  }

  try {
    chrome.runtime.sendMessage({ type: 'START_VIDEO_RECORDING', tabId: tab.id }, (response) => {
      if (response && response.ok) {
        chrome.storage.local.get('videoStartTime', (data) => {
          videoStartTime = data.videoStartTime || Date.now();
          showState('video');
          startVideoTimer();
        });
      } else {
        btnVideo.disabled = false;
        showError(response?.error || 'Failed to start video recording.');
      }
    });
  } catch (err) {
    btnVideo.disabled = false;
    showError("Can't record on this page. Try a different tab.");
    console.error('Aceframe: Failed to start video recording', err);
  }
});

btnVideoStop.addEventListener('click', () => {
  btnVideoStop.disabled = true;
  btnVideoStop.textContent = 'Uploading...';
  stopVideoTimer();

  chrome.runtime.sendMessage({ type: 'STOP_VIDEO_RECORDING' }, (response) => {
    if (response && response.ok) {
      setTimeout(() => window.close(), 500);
    } else {
      btnVideoStop.disabled = false;
      btnVideoStop.textContent = 'Stop & Edit';
      showError(response?.error || 'Failed to save video. Check your connection.');
      showState('idle');
    }
  });
});

btnVideoCancel.addEventListener('click', () => {
  if (videoStartTime && !confirm('Cancel video recording? The recording will be discarded.')) {
    return;
  }
  stopVideoTimer();
  chrome.runtime.sendMessage({ type: 'CANCEL_VIDEO_RECORDING' });
  showState('idle');
});

// ── UI Helpers ──

function setPausedUI(paused) {
  isPaused = paused;
  if (paused) {
    btnPause.textContent = 'Resume';
    btnPause.classList.add('resumed');
    recordingStatus.textContent = 'Paused';
    recordingStatus.classList.add('paused');
    recDot.classList.add('paused');
    progressFill.classList.remove('recording');
  } else {
    btnPause.textContent = 'Pause';
    btnPause.classList.remove('resumed');
    recordingStatus.textContent = 'Recording';
    recordingStatus.classList.remove('paused');
    recDot.classList.remove('paused');
    progressFill.classList.add('recording');
  }
}

function startVideoTimer() {
  stopVideoTimer();
  updateVideoTimer();
  videoTimerInterval = setInterval(updateVideoTimer, 1000);
}

function stopVideoTimer() {
  if (videoTimerInterval) {
    clearInterval(videoTimerInterval);
    videoTimerInterval = null;
  }
}

function updateVideoTimer() {
  if (!videoStartTime) return;
  const elapsed = Math.floor((Date.now() - videoStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  videoTimerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
}

function showError(msg) {
  const existing = document.querySelector('.error-msg');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.className = 'error-msg';
  el.textContent = msg;

  // Append to whichever state is currently visible
  const target = idleState.style.display !== 'none' ? idleState.querySelector('.state-enter') || idleState
    : videoState.style.display !== 'none' ? videoState.querySelector('.state-enter') || videoState
    : signinState.style.display !== 'none' ? signinState.querySelector('.signin-card') || signinState
    : recordingState.querySelector('.state-enter') || recordingState;
  target.appendChild(el);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    if (el.parentNode) el.remove();
  }, 5000);
}

// ── Start ──
init();
