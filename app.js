const STATE = {
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  PLAYBACK: 'PLAYBACK'
};

let currentState = STATE.IDLE;
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = 0;
let recordingTimer = null;
let objectUrl = null;

// DOM Elements
const liveVideo = document.getElementById('live-video');
const playbackVideo = document.getElementById('playback-video');
const cameraSelect = document.getElementById('camera-select');
const micSelect = document.getElementById('mic-select');
const recordBtn = document.getElementById('record-btn');
const playBtn = document.getElementById('play-btn');
const discardBtn = document.getElementById('discard-btn');
const downloadBtn = document.getElementById('download-btn');
const formatSelect = document.getElementById('format-select');
const resolutionSelect = document.getElementById('resolution-select');
const beautyToggle = document.getElementById('beauty-toggle');
const settingsModal = document.getElementById('settings-modal');
const modalOverlay = document.getElementById('modal-overlay');
const settingsBtn = document.getElementById('settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const deviceSelectors = document.getElementById('device-selectors');
const recordingIndicator = document.getElementById('recording-indicator');
const recordingTimeEl = document.getElementById('recording-time');
const stateOverlay = document.getElementById('state-overlay');
const stateText = stateOverlay.querySelector('.state-text');

// Initialize
async function init() {
  try {
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
    const savedBeauty = localStorage.getItem('pm-beauty-filter') === 'true';

    // Apply saved dropdown options
    if (savedFormat) formatSelect.value = savedFormat;
    if (savedResolution) resolutionSelect.value = savedResolution;
    
    // Apply saved toggle
    beautyToggle.checked = savedBeauty;
    if (savedBeauty) {
      liveVideo.classList.add('beauty-filter');
    } else {
      liveVideo.classList.remove('beauty-filter');
    }

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

  beautyToggle.addEventListener('change', () => {
    localStorage.setItem('pm-beauty-filter', beautyToggle.checked);
    if (beautyToggle.checked) {
      liveVideo.classList.add('beauty-filter');
    } else {
      liveVideo.classList.remove('beauty-filter');
    }
  });

  settingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
    modalOverlay.classList.add('hidden');
  });
  
  modalOverlay.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
    modalOverlay.classList.add('hidden');
  });
  
  recordBtn.addEventListener('click', () => {
    if (currentState === STATE.IDLE) {
      startRecording();
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
      // Use selected format for extension
      const format = formatSelect.value || 'webm';
      let ext = format === 'mp4' ? 'mp4' : 'webm';
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
}

function startRecording() {
  if (!mediaStream) return;
  recordedChunks = [];
  
  const selectedFormat = formatSelect.value || 'webm';
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
  const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  
  playbackVideo.src = objectUrl;
  playbackVideo.load();
  setState(STATE.PLAYBACK);
}

function cleanupPlayback() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  playbackVideo.src = '';
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
  liveVideo.classList.add('hidden');
  playbackVideo.classList.add('hidden');
  recordingIndicator.classList.add('hidden');
  stateOverlay.classList.add('hidden');
  
  if (newState === STATE.IDLE) {
    liveVideo.classList.remove('hidden');
    recordBtn.classList.remove('hidden');
    recordBtn.classList.remove('recording');
    clearInterval(recordingTimer);
    recordingTimeEl.textContent = '00:00';
    showOverlay('Ready to Practice');
    
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
    playBtn.innerHTML = '<svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>';
    clearInterval(recordingTimer);
  }
}

function showOverlay(text, persistent = false) {
  stateText.textContent = text;
  stateOverlay.classList.remove('hidden');
  if (!persistent) {
    setTimeout(() => {
      stateOverlay.classList.add('hidden');
    }, 2000);
  }
}

function getSupportedMimeType(preferredFormat = 'webm') {
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
