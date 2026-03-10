// Bridge content script - injected into the Aceframe web app page.
// Reads captured steps individually from chrome.storage.local (each step
// is stored as a separate key to avoid size limits) and writes them into
// the DOM so the React app can read them.
// Also handles HTML snapshots when captureMode is 'html'.

(async function () {
  if (!window.location.pathname.includes("/new")) return;
  if (!new URLSearchParams(window.location.search).has("source")) return;

  try {
    // Check if there are pending steps, video, or HTML snapshots
    const meta = await chrome.storage.local.get([
      "pendingStepCount",
      "pendingVideoStep",
      "pendingHtmlStepCount"
    ]);
    const count = meta.pendingStepCount || 0;
    const pendingVideo = meta.pendingVideoStep;
    const htmlCount = meta.pendingHtmlStepCount || 0;

    if (!count && !pendingVideo && !htmlCount) return;

    // Read screenshot steps
    const steps = [];
    if (count > 0) {
      const keys = [];
      for (let i = 0; i < count; i++) {
        keys.push(`step_${i}`);
      }
      const result = await chrome.storage.local.get(keys);
      for (let i = 0; i < count; i++) {
        const step = result[`step_${i}`];
        if (step) {
          steps.push({ ...step, order: i });
        }
      }
    }

    // Read HTML snapshot steps
    const htmlSnapshots = [];
    if (htmlCount > 0) {
      const htmlKeys = [];
      for (let i = 0; i < htmlCount; i++) {
        htmlKeys.push(`htmlStep_${i}`);
      }
      const htmlResult = await chrome.storage.local.get(htmlKeys);
      for (let i = 0; i < htmlCount; i++) {
        const snapshot = htmlResult[`htmlStep_${i}`];
        if (snapshot) {
          htmlSnapshots.push({ ...snapshot, order: i });
        }
      }
    }

    // If there's a standalone video step (no screenshot steps), add it
    if (pendingVideo && steps.length === 0) {
      steps.push({
        order: 0,
        screenshot: pendingVideo.posterDataUrl || '',
        click: { x: 0.5, y: 0.5 },
        viewportWidth: 1440,
        viewportHeight: 900,
        pageUrl: '',
        annotation: '',
        zoomLevel: 1.0,
        mediaType: 'video',
        videoBase64: pendingVideo.videoBase64, // data URL - web app will upload
        videoMimeType: pendingVideo.videoMimeType,
        videoDuration: pendingVideo.videoDuration,
      });
    }

    if (steps.length === 0 && htmlSnapshots.length === 0) return;

    // Use the first step's page title as the suggested demo title
    const pageTitle = steps[0]?.pageTitle || '';

    // Determine capture mode from URL params
    const captureMode = new URLSearchParams(window.location.search).get('captureMode') || 'screenshot';

    const data = {
      steps,
      pageTitle,
      capturedAt: new Date().toISOString(),
      captureMode,
    };

    // Attach HTML snapshots if present
    if (htmlSnapshots.length > 0) {
      data.htmlSnapshots = htmlSnapshots;
    }

    // Write into the DOM for the React app to read
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = "aceframe-pending-demo";
    el.textContent = JSON.stringify(data);
    document.head.appendChild(el);

    // Notify the page
    document.dispatchEvent(new CustomEvent("aceframe-data-ready"));

    // Clean up storage
    const removeKeys = [
      "pendingStepCount",
      "pendingVideoStep",
      "pendingHtmlStepCount",
      "captureMode"
    ];
    for (let i = 0; i < count; i++) {
      removeKeys.push(`step_${i}`);
    }
    for (let i = 0; i < htmlCount; i++) {
      removeKeys.push(`htmlStep_${i}`);
    }
    await chrome.storage.local.remove(removeKeys);
  } catch (err) {
    console.error("Aceframe bridge: Failed to transfer data", err);
  }
})();
