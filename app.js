const STATE = {
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  PLAYBACK: 'PLAYBACK'
};

// --- Build-time Injected Constants ---
// Netlify: injected at build from env GOOGLE_CLIENT_ID. Local: set in config.local.js.
const GOOGLE_CLIENT_ID = '';
const APP_VERSION = 'v20260425190919';

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
const rewindStartBtn = document.getElementById('rewind-start-btn');
const skipLeftIndicator = document.getElementById('skip-indicator-left');
const skipRightIndicator = document.getElementById('skip-indicator-right');
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
const trimTimeline = document.getElementById('trim-timeline');
const trimHandleStart = document.getElementById('trim-handle-start');
const trimHandleEnd = document.getElementById('trim-handle-end');
const trimActiveRange = document.getElementById('trim-active-range');
const trimFilmstrip = document.getElementById('trim-filmstrip');
const processBtn = document.getElementById('process-btn');
let snackbarContainer;
const youtubeModal = document.getElementById('youtube-modal');
const youtubeFormView = document.getElementById('youtube-form-view');
const youtubeSuccessView = document.getElementById('youtube-success-view');
const youtubeDoneBtn = document.getElementById('youtube-done-btn');
const closeYoutubeBtn = document.getElementById('close-youtube-btn');
const youtubeTitleInput = document.getElementById('youtube-title');
const youtubePrivacySelect = document.getElementById('youtube-privacy');
const youtubeStatusEl = document.getElementById('youtube-status');
const youtubeProgressContainer = document.getElementById('youtube-progress-container');
const youtubeProgressBar = document.getElementById('youtube-progress-bar');
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
  console.log('App initialization starting...');
  
  // 1. Setup UI & Global Listeners (Non-blocking)
  setupEventListeners();
  initGoogleLogin();
  checkAndRestoreAuth();
  
  // 2. Load FFmpeg (Non-blocking for other features)
  try {
    const mod = window.FFmpegWASM || window.FFmpeg;
    const FFmpegClass = mod?.FFmpeg ?? mod;
    if (FFmpegClass && typeof FFmpegClass === 'function') {
      ffmpeg = new FFmpegClass();
      ffmpeg.on('log', ({ message }) => console.log(message));
      
      const base = location.origin + '/vendor/';
      const coreURL = base + 'umd/ffmpeg-core.js';
      const wasmURL = base + 'ffmpeg-core.wasm';
      
      console.log("Loading FFmpeg core...");
      await ffmpeg.load({ coreURL, wasmURL });
      console.log("FFmpeg loaded successfully");
    }
  } catch(err) {
    console.warn('FFmpeg failed to load, processing will be disabled:', err);
  }

  // 3. Media Devices (Can block / fail safely)
  try {
    // Read saved settings first
    const savedCamera = localStorage.getItem('pm-camera-id');
    const savedMic = localStorage.getItem('pm-mic-id');
    const savedFormat = localStorage.getItem('pm-format');
    const savedResolution = localStorage.getItem('pm-resolution');

    // Initialize Snackbar Container
    snackbarContainer = document.getElementById('snackbar-container');
  
    if (savedFormat) formatSelect.value = savedFormat;
    if (savedResolution) resolutionSelect.value = savedResolution;
    liveVideo.classList.add('beauty-filter');

    // Try initial permissions with saved devices if available to avoid starting default camera unnecessarily
    try {
      const initialConstraints = {
        video: savedCamera ? { deviceId: { exact: savedCamera } } : true,
        audio: savedMic ? { deviceId: { exact: savedMic } } : true
      };
      mediaStream = await navigator.mediaDevices.getUserMedia(initialConstraints);
    } catch(err) {
      console.warn('Initial camera access with saved devices denied or device not found, trying defaults', err);
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch(defaultErr) {
        console.warn('Default media access also denied, continuing to load UI', defaultErr);
      }
    }
    
    await populateDeviceSelectors();
    
    // Update selectors to reflect saved IDs if they are still valid/present
    if (savedCamera && Array.from(cameraSelect.options).some(opt => opt.value === savedCamera)) {
      cameraSelect.value = savedCamera;
    }
    if (savedMic && Array.from(micSelect.options).some(opt => opt.value === savedMic)) {
      micSelect.value = savedMic;
    }
    
    // Synchronization: If we have an active stream (from defaults or successful saved ID),
    // and the selector isn't matching it, update the selector to match reality.
    if (mediaStream) {
      const videoTrack = mediaStream.getVideoTracks()[0];
      const audioTrack = mediaStream.getAudioTracks()[0];
      const activeVideoId = videoTrack?.getSettings()?.deviceId;
      const activeAudioId = audioTrack?.getSettings()?.deviceId;

      if (activeVideoId && cameraSelect.value !== activeVideoId) {
        if (Array.from(cameraSelect.options).some(opt => opt.value === activeVideoId)) {
          cameraSelect.value = activeVideoId;
        }
      }
      if (activeAudioId && micSelect.value !== activeAudioId) {
        if (Array.from(micSelect.options).some(opt => opt.value === activeAudioId)) {
          micSelect.value = activeAudioId;
        }
      }
    }
    
    if (mediaStream) {
      // Apply full selected resolution and constraints
      // This is necessary because the initial getUserMedia might have used defaults
      await startCamera();
    } else {
      setState(STATE.IDLE);
      updatePreviewUI();
    }
    
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      await populateDeviceSelectors();
    });

    // Check for existing session recording
    await checkAndRestoreSession();

    // Register Service Worker for updates
    registerServiceWorker();
  } catch (err) {
    console.error('Media initialization error:', err);
    showOverlay('Initialization issue. Check device permissions.', true);
  }
  
  console.log('App initialization complete!');
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
    const newStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    // Replace current stream
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
    }
    mediaStream = newStream;
    
    liveVideo.srcObject = mediaStream;
    liveVideo.muted = true; // Avoid feedback loop
    setState(STATE.IDLE);
    updatePreviewUI();
  } catch (err) {
    console.error('Error starting camera with constraints:', constraints, err);
    // If it failed and we have no stream at all, ensure UI reflects that
    if (!mediaStream) {
      setState(STATE.IDLE);
      updatePreviewUI();
    }
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
        playBtn.setAttribute('aria-label', 'Pause Recording');
        playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
      } else {
        playbackVideo.pause();
        playBtn.setAttribute('aria-label', 'Play Recording');
        playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>';
      }
    }
  });

  rewindStartBtn.addEventListener('click', () => {
    if (currentState === STATE.PLAYBACK) {
      playbackVideo.currentTime = 0;
    }
  });

  document.addEventListener('keydown', (e) => {
    // Don't trigger if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (currentState === STATE.IDLE) {
        if (!recordBtn.disabled) runCountdownThenStartRecording();
      } else if (currentState === STATE.RECORDING) {
        stopRecording();
      } else if (currentState === STATE.PLAYBACK) {
        playBtn.click();
      }
      return;
    }

    if (currentState !== STATE.PLAYBACK) return;
    
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      playbackVideo.currentTime = Math.max(0, playbackVideo.currentTime - 5);
      showSkipIndicator(skipLeftIndicator);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      playbackVideo.currentTime = Math.min(playbackVideo.duration || 0, playbackVideo.currentTime + 5);
      showSkipIndicator(skipRightIndicator);
    }
  });

  playbackVideo.addEventListener('ended', () => {
    playBtn.setAttribute('aria-label', 'Play Recording');
    playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>';
  });

  setupTrimTimeline();
  
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
    youtubeUploadBtn.textContent = accessToken ? 'Upload to YouTube' : 'Sign in & Upload';
    youtubeUploadBtn.disabled = false;
    
    // Reset to form view
    youtubeFormView.classList.remove('hidden');
    youtubeSuccessView.classList.add('hidden');
    
    youtubeModal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');
  });

  closeYoutubeBtn.addEventListener('click', () => {
    youtubeModal.classList.add('hidden');
    modalOverlay.classList.add('hidden');
  });

  youtubeDoneBtn.addEventListener('click', () => {
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
  
  // Kick off thumbnail generation in background
  generateThumbnails(blob);
  
  // Set trim values to video duration once metadata loads
  playbackVideo.onloadedmetadata = () => {
    const dur = playbackVideo.duration;
    trimStart.value = '0';
    trimEnd.value = dur.toFixed(1);
    trimEnd.max = dur;
    updateTimelineFromInputs();
    playbackVideo.onloadedmetadata = null;
  };

  setState(STATE.PLAYBACK);
}

function setupTrimTimeline() {
  let draggingHandle = null;

  const getPercentage = (clientX) => {
    const rect = trimTimeline.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return x / rect.width;
  };

  const updateFromHandle = (percent) => {
    const dur = playbackVideo.duration;
    if (!dur) return;
    const time = percent * dur;

    if (draggingHandle === trimHandleStart) {
      const endTime = parseFloat(trimEnd.value) || dur;
      const newTime = Math.min(time, endTime - 0.1);
      trimStart.value = newTime.toFixed(1);
      playbackVideo.currentTime = newTime;
    } else if (draggingHandle === trimHandleEnd) {
      const startTime = parseFloat(trimStart.value) || 0;
      const newTime = Math.max(time, startTime + 0.1);
      trimEnd.value = newTime.toFixed(1);
      playbackVideo.currentTime = newTime;
    }
    updateTimelineFromInputs();
  };

  const onMouseMove = (e) => {
    if (!draggingHandle) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    updateFromHandle(getPercentage(clientX));
  };

  const onMouseUp = () => {
    draggingHandle = null;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('touchmove', onMouseMove);
    document.removeEventListener('touchend', onMouseUp);
  };

  const onMouseDown = (e, handle) => {
    e.preventDefault();
    e.stopPropagation();
    draggingHandle = handle;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onMouseMove, { passive: false });
    document.addEventListener('touchend', onMouseUp);
  };

  trimHandleStart.addEventListener('mousedown', (e) => onMouseDown(e, trimHandleStart));
  trimHandleEnd.addEventListener('mousedown', (e) => onMouseDown(e, trimHandleEnd));
  trimHandleStart.addEventListener('touchstart', (e) => onMouseDown(e, trimHandleStart), { passive: false });
  trimHandleEnd.addEventListener('touchstart', (e) => onMouseDown(e, trimHandleEnd), { passive: false });

  // Handle clicking on the timeline track
  trimTimeline.addEventListener('mousedown', (e) => {
    if (e.target !== trimTimeline && e.target !== trimActiveRange) return;
    const percent = getPercentage(e.clientX);
    const dur = playbackVideo.duration;
    if (!dur) return;
    
    // Click on timeline now only seeks the video
    playbackVideo.currentTime = percent * dur;
  });

  trimStart.addEventListener('input', updateTimelineFromInputs);
  trimEnd.addEventListener('input', updateTimelineFromInputs);
}

async function generateThumbnails(blob) {
  if (!ffmpeg || !ffmpeg.loaded) return;
  
  const inputName = `thumb_input.${recordedFormat}`;
  const videoData = await blob.arrayBuffer();
  await ffmpeg.writeFile(inputName, new Uint8Array(videoData));
  
  // Get duration
  const dur = playbackVideo.duration || 5; // fallback
  const numThumbs = 10;
  const fps = numThumbs / dur;
  
  trimFilmstrip.innerHTML = ''; // clear existing
  
  try {
    // Extract thumbnails
    // Using simple scale and fps filters
    await ffmpeg.exec(['-i', inputName, '-vf', `fps=${fps},scale=-1:48`, 'thumb%d.jpg']);
    
    for (let i = 1; i <= numThumbs; i++) {
        try {
            const data = await ffmpeg.readFile(`thumb${i}.jpg`);
            const url = URL.createObjectURL(new Blob([data.buffer], { type: 'image/jpeg' }));
            const img = document.createElement('img');
            img.src = url;
            trimFilmstrip.appendChild(img);
        } catch (e) {
            // Might have fewer thumbs than requested if video is very short
            break;
        }
    }
  } catch (err) {
    console.warn('Thumbnail generation failed:', err);
  }
}

function updateTimelineFromInputs() {
  const dur = playbackVideo.duration;
  if (!dur || !trimTimeline) return;

  const start = parseFloat(trimStart.value) || 0;
  const end = parseFloat(trimEnd.value) || dur;

  const startPct = (start / dur) * 100;
  const endPct = (end / dur) * 100;

  trimHandleStart.style.left = `${startPct}%`;
  trimHandleEnd.style.left = `${endPct}%`;
  trimActiveRange.style.left = `${startPct}%`;
  trimActiveRange.style.width = `${endPct - startPct}%`;
}

async function cleanupPlayback() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  playbackVideo.src = '';
  trimFilmstrip.innerHTML = '';
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
    
    // reset trim values to new duration
    playbackVideo.onloadedmetadata = () => {
      const dur = playbackVideo.duration;
      trimStart.value = '0';
      trimEnd.value = dur.toFixed(1);
      trimEnd.max = dur;
      updateTimelineFromInputs();
      generateThumbnails(processedBlob);
      showToast('Processing complete', 'success');
      playbackVideo.onloadedmetadata = null;
    };
    
  } catch (err) {
    console.error("FFmpeg processing failed:", err);
    showToast("Processing failed", "error");
  } finally {
    processBtn.disabled = false;
    processBtn.textContent = 'Process Video';
  }
}

function showToast(message, type = 'info') {
  if (!snackbarContainer) return;
  const snackbar = document.createElement('div');
  snackbar.className = `snackbar snackbar--${type}`;
  snackbar.textContent = message;
  snackbarContainer.appendChild(snackbar);
  
  setTimeout(() => {
    snackbar.classList.add('fade-out');
    snackbar.addEventListener('animationend', () => snackbar.remove());
  }, 5000); // Increased to 5s for better visibility of updates
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      console.log(`SW registered (Version: ${APP_VERSION})`);
      
      // Explicitly check for updates on load and periodically (every hour)
      reg.update();
      setInterval(() => reg.update(), 1000 * 60 * 60);

      reg.onupdatefound = () => {
        const installingWorker = reg.installing;
        if (!installingWorker) return;
        
        installingWorker.onstatechange = () => {
          if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('New SW version installed and waiting.');
            // Note: sw.js has self.skipWaiting(), so it will activate immediately,
            // which triggers the 'controllerchange' event below.
          }
        };
      };

      // Force update check on visibility change (user switching back to tab)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          reg.update();
        }
      });
    });
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    
    // Only reload automatically if the user is in the IDLE state (not recording or playing back)
    if (currentState === STATE.IDLE) {
      refreshing = true;
      console.log('New version detected. Reloading...');
      window.location.reload();
    } else {
      // If busy, notify them but don't interrupt
      showToast('New version available. It will apply when you finish or refresh.', 'info');
    }
  });
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
  rewindStartBtn.classList.add('hidden');
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
    recordBtn.setAttribute('aria-label', 'Start Recording');
    clearInterval(recordingTimer);
    recordingTimeEl.textContent = '00:00';
    showOverlay('Ready to Practice');
    updatePreviewUI();
    
  } else if (newState === STATE.RECORDING) {
    liveVideo.classList.remove('hidden');
    recordBtn.classList.remove('hidden');
    recordBtn.classList.add('recording');
    recordBtn.setAttribute('aria-label', 'Stop Recording');
    recordingIndicator.classList.remove('hidden');
    
    recordingStartTime = Date.now();
    updateTimer();
    recordingTimer = setInterval(updateTimer, 1000);
    
  } else if (newState === STATE.PLAYBACK) {
    playbackVideo.classList.remove('hidden');
    playBtn.classList.remove('hidden');
    rewindStartBtn.classList.remove('hidden');
    discardBtn.classList.remove('hidden');
    downloadBtn.classList.remove('hidden');
    
    // YouTube GATING: Only show if enabled
    if (YOUTUBE_UPLOAD_ENABLED) {
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

function showSkipIndicator(el) {
  el.classList.remove('show');
  void el.offsetWidth; // force reflow
  el.classList.add('show');
  
  if (el._skipTimeout) clearTimeout(el._skipTimeout);
  el._skipTimeout = setTimeout(() => {
    el.classList.remove('show');
  }, 500);
}


// --- YouTube upload ---
async function startYoutubeUpload() {
  if (!objectUrl) {
    console.warn('YouTube upload: no video to upload.');
    return;
  }
  
  if (!accessToken) {
    console.warn('YouTube upload: no access token — user not signed in.');
    youtubeUploadBtn.textContent = 'Signing in...';
    youtubeUploadBtn.disabled = true;
    requestLogin();
    return;
  }

  const title = (youtubeTitleInput.value || 'Practice recording').trim();
  const privacy = youtubePrivacySelect.value;

  youtubeUploadBtn.disabled = true;
  youtubeStatusEl.className = 'youtube-status';
  youtubeStatusEl.textContent = 'Preparing your video...';
  
  if (youtubeProgressContainer) {
    youtubeProgressContainer.classList.remove('hidden');
    youtubeProgressBar.style.width = '0%';
  }

  try {
    const res = await fetch(objectUrl);
    const blob = await res.blob();
    const mimeType = recordedFormat === 'mp4' ? 'video/mp4' : 'video/webm';
    await uploadVideoToYouTube(accessToken, blob, mimeType, title, privacy);
    
    // Switch to success view
    youtubeFormView.classList.add('hidden');
    youtubeSuccessView.classList.remove('hidden');
  } catch (err) {
    console.error('YouTube upload failed:', err);
    // Detect expired / invalid token (401)
    if (err.message && err.message.includes('401')) {
      handleSignOut();
      youtubeStatusEl.className = 'youtube-status youtube-status--error';
      youtubeStatusEl.textContent = 'Your session expired. Please sign in again from Settings.';
    } else {
      youtubeStatusEl.className = 'youtube-status youtube-status--error';
      youtubeStatusEl.textContent = 'Upload failed. Please try again.';
    }
  } finally {
    youtubeUploadBtn.disabled = false;
    if (youtubeProgressContainer) youtubeProgressContainer.classList.add('hidden');
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
    const percent = Math.round((end / totalSize) * 100);
    youtubeStatusEl.textContent = `Uploading... ${percent}%`;
    if (youtubeProgressBar) youtubeProgressBar.style.width = `${percent}%`;

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
    // Restore thumbnails
      generateThumbnails(data.blob);

      playbackVideo.onloadedmetadata = () => {
        const dur = playbackVideo.duration;
        trimStart.value = '0';
        trimEnd.value = dur.toFixed(1);
        trimEnd.max = dur;
        updateTimelineFromInputs();
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

  // Use injected ID or fallback to local window global
  const clientId = (GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith('__')) 
    ? GOOGLE_CLIENT_ID 
    : (typeof window !== 'undefined' && window.__GOOGLE_CLIENT_ID__) ? window.__GOOGLE_CLIENT_ID__ : '';
    
  console.log('Initializing Google Login with Client ID:', clientId);

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: 'openid profile email https://www.googleapis.com/auth/youtube.upload',
    callback: handleTokenResponse,
    error_callback: (err) => {
      console.error('Auth error:', err);
      showOverlay('Authentication failed. Please try again.');
    }
  });
}

function requestLogin() {
  if (tokenClient) {
    tokenClient.requestAccessToken();
  } else {
    initGoogleLogin();
    if (tokenClient) {
      tokenClient.requestAccessToken();
    } else {
      console.error('Google login failed: tokenClient could not be initialized.');
      showOverlay('Authentication initialization failed.');
      updateAuthUI(); // Reset button text
    }
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
    
    // Persist profile in localStorage, token in sessionStorage
    localStorage.setItem('pm-user-profile', JSON.stringify(userProfile));
    localStorage.setItem('pm-login-timestamp', Date.now());
    sessionStorage.setItem('pm-access-token', accessToken);
    
    updateAuthUI();
    
    // Auto-resume upload if we were waiting for login in the YouTube modal
    if (!youtubeModal.classList.contains('hidden') && currentState === STATE.PLAYBACK) {
      startYoutubeUpload();
    } else if (currentState === STATE.PLAYBACK) {
      setState(STATE.PLAYBACK);
    }
  } catch (err) {
    console.error('Error handling login:', err);
  }
}

function checkAndRestoreAuth() {
  const savedProfile = localStorage.getItem('pm-user-profile');
  const savedToken = sessionStorage.getItem('pm-access-token');
  const loginTime = parseInt(localStorage.getItem('pm-login-timestamp') || '0', 10);
  const isExpired = !loginTime || (Date.now() - loginTime > 55 * 60 * 1000);

  if (savedProfile) {
    try {
      userProfile = JSON.parse(savedProfile);
      updateAuthUI();
      
      if (savedToken && !isExpired) {
        accessToken = savedToken;
      } else {
        // We have a profile but token is missing or expired.
        // Try silent refresh if Google script is loaded.
        setTimeout(() => {
          if (tokenClient) silentTokenRefresh();
        }, 1000);
      }
    } catch (e) {
      handleSignOut();
    }
  }
}

function silentTokenRefresh() {
  if (tokenClient && userProfile) {
    console.log('--- Attempting Silent Token Refresh ---');
    tokenClient.requestAccessToken({ prompt: '' });
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
  localStorage.removeItem('pm-user-profile');
  localStorage.removeItem('pm-login-timestamp');
  sessionStorage.removeItem('pm-access-token');
  updateAuthUI();
  
  // Hide YouTube button if currently visible
  if (currentState === STATE.PLAYBACK) {
    setState(STATE.PLAYBACK);
  }
}

// Kick off
document.addEventListener('DOMContentLoaded', init);
