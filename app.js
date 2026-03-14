const STATE = {
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  PLAYBACK: 'PLAYBACK'
};

// Netlify: injected at build from env GOOGLE_CLIENT_ID. Local: set in config.local.js (copy from config.local.example.js).
const GOOGLE_CLIENT_ID = (typeof window !== 'undefined' && window.__GOOGLE_CLIENT_ID__) ? window.__GOOGLE_CLIENT_ID__ : '__GOOGLE_CLIENT_ID__';

// YouTube upload: only on local (localhost / 127.0.0.1). Hidden in production until verification is done.
const YOUTUBE_UPLOAD_ENABLED = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

let currentState = STATE.IDLE;
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = 0;
let recordingTimer = null;
let objectUrl = null;
let recordedFormat = 'webm'; // actual format from MediaRecorder (may differ from formatSelect)
let ffmpeg = null;

// DOM Elements
const liveVideo = document.getElementById('live-video');
const playbackVideo = document.getElementById('playback-video');
const cameraSelect = document.getElementById('camera-select');
const micSelect = document.getElementById('mic-select');
const recordBtn = document.getElementById('record-btn');
const recordCountdownEl = document.getElementById('record-countdown');
let countdownTimeoutIds = [];
const playBtn = document.getElementById('play-btn');
const discardBtn = document.getElementById('discard-btn');
const downloadBtn = document.getElementById('download-btn');
const youtubeBtn = document.getElementById('youtube-btn');
const formatSelect = document.getElementById('format-select');
const resolutionSelect = document.getElementById('resolution-select');
const videoContainer = document.getElementById('video-container');
const previewOffHoverBtn = document.getElementById('preview-off-hover-btn');
const previewPlaceholder = document.getElementById('preview-off-placeholder');
const previewOnBtn = document.getElementById('preview-on-btn');
const settingsModal = document.getElementById('settings-modal');
const modalOverlay = document.getElementById('modal-overlay');
const settingsBtn = document.getElementById('settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const deviceSelectors = document.getElementById('device-selectors');
const recordingIndicator = document.getElementById('recording-indicator');
const recordingTimeEl = document.getElementById('recording-time');
const stateOverlay = document.getElementById('state-overlay');
const stateText = stateOverlay.querySelector('.state-text');

// Editing Tools elements
const editingTools = document.getElementById('editing-tools');
const editBtn = document.getElementById('edit-btn');
const editingPanel = document.getElementById('editing-panel');
const trimStart = document.getElementById('trim-start');
const trimEnd = document.getElementById('trim-end');
const processBtn = document.getElementById('process-btn');
const youtubeModal = document.getElementById('youtube-modal');
const closeYoutubeBtn = document.getElementById('close-youtube-btn');
const youtubeTitleInput = document.getElementById('youtube-title');
const youtubePrivacySelect = document.getElementById('youtube-privacy');
const youtubeStatusEl = document.getElementById('youtube-status');
const youtubeUploadBtn = document.getElementById('youtube-upload-btn');

// Initialize
async function init() {
  try {
    // Load FFmpeg (UMD exposes as FFmpegWASM, unpkg sets it)
    try {
      const mod = window.FFmpegWASM || window.FFmpeg;
      const FFmpegClass = mod?.FFmpeg ?? mod;
      if (FFmpegClass && typeof FFmpegClass === 'function') {
        ffmpeg = new FFmpegClass();
        ffmpeg.on('log', ({ message }) => console.log(message));
        
        // Don't pass classWorkerURL — the UMD build resolves it against a hardcoded
        // file:/// base, producing file:///vendor/814.ffmpeg.js which fails.
        // Instead, serve ffmpeg.js from /vendor/ so e.p = /vendor/ and the worker
        // auto-resolves to /vendor/814.ffmpeg.js (same-origin classic worker).
        // Classic workers support importScripts, so coreURL can be a plain URL.
        const base = location.origin + '/vendor/';
        const coreURL = base + 'umd/ffmpeg-core.js';
        const wasmURL = base + 'ffmpeg-core.wasm';
        
        console.log("Loading FFmpeg core...");
        await ffmpeg.load({ coreURL, wasmURL });
        console.log("FFmpeg loaded successfully");
      } else {
        console.error("FFmpeg not found. Expected window.FFmpegWASM or window.FFmpeg");
      }
    } catch(err) {
      console.error('FFmpeg failed to load:', err);
    }

    // Try initial permissions, but don't block layout creation if denied
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch(err) {
      console.warn('Initial camera access suspended or denied, continuing to load UI', err);
    }
    
    await populateDeviceSelectors();
    
    // Read saved settings
    const savedCamera = localStorage.getItem('pm-camera-id');
    const savedMic = localStorage.getItem('pm-mic-id');
    const savedFormat = localStorage.getItem('pm-format');
    const savedResolution = localStorage.getItem('pm-resolution');

    // Apply saved dropdown options
    if (savedFormat) formatSelect.value = savedFormat;
    if (savedResolution) resolutionSelect.value = savedResolution;

    // Touch up appearance is always on
    liveVideo.classList.add('beauty-filter');

    // Apply saved devices if they exist in the current device list
    if (savedCamera && Array.from(cameraSelect.options).some(opt => opt.value === savedCamera)) {
      cameraSelect.value = savedCamera;
    }
    if (savedMic && Array.from(micSelect.options).some(opt => opt.value === savedMic)) {
      micSelect.value = savedMic;
    }
    
    // Only try to start camera if we have a stream or devices
    if (mediaStream) {
      await startCamera();
    } else {
      setState(STATE.IDLE);
      updatePreviewUI();
    }
    
    // Listen for device changes (e.g., plugging in a new mic)
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      await populateDeviceSelectors();
    });

    setupEventListeners();
  } catch (err) {
    console.error('Error initializing media devices:', err);
    showOverlay('Camera/Mic access denied. Please allow permissions.', true);
  }
}

async function populateDeviceSelectors() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  
  const videoInput = devices.filter(d => d.kind === 'videoinput');
  const audioInput = devices.filter(d => d.kind === 'audioinput');

  const createOptions = (devices, defaultText) => {
    if (devices.length === 0) return `<option value="">${defaultText}</option>`;
    return devices.map(d => `<option value="${d.deviceId}">${d.label || `Device ${d.deviceId.slice(0, 5)}`}</option>`).join('');
  };

  cameraSelect.innerHTML = createOptions(videoInput, 'No Camera Found');
  micSelect.innerHTML = createOptions(audioInput, 'No Mic Found');
}

function stopPreview() {
  if (currentState !== STATE.IDLE || !mediaStream) return;
  // Release video element first so the browser can release the device immediately
  liveVideo.srcObject = null;
  mediaStream.getTracks().forEach(track => track.stop());
  mediaStream = null;
  updatePreviewUI();
}

function updatePreviewUI() {
  const hasPreview = !!mediaStream;
  const isIdle = currentState === STATE.IDLE;
  if (videoContainer) {
    if (isIdle && hasPreview) {
      videoContainer.classList.add('preview-active');
    } else {
      videoContainer.classList.remove('preview-active');
    }
  }
  if (previewOffHoverBtn) {
    if (isIdle && hasPreview) {
      previewOffHoverBtn.classList.remove('hidden');
    } else {
      previewOffHoverBtn.classList.add('hidden');
    }
  }
  if (previewPlaceholder) {
    if (isIdle && !hasPreview) {
      previewPlaceholder.classList.remove('hidden');
    } else {
      previewPlaceholder.classList.add('hidden');
    }
  }
  if (recordBtn) {
    recordBtn.disabled = isIdle && !hasPreview;
  }
  if (isIdle && hasPreview) {
    liveVideo.classList.remove('hidden');
  } else if (isIdle && !hasPreview) {
    liveVideo.classList.add('hidden');
  }
}

async function startCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }

  const videoSource = cameraSelect.value;
  const audioSource = micSelect.value;
  
  // Determine resolution constraints
  const resVal = resolutionSelect.value || '1080';
  let widthConstraint = { ideal: 1920 };
  let heightConstraint = { ideal: 1080 };
  
  if (resVal === '720') {
    widthConstraint = { ideal: 1280 };
    heightConstraint = { ideal: 720 };
  } else if (resVal === '2160') {
    widthConstraint = { ideal: 3840 };
    heightConstraint = { ideal: 2160 };
  }

  const videoConstraints = {
    width: widthConstraint,
    height: heightConstraint,
    backgroundBlur: false // Explicitly request no background blur from the OS/Browser
  };

  if (videoSource) {
    videoConstraints.deviceId = { exact: videoSource };
  }

  const constraints = {
    video: videoConstraints,
    audio: audioSource 
      ? { deviceId: { exact: audioSource }, echoCancellation: false, autoGainControl: false, noiseSuppression: false } 
      : true
  };

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    liveVideo.srcObject = mediaStream;
    liveVideo.muted = true; // Avoid feedback loop
    setState(STATE.IDLE);
    updatePreviewUI();
  } catch (err) {
    console.error('Error starting camera with constraints:', constraints, err);
  }
}

function setupEventListeners() {
  cameraSelect.addEventListener('change', () => {
    localStorage.setItem('pm-camera-id', cameraSelect.value);
    startCamera();
  });
  
  micSelect.addEventListener('change', () => {
    localStorage.setItem('pm-mic-id', micSelect.value);
    startCamera();
  });

  resolutionSelect.addEventListener('change', () => {
    localStorage.setItem('pm-resolution', resolutionSelect.value);
    startCamera();
  });

  formatSelect.addEventListener('change', () => {
    localStorage.setItem('pm-format', formatSelect.value);
  });

  previewOffHoverBtn.addEventListener('click', stopPreview);
  previewOnBtn.addEventListener('click', () => startCamera());

  settingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
    modalOverlay.classList.add('hidden');
  });
  
  recordBtn.addEventListener('click', () => {
    if (currentState === STATE.IDLE) {
      runCountdownThenStartRecording();
    } else if (currentState === STATE.RECORDING) {
      stopRecording();
    }
  });

  discardBtn.addEventListener('click', () => {
    if (currentState === STATE.PLAYBACK) {
      cleanupPlayback();
      setState(STATE.IDLE);
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (currentState === STATE.PLAYBACK && objectUrl) {
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = objectUrl;
      const ext = recordedFormat === 'mp4' ? 'mp4' : 'webm';
      a.download = `practice-recording-${new Date().getTime()}.${ext}`;
      
      document.body.appendChild(a);
      a.click();
      
      setTimeout(() => {
        document.body.removeChild(a);
      }, 100);
    }
  });

  playBtn.addEventListener('click', () => {
    if (currentState === STATE.PLAYBACK) {
      if (playbackVideo.paused) {
        playbackVideo.play();
        playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
      } else {
        playbackVideo.pause();
        playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>';
      }
    }
  });

  playbackVideo.addEventListener('ended', () => {
    playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>';
  });

  processBtn.addEventListener('click', processVideo);

  editBtn.addEventListener('click', () => {
    const expanded = editBtn.getAttribute('aria-expanded') === 'true';
    editBtn.setAttribute('aria-expanded', !expanded);
    editingPanel.hidden = expanded;
    editingTools.classList.toggle('editing-tools--expanded', !expanded);
  });

  youtubeBtn.addEventListener('click', () => {
    if (currentState !== STATE.PLAYBACK || !objectUrl) return;
    youtubeTitleInput.value = 'Practice recording ' + new Date().toLocaleDateString();
    youtubeStatusEl.textContent = '';
    youtubeUploadBtn.textContent = 'Sign in & Upload';
    youtubeUploadBtn.disabled = false;
    youtubeModal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');
  });

  closeYoutubeBtn.addEventListener('click', () => {
    youtubeModal.classList.add('hidden');
    modalOverlay.classList.add('hidden');
  });

  modalOverlay.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
    youtubeModal.classList.add('hidden');
    modalOverlay.classList.add('hidden');
  });

  youtubeUploadBtn.addEventListener('click', startYoutubeUpload);
}

function runCountdownThenStartRecording() {
  if (!mediaStream || !recordCountdownEl) {
    startRecording();
    return;
  }
  recordBtn.disabled = true;
  recordCountdownEl.classList.add('visible');
  recordCountdownEl.textContent = '3';
  const inner = recordBtn.querySelector('.record-btn-inner');
  if (inner) inner.style.visibility = 'hidden';

  function show(n, then) {
    countdownTimeoutIds.push(setTimeout(() => {
      if (n > 0) {
        recordCountdownEl.textContent = String(n);
        show(n - 1, then);
      } else {
        recordCountdownEl.classList.remove('visible');
        recordCountdownEl.textContent = '';
        if (inner) inner.style.visibility = '';
        recordBtn.disabled = false;
        countdownTimeoutIds = [];
        then();
      }
    }, 1000));
  }
  show(2, startRecording);
}

function startRecording() {
  if (!mediaStream) return;
  recordedChunks = [];
  
  const selectedFormat = formatSelect.value || 'mp4';
  const options = { mimeType: getSupportedMimeType(selectedFormat) };
  try {
    mediaRecorder = new MediaRecorder(mediaStream, options);
  } catch (e) {
    console.error('MediaRecorder error with requested mimeType:', options.mimeType, e);
    // Fallback to default if explicitly requested type fails
    mediaRecorder = new MediaRecorder(mediaStream);
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    switchToPlayback();
  };

  mediaRecorder.start(200); // collect 200ms chunks
  setState(STATE.RECORDING);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function switchToPlayback() {
  const mimeType = mediaRecorder.mimeType || '';
  recordedFormat = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(recordedChunks, { type: mimeType });
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  
  playbackVideo.src = objectUrl;
  playbackVideo.load();
  
  // Set trim values to video duration once metadata loads
  playbackVideo.onloadedmetadata = () => {
    const dur = playbackVideo.duration;
    trimStart.value = '0';
    trimEnd.value = dur.toFixed(1);
    trimEnd.max = dur;
    playbackVideo.onloadedmetadata = null;
  };

  setState(STATE.PLAYBACK);
}

function cleanupPlayback() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  playbackVideo.src = '';
}

async function processVideo() {
  if (!ffmpeg || !ffmpeg.loaded) {
    alert("Video editor is still loading or failed. Please refresh and ensure you're online.");
    return;
  }
  
  processBtn.disabled = true;
  processBtn.textContent = 'Processing...';
  
  try {
    const videoDuration = playbackVideo.duration;
    if (!videoDuration || isNaN(videoDuration)) {
      alert("Please wait for the video to load before processing.");
      return;
    }
    const start = Math.max(0, parseFloat(trimStart.value) || 0);
    const end = Math.min(videoDuration, parseFloat(trimEnd.value) || videoDuration);
    const duration = end - start;
    const addFade = true; // always apply fade in/out
    
    if (duration <= 0) {
      alert("End time must be greater than start time.");
      return;
    }

    // Use actual recorded format for input (MediaRecorder may have used webm even if user chose mp4)
    const inputFormat = recordedFormat;
    const outputFormat = formatSelect.value || 'mp4';
    const inputName = `input.${inputFormat}`;
    const outputName = `output.${outputFormat}`;
    
    // Convert objectUrL string back to a valid URL we can fetch
    const response = await fetch(objectUrl);
    const videoData = await response.arrayBuffer();
    
    await ffmpeg.writeFile(inputName, new Uint8Array(videoData));
    
    let ffmpegArgs = [];
    if (start > 0) {
       ffmpegArgs.push('-ss', start.toString());
    }
    
    ffmpegArgs.push('-i', inputName);
    
    if (end > start) {
       ffmpegArgs.push('-t', duration.toString());
    }
    
    if (addFade && duration > 2) {
      // 1-second fade in and out 
      const fadeOutStart = duration - 1;
      ffmpegArgs.push('-vf', `fade=t=in:st=0:d=1,fade=t=out:st=${fadeOutStart}:d=1`);
      ffmpegArgs.push('-af', `afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart}:d=1`);
    }
    
    // Maintain decent defaults for re-encoding
    if (outputFormat === 'mp4') {
      ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28');
    }
    
    ffmpegArgs.push(outputName);
    
    const exitCode = await ffmpeg.exec(ffmpegArgs);
    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}`);
    }
    
    const outputData = await ffmpeg.readFile(outputName);
    const processedBlob = new Blob([outputData], { type: `video/${outputFormat === 'mp4' ? 'mp4' : 'webm'}` });
    
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(processedBlob);
    recordedFormat = outputFormat; // processed video is now the source for further edits
    playbackVideo.src = objectUrl;
    playbackVideo.load();
    playbackVideo.play();
    
    // reset trim values to new duration
    playbackVideo.onloadedmetadata = () => {
      const dur = playbackVideo.duration;
      trimStart.value = '0';
      trimEnd.value = dur.toFixed(1);
      trimEnd.max = dur;
      playbackVideo.onloadedmetadata = null;
    };
    
  } catch (err) {
    console.error("FFmpeg processing failed:", err);
    alert("Processing failed. " + (err.message || "Check console for details."));
  } finally {
    processBtn.disabled = false;
    processBtn.textContent = 'Process Video';
  }
}

// Timer Logic
function updateTimer() {
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  recordingTimeEl.textContent = `${m}:${s}`;
}

// State Management & UI Updates
function setState(newState) {
  currentState = newState;
  
  // Reset all visibility
  recordBtn.classList.add('hidden');
  playBtn.classList.add('hidden');
  discardBtn.classList.add('hidden');
  downloadBtn.classList.add('hidden');
  youtubeBtn.classList.add('hidden');
  editBtn.classList.add('hidden');
  editingTools.classList.add('hidden');
  liveVideo.classList.add('hidden');
  playbackVideo.classList.add('hidden');
  recordingIndicator.classList.add('hidden');
  stateOverlay.classList.add('hidden');
  
  if (newState === STATE.IDLE) {
    recordBtn.classList.remove('hidden');
    recordBtn.classList.remove('recording');
    clearInterval(recordingTimer);
    recordingTimeEl.textContent = '00:00';
    showOverlay('Ready to Practice');
    updatePreviewUI();
    
  } else if (newState === STATE.RECORDING) {
    liveVideo.classList.remove('hidden');
    recordBtn.classList.remove('hidden');
    recordBtn.classList.add('recording');
    recordingIndicator.classList.remove('hidden');
    
    recordingStartTime = Date.now();
    updateTimer();
    recordingTimer = setInterval(updateTimer, 1000);
    
  } else if (newState === STATE.PLAYBACK) {
    playbackVideo.classList.remove('hidden');
    playBtn.classList.remove('hidden');
    discardBtn.classList.remove('hidden');
    downloadBtn.classList.remove('hidden');
    if (YOUTUBE_UPLOAD_ENABLED) youtubeBtn.classList.remove('hidden');
    editBtn.classList.remove('hidden');
    editingTools.classList.remove('hidden');
    editBtn.setAttribute('aria-expanded', 'false');
    editingPanel.hidden = true;
    editingTools.classList.remove('editing-tools--expanded');
    playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>';
    clearInterval(recordingTimer);
  }
}

function showOverlay(text, persistent = false) {
  stateText.textContent = text;
  stateOverlay.classList.remove('hidden');
  if (videoContainer) videoContainer.classList.remove('ready-dismissed');
  if (!persistent) {
    setTimeout(() => {
      stateOverlay.classList.add('hidden');
      if (videoContainer) videoContainer.classList.add('ready-dismissed');
    }, 2000);
  }
}

// --- YouTube upload ---
function startYoutubeUpload() {
  if (!objectUrl) {
    youtubeStatusEl.textContent = 'No video to upload.';
    return;
  }
  if (!GOOGLE_CLIENT_ID) {
    youtubeStatusEl.textContent = 'YouTube upload is not configured. Add your Google Client ID in app.js.';
    return;
  }
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
    youtubeStatusEl.textContent = 'Google sign-in is loading. Try again in a moment.';
    return;
  }
  const title = (youtubeTitleInput.value || 'Practice recording').trim();
  const privacy = youtubePrivacySelect.value;
  youtubeUploadBtn.disabled = true;
  youtubeStatusEl.textContent = 'Opening sign-in…';

  // Request token immediately (no await) so the popup opens in response to the click and isn't blocked
  const client = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/youtube.upload',
    callback: async (tokenResponse) => {
      try {
        youtubeStatusEl.textContent = 'Preparing video…';
        const res = await fetch(objectUrl);
        const blob = await res.blob();
        const mimeType = recordedFormat === 'mp4' ? 'video/mp4' : 'video/webm';
        youtubeStatusEl.textContent = 'Uploading…';
        await uploadVideoToYouTube(tokenResponse.access_token, blob, mimeType, title, privacy);
        youtubeStatusEl.textContent = 'Upload complete. Check your YouTube studio.';
        youtubeUploadBtn.textContent = 'Upload another';
      } catch (err) {
        console.error('YouTube upload failed:', err);
        youtubeStatusEl.textContent = 'Upload failed: ' + (err.message || 'Unknown error');
      } finally {
        youtubeUploadBtn.disabled = false;
      }
    }
  });
  client.requestAccessToken();
}

async function uploadVideoToYouTube(accessToken, blob, mimeType, title, privacyStatus) {
  // Use same-origin proxy to avoid CORS (YouTube API blocks direct browser uploads).
  const proxyUrl = '/api/youtube-upload';
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': mimeType,
      'X-Title': title,
      'X-Privacy': privacyStatus
    },
    body: blob
  });
  if (!res.ok) {
    const errBody = await res.text();
    let msg = errBody || 'Upload failed';
    try {
      const j = JSON.parse(errBody);
      if (j.error != null) {
        msg = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
      }
    } catch (_) {}
    throw new Error(msg);
  }
}

function getSupportedMimeType(preferredFormat = 'mp4') {
  let types = [];
  if (preferredFormat === 'mp4') {
    types = [
      'video/mp4;codecs=avc1',
      'video/mp4'
    ];
  } else {
    // webm preferred
    types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
  }
  
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

// Kick off
document.addEventListener('DOMContentLoaded', init);
