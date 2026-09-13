const STATE = {
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  PLAYBACK: 'PLAYBACK'
};

// --- Build-time Injected Constants ---
// Netlify: injected at build from env GOOGLE_CLIENT_ID. Local: set in config.local.js.
const GOOGLE_CLIENT_ID = '__GOOGLE_CLIENT_ID__';
const APP_VERSION = '__APP_VERSION__';

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
let isUploading = false; // Tracks active YouTube upload to prevent accidental closing

// Web Audio API Globals for visualizer and audio gain stage
let audioCtx = null;
let audioSourceNode = null;
let gainNode = null;
let audioDestinationNode = null;
let analyserNode = null;
let audioLevelAnimationId = null;
let clipTimeoutId = null;
let currentMicGain = 1.0;

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
const micGainSlider = document.getElementById('mic-gain-slider');
const micGainVal = document.getElementById('mic-gain-val');
const audioClipIndicator = document.getElementById('audio-clip-indicator');
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

// Seek Bar elements
const seekbarRow = document.getElementById('seekbar-row');
const seekbarTrack = document.getElementById('seekbar-track');
const seekbarProgress = document.getElementById('seekbar-progress');
const seekbarBuffered = document.getElementById('seekbar-buffered');
const seekbarThumb = document.getElementById('seekbar-thumb');
const seekCurrentTime = document.getElementById('seek-current-time');
const seekDuration = document.getElementById('seek-duration');

// Trim time display spans
const trimStartDisplay = document.getElementById('trim-start-display');
const trimEndDisplay = document.getElementById('trim-end-display');

const youtubeModal = document.getElementById('youtube-modal');
const youtubeFormView = document.getElementById('youtube-form-view');
const youtubeSuccessView = document.getElementById('youtube-success-view');

// Edit button icon SVGs
const EDIT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 -960 960 960" fill="currentColor"><path d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"/></svg>`;
const CLOSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
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
      // ffmpeg.on('log', ({ message }) => console.debug(message));

      const base = location.origin + '/vendor/';
      const coreURL = base + 'umd/ffmpeg-core.js';
      const wasmURL = base + 'ffmpeg-core.wasm';

      console.log("Loading FFmpeg core...");
      await ffmpeg.load({ coreURL, wasmURL });
      console.log("FFmpeg loaded successfully");
    }
  } catch (err) {
    console.warn('FFmpeg failed to load, processing will be disabled:', err);
  }

  // 3. Media Devices (Can block / fail safely)
  try {
    // Read saved settings first
    const savedCameraId = localStorage.getItem('pm-camera-id');
    const savedMicId = localStorage.getItem('pm-mic-id');
    const savedCameraLabel = localStorage.getItem('pm-camera-label');
    const savedMicLabel = localStorage.getItem('pm-mic-label');
    const savedFormat = localStorage.getItem('pm-format');
    const savedResolution = localStorage.getItem('pm-resolution');
    const savedMicGain = localStorage.getItem('pm-mic-gain');
    if (savedMicGain && micGainSlider) {
      micGainSlider.value = savedMicGain;
      if (micGainVal) micGainVal.textContent = `${savedMicGain}%`;
      currentMicGain = (parseInt(savedMicGain, 10) || 100) / 100;
    }

    // Initialize Snackbar Container
    snackbarContainer = document.getElementById('snackbar-container');

    if (savedFormat) formatSelect.value = savedFormat;
    if (savedResolution) resolutionSelect.value = savedResolution;
    liveVideo.classList.add('beauty-filter');

    // Try initial permissions with saved devices
    try {
      const initialConstraints = {
        video: savedCameraId ? { deviceId: { exact: savedCameraId } } : true,
        audio: getAudioConstraints(savedMicId)
      };
      mediaStream = await navigator.mediaDevices.getUserMedia(initialConstraints);
    } catch (err) {
      console.warn('Initial access with saved IDs failed, attempting label-based fallback...', err);
      try {
        // If exact ID failed, try to find the device by label before falling back to defaults
        const devices = await navigator.mediaDevices.enumerateDevices();
        const fallbackCameraId = findDeviceIdByLabel(devices, 'videoinput', savedCameraLabel);
        const fallbackMicId = findDeviceIdByLabel(devices, 'audioinput', savedMicLabel);

        if (fallbackCameraId || fallbackMicId) {
          const fallbackConstraints = {
            video: fallbackCameraId ? { deviceId: { exact: fallbackCameraId } } : true,
            audio: getAudioConstraints(fallbackMicId)
          };
          mediaStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
        } else {
          // No label match either, go with music-safe defaults
          mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: getAudioConstraints() });
        }
      } catch (fallbackErr) {
        console.warn('All device restoration attempts failed, using defaults.', fallbackErr);
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: getAudioConstraints() });
        } catch (defaultErr) {
          console.warn('Total media access denial.', defaultErr);
        }
      }
    }

    await populateDeviceSelectors();

    // Update selectors to reflect current state or preferences
    if (savedCameraId && Array.from(cameraSelect.options).some(opt => opt.value === savedCameraId)) {
      cameraSelect.value = savedCameraId;
    }
    if (savedMicId && Array.from(micSelect.options).some(opt => opt.value === savedMicId)) {
      micSelect.value = savedMicId;
    }

    // Synchronization: If we have an active stream (from defaults or successful saved ID),
    // and the selector isn't matching it, update the selector to match reality.
    syncSelectorsToActiveStream();

    if (mediaStream) {
      // Apply full selected resolution and constraints
      // This is necessary because the initial getUserMedia might have used defaults
      await startCamera();
    } else {
      setState(STATE.IDLE);
      updatePreviewUI();
    }

    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', async () => {
        console.log('--- Media Device Change Detected ---');
        const oldCameraValue = cameraSelect.value;
        const oldMicValue = micSelect.value;
        
        await populateDeviceSelectors();
        
        // Preserve previously selected devices if they still exist in the new options list
        if (oldCameraValue && Array.from(cameraSelect.options).some(opt => opt.value === oldCameraValue)) {
          cameraSelect.value = oldCameraValue;
        }
        if (oldMicValue && Array.from(micSelect.options).some(opt => opt.value === oldMicValue)) {
          micSelect.value = oldMicValue;
        }
        
        // Synchronize select values to the actually running stream tracks (if any)
        syncSelectorsToActiveStream();
        
        // If the running microphone track has ended, or if the user's preferred mic has just been reconnected,
        // let's restart the camera/mic to reconnect audio and update visualizer!
        const audioTrack = mediaStream?.getAudioTracks()[0];
        const hasEnded = audioTrack?.readyState === 'ended';
        
        // Also check if the reconnected preferred mic is now available
        const savedMicId = localStorage.getItem('pm-mic-id');
        const preferredMicNowAvailable = savedMicId && savedMicId !== micSelect.value && 
                                         Array.from(micSelect.options).some(opt => opt.value === savedMicId);

        if (hasEnded || preferredMicNowAvailable) {
          console.log('Active audio track ended or preferred mic reconnected. Re-initializing camera...');
          if (preferredMicNowAvailable && savedMicId) {
            micSelect.value = savedMicId;
          }
          await startCamera();
        } else {
          // Just refresh the HUD overlays
          updateDeviceOverlayDisplay();
          if (mediaStream) {
            setupAudioLevelMeter(mediaStream);
          }
        }
      });
    }

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

function formatDeviceLabel(label) {
  if (!label) return '';
  // Remove technical USB hardware IDs like (0000:0001) or (05ac:8514)
  return label
    .replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}(?::[0-9a-fA-F]{4})?\)/g, '')
    .trim();
}

async function populateDeviceSelectors() {
  if (!navigator.mediaDevices) {
    console.warn('navigator.mediaDevices is not supported. Skipping populating device selectors.');
    return;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();

  const videoInput = devices.filter(d => d.kind === 'videoinput');
  const audioInput = devices.filter(d => d.kind === 'audioinput');

  const createOptions = (devices, defaultText) => {
    if (devices.length === 0) return `<option value="">${defaultText}</option>`;
    return devices.map(d => {
      const cleanLabel = formatDeviceLabel(d.label);
      const displayText = cleanLabel || `Device ${d.deviceId.slice(0, 5)}`;
      return `<option value="${d.deviceId}">${displayText}</option>`;
    }).join('');
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
  cleanupAudioLevelMeter();
  updateDeviceOverlayDisplay();
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

function getAudioConstraints(audioSourceId) {
  const audioConstraints = {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
    // Bypass browser speech filters (preserves classical guitar low E fundamental 82Hz & body warmth)
    googEchoCancellation: false,
    googAutoGainControl: false,
    googNoiseSuppression: false,
    googHighpassFilter: false,
    googTypingNoiseDetection: false,
    googAudioMirroring: false
  };
  if (audioSourceId) {
    audioConstraints.deviceId = { exact: audioSourceId };
  }
  return audioConstraints;
}

async function startCamera() {
  // If preview was stopped, clear that flag
  isPreviewStopped = false;

  // Stop any existing stream tracks first
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
    audio: getAudioConstraints(audioSource)
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
    updateDeviceOverlayDisplay();
    setupAudioLevelMeter(mediaStream);
  } catch (err) {
    console.error('Error starting camera with constraints:', constraints, err);
    // If it failed and we have no stream at all, ensure UI reflects that
    if (!mediaStream) {
      setState(STATE.IDLE);
      updatePreviewUI();
    } else {
      updateDeviceOverlayDisplay();
      setupAudioLevelMeter(mediaStream);
    }
  }
}

function findDeviceIdByLabel(devices, kind, label) {
  if (!label) return null;
  const cleanTarget = formatDeviceLabel(label);
  const match = devices.find(d => {
    if (d.kind !== kind) return false;
    const cleanCurrent = formatDeviceLabel(d.label);
    return (
      d.label === label ||
      d.label.includes(label) ||
      cleanCurrent === cleanTarget ||
      cleanCurrent.includes(cleanTarget) ||
      cleanTarget.includes(cleanCurrent)
    );
  });
  return match ? match.deviceId : null;
}

function setupEventListeners() {
  cameraSelect.addEventListener('change', () => {
    const selectedOption = cameraSelect.options[cameraSelect.selectedIndex];
    localStorage.setItem('pm-camera-id', cameraSelect.value);
    localStorage.setItem('pm-camera-label', selectedOption.text);
    startCamera();
  });

  micSelect.addEventListener('change', () => {
    const selectedOption = micSelect.options[micSelect.selectedIndex];
    localStorage.setItem('pm-mic-id', micSelect.value);
    localStorage.setItem('pm-mic-label', selectedOption.text);
    startCamera();
  });

  if (micGainSlider) {
    micGainSlider.addEventListener('input', () => {
      const val = parseInt(micGainSlider.value, 10) || 100;
      if (micGainVal) micGainVal.textContent = `${val}%`;
      currentMicGain = val / 100;
      if (gainNode && audioCtx) {
        gainNode.gain.setTargetAtTime(currentMicGain, audioCtx.currentTime, 0.02);
      }
      localStorage.setItem('pm-mic-gain', val.toString());
    });
  }

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

  discardBtn.addEventListener('click', async () => {
    if (currentState === STATE.PLAYBACK) {
      cleanupPlayback();
      await startCamera();
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
  setupSeekBar();

  processBtn.addEventListener('click', processVideo);

  editBtn.addEventListener('click', () => {
    const expanded = editBtn.getAttribute('aria-expanded') === 'true';
    editBtn.setAttribute('aria-expanded', !expanded);
    editBtn.setAttribute('aria-label', expanded ? 'Edit video' : 'Close edit pane');
    editBtn.innerHTML = expanded ? EDIT_ICON : CLOSE_ICON;
    editingPanel.hidden = expanded;
    editingTools.classList.toggle('editing-tools--expanded', !expanded);
    if (expanded) {
      editBtn.focus();
    }
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
    if (isUploading) return; // Prevent closing if an upload is in progress
    settingsModal.classList.add('hidden');
    youtubeModal.classList.add('hidden');
    modalOverlay.classList.add('hidden');
  });

  youtubeUploadBtn.addEventListener('click', startYoutubeUpload);
  signoutBtn.addEventListener('click', handleSignOut);
  if (customSigninBtn) customSigninBtn.addEventListener('click', requestLogin);
  setupDraggableDeviceOverlay();
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

  // Form stream to record: combine camera video track with gain-processed audio track if active
  let streamToRecord = mediaStream;
  if (audioDestinationNode && audioDestinationNode.stream) {
    const videoTracks = mediaStream.getVideoTracks();
    const processedAudioTracks = audioDestinationNode.stream.getAudioTracks();
    if (videoTracks.length > 0 && processedAudioTracks.length > 0) {
      streamToRecord = new MediaStream([videoTracks[0], processedAudioTracks[0]]);
    }
  }

  const selectedFormat = formatSelect.value || 'mp4';
  const mimeType = getSupportedMimeType(selectedFormat);
  const resVal = resolutionSelect ? resolutionSelect.value : '1080';

  // High-bitrate video allocation for YouTube & NLE editing
  let videoBitsPerSecond = 12000000; // 12 Mbps default for 1080p
  if (resVal === '720') {
    videoBitsPerSecond = 6000000; // 6 Mbps
  } else if (resVal === '2160') {
    videoBitsPerSecond = 30000000; // 30 Mbps
  }
  const audioBitsPerSecond = 320000; // 320 kbps studio-grade music audio

  const options = {
    mimeType,
    videoBitsPerSecond,
    audioBitsPerSecond
  };

  try {
    mediaRecorder = new MediaRecorder(streamToRecord, options);
  } catch (e) {
    console.warn('MediaRecorder with bitrate options failed, falling back to basic mimeType:', e);
    try {
      mediaRecorder = new MediaRecorder(streamToRecord, { mimeType });
    } catch (e2) {
      console.error('MediaRecorder fallback to default:', e2);
      mediaRecorder = new MediaRecorder(streamToRecord);
    }
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

function formatTime(seconds) {
  if (!isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function setupSeekBar() {
  let isSeeking = false;

  function getSeekPercent(clientX) {
    const rect = seekbarTrack.getBoundingClientRect();
    return Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
  }

  function applyPercent(percent) {
    seekbarProgress.style.width = `${percent * 100}%`;
    seekbarThumb.style.left = `${percent * 100}%`;
  }

  function seekTo(clientX) {
    const dur = playbackVideo.duration;
    if (!dur || !isFinite(dur)) return;
    const percent = getSeekPercent(clientX);
    playbackVideo.currentTime = percent * dur;
    applyPercent(percent);
    seekCurrentTime.textContent = formatTime(percent * dur);
  }

  // Update bar and time display as video plays
  playbackVideo.addEventListener('timeupdate', () => {
    const dur = playbackVideo.duration;
    if (!dur || !isFinite(dur) || isSeeking) return;
    const percent = playbackVideo.currentTime / dur;
    applyPercent(percent);
    seekCurrentTime.textContent = formatTime(playbackVideo.currentTime);

    // Update buffered
    if (playbackVideo.buffered.length > 0) {
      const bufferedEnd = playbackVideo.buffered.end(playbackVideo.buffered.length - 1);
      seekbarBuffered.style.width = `${(bufferedEnd / dur) * 100}%`;
    }
  });

  // Set duration display when metadata is available
  playbackVideo.addEventListener('loadedmetadata', () => {
    seekDuration.textContent = formatTime(playbackVideo.duration);
    seekCurrentTime.textContent = '0:00';
    applyPercent(0);
  });

  // Sync play/pause button icon with video state (e.g. clicking the video body)
  playbackVideo.addEventListener('play', () => {
    if (currentState !== STATE.PLAYBACK) return;
    playBtn.setAttribute('aria-label', 'Pause Recording');
    playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
  });

  playbackVideo.addEventListener('pause', () => {
    if (currentState !== STATE.PLAYBACK) return;
    playBtn.setAttribute('aria-label', 'Play Recording');
    playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>';
  });

  // Mouse drag-to-seek
  seekbarTrack.addEventListener('mousedown', (e) => {
    if (currentState !== STATE.PLAYBACK) return;
    isSeeking = true;
    seekbarTrack.classList.add('seeking');
    seekTo(e.clientX);

    const onMove = (e) => seekTo(e.clientX);
    const onUp = () => {
      isSeeking = false;
      seekbarTrack.classList.remove('seeking');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Touch drag-to-seek
  seekbarTrack.addEventListener('touchstart', (e) => {
    if (currentState !== STATE.PLAYBACK) return;
    e.preventDefault();
    isSeeking = true;
    seekbarTrack.classList.add('seeking');
    seekTo(e.touches[0].clientX);

    const onMove = (e) => { e.preventDefault(); seekTo(e.touches[0].clientX); };
    const onEnd = () => {
      isSeeking = false;
      seekbarTrack.classList.remove('seeking');
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  }, { passive: false });
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
}

async function generateThumbnails(blob) {
  if (!trimFilmstrip) return;
  trimFilmstrip.innerHTML = ''; // clear existing

  let srcUrl = objectUrl;
  let createdUrl = null;
  if (!srcUrl && blob) {
    createdUrl = URL.createObjectURL(blob);
    srcUrl = createdUrl;
  }
  if (!srcUrl) return;

  const tempVideo = document.createElement('video');
  tempVideo.muted = true;
  tempVideo.playsInline = true;
  tempVideo.preload = 'metadata';
  tempVideo.src = srcUrl;

  try {
    await new Promise((resolve, reject) => {
      const onLoaded = () => {
        tempVideo.removeEventListener('loadedmetadata', onLoaded);
        resolve();
      };
      const onError = () => {
        tempVideo.removeEventListener('error', onError);
        reject();
      };
      tempVideo.addEventListener('loadedmetadata', onLoaded);
      tempVideo.addEventListener('error', onError);
      setTimeout(resolve, 1000);
    });

    const dur = tempVideo.duration || playbackVideo.duration;
    if (!dur || isNaN(dur) || dur <= 0) return;

    const numThumbs = 10;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const width = 160;
    const height = 90;
    canvas.width = width;
    canvas.height = height;

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < numThumbs; i++) {
      const time = ((i + 0.5) / numThumbs) * dur;
      tempVideo.currentTime = Math.min(dur - 0.05, Math.max(0, time));

      await new Promise((resolve) => {
        let done = false;
        const capture = () => {
          if (done) return;
          done = true;
          try {
            ctx.drawImage(tempVideo, 0, 0, width, height);
            const img = document.createElement('img');
            img.src = canvas.toDataURL('image/jpeg', 0.7);
            fragment.appendChild(img);
          } catch (e) {}
          resolve();
        };
        const timer = setTimeout(capture, 250);
        const onSeeked = () => {
          clearTimeout(timer);
          tempVideo.removeEventListener('seeked', onSeeked);
          capture();
        };
        tempVideo.addEventListener('seeked', onSeeked);
      });
    }

    trimFilmstrip.appendChild(fragment);
  } catch (err) {
    console.warn('Thumbnail generation failed:', err);
  } finally {
    tempVideo.remove();
    if (createdUrl) {
      URL.revokeObjectURL(createdUrl);
    }
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

  if (trimStartDisplay) trimStartDisplay.textContent = formatTime(start);
  if (trimEndDisplay) trimEndDisplay.textContent = formatTime(end);
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

  const videoDuration = playbackVideo.duration;
  if (!videoDuration || isNaN(videoDuration)) {
    alert("Please wait for the video to load before processing.");
    return;
  }
  const start = Math.max(0, parseFloat(trimStart.value) || 0);
  const end = Math.min(videoDuration, parseFloat(trimEnd.value) || videoDuration);
  const duration = end - start;
  const addFade = false; // Disabled by default to protect acoustic note attacks and natural reverb decay

  if (duration <= 0) {
    alert("End time must be greater than start time.");
    return;
  }

  processBtn.disabled = true;
  processBtn.classList.add('is-processing');
  processBtn.style.setProperty('--progress', '0%');
  processBtn.textContent = 'Processing... 0%';

  let hasStartedEncoding = false;
  let lastRatio = 0;

  const handleProgress = ({ progress }) => {
    const ratio = progress > 1 ? progress / 100 : progress;
    // When FFmpeg switches from fast seek/demux to encoding, ratio resets near 0
    if (ratio < lastRatio && lastRatio > 0.5) {
      hasStartedEncoding = true;
    }
    lastRatio = ratio;

    const pct = Math.min(100, Math.max(0, Math.round(ratio * 100)));
    const label = (hasStartedEncoding || start === 0) ? `Encoding... ${pct}%` : `Preparing... ${pct}%`;
    processBtn.textContent = label;
    processBtn.style.setProperty('--progress', `${pct}%`);
  };

  try {
    ffmpeg.on('progress', handleProgress);

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

    // DaVinci Resolve / Premiere Pro / Final Cut / YouTube compatible MP4 encoding:
    // H.264 High profile yuv420p + AAC 320k 48kHz stereo + faststart moov atom
    if (outputFormat === 'mp4') {
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '19',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '320k',
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+faststart'
      );
    } else {
      // High-quality WebM VP9 + Opus
      ffmpegArgs.push(
        '-c:v', 'libvpx-vp9',
        '-b:v', '0',
        '-crf', '24',
        '-c:a', 'libopus',
        '-b:a', '256k',
        '-ar', '48000'
      );
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
      
      // Close the edit UI
      editBtn.setAttribute('aria-expanded', 'false');
      editBtn.innerHTML = EDIT_ICON;
      editingPanel.hidden = true;
      editingTools.classList.remove('editing-tools--expanded');
      editBtn.focus();
      
      playbackVideo.onloadedmetadata = null;
    };

  } catch (err) {
    console.error("FFmpeg processing failed:", err);
    showToast("Processing failed", "error");
  } finally {
    if (ffmpeg) {
      ffmpeg.off('progress', handleProgress);
    }
    processBtn.disabled = false;
    processBtn.classList.remove('is-processing');
    processBtn.style.removeProperty('--progress');
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
  seekbarRow.classList.add('hidden');

  if (newState === STATE.IDLE) {
    recordBtn.classList.remove('hidden');
    recordBtn.classList.remove('recording');
    recordBtn.setAttribute('aria-label', 'Start Recording');
    clearInterval(recordingTimer);
    recordingTimeEl.textContent = '00:00';
    showOverlay('Ready to Practice');
    updatePreviewUI();
    
    if (mediaStream) {
      setupAudioLevelMeter(mediaStream);
    }

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
    editBtn.innerHTML = EDIT_ICON;
    editingPanel.hidden = true;
    editingTools.classList.remove('editing-tools--expanded');
    playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>';
    seekbarRow.classList.remove('hidden');
    clearInterval(recordingTimer);

    // Release camera and microphone stream to save battery
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
      cleanupAudioLevelMeter();
    }
  }

  // Ensure preview UI (like 'Pause Preview' button) updates for all states
  updatePreviewUI();

  // Update device status overlay
  updateDeviceOverlayDisplay();
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

  isUploading = true;
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
    isUploading = false;
    youtubeUploadBtn.disabled = false;
    if (youtubeProgressContainer) youtubeProgressContainer.classList.add('hidden');
  }
}

// Prevent accidental tab closing during upload
window.addEventListener('beforeunload', (e) => {
  if (isUploading) {
    e.preventDefault();
    e.returnValue = ''; // Browsers show their own generic confirmation message
  }
});

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
      'video/mp4;codecs=avc1,mp4a.40.2',
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
    // Set localStorage flag so we know this session has a valid recording that survives restarts
    localStorage.setItem('pm-has-recording', 'true');
  } catch (err) {
    console.warn('Failed to save video to IndexedDB:', err);
  }
}

async function clearVideoFromSession() {
  try {
    localStorage.removeItem('pm-has-recording');
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('current-video');
  } catch (err) {
    console.warn('Failed to clear video from IndexedDB:', err);
  }
}

async function checkAndRestoreSession() {
  // If no recording flag exists, we don't need to do anything
  if (!localStorage.getItem('pm-has-recording')) {
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

  if (!clientId) {
    console.warn('Google Client ID is missing. YouTube upload features will be disabled.');
    return;
  }

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
  const state = Math.random().toString(36).substring(2, 15);
  sessionStorage.setItem('pm-oauth-state', state);
  if (tokenClient) {
    tokenClient.requestAccessToken({ state: state });
  } else {
    initGoogleLogin();
    if (tokenClient) {
      tokenClient.requestAccessToken({ state: state });
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

  const savedState = sessionStorage.getItem('pm-oauth-state');
  if (!response.state || response.state !== savedState) {
    console.error('OAuth state mismatch. Possible CSRF attack.');
    showOverlay('Authentication security check failed.');
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

function syncSelectorsToActiveStream() {
  if (!mediaStream) return;
  const videoTrack = mediaStream.getVideoTracks()[0];
  const audioTrack = mediaStream.getAudioTracks()[0];
  const activeVideoId = videoTrack?.getSettings()?.deviceId;
  const activeAudioId = audioTrack?.getSettings()?.deviceId;

  if (activeVideoId && cameraSelect && cameraSelect.value !== activeVideoId) {
    if (Array.from(cameraSelect.options).some(opt => opt.value === activeVideoId)) {
      cameraSelect.value = activeVideoId;
    }
  }
  if (activeAudioId && micSelect && micSelect.value !== activeAudioId) {
    if (Array.from(micSelect.options).some(opt => opt.value === activeAudioId)) {
      micSelect.value = activeAudioId;
    }
  }
}

// --- Device & Audio Level Overlay Logic ---

function setupDraggableDeviceOverlay() {
  const overlay = document.getElementById('device-status-overlay');
  const container = document.getElementById('video-container');
  if (!overlay || !container) return;

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  // Restore saved position if valid
  const restoreSavedPosition = () => {
    const savedPos = localStorage.getItem('pm-device-overlay-pos');
    if (!savedPos) return;
    try {
      const { leftPct, topPct } = JSON.parse(savedPos);
      if (typeof leftPct === 'number' && typeof topPct === 'number') {
        overlay.style.left = `${leftPct}%`;
        overlay.style.top = `${topPct}%`;
        overlay.style.right = 'auto';
        overlay.style.bottom = 'auto';
      }
    } catch (e) {
      console.warn('Could not restore device overlay position:', e);
    }
  };

  restoreSavedPosition();

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;

    const containerRect = container.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    initialLeft = overlayRect.left - containerRect.left;
    initialTop = overlayRect.top - containerRect.top;

    overlay.classList.add('is-dragging');
    try {
      overlay.setPointerCapture(e.pointerId);
    } catch (_) {}
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const containerRect = container.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();

    const maxLeft = Math.max(0, containerRect.width - overlayRect.width);
    const maxTop = Math.max(0, containerRect.height - overlayRect.height);

    const newLeft = Math.max(0, Math.min(maxLeft, initialLeft + dx));
    const newTop = Math.max(0, Math.min(maxTop, initialTop + dy));

    overlay.style.left = `${newLeft}px`;
    overlay.style.top = `${newTop}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
  };

  const onPointerUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    overlay.classList.remove('is-dragging');
    try {
      overlay.releasePointerCapture(e.pointerId);
    } catch (_) {}

    const containerRect = container.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const curLeft = overlayRect.left - containerRect.left;
    const curTop = overlayRect.top - containerRect.top;

    if (containerRect.width > 0 && containerRect.height > 0) {
      const leftPct = Math.max(0, Math.min(95, (curLeft / containerRect.width) * 100));
      const topPct = Math.max(0, Math.min(95, (curTop / containerRect.height) * 100));
      overlay.style.left = `${leftPct.toFixed(2)}%`;
      overlay.style.top = `${topPct.toFixed(2)}%`;
      localStorage.setItem('pm-device-overlay-pos', JSON.stringify({ leftPct, topPct }));
    }
  };

  // Double-click to reset to default top-right position
  overlay.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    overlay.style.left = '';
    overlay.style.top = '';
    overlay.style.right = '';
    overlay.style.bottom = '';
    localStorage.removeItem('pm-device-overlay-pos');
  });

  // Keep overlay inside container on window resize
  window.addEventListener('resize', () => {
    if (overlay.style.left && overlay.style.left.endsWith('%')) {
      const containerRect = container.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      if (containerRect.width === 0 || containerRect.height === 0) return;

      const maxLeft = Math.max(0, containerRect.width - overlayRect.width);
      const maxTop = Math.max(0, containerRect.height - overlayRect.height);
      const curLeft = overlayRect.left - containerRect.left;
      const curTop = overlayRect.top - containerRect.top;

      if (curLeft > maxLeft || curTop > maxTop) {
        const clampedLeft = Math.max(0, Math.min(maxLeft, curLeft));
        const clampedTop = Math.max(0, Math.min(maxTop, curTop));
        const leftPct = (clampedLeft / containerRect.width) * 100;
        const topPct = (clampedTop / containerRect.height) * 100;
        overlay.style.left = `${leftPct.toFixed(2)}%`;
        overlay.style.top = `${topPct.toFixed(2)}%`;
      }
    }
  });

  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointercancel', onPointerUp);
}

function updateDeviceOverlayDisplay() {
  const overlay = document.getElementById('device-status-overlay');
  if (!overlay) return;

  const hasStream = !!mediaStream;
  const isIdleOrRecording = currentState === STATE.IDLE || currentState === STATE.RECORDING;

  if (hasStream && isIdleOrRecording) {
    overlay.classList.remove('hidden');
    
    // Update camera name
    const cameraNameEl = document.getElementById('active-camera-name');
    if (cameraNameEl && cameraSelect) {
      const activeCameraLabel = cameraSelect.options[cameraSelect.selectedIndex]?.text || 'Default Camera';
      cameraNameEl.textContent = activeCameraLabel;
    }
    
    // Update mic name
    const micNameEl = document.getElementById('active-mic-name');
    if (micNameEl && micSelect) {
      const activeMicLabel = micSelect.options[micSelect.selectedIndex]?.text || 'Default Microphone';
      micNameEl.textContent = activeMicLabel;
    }
  } else {
    overlay.classList.add('hidden');
  }
}

function setupAudioLevelMeter(stream) {
  // Clean up any existing analyzer loop
  cleanupAudioLevelMeter();

  if (!stream) return;
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    console.warn('Audio level visualizer: No audio tracks in active mediaStream.');
    const micInfoEl = document.getElementById('active-mic-info');
    if (micInfoEl) micInfoEl.style.color = 'var(--danger-color)';
    updateAudioMeterUI(0, false);
    return;
  }
  
  const micInfoEl = document.getElementById('active-mic-info');
  if (micInfoEl) micInfoEl.style.color = '';

  try {
    // Create or restore AudioContext
    if (!audioCtx || audioCtx.state === 'closed') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
    }
    
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 512;
    analyserNode.smoothingTimeConstant = 0.2;
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    audioSourceNode = audioCtx.createMediaStreamSource(stream);
    gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(currentMicGain, audioCtx.currentTime);

    audioDestinationNode = audioCtx.createMediaStreamDestination();

    // Connect graph:
    // audioSourceNode -> gainNode -> audioDestinationNode (for recording)
    //                             -> analyserNode (for metering & peak detection)
    audioSourceNode.connect(gainNode);
    gainNode.connect(audioDestinationNode);
    gainNode.connect(analyserNode);

    // Auto-resume AudioContext if suspended (browser autoplay policy)
    if (audioCtx.state === 'suspended') {
      // Try immediate resume first
      audioCtx.resume().catch(() => {});

      const resumeContext = () => {
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().then(() => {
            console.log('AudioContext successfully resumed on gesture.');
          });
        }
        ['click', 'touchstart', 'mousedown', 'keydown'].forEach(evt => {
          window.removeEventListener(evt, resumeContext);
        });
      };
      ['click', 'touchstart', 'mousedown', 'keydown'].forEach(evt => {
        window.addEventListener(evt, resumeContext, { passive: true });
      });
    }

    let lastDrawTime = 0;
    const fpsInterval = 1000 / 30; // Throttle to 30 FPS

    const drawMeter = (timestamp) => {
      // Loop stops if we switch to playback, stop the stream, or analyzer is removed
      if (currentState === STATE.PLAYBACK || !mediaStream || !analyserNode) {
        updateAudioMeterUI(0, false);
        return;
      }

      audioLevelAnimationId = requestAnimationFrame(drawMeter);

      if (!timestamp) timestamp = performance.now();
      const elapsed = timestamp - lastDrawTime;

      if (elapsed < fpsInterval) {
        return;
      }
      lastDrawTime = timestamp - (elapsed % fpsInterval);

      analyserNode.getByteTimeDomainData(dataArray);
      
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < bufferLength; i++) {
        const sample = (dataArray[i] - 128) / 128; // -1.0 to 1.0
        const absSample = Math.abs(sample);
        if (absSample > peak) peak = absSample;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / bufferLength);
      
      // Music dynamic range dBFS mapping (-48 dBFS to 0 dBFS)
      const db = rms > 0.0001 ? 20 * Math.log10(rms) : -60;
      const percent = Math.min(100, Math.max(0, Math.round(((db + 48) / 48) * 100)));
      
      // True peak clipping threshold (>= -0.2 dBFS is ~0.98)
      const isClipping = peak >= 0.98;
      updateAudioMeterUI(percent, isClipping);
    };

    drawMeter();
  } catch (err) {
    console.warn('Could not initialize audio level visualizer:', err);
  }
}

function cleanupAudioLevelMeter() {
  if (audioLevelAnimationId) {
    cancelAnimationFrame(audioLevelAnimationId);
    audioLevelAnimationId = null;
  }
  if (audioSourceNode) {
    try {
      audioSourceNode.disconnect();
    } catch (e) {}
    audioSourceNode = null;
  }
  if (gainNode) {
    try {
      gainNode.disconnect();
    } catch (e) {}
    gainNode = null;
  }
  if (clipTimeoutId) {
    clearTimeout(clipTimeoutId);
    clipTimeoutId = null;
  }
  updateAudioMeterUI(0, false);
}

function updateAudioMeterUI(percent, isClipping = false) {
  const bar = document.getElementById('audio-level-bar');
  const clipEl = document.getElementById('audio-clip-indicator');
  if (!bar) return;

  bar.style.width = `${percent}%`;
  
  // Transition styles for material design
  if (percent < 70) {
    bar.style.backgroundColor = 'var(--success-color, #10b981)';
    bar.style.boxShadow = '0 0 8px rgba(16, 185, 129, 0.4)';
  } else if (percent < 88) {
    bar.style.backgroundColor = '#fbbf24'; // beautiful material warning amber
    bar.style.boxShadow = '0 0 8px rgba(251, 191, 36, 0.4)';
  } else {
    bar.style.backgroundColor = 'var(--danger-color, #ef4444)'; // beautiful material error red
    bar.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.6)';
  }

  if (clipEl) {
    if (isClipping) {
      clipEl.classList.add('is-clipping');
      if (clipTimeoutId) clearTimeout(clipTimeoutId);
      clipTimeoutId = setTimeout(() => {
        clipEl.classList.remove('is-clipping');
        clipTimeoutId = null;
      }, 1500);
    } else if (!clipTimeoutId) {
      clipEl.classList.remove('is-clipping');
    }
  }
}

// Kick off
document.addEventListener('DOMContentLoaded', init);
