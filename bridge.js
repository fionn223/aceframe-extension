// Bridge content script — injected into the Aceframe web app page.
// Reads captured steps individually from chrome.storage.local (each step
// is stored as a separate key to avoid size limits) and writes them into
// the DOM so the React app can read them.

(async function () {
  if (!window.location.pathname.includes("/new")) return;
  if (!new URLSearchParams(window.location.search).has("source")) return;

  try {
    // Check if there are pending steps
    const meta = await chrome.storage.local.get("pendingStepCount");
    const count = meta.pendingStepCount;
    if (!count) return;

    // Read each step individually
    const keys = [];
    for (let i = 0; i < count; i++) {
      keys.push(`step_${i}`);
    }
    const result = await chrome.storage.local.get(keys);

    const steps = [];
    for (let i = 0; i < count; i++) {
      const step = result[`step_${i}`];
      if (step) {
        steps.push({ ...step, order: i });
      }
    }

    if (steps.length === 0) return;

    // Use the first step's page title as the suggested demo title
    const pageTitle = steps[0]?.pageTitle || '';

    const data = {
      steps,
      pageTitle,
      capturedAt: new Date().toISOString()
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
    const removeKeys = ["pendingStepCount"];
    for (let i = 0; i < count; i++) {
      removeKeys.push(`step_${i}`);
    }
    await chrome.storage.local.remove(removeKeys);
  } catch (err) {
    console.error("Aceframe bridge: Failed to transfer data", err);
  }
})();
