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

    // If there's a pending video recording, pass it as a special video entry
    // The web app will auto-split this into multiple steps using click timestamps
    if (pendingVideo) {
      const videoEntry = {
        order: 0,
        screenshot: pendingVideo.posterDataUrl || '',
        click: { x: 0.5, y: 0.5 },
        viewportWidth: 1440,
        viewportHeight: 900,
        pageUrl: '',
        annotation: '',
        zoomLevel: 1.0,
        mediaType: 'video',
        videoBase64: pendingVideo.videoBase64,
        videoMimeType: pendingVideo.videoMimeType,
        videoDuration: pendingVideo.videoDuration,
        videoMeta: {
          cursorTrack: pendingVideo.cursorTrack || [],
        },
        // Click events for step splitting - web app uses these to auto-split
        videoClicks: pendingVideo.videoClicks || [],
      };
      // If there are click events, don't add to steps array directly -
      // mark this as a video-to-split entry. The web app handles the rest.
      if (steps.length === 0) {
        steps.push(videoEntry);
      }
    }

    if (steps.length === 0 && htmlSnapshots.length === 0) return;

    // Merge HTML snapshots onto corresponding steps (partial merge OK - some captures may have failed)
    if (htmlSnapshots.length > 0) {
      for (let i = 0; i < steps.length; i++) {
        const snapshot = htmlSnapshots[i];
        if (!snapshot) continue;
        steps[i].mediaType = 'html';
        if (snapshot.type === 'pan') {
          // Pan step - reference a previous snapshot instead of full DOM
          steps[i].htmlSnapshotRefIndex = snapshot.refIndex;
          steps[i].scrollX = snapshot.scrollX || steps[i].scrollX || 0;
          steps[i].scrollY = snapshot.scrollY || steps[i].scrollY || 0;
        } else {
          // Full snapshot - attach the DOM data
          steps[i].htmlSnapshot = snapshot;
          // Use scroll from the snapshot viewport if available
          if (snapshot.viewport) {
            steps[i].scrollX = steps[i].scrollX || snapshot.viewport.scrollX || 0;
            steps[i].scrollY = steps[i].scrollY || snapshot.viewport.scrollY || 0;
          }
        }
      }
    }

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
