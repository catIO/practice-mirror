const STATE = {
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  PLAYBACK: 'PLAYBACK'
};

// Netlify: injected at build from env GOOGLE_CLIENT_ID. Local: set in config.local.js (copy from config.local.example.js).
const GOOGLE_CLIENT_ID = (typeof window !== 'undefined' && window.__GOOGLE_CLIENT_ID__) ? window.__GOOGLE_CLIENT_ID__ : '__GOOGLE_CLIENT_ID__';

// YouTube upload: gated behind login in all environments.
const YOUTUBE_UPLOAD_ENABLED = true;

let currentState = STATE.IDLE;
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = 0;
let recordingTimer = null;
let objectUrl = null;
let recordedFormat = 'webm'; // actual format from MediaRecorder (may differ from formatSelect)
let ffmpeg = null;
let userProfile = null; // Stores { name, email, picture }
let accessToken = null; // Stores the active token for YouTube uploads

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
const authUnlogged = document.getElementById('auth-unlogged');
const authLogged = document.getElementById('auth-logged');
const userPhoto = document.getElementById('user-photo');
const userName = document.getElementById('user-name');
const userEmail = document.getElementById('user-email');
const signoutBtn = document.getElementById('signout-btn');
const customSigninBtn = document.getElementById('google-signin-custom');

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
    
    // Auth & Session
    initGoogleLogin();
    checkAndRestoreAuth();
    
    // Check for existing session recording
    await checkAndRestoreSession();
  } catch (sessErr) {
    console.warn('Session restoration skipped or failed:', sessErr);
    console.error('Error initializing media devices:', sessErr);
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
  signoutBtn.addEventListener('click', handleSignOut);
  if (customSigninBtn) customSigninBtn.addEventListener('click', requestLogin);
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

  mediaRecorder.onstop = async () => {
    await switchToPlayback();
  };

  mediaRecorder.start(200); // collect 200ms chunks
  setState(STATE.RECORDING);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

async function switchToPlayback() {
  const mimeType = mediaRecorder.mimeType || '';
  recordedFormat = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(recordedChunks, { type: mimeType });
  
  // Safeguard: Save to IndexedDB and mark session
  await saveVideoToSession(blob, recordedFormat);
  
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

async function cleanupPlayback() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  playbackVideo.src = '';
  // Clear persistent storage
  await clearVideoFromSession();
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
    
    // Safeguard: Update session storage with processed video
    await saveVideoToSession(processedBlob, outputFormat);
    
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
    
    // YouTube GATING: Only show if enabled AND user is logged in
    if (YOUTUBE_UPLOAD_ENABLED && userProfile) {
      youtubeBtn.classList.remove('hidden');
    }
    
    editBtn.classList.remove('hidden');
    editingTools.classList.remove('hidden');
    editBtn.setAttribute('aria-expanded', 'false');
    editingPanel.hidden = true;
    editingTools.classList.remove('editing-tools--expanded');
    playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>';
    clearInterval(recordingTimer);
  }
  
  // Ensure preview UI (like 'Pause Preview' button) updates for all states
  updatePreviewUI();
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
async function startYoutubeUpload() {
  if (!objectUrl) {
    console.warn('YouTube upload: no video to upload.');
    return;
  }
  
  if (!accessToken) {
    console.warn('YouTube upload: no access token — user not signed in.');
    return;
  }

  const title = (youtubeTitleInput.value || 'Practice recording').trim();
  const privacy = youtubePrivacySelect.value;

  youtubeUploadBtn.disabled = true;
  youtubeStatusEl.className = 'youtube-status';
  youtubeStatusEl.textContent = 'Preparing your video...';

  try {
    const res = await fetch(objectUrl);
    const blob = await res.blob();
    const mimeType = recordedFormat === 'mp4' ? 'video/mp4' : 'video/webm';
    await uploadVideoToYouTube(accessToken, blob, mimeType, title, privacy);
    youtubeStatusEl.className = 'youtube-status youtube-status--success';
    youtubeStatusEl.textContent = 'Video posted! Open YouTube Studio to see it.';
    youtubeUploadBtn.textContent = 'Upload another';
  } catch (err) {
    console.error('YouTube upload failed:', err);
    // Detect expired / invalid token (401)
    if (err.message && err.message.includes('401')) {
      accessToken = null;
      userProfile = null;
      sessionStorage.removeItem('pm-access-token');
      sessionStorage.removeItem('pm-user-profile');
      updateAuthUI();
      youtubeStatusEl.className = 'youtube-status youtube-status--error';
      youtubeStatusEl.textContent = 'Your session expired. Please sign in again from Settings.';
    } else {
      youtubeStatusEl.className = 'youtube-status youtube-status--error';
      youtubeStatusEl.textContent = 'Upload failed. Check the browser console for details.';
    }
  } finally {
    youtubeUploadBtn.disabled = false;
  }
}

async function uploadVideoToYouTube(accessToken, blob, mimeType, title, privacyStatus) {
  console.log('--- Starting YouTube Chunked Upload ---');
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const proxyUrl = isLocal ? '/api/youtube-upload' : '/.netlify/functions/youtube-upload';
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB per chunk

  // --- Step 1: Initialize upload session ---
  let uploadUrl;
  try {
    console.log('Step 1: Initializing upload session via', proxyUrl);
    const initRes = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': mimeType,
        'X-Title': title,
        'X-Privacy': privacyStatus,
        'X-Total-Size': String(blob.size)
      }
      // No body on init — just request the session URL
    });

    const initText = await initRes.text();
    if (!initRes.ok) throw new Error(`Step 1 failed (${initRes.status}): ${initText}`);

    const data = JSON.parse(initText);
    uploadUrl = data.uploadUrl;
    if (!uploadUrl) {
      // Local server handled the full upload
      console.log('Upload completed by local server.');
      return data;
    }
    console.log('Step 1 success: Got upload URL.');
  } catch (err) {
    throw new Error(`Init failed: ${err.message}`);
  }

  // --- Step 2: Send chunks through the proxy ---
  const totalSize = blob.size;
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
  console.log(`Step 2: Uploading ${totalChunks} chunk(s) via proxy...`);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunk = blob.slice(start, end);
    const chunkNum = i + 1;

    console.log(`  Chunk ${chunkNum}/${totalChunks}: bytes ${start}–${end - 1}`);
    youtubeStatusEl.textContent = `Uploading... (${chunkNum} of ${totalChunks})`;

    let chunkRes;
    try {
      const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': mimeType,
          'X-Upload-Url': uploadUrl,
          'X-Chunk-Offset': String(start),
          'X-Total-Size': String(totalSize)
        },
        body: chunk
      });

      const resText = await res.text();
      if (!res.ok) throw new Error(`Chunk ${chunkNum} failed (${res.status}): ${resText}`);

      chunkRes = JSON.parse(resText);
      console.log(`  Chunk ${chunkNum} result:`, chunkRes.status, chunkRes.range || '');
    } catch (err) {
      throw new Error(`Upload failed at chunk ${chunkNum}: ${err.message}`);
    }

    // 200/201 means all done
    if (chunkRes.status === 200 || chunkRes.status === 201) {
      console.log('Upload complete!');
      return chunkRes.body ? JSON.parse(chunkRes.body) : {};
    }
  }

  return {};
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

// --- IndexedDB & Session Persistence (Safeguard) ---
const DB_NAME = 'PracticeMirrorDB';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveVideoToSession(blob, format) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ blob, format, timestamp: Date.now() }, 'current-video');
    // Set sessionStorage flag so we know this tab has a valid recording
    sessionStorage.setItem('pm-has-recording', 'true');
    // In native IDB, we don't await tx.complete like this. 
    // The put operation is queued.
  } catch (err) {
    console.warn('Failed to save video to IndexedDB:', err);
  }
}

async function clearVideoFromSession() {
  try {
    sessionStorage.removeItem('pm-has-recording');
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('current-video');
  } catch (err) {
    console.warn('Failed to clear video from IndexedDB:', err);
  }
}

async function checkAndRestoreSession() {
  // If the session flag is gone (tab closed and reopened), wipe IndexedDB immediately for privacy
  if (!sessionStorage.getItem('pm-has-recording')) {
    await clearVideoFromSession();
    return;
  }

  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const data = await new Promise((resolve, reject) => {
      const req = tx.objectStore(STORE_NAME).get('current-video');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (data && data.blob) {
      recordedFormat = data.format;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(data.blob);
      
      playbackVideo.src = objectUrl;
      playbackVideo.load();
      playbackVideo.onloadedmetadata = () => {
        const dur = playbackVideo.duration;
        trimStart.value = '0';
        trimEnd.value = dur.toFixed(1);
        trimEnd.max = dur;
        playbackVideo.onloadedmetadata = null;
      };
      
      setState(STATE.PLAYBACK);
    }
  } catch (err) {
    console.warn('Failed to restore session from IndexedDB:', err);
  }
}

// --- Authentication (Sign-in Gate) ---

let tokenClient = null;

function initGoogleLogin() {
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
    console.warn('Google Identity Services not loaded yet.');
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'openid profile email https://www.googleapis.com/auth/youtube.upload',
    callback: handleTokenResponse,
    error_callback: (err) => {
      console.error('Auth error:', err);
      showOverlay('Authentication failed. Check console.');
    }
  });
}

function requestLogin() {
  if (tokenClient) {
    tokenClient.requestAccessToken();
  } else {
    initGoogleLogin();
    if (tokenClient) tokenClient.requestAccessToken();
  }
}

async function handleTokenResponse(response) {
  if (response.error !== undefined) {
    console.error('Token error:', response.error);
    return;
  }
  
  accessToken = response.access_token;
  
  try {
    // Fetch user info from Google's UserInfo API
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!res.ok) throw new Error('Failed to fetch user info');
    
    const payload = await res.json();
    userProfile = {
      name: payload.name,
      email: payload.email,
      picture: payload.picture
    };
    
    // Persist for session
    sessionStorage.setItem('pm-user-profile', JSON.stringify(userProfile));
    sessionStorage.setItem('pm-access-token', accessToken);
    
    updateAuthUI();
    
    // If we're currently in playback, refresh UI to show YouTube button
    if (currentState === STATE.PLAYBACK) {
      setState(STATE.PLAYBACK);
    }
  } catch (err) {
    console.error('Error handling login:', err);
  }
}

function checkAndRestoreAuth() {
  const savedProfile = sessionStorage.getItem('pm-user-profile');
  const savedToken = sessionStorage.getItem('pm-access-token');
  
  if (savedProfile && savedToken) {
    try {
      userProfile = JSON.parse(savedProfile);
      accessToken = savedToken;
      updateAuthUI();
    } catch (e) {
      sessionStorage.removeItem('pm-user-profile');
      sessionStorage.removeItem('pm-access-token');
    }
  }
}

function updateAuthUI() {
  if (userProfile) {
    authUnlogged.classList.add('hidden');
    authLogged.classList.remove('hidden');
    userName.textContent = userProfile.name;
    userEmail.textContent = userProfile.email;
    userPhoto.src = userProfile.picture;
    // Update the upload button to reflect signed-in state
    if (youtubeUploadBtn) {
      youtubeUploadBtn.textContent = 'Upload to YouTube';
    }
  } else {
    authUnlogged.classList.remove('hidden');
    authLogged.classList.add('hidden');
    if (youtubeUploadBtn) {
      youtubeUploadBtn.textContent = 'Sign in & Upload';
    }
  }
}

function handleSignOut() {
  userProfile = null;
  accessToken = null;
  sessionStorage.removeItem('pm-user-profile');
  sessionStorage.removeItem('pm-access-token');
  updateAuthUI();
  
  // Hide YouTube button if currently visible
  if (currentState === STATE.PLAYBACK) {
    setState(STATE.PLAYBACK);
  }
}

// Kick off
document.addEventListener('DOMContentLoaded', init);
