// Aceframe offscreen document - handles MediaRecorder for video capture
// Service workers can't use MediaRecorder, so we use an offscreen document.

let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = 0;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'OFFSCREEN_START_RECORDING':
      startRecording(message.streamId).then(() => {
        sendResponse({ ok: true });
      }).catch((err) => {
        console.error('Aceframe offscreen: Failed to start recording', err);
        sendResponse({ ok: false, error: err.message });
      });
      return true;

    case 'OFFSCREEN_STOP_RECORDING':
      stopRecording().then((result) => {
        sendResponse(result);
      }).catch((err) => {
        console.error('Aceframe offscreen: Failed to stop recording', err);
        sendResponse({ ok: false, error: err.message });
      });
      return true;

    case 'OFFSCREEN_CANCEL_RECORDING':
      cancelRecording();
      sendResponse({ ok: true });
      return true;
  }
});

async function startRecording(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  recordedChunks = [];
  recordingStartTime = Date.now();

  // Prefer VP9 for better quality/size, fall back to VP8
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm;codecs=vp8';

  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 1_000_000, // 1 Mbps - good quality at small file size
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.start(1000); // collect data every second
  console.log('Aceframe offscreen: Recording started (' + mimeType + ')');
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    return { ok: false, error: 'Not recording' };
  }

  return new Promise((resolve) => {
    mediaRecorder.onstop = async () => {
      const duration = (Date.now() - recordingStartTime) / 1000;
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      recordedChunks = [];

      // Stop all tracks
      mediaRecorder.stream.getTracks().forEach((t) => t.stop());

      // Convert blob to base64 for passing via message
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result;
        console.log(`Aceframe offscreen: Recording stopped (${duration.toFixed(1)}s, ${(blob.size / 1024 / 1024).toFixed(1)}MB)`);
        resolve({
          ok: true,
          videoDataUrl: base64,
          duration,
          mimeType: blob.type,
          sizeBytes: blob.size,
        });
      };
      reader.readAsDataURL(blob);
    };

    mediaRecorder.stop();
  });
}

function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    mediaRecorder.stop();
  }
  recordedChunks = [];
  mediaRecorder = null;
  console.log('Aceframe offscreen: Recording cancelled');
}
