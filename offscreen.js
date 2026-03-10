// Offscreen document for video recording.
// Service workers can't use MediaRecorder, so we do it here.
// Flow: background sends stream ID -> we record -> on stop, convert to base64 -> send back.
// The actual upload to Aceframe API happens from the web app (which has auth cookies).

let mediaRecorder = null;
let recordedChunks = [];
let mediaStream = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'OFFSCREEN_START_RECORDING':
      startRecording(message.streamId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'OFFSCREEN_STOP_RECORDING':
      stopRecording()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
  }
});

async function startRecording(streamId) {
  // Get the media stream from the tab capture stream ID
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  recordedChunks = [];

  // Prefer WebM VP9 (widely supported, good compression)
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';

  mediaRecorder = new MediaRecorder(mediaStream, {
    mimeType,
    videoBitsPerSecond: 2_500_000, // 2.5 Mbps
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.start(1000);
  console.log('Aceframe offscreen: Recording started');
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    return { ok: false, error: 'Not recording' };
  }

  // Stop recording and wait for final data
  const blob = await new Promise((resolve) => {
    mediaRecorder.onstop = () => {
      const fullBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      resolve(fullBlob);
    };
    mediaRecorder.stop();
  });

  // Stop all media tracks
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  mediaRecorder = null;

  const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
  console.log(`Aceframe offscreen: Recording stopped. Size: ${sizeMB}MB`);

  // Extract poster frame
  const posterDataUrl = await extractPosterFrame(blob);

  // Get duration
  const duration = await getVideoDuration(blob);

  // Convert video blob to base64 for storage transfer
  // (We can't upload from here - no auth cookies. The web app will upload.)
  const base64 = await blobToBase64(blob);

  return {
    ok: true,
    videoBase64: base64,
    videoMimeType: blob.type,
    posterDataUrl,
    duration,
    sizeMB: parseFloat(sizeMB),
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function extractPosterFrame(blob) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(blob);
    video.src = url;
    video.onloadeddata = () => {
      video.currentTime = 0.1;
    };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } else {
        resolve('');
      }
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve('');
    };
  });
}

function getVideoDuration(blob) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    const url = URL.createObjectURL(blob);
    video.src = url;
    video.onloadedmetadata = () => {
      resolve(Math.round(video.duration * 10) / 10);
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
  });
}
