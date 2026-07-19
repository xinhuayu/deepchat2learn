const SESSION_STORAGE_KEY = 'deepchat2learn-session';
const LEGACY_SESSION_STORAGE_KEY = 'speakwise-session';
const $ = selector => document.querySelector(selector);
const voicePolicy = {
  autoSubmitDelayMs: 5_000,
  transitionDelayMs: 750,
  realtimeWatchdogMs: 0,
  maxRecognitionRetries: 8
};
const BROWSER_CONVERSATION_STATES = [
  'idle',
  'ai-speaking',
  'listening',
  'user-speaking',
  'processing',
  'retryable-error',
  'paused',
  'completed'
];
const microphoneConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
};
let state = { session: null, token: null, mode: 'practice', sourceLimits: { maxFiles: 10, maxFileBytes: 20_000_000 }, recognition: null, recognitionActive: false, microphonePermission: 'unknown', speechRecognitionPermission: 'unavailable', speechRecognitionProbe: false, speechRecognitionProbePromise: null, speechRecognitionProbeResolve: null, speechRecognitionProbeTimer: null, isMobileBrowser: false, realtimeConfigured: false, peer: null, localStream: null, dataChannel: null, remoteAudio: null, pendingSource: null, processedVoiceItems: new Set(), voiceReviewPending: false, voiceConversation: 'off', browserConversationState: 'idle', voiceAnnouncement: '', voiceSubmissionKey: null, voiceRecognitionSessionId: 0, voiceRecognitionAttempts: 0, voiceRecognitionRetryPending: false, transcript: [], materialHistory: [], summary: null, lastFeedback: null, lastSpokenLine: '' };
let sourceProcessingTimers = [];
let sourceDigestRequest = null;
let recordingController = null;
let recordingOptIn = false;
let recordingInputStream = null;
let recordingInputBorrowed = false;
let recordingRemoteStatusMessage = '';

function formatRecordingElapsed(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function getRecordingSnapshot() {
  return recordingController?.snapshot?.() || { state: 'idle', captureMode: 'microphone-only', modeLabel: 'Microphone only', elapsedMs: 0, blob: null };
}

function isRecordingActive(snapshot = getRecordingSnapshot()) {
  return ['starting', 'recording', 'paused', 'stopping'].includes(snapshot.state);
}

function releaseRecordingInputStream() {
  if (recordingInputStream && !recordingInputBorrowed) {
    recordingInputStream.getTracks?.().forEach(track => {
      try { track.stop(); } catch { /* Ignore local recording cleanup errors. */ }
    });
  }
  recordingInputStream = null;
  recordingInputBorrowed = false;
}

function syncRecordingUi(snapshot = getRecordingSnapshot()) {
  const status = $('#recordingStatus');
  const timer = $('#recordingTimer');
  const mode = $('#recordingMode');
  const recordButton = $('#recordConversationButton');
  const stopButton = $('#stopRecordingButton');
  const discardButton = $('#discardRecordingButton');
  const downloadButton = $('#downloadRecordingButton');
  const summaryDownloadButton = $('#downloadRecordingSummaryButton');
  if (!status || !timer || !mode || !recordButton || !stopButton || !discardButton || !downloadButton) return;

  const active = isRecordingActive(snapshot);
  const ready = snapshot.state === 'ready' && Boolean(snapshot.blob);
  const armed = snapshot.state === 'armed';
  const pressed = recordingOptIn || active || ready || armed;
  recordButton.setAttribute('aria-pressed', String(pressed));
  recordButton.textContent = pressed && !ready ? 'Recording requested' : 'Record conversation';
  stopButton.disabled = !active;
  discardButton.disabled = !recordingController || (!pressed && !ready && snapshot.state !== 'unavailable' && snapshot.state !== 'error');
  downloadButton.disabled = !ready;
  if (summaryDownloadButton) summaryDownloadButton.disabled = !ready;
  timer.textContent = formatRecordingElapsed(snapshot.elapsedMs);

  const microphoneOnlyCopy = 'Microphone only. Spoken browser playback is not captured in local recordings.';
  const completeCopy = 'Complete conversation. Your microphone and live AI audio are mixed locally.';
  mode.textContent = snapshot.captureMode === 'complete-conversation' ? completeCopy : microphoneOnlyCopy;

  const statusCopy = {
    idle: recordingOptIn ? 'Recording will start when voice starts.' : 'Recording off. Start a voice conversation after pressing Record conversation.',
    armed: 'Recording armed. It will start with the next voice connection.',
    starting: 'Starting local recording...',
    recording: 'Recording locally.',
    paused: 'Recording paused with the voice conversation.',
    stopping: 'Stopping local recording...',
    ready: 'Recording ready to download.',
    unavailable: snapshot.message || 'Recording unavailable, but voice conversation can continue.',
    error: snapshot.message || 'Recording stopped because local capture failed.'
  };
  const statusMessage = recordingRemoteStatusMessage && snapshot.captureMode !== 'complete-conversation'
    ? `${recordingRemoteStatusMessage} ${statusCopy[snapshot.state] || statusCopy.idle}`
    : statusCopy[snapshot.state] || statusCopy.idle;
  status.textContent = statusMessage;
}

function ensureRecordingController() {
  if (recordingController) return recordingController;
  const factory = window.deepchat2learnRecording?.createController;
  if (typeof factory !== 'function') {
    syncRecordingUi({ state: 'unavailable', captureMode: 'microphone-only', modeLabel: 'Microphone only', elapsedMs: 0, blob: null, message: 'Recording unavailable: local recorder did not load.' });
    return null;
  }
  recordingController = factory({
    MediaRecorderCtor: window.MediaRecorder,
    AudioContextCtor: window.AudioContext || window.webkitAudioContext,
    URLRef: window.URL
  });
  recordingController.subscribe(snapshot => syncRecordingUi(snapshot));
  syncRecordingUi(recordingController.snapshot());
  return recordingController;
}

function attachRecordingRemoteStream(remoteStream) {
  if (!recordingController || !remoteStream) return;
  recordingRemoteStatusMessage = '';
  const snapshot = recordingController.attachRemoteStream(remoteStream);
  syncRecordingUi(snapshot);
}

function markRecordingRemoteUnavailable(message = 'AI audio unavailable; continuing microphone-only recording.') {
  recordingRemoteStatusMessage = message;
  if (recordingController) {
    const snapshot = recordingController.detachRemoteStream();
    syncRecordingUi({ ...snapshot, captureMode: 'microphone-only', modeLabel: 'Microphone only' });
  } else {
    syncRecordingUi();
  }
}

async function startRecordingForVoiceTransport(transport) {
  if (!recordingOptIn) return;
  const controller = ensureRecordingController();
  if (!controller) return;
  releaseRecordingInputStream();
  recordingRemoteStatusMessage = '';
  let microphoneStream = null;
  let microphoneError = null;
  let borrowed = false;
  if (transport === 'realtime') {
    microphoneStream = state.localStream;
    borrowed = true;
    if (!state.remoteAudio?.srcObject) {
      recordingRemoteStatusMessage = 'AI audio unavailable; continuing microphone-only recording.';
    }
  } else if (navigator.mediaDevices?.getUserMedia) {
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia(microphoneConstraints);
    } catch (error) {
      microphoneError = error;
    }
  } else {
    microphoneError = new Error('Recording unavailable: this browser cannot request microphone access.');
  }

  recordingInputStream = microphoneStream;
  recordingInputBorrowed = borrowed;
  controller.arm({
    microphoneStream,
    microphoneError,
    // Keep the local mixer alive when Realtime audio has not arrived yet so a
    // later ontrack event can add AI audio without restarting the recorder.
    disableAudioContext: false
  });
  if (transport === 'realtime' && state.remoteAudio?.srcObject) {
    controller.attachRemoteStream(state.remoteAudio.srcObject);
  }
  const snapshot = await controller.start() || controller.snapshot();
  syncRecordingUi(snapshot);
  if (snapshot.state === 'unavailable') {
    releaseRecordingInputStream();
    recordingOptIn = false;
    syncRecordingUi(snapshot);
  }
}

async function stopRecordingAndKeepBlob() {
  if (!recordingController) return getRecordingSnapshot();
  const snapshot = getRecordingSnapshot();
  recordingOptIn = false;
  if (isRecordingActive(snapshot)) {
    const stopped = await recordingController.stop();
    releaseRecordingInputStream();
    syncRecordingUi(stopped);
    return stopped;
  }
  releaseRecordingInputStream();
  syncRecordingUi(snapshot);
  return snapshot;
}

function discardRecording() {
  recordingOptIn = false;
  recordingRemoteStatusMessage = '';
  if (recordingController) recordingController.discard();
  releaseRecordingInputStream();
  syncRecordingUi(getRecordingSnapshot());
}

function pauseRecording() {
  if (!recordingController) return;
  syncRecordingUi(recordingController.pause());
}

function resumeRecording() {
  if (!recordingController) return;
  syncRecordingUi(recordingController.resume());
}

async function downloadRecording(target = 'recording') {
  if (!recordingController) return;
  const result = await recordingController.download();
  if (!result) return;
  if (target === 'summary') $('#summaryStatus').textContent = 'Audio recording downloaded.';
  else $('#recordingStatus').textContent = 'Recording downloaded.';
}

function show(view) {
  ['setupView', 'sessionView', 'summaryView'].forEach(id => $(`#${id}`).classList.toggle('hidden', id !== view));
}

function syncModeSelection() {
  document.querySelectorAll('.mode-option').forEach(option => option.classList.toggle('selected', Boolean(option.querySelector('input')?.checked)));
}

function syncConversationDefaults() {
  const sourceMode = state.mode === 'materials';
  const defaults = {
    goal: sourceMode ? 'structure' : 'clarity',
    difficulty: sourceMode ? 'intermediate' : 'beginner',
    feedbackStyle: sourceMode ? 'socratic' : 'supportive'
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const select = $(`#${id}`);
    if (select) select.value = value;
  });
}

function syncQuestionLimitOptions() {
  const select = $('#questionLimit');
  if (!select) return;
  const maxQuestions = state.mode === 'materials' ? 200 : 50;
  Array.from(select.options || []).forEach(option => { option.disabled = Number(option.value) > maxQuestions; });
  if (select.value !== String(maxQuestions)) select.value = String(maxQuestions);
  const help = $('#questionLimitHelp');
  if (help) help.textContent = state.mode === 'materials'
    ? 'Source conversations allow up to 200 rounds.'
    : 'Practice voice sessions allow up to 50 rounds; source conversations allow up to 200.';
}

function notify(message) {
  const toast = $('#globalError');
  toast.textContent = message;
  toast.classList.remove('hidden');
  window.setTimeout(() => toast.classList.add('hidden'), 4500);
}

function notifyError(error) {
  if (error?.handled) return;
  if (error?.spokenMessage) {
    setVoiceAnnouncement(error.message);
    if (state.voiceConversation !== 'off' || state.voiceReviewPending) {
      speak(error.spokenMessage, { onerror: () => null });
    }
  }
  notify(error.message);
}

async function loadServiceStatus() {
  const status = $('#serviceStatus');
  try {
    const response = await fetch('/api/health', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Service status unavailable');
    const data = await response.json();
    state.sourceLimits = {
      ...state.sourceLimits,
      ...(data.sourceLimits || {})
    };
    Object.assign(voicePolicy, data.voice || {});
    const capabilities = data.capabilities || {};
    const connection = data.connection || {};
    state.realtimeConfigured = connection?.realtimeVoice === 'configured';
    const privacy = data.privacy || {};
    const coach = connection?.textModel === 'configured'
      ? 'AI text coaching is configured.'
      : 'Local demo coach is active.';
    const voice = connection?.realtimeVoice === 'configured'
      ? ' Live AI voice is configured.'
      : state.recognition
        ? ' Browser voice input and spoken playback remain available.'
        : ' This browser has no browser speech recognition. Use live AI voice when configured or type instead.';
    const storage = capabilities.storage === 'sqlite'
      ? ' Sessions use persistent storage.'
      : ' Sessions use lightweight in-memory storage.';
    const privacyNote = privacy.defaultRetentionMode
      ? ` Default retention is ${privacy.defaultRetentionMode.replace('_', ' ')} and audio is ${privacy.audioStorage || 'never'} stored.`
      : '';
    status.textContent = `${coach}${voice}${storage}${privacyNote}`;
    syncVoiceAccessSetup();
  } catch {
    status.textContent = 'Coaching service status is unavailable. You can still start a local session.';
    syncVoiceAccessSetup();
  }
}

function persistClientSession() {
  if (!state.session || !state.token) return;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ id: state.session.id, token: state.token, mode: state.mode, transcript: state.transcript, materialHistory: state.materialHistory, draft: $('#answerText').value, additionalSourceName: $('#additionalSourceName').value, additionalSourceText: $('#additionalSourceText').value }));
  } catch { /* Session storage can be unavailable in private browsing contexts. */ }
}

function clearClientSession() {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    sessionStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  } catch { /* Ignore storage cleanup failures. */ }
}

function clearAdditionalSourceDraft() {
  $('#additionalSourceFile').value = '';
  $('#additionalSourceName').value = '';
  $('#additionalSourceText').value = '';
}

function clearSourceNameAutoMarker() {
  $('#sourceName').dataset.autoName = '';
}

function recoverExpiredSession(message = 'Your session expired. Start a new session to continue.') {
  discardRecording();
  stopLiveVoice();
  stopVoiceConversation();
  clearAdditionalSourceDraft();
  clearClientSession();
  state.session = null;
  state.token = null;
  state.mode = 'practice';
  state.pendingSource = null;
  state.processedVoiceItems = new Set();
  state.voiceReviewPending = false;
  state.voiceConversation = 'off';
  state.browserConversationState = 'idle';
  state.voiceAnnouncement = '';
  state.voiceSubmissionKey = null;
  state.voiceRecognitionSessionId = 0;
  state.voiceRecognitionAttempts = 0;
  state.voiceRecognitionRetryPending = false;
  state.transcript = [];
  state.materialHistory = [];
  state.summary = null;
  state.lastFeedback = null;
  state.lastSpokenLine = '';
  $('#setupForm').reset();
  syncConversationDefaults();
  syncModeSelection();
  clearSourceNameAutoMarker();
  $('#sourceSetup').classList.add('hidden');
  show('setupView');
  notify(message);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(state.token ? { 'x-session-token': state.token } : {}), ...(options.headers || {}) } });
  } catch {
    throw new Error('Unable to reach deepchat2learn. Check your connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const sessionMessage = {
      SESSION_EXPIRED: 'Your session expired. Start a new session to continue.',
      SESSION_NOT_FOUND: 'Your session is no longer available. Start a new session to continue.',
      UNAUTHORIZED: 'Your session is no longer available. Start a new session to continue.'
    }[data.error?.code];
    const error = new Error(sessionMessage || data.error?.message || 'Something went wrong.');
    error.code = data.error?.code;
    error.spokenMessage = data.error?.spokenMessage || '';
    if (sessionMessage) {
      recoverExpiredSession(sessionMessage);
      error.handled = true;
    }
    throw error;
  }
  return data;
}

function speak(text, { onend, onerror } = {}) {
  if (!('speechSynthesis' in window)) {
    onerror?.();
    notify('Spoken playback is not available in this browser. The text captions are still available.');
    return;
  }
  setLastSpokenLine(text);
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onend = onend;
  utterance.onerror = onerror;
  window.speechSynthesis.speak(utterance);
}

function emitVoiceEvent(type, detail = {}) {
  const payload = { type, ...detail };
  document.dispatchEvent(new CustomEvent('deepchat2learn:voice', { detail: payload }));
  return payload;
}

function buildVoiceTurnKey({ transcript, confidence, reviewed, itemKey }) {
  return [state.session?.id || 'no-session', state.voiceConversation, itemKey || state.session?.turnCount || 0, String(transcript || '').trim(), confidence ?? '', reviewed ? 'reviewed' : 'raw'].join(':');
}

function clearVoiceSilenceTimer() {
  if (!voiceCoordinator.silenceTimer) return;
  window.clearTimeout(voiceCoordinator.silenceTimer);
  voiceCoordinator.silenceTimer = null;
}

function clearVoiceAutoSubmitTimer() {
  if (!voiceCoordinator.voiceSubmitTimer) return;
  window.clearTimeout(voiceCoordinator.voiceSubmitTimer);
  voiceCoordinator.voiceSubmitTimer = null;
  voiceCoordinator.pendingTranscript = null;
}

function clearVoiceCapture() {
  voiceCoordinator.captureSegments = [];
  voiceCoordinator.captureCycleResults = new Map();
  voiceCoordinator.captureCycleId = null;
  voiceCoordinator.captureInterim = '';
}

function normalizeVoiceTranscript(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function mergeVoiceTranscript(previous, next) {
  const earlier = normalizeVoiceTranscript(previous);
  const later = normalizeVoiceTranscript(next);
  if (!earlier) return later;
  if (!later || earlier.toLowerCase() === later.toLowerCase()) return earlier;
  if (later.toLowerCase().startsWith(`${earlier.toLowerCase()} `)) return later;
  if (earlier.toLowerCase().endsWith(` ${later.toLowerCase()}`)) return earlier;

  const earlierWords = earlier.split(' ');
  const laterWords = later.split(' ');
  for (let overlap = Math.min(earlierWords.length, laterWords.length); overlap >= 2; overlap -= 1) {
    const earlierTail = earlierWords.slice(-overlap).join(' ').toLowerCase();
    const laterHead = laterWords.slice(0, overlap).join(' ').toLowerCase();
    if (earlierTail === laterHead) return `${earlierWords.join(' ')} ${laterWords.slice(overlap).join(' ')}`.trim();
  }
  return `${earlier} ${later}`.trim();
}

function currentRecognitionCycleText() {
  return [...voiceCoordinator.captureCycleResults.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .reduce((transcript, text) => mergeVoiceTranscript(transcript, text), '');
}

function commitRecognitionCycle() {
  const cycleText = currentRecognitionCycleText();
  if (cycleText) {
    const committed = voiceCoordinator.captureSegments.join(' ');
    voiceCoordinator.captureSegments = [mergeVoiceTranscript(committed, cycleText)];
  }
  voiceCoordinator.captureCycleResults = new Map();
  voiceCoordinator.captureCycleId = null;
  voiceCoordinator.captureInterim = '';
}

function beginRecognitionCycle(cycleId) {
  if (voiceCoordinator.captureCycleId !== null && voiceCoordinator.captureCycleId !== cycleId) commitRecognitionCycle();
  if (voiceCoordinator.captureCycleId === cycleId) return;
  voiceCoordinator.captureCycleId = cycleId;
  voiceCoordinator.captureCycleResults = new Map();
  voiceCoordinator.captureInterim = '';
}

function collectVoiceRecognitionText(event) {
  const results = Array.from(event?.results || []);
  const baseIndex = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0;
  beginRecognitionCycle(state.voiceRecognitionSessionId);
  let interim = '';
  let hasFinal = false;
  const fullResultList = results.length > baseIndex;
  for (const [offset, result] of results.entries()) {
    const alternative = result?.[0];
    const text = normalizeVoiceTranscript(alternative?.transcript);
    if (!text) continue;
    if (alternative?.isFinal === false) {
      interim = text;
      continue;
    }
    hasFinal = true;
    const resultIndex = fullResultList ? offset : baseIndex + offset;
    voiceCoordinator.captureCycleResults.set(resultIndex, text);
  }
  voiceCoordinator.captureInterim = interim;
  return {
    hasFinal,
    transcript: mergeVoiceTranscript(voiceCoordinator.captureSegments.join(' '), currentRecognitionCycleText())
  };
}

function clearVoiceResumeTimer() {
  if (!voiceCoordinator.resumeTimer) return;
  window.clearTimeout(voiceCoordinator.resumeTimer);
  voiceCoordinator.resumeTimer = null;
}

function clearVoiceCompletionTimer() {
  if (!voiceCoordinator.completionTimer) return;
  window.clearTimeout(voiceCoordinator.completionTimer);
  voiceCoordinator.completionTimer = null;
}

function armVoiceSilenceTimer() {
  clearVoiceSilenceTimer();
  if (!voiceCoordinator.active || state.voiceConversation !== 'listening') return;
  if (voiceCoordinator.transport === 'browser-fallback') return;
  if (!voicePolicy.realtimeWatchdogMs) return;
  voiceCoordinator.silenceTimer = window.setTimeout(() => {
    voiceCoordinator.interrupt();
  }, voicePolicy.realtimeWatchdogMs);
}

function clearVoiceReconnectTimer() {
  if (!voiceCoordinator.reconnectTimer) return;
  window.clearTimeout(voiceCoordinator.reconnectTimer);
  voiceCoordinator.reconnectTimer = null;
}

function applyVoiceEventsState(event) {
  if (!event) return;
  if (event.type === 'permission_pending') {
    voiceCoordinator.state = 'permission_pending';
    setVoiceAnnouncement('Please allow microphone access when your browser asks.');
    setVoiceConversationState('speaking');
  } else if (event.type === 'listening') {
    voiceCoordinator.state = 'listening';
    setLiveInputEnabled(true);
    setVoiceAnnouncement(event.transport === 'browser-fallback'
      ? 'Listening… speak naturally. I will keep listening until you pause.'
      : 'Listening… ask your question naturally, then pause.');
    setVoiceConversationState('listening');
    setListeningState(true);
    armVoiceSilenceTimer();
  } else if (event.type === 'transcript_finalized') {
    voiceCoordinator.state = 'finalizing_transcript';
    clearVoiceSilenceTimer();
    setVoiceAnnouncement('Reviewing your spoken turn…');
    setTranscriptReviewMessage(`Transcript ready: ${event.transcript}`);
    setVoiceAnnouncement(state.mode === 'materials'
      ? 'Retrieving relevant passages and digesting your spoken question...'
      : 'Evaluating your spoken answer...');
    setVoiceConversationState('submitting');
  } else if (event.type === 'answer_approved') {
    voiceCoordinator.state = 'speaking_answer';
    clearVoiceSilenceTimer();
    setVoiceAnnouncement('Approved answer ready.');
    setVoiceConversationState('speaking');
  } else if (event.type === 'speech_started') {
    voiceCoordinator.state = 'speaking';
    if (voiceCoordinator.transport === 'browser-fallback') stopSpeechRecognition();
    setLiveInputEnabled(false);
    setVoiceAnnouncement(event.questionPrompt
      ? 'AI is asking the question. Please wait until it finishes.'
      : 'AI is speaking. You can interrupt at any time.');
    setVoiceConversationState('speaking');
  } else if (event.type === 'user_speech_started') {
    if (state.voiceConversation === 'speaking' || voiceCoordinator.state === 'speaking') {
      setLiveInputEnabled(false);
      setVoiceAnnouncement('AI is still speaking. Press “Interrupt answer” before speaking.');
      return;
    }
    voiceCoordinator.state = 'listening';
    transitionBrowserConversationState('user-speaking', {
      legacyMode: 'listening',
      announcement: 'I can hear you. Keep speaking until you pause.'
    });
    setListeningState(true);
  } else if (event.type === 'speech_ended') {
    setLiveInputEnabled(true);
    if (voiceCoordinator.transport === 'browser-fallback' && voiceCoordinator.active && voiceCoordinator.shouldAutoResume) {
      voiceCoordinator.bargeInListening = false;
      clearVoiceCapture();
      startVoiceListening();
    } else if (voiceCoordinator.active && voiceCoordinator.shouldAutoResume) voiceCoordinator.scheduleResume();
    else if (state.session?.status === 'ready_to_complete') {
      voiceCoordinator.active = false;
      voiceCoordinator.state = 'idle';
      transitionBrowserConversationState('completed', {
        legacyMode: 'off',
        announcement: 'This session reached its question limit. Wrapping up your summary...'
      });
      clearVoiceCompletionTimer();
      voiceCoordinator.completionTimer = window.setTimeout(() => {
        voiceCoordinator.completionTimer = null;
        if (state.session?.status === 'ready_to_complete') completeSession().catch(notifyError);
      }, voicePolicy.transitionDelayMs);
    }
  } else if (event.type === 'recoverable_error') {
    voiceCoordinator.state = 'error';
    setVoiceAnnouncement(`${event.message} You can type your answer instead.`);
    if (voiceCoordinator.transport === 'realtime') scheduleRealtimeReconnect(event.message);
    else if (voiceCoordinator.active && state.voiceConversation !== 'off') scheduleVoiceListeningRetry(event.message);
  }
}

function emitAndApplyVoiceEvent(type, detail = {}) {
  const event = emitVoiceEvent(type, detail);
  applyVoiceEventsState(event);
  return event;
}

function scheduleRealtimeReconnect(message = 'Live voice connection changed.') {
  if (voiceCoordinator.transport !== 'realtime' || !voiceCoordinator.active) return;
  if (voiceCoordinator.reconnectTimer) return;
  if (voiceCoordinator.reconnectAttempts >= voiceCoordinator.maxReconnectAttempts) {
    setVoiceConversationError(`${message} Live voice could not reconnect.`);
    return;
  }
  voiceCoordinator.reconnectAttempts += 1;
  voiceCoordinator.reconnectTimer = window.setTimeout(async () => {
    voiceCoordinator.reconnectTimer = null;
    try {
      await openRealtimeVoiceTransport({ reconnecting: true });
      if (voiceCoordinator.active && voiceCoordinator.shouldAutoResume) await voiceCoordinator.resume();
    } catch (error) {
      emitAndApplyVoiceEvent('recoverable_error', { message: error?.message || 'Live voice could not reconnect.' });
    }
  }, 600);
}

function defaultVoiceAnnouncement(browserState) {
  return {
    idle: 'Voice idle. You can still type below.',
    'ai-speaking': 'AI is speaking. You can interrupt at any time.',
    listening: 'Listening… speak naturally, then pause.',
    'user-speaking': 'I can hear you. Keep going until you pause.',
    processing: 'Reviewing your spoken turn…',
    'retryable-error': 'That voice turn can be retried. You can also type your answer instead.',
    paused: 'Voice conversation paused. You can still type.',
    completed: 'This session reached its question limit. You can review or end the session.'
  }[browserState] || 'Voice idle. You can still type below.';
}

function browserStateLabel(browserState) {
  return {
    idle: 'Idle',
    'ai-speaking': 'AI speaking',
    listening: 'Listening',
    'user-speaking': 'User speaking',
    processing: 'Processing',
    'retryable-error': 'Retry needed',
    paused: 'Paused',
    completed: 'Completed'
  }[browserState] || 'Idle';
}

function browserStateGuidance(browserState) {
  if (browserState === 'ai-speaking') return 'AI is speaking. Microphone input is paused to prevent echo capture. Press Interrupt answer if you need to take the floor.';
  if (browserState === 'listening') return 'Listening for your answer. Speak naturally; a five-second pause submits the captured answer.';
  if (browserState === 'user-speaking') return 'You are speaking. Keep going until you finish; the AI will respond after the pause.';
  if (browserState === 'retryable-error') return 'Your transcript stays in the text box. Retry the voice step or edit the text below. Press Ctrl+Enter or Cmd+Enter to submit a typed answer.';
  if (browserState === 'paused') return 'Voice is paused. You can resume voice or keep going by typing below.';
  if (browserState === 'processing') return 'Please wait while I review the current turn. If voice fails, your transcript stays available for retry or typing.';
  return 'If voice is unavailable, type below. Press Ctrl+Enter or Cmd+Enter to submit a typed answer.';
}

function syncRepeatSpokenLineButton() {
  const button = $('#repeatSpokenLine');
  if (!button) return;
  button.disabled = !(state.lastSpokenLine && 'speechSynthesis' in window);
}

function setLastSpokenLine(text = '') {
  state.lastSpokenLine = String(text || '').trim();
  setVoiceCaption(state.lastSpokenLine);
  syncRepeatSpokenLineButton();
}

function setVoiceCaption(text = '') {
  const caption = $('#voiceCaptionText');
  if (caption) caption.textContent = String(text || '').trim() || 'Latest spoken line captions will appear here.';
}

function focusTypedFallback() {
  for (const selector of ['#answerText', '#submitAnswer', '#materialQuestion', '#askQuestion']) {
    const element = $(selector);
    if (!element || element.disabled) continue;
    element.focus?.();
    return element;
  }
  return null;
}

function returnFocusToRecoveryControl({ preferRetry = false } = {}) {
  if (preferRetry) {
    const retryButton = $('#voiceRetryButton');
    if (retryButton && !retryButton.disabled) {
      retryButton.focus?.();
      return retryButton;
    }
  }
  return focusTypedFallback();
}

function browserStateFromLegacyVoiceMode(mode) {
  if (mode === 'speaking') return 'ai-speaking';
  if (mode === 'listening') return 'listening';
  if (mode === 'submitting') return 'processing';
  if (mode === 'error') return voiceCoordinator?.state === 'paused' ? 'paused' : 'retryable-error';
  if (state.session?.status === 'ready_to_complete') return 'completed';
  return 'idle';
}

function applyVoiceStateClasses(element, browserState) {
  if (!element) return;
  element.setAttribute('data-voice-state', browserState);
  element.classList.toggle('voice-state-active', ['ai-speaking', 'listening', 'user-speaking'].includes(browserState));
  element.classList.toggle('voice-state-processing', browserState === 'processing');
  element.classList.toggle('voice-state-error', ['retryable-error', 'paused'].includes(browserState));
}

function renderBrowserConversationState() {
  const browserState = BROWSER_CONVERSATION_STATES.includes(state.browserConversationState)
    ? state.browserConversationState
    : 'idle';
  const announcement = state.voiceAnnouncement || defaultVoiceAnnouncement(browserState);
  const voiceState = $('#voiceState');
  const voiceStateLabel = $('#voiceStateLabel');
  const voiceStateGuidance = $('#voiceStateGuidance');
  const voiceLiveRegion = $('#voiceLiveRegion');
  const voiceButton = $('#voiceConversationButton');
  const pauseButton = $('#voicePauseButton');
  const stopButton = $('#voiceStopButton');
  const interruptButton = $('#voiceInterruptButton');
  const retryButton = $('#voiceRetryButton');
  const submitButton = $('#submitAnswer');
  const listenButton = $('#listenButton');
  const microphoneStatus = $('#microphoneStatus');
  const active = !['idle', 'completed'].includes(browserState);
  const paused = browserState === 'paused';
  const speaking = browserState === 'ai-speaking';
  const listening = ['listening', 'user-speaking'].includes(browserState);
  const retryable = browserState === 'retryable-error';
  const processing = browserState === 'processing';

  if (voiceState) {
    voiceState.textContent = announcement;
    voiceState.setAttribute('aria-label', `Voice state: ${browserStateLabel(browserState)}. ${announcement}`);
    applyVoiceStateClasses(voiceState, browserState);
  }
  if (voiceStateLabel) voiceStateLabel.textContent = `Voice state: ${browserStateLabel(browserState)}`;
  if (voiceStateGuidance) voiceStateGuidance.textContent = browserStateGuidance(browserState);
  if (voiceLiveRegion) voiceLiveRegion.textContent = `Voice state: ${browserStateLabel(browserState)}. ${announcement}`;
  applyVoiceStateClasses(voiceButton, browserState);
  applyVoiceStateClasses(pauseButton, browserState);
  applyVoiceStateClasses(stopButton, browserState);
  applyVoiceStateClasses(interruptButton, browserState);
  applyVoiceStateClasses(retryButton, browserState);
  applyVoiceStateClasses(submitButton, browserState);
  applyVoiceStateClasses(listenButton, browserState);
  applyVoiceStateClasses(microphoneStatus, browserState);

  if (voiceButton) {
    voiceButton.disabled = processing;
    voiceButton.setAttribute('aria-pressed', String(active));
    voiceButton.textContent = active ? 'Stop voice conversation' : 'Start voice conversation';
  }
  if (pauseButton) {
    pauseButton.disabled = !(speaking || listening || paused);
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.textContent = paused ? 'Resume voice conversation' : 'Pause voice conversation';
  }
  if (stopButton) stopButton.disabled = !active;
  if (interruptButton) interruptButton.disabled = !speaking;
  if (retryButton) retryButton.disabled = !(retryable && (state.voiceReviewPending || voiceCoordinator.failedTranscript));
  if (submitButton) submitButton.setAttribute('aria-busy', String(processing || submitButton.disabled));
  syncRepeatSpokenLineButton();
}

function transitionBrowserConversationState(nextState, options = {}) {
  const browserState = BROWSER_CONVERSATION_STATES.includes(nextState) ? nextState : 'idle';
  state.browserConversationState = browserState;
  state.voiceConversation = options.legacyMode ?? ({
    idle: 'off',
    'ai-speaking': 'speaking',
    listening: 'listening',
    'user-speaking': 'listening',
    processing: 'submitting',
    'retryable-error': 'error',
    paused: 'error',
    completed: 'off'
  }[browserState] || 'off');
  if (Object.prototype.hasOwnProperty.call(options, 'announcement')) {
    state.voiceAnnouncement = options.announcement || '';
  }
  renderBrowserConversationState();
}

function normalizeVoiceLegacyAnswer(result) {
  if (result?.legacyAnswer) return result.legacyAnswer;
  return {
    mode: result?.knowledgeLayers?.includes('source') ? 'source' : 'general',
    answer: result?.answerText || '',
    sourceGroundedClaims: [],
    additionalContext: [],
    unsupportedOrUnresolved: [],
    confidence: result?.confidence || null
  };
}

function setVoiceAnnouncement(message) {
  state.voiceAnnouncement = message || '';
  renderBrowserConversationState();
}

function setTranscriptReviewMessage(message) {
  const element = $('#voiceTranscriptReviewText');
  if (element) element.textContent = message;
}

function renderKnowledgeLayers(layers = []) {
  const normalized = layers.length ? layers : ['llm'];
  const labels = {
    source: 'From your materials',
    llm: 'LLM background',
    external: 'External research'
  };
  return normalized.map(layer => `<span class="knowledge-layer knowledge-layer-${escapeHtml(layer)}">${escapeHtml(labels[layer] || layer)}</span>`).join('');
}

function renderCitationCards(citations = []) {
  const sourceMarkup = citations.map(citation => {
    const page = citation.page ? `Page ${citation.page}` : '';
    const section = citation.section ? `Section: ${citation.section}` : '';
    const locator = [page, section].filter(Boolean).join(' · ');
    const excerpt = citation.excerpt || citation.evidence || citation.text || '';
    return `<div class="citation"><strong>${escapeHtml(citation.sourceName || citation.sourceId || 'Supplied material')}</strong>${locator ? `<div class="citation-locator">${escapeHtml(locator)}</div>` : ''}${excerpt ? `<p>${escapeHtml(excerpt)}</p>` : ''}</div>`;
  }).join('');
  return sourceMarkup;
}

function renderEvidenceDisclosure({ label, body, tone = 'default', open = false }) {
  if (!body) return '';
  return `<details class="evidence-disclosure evidence-disclosure-${escapeHtml(tone)}"${open ? ' open' : ''}><summary>${escapeHtml(label)}</summary><div class="evidence-disclosure-body">${body}</div></details>`;
}

function renderSourceEvidenceSection(approved) {
  if (approved.citations.length) {
    return renderEvidenceDisclosure({
      label: `Source evidence (${approved.citations.length})`,
      body: `<div class="voice-citations">${renderCitationCards(approved.citations)}</div>`,
      tone: 'source'
    });
  }
  if (approved.sourceSupportStatus === 'not_in_sources') {
    return renderEvidenceDisclosure({
      label: 'Source evidence unavailable',
      body: '<p>I could not match this answer to a supporting passage in your supplied materials.</p>',
      tone: 'warning'
    });
  }
  if (approved.sourceSupportStatus === 'pending') {
    return renderEvidenceDisclosure({
      label: 'Source evidence pending',
      body: '<p>Your materials are still processing, so grounded source citations are not ready yet.</p>',
      tone: 'warning'
    });
  }
  if (approved.sourceSupportStatus === 'digest_only') {
    return renderEvidenceDisclosure({
      label: 'Source digest only',
      body: '<p>This answer used the prepared digest because no matching passage was retrieved for a direct citation.</p>',
      tone: 'warning'
    });
  }
  return '';
}

function renderLlmContextSection(approved) {
  if (!approved.knowledgeLayers.includes('llm')) return '';
  const copy = approved.knowledgeLayers.includes('source')
    ? 'General LLM background helped connect the source-supported answer, but it is separate from your cited materials.'
    : 'This answer relies on general LLM background knowledge rather than a supplied source passage.';
  return renderEvidenceDisclosure({
    label: 'General LLM context',
    body: `<p>${escapeHtml(copy)}</p>`,
    tone: 'llm'
  });
}

function renderExternalResearchSection(externalCitations = []) {
  const externalKnowledgeStatus = arguments[1] || 'not_requested';
  if (!externalCitations.length && externalKnowledgeStatus !== 'consent_required') return '';
  if (externalKnowledgeStatus === 'consent_required') {
    return renderEvidenceDisclosure({
      label: 'External research locked',
      body: '<p>External research is available only after you approve a one-time lookup.</p>',
      tone: 'warning'
    });
  }
  const externalMarkup = externalCitations.map(citation => {
    const publisher = citation.publisher || citation.provider || 'External source';
    const time = citation.retrievedAt ? ` · Retrieved ${citation.retrievedAt}` : '';
    const excerpt = citation.excerpt || citation.snippet || '';
    return `<div class="citation"><strong>${escapeHtml(citation.title || publisher)}</strong><div class="citation-locator">${escapeHtml(publisher)}${escapeHtml(time)}</div>${citation.url ? `<p><a href="${escapeHtml(citation.url)}" target="_blank" rel="noreferrer">${escapeHtml(citation.url)}</a></p>` : ''}${excerpt ? `<p>${escapeHtml(excerpt)}</p>` : ''}</div>`;
  }).join('');
  return renderEvidenceDisclosure({
    label: `External research (${externalCitations.length})`,
    body: `<div class="voice-citations">${externalMarkup}</div>`,
    tone: 'external'
  });
}

function buildExternalResearchSpeech(externalCitations = []) {
  return externalCitations.length ? 'Separate external research is available in the transcript panel.' : '';
}

function buildApprovedSpeechRequest(answerSpeechText, externalResearchSpeechText) {
  const external = String(externalResearchSpeechText || '').trim();
  return {
    type: 'response.create',
    response: {
      instructions: external
        ? `Speak exactly this approved answer, then clearly say the separate external-research segment. Do not add or change anything: ${answerSpeechText} ${external}`
        : `Speak exactly this approved answer. Do not add or change anything: ${answerSpeechText}`
    }
  };
}

function speakLayeredAnswer({ answerSpeechText, externalResearchSpeechText, oncomplete } = {}) {
  const primary = String(answerSpeechText || '').trim();
  const external = String(externalResearchSpeechText || '').trim();
  if (!primary) return;
  if (!external) {
    speak(primary, { onend: oncomplete });
    return;
  }
  speak(primary, {
    onend: () => speak(external, { onend: oncomplete })
  });
}

function normalizeApprovedAnswerResult(result) {
  const legacy = result?.answer ? result : normalizeVoiceLegacyAnswer(result);
  const answerText = result?.answerText || legacy?.answer || '';
  const sourceClaims = legacy?.sourceGroundedClaims || [];
  const citations = result?.citations?.length
    ? result.citations
    : sourceClaims.map(claim => ({
      sourceName: claim.sourceName,
      sourceId: claim.sourceId,
      page: claim.page,
      section: claim.section,
      excerpt: claim.evidence,
      locator: claim.locator
    }));
  const knowledgeLayers = result?.knowledgeLayers?.length
    ? result.knowledgeLayers
    : legacy?.mode === 'source' ? ['source'] : ['llm'];
  const unsupported = result?.unsupportedOrUnresolved || legacy?.unsupportedOrUnresolved || [];
  return {
    ...legacy,
    answer: answerText,
    answerText,
    confidence: result?.confidence || legacy?.confidence || null,
    knowledgeLayers,
    citations,
    externalCitations: result?.externalCitations || [],
    externalKnowledgeStatus: result?.externalKnowledgeStatus || 'not_requested',
    discussionPoints: Array.isArray(result?.discussionPoints) ? result.discussionPoints.map(String).filter(Boolean) : [],
    suggestions: Array.isArray(result?.suggestions) ? result.suggestions.map(String).filter(Boolean) : [],
    academicAssessment: result?.academicAssessment || null,
    conflicts: result?.conflicts || legacy?.conflicts || [],
    unsupportedOrUnresolved: unsupported,
    followUp: result?.followUp || '',
    requiresExternalConsent: Boolean(result?.requiresExternalConsent),
    externalResearchSpeechText: result?.externalResearchSpeechText || buildExternalResearchSpeech(result?.externalCitations || []),
    ingestionWarnings: result?.ingestionWarnings || result?.warnings || [],
    sourceDigestStatus: result?.sourceDigestStatus || ''
  };
}

function renderApprovedAnswer(result) {
  const options = arguments[1] || {};
  const { speakAnswer = true } = options;
  const approved = normalizeApprovedAnswerResult(result);
  const layersMarkup = renderKnowledgeLayers(approved.knowledgeLayers);
  const confidence = approved.confidence ? `<span class="confidence">Confidence: ${escapeHtml(approved.confidence)}</span>` : '';
  const warnings = [];
  if (approved.sourceDigestStatus) warnings.push(approved.sourceDigestStatus);
  if (approved.requiresExternalConsent) warnings.push('External research needs your approval before I look beyond your materials.');
  if (approved.ingestionWarnings?.length) warnings.push(...approved.ingestionWarnings);
  if (approved.unsupportedOrUnresolved?.length) warnings.push(...approved.unsupportedOrUnresolved);
  const conflictMarkup = approved.conflicts?.length
    ? approved.conflicts.map(conflict => `<div class="conflict-warning"><strong>Materials may disagree</strong><br>${escapeHtml(conflict.description || conflict.topic || String(conflict))}</div>`).join('')
    : '';
  const followUpMarkup = approved.followUp ? `<p class="follow-up-prompt"><strong>Next step:</strong> ${escapeHtml(approved.followUp)}</p>` : '';
  const discussionMarkup = approved.discussionPoints?.length
    ? `<section class="approved-answer-section"><strong>Discussion points</strong><ul>${approved.discussionPoints.map(point => `<li>${escapeHtml(point)}</li>`).join('')}</ul></section>`
    : '';
  const suggestionsMarkup = approved.suggestions?.length
    ? `<section class="approved-answer-section"><strong>Suggestions</strong><ul>${approved.suggestions.map(suggestion => `<li>${escapeHtml(suggestion)}</li>`).join('')}</ul></section>`
    : '';
  const academicAssessmentMarkup = approved.knowledgeLayers.includes('source') && approved.academicAssessment?.rationale
    ? `<p class="approved-answer-note"><strong>Relevant to your question:</strong> ${escapeHtml(approved.academicAssessment.rationale)}</p>`
    : '';
  const warningMarkup = warnings.length ? `<div class="approved-answer-warnings">${warnings.map(warning => `<p class="muted">${escapeHtml(warning)}</p>`).join('')}</div>` : '';
  $('#materialAnswer').classList.remove('hidden');
  const evidenceMarkup = `<div id="voiceCitations" class="answer-evidence">${renderSourceEvidenceSection(approved)}${renderLlmContextSection(approved)}${renderExternalResearchSection(approved.externalCitations, approved.externalKnowledgeStatus)}</div>`;
  $('#materialAnswer').innerHTML = `<div class="approved-answer-body"><div class="approved-answer-head"><strong>${escapeHtml(approved.knowledgeLayers.includes('source') ? 'From your materials' : 'Approved answer')}</strong>${confidence}</div><p>${escapeHtml(approved.answerText)}</p>${academicAssessmentMarkup}${discussionMarkup}${suggestionsMarkup}<div id="knowledgeLayers" class="knowledge-layers" aria-label="Knowledge layers used">${layersMarkup}</div>${warningMarkup}${conflictMarkup}${followUpMarkup}${evidenceMarkup}</div>`;
  $('#sourceDigestStatus').textContent = warnings[0] || (approved.knowledgeLayers.includes('source')
    ? 'Source digest ready for grounded answers.'
    : 'Answer used general background because no stronger source evidence was available.');
  if (approved.requiresExternalConsent) setVoiceAnnouncement('I need your approval before using external research. You can still type or continue with your materials.');
  if (speakAnswer) speakLayeredAnswer({ answerSpeechText: approved.answerSpeechText, externalResearchSpeechText: approved.externalResearchSpeechText });
  return approved;
}

const voiceCoordinator = {
  state: 'idle',
  transport: 'browser-fallback',
  active: false,
  shouldAutoResume: false,
  silenceTimeoutMs: voicePolicy.realtimeWatchdogMs,
  reconnectAttempts: 0,
  maxReconnectAttempts: 2,
  reconnectTimer: null,
  resumeTimer: null,
  completionTimer: null,
  silenceTimer: null,
  voiceSubmitTimer: null,
  pendingTranscript: null,
  captureSegments: [],
  captureCycleResults: new Map(),
  captureCycleId: null,
  captureInterim: '',
  autoSubmitDelayMs: 5000,
  runId: 0,
  failedTranscript: null,
  standaloneListening: false,
  bargeInListening: false,
  preserveUserSpeakingUntilNextResult: false,
  lastTranscriptKey: null,
  lastTurnId: null,
  start: async ({ transport = 'browser-fallback', reconnecting = false } = {}) => {
    if (!state.session) throw new Error('Start a session before using voice.');
    if (transport === 'browser-fallback' && !state.recognition) throw new Error('Speech recognition is unavailable in this browser.');
    voiceCoordinator.active = true;
    if (voiceCoordinator.standaloneListening) stopSpeechRecognition();
    voiceCoordinator.standaloneListening = false;
    voiceCoordinator.transport = transport;
    voiceCoordinator.state = reconnecting ? voiceCoordinator.state : 'permission_pending';
    voiceCoordinator.shouldAutoResume = true;
    clearVoiceSilenceTimer();
    clearVoiceAutoSubmitTimer();
    clearVoiceReconnectTimer();
    clearVoiceResumeTimer();
    clearVoiceCompletionTimer();
    emitAndApplyVoiceEvent('permission_pending', { transport });
    await api(`/api/voice/sessions/${state.session.id}/start`, { method: 'POST' }).catch(() => null);
    const microphoneAccess = await requestMicrophoneAccess({ retainStream: transport === 'realtime' });
    if (!microphoneAccess) {
      voiceCoordinator.active = false;
      throw new Error('Microphone access could not be started.');
    }
    if (transport === 'realtime') {
      await openRealtimeVoiceTransport({ reconnecting, reusableLocalStream: microphoneAccess });
    }
    await startRecordingForVoiceTransport(transport);
    voiceCoordinator.reconnectAttempts = reconnecting ? voiceCoordinator.reconnectAttempts : 0;
    if (state.session.currentQuestion && !reconnecting) {
      setLiveInputEnabled(false);
      stopSpeechRecognition();
      setVoiceConversationState('speaking');
      speak(state.session.currentQuestion, { onend: () => {
        emitAndApplyVoiceEvent('speech_ended', { questionPrompt: true });
      },
      onerror: () => emitAndApplyVoiceEvent('recoverable_error', { message: 'Question playback stopped.' })
      });
      emitAndApplyVoiceEvent('speech_started', { questionPrompt: true });
      return;
    }
    await voiceCoordinator.resume();
  },
  stop: ({ skipServer = false, preserveBrowserState = false } = {}) => {
    voiceCoordinator.runId += 1;
    voiceCoordinator.active = false;
    voiceCoordinator.shouldAutoResume = false;
    voiceCoordinator.state = 'idle';
    voiceCoordinator.lastTurnId = null;
    voiceCoordinator.lastTranscriptKey = null;
    voiceCoordinator.failedTranscript = null;
    voiceCoordinator.standaloneListening = false;
    voiceCoordinator.bargeInListening = false;
    voiceCoordinator.preserveUserSpeakingUntilNextResult = false;
    clearVoiceSilenceTimer();
    clearVoiceAutoSubmitTimer();
    clearVoiceReconnectTimer();
    clearVoiceResumeTimer();
    clearVoiceCompletionTimer();
    clearVoiceCapture();
    window.speechSynthesis?.cancel();
    stopSpeechRecognition();
    stopRecordingAndKeepBlob().catch(() => null);
    stopLiveVoice();
    if (!preserveBrowserState) setVoiceConversationState('off');
    if (!skipServer && state.session?.id) {
      api(`/api/voice/sessions/${state.session.id}/stop`, { method: 'POST' }).catch(() => null);
    }
  },
  pause: async () => {
    if (!state.session?.id) return;
    voiceCoordinator.shouldAutoResume = false;
    clearVoiceSilenceTimer();
    clearVoiceAutoSubmitTimer();
    clearVoiceResumeTimer();
    clearVoiceCompletionTimer();
    stopSpeechRecognition();
    window.speechSynthesis?.cancel();
    pauseRecording();
    await api(`/api/voice/sessions/${state.session.id}/pause`, { method: 'POST' }).catch(() => null);
    voiceCoordinator.state = 'paused';
    setVoiceConversationState('error');
    setVoiceAnnouncement('Voice conversation paused. You can still type.');
  },
  resume: async () => {
    if (!voiceCoordinator.active || !state.session?.id) return;
    clearVoiceResumeTimer();
    voiceCoordinator.shouldAutoResume = true;
    resumeRecording();
    voiceCoordinator.state = 'listening';
    if (voiceCoordinator.transport === 'browser-fallback') {
      startVoiceListening();
    } else {
      emitAndApplyVoiceEvent('listening', { transport: 'realtime' });
    }
    await api(`/api/voice/sessions/${state.session.id}/resume`, { method: 'POST' }).catch(() => null);
  },
  interrupt: async ({ bargeIn = false } = {}) => {
    clearVoiceSilenceTimer();
    clearVoiceAutoSubmitTimer();
    const preserveBrowserRecognition = bargeIn
      && voiceCoordinator.transport === 'browser-fallback'
      && Boolean(state.recognition?.started);
    voiceCoordinator.bargeInListening = false;
    window.speechSynthesis?.cancel();
    if (!preserveBrowserRecognition) stopSpeechRecognition();
    if (voiceCoordinator.transport === 'realtime' && state.dataChannel?.readyState === 'open') {
      state.dataChannel.send(JSON.stringify({ type: 'response.cancel' }));
      state.dataChannel.send(JSON.stringify({ type: 'output_audio_buffer.clear' }));
    }
    if (state.session?.id && voiceCoordinator.lastTurnId) {
      await api(`/api/voice/sessions/${state.session.id}/turns/${voiceCoordinator.lastTurnId}/interrupt`, { method: 'POST' }).catch(() => null);
    }
    if (bargeIn) {
      voiceCoordinator.state = 'listening';
      voiceCoordinator.shouldAutoResume = true;
      voiceCoordinator.preserveUserSpeakingUntilNextResult = voiceCoordinator.transport === 'browser-fallback';
      setLiveInputEnabled(true);
      setListeningState(true);
      if (!preserveBrowserRecognition && voiceCoordinator.transport === 'browser-fallback') startVoiceListening({ preserveCapture: true });
      transitionBrowserConversationState('user-speaking', {
        legacyMode: 'listening',
        announcement: 'I can hear you. Your interruption is taking priority.'
      });
    } else {
      emitAndApplyVoiceEvent('speech_ended', { interrupted: true });
    }
  },
  queueTranscript: ({ transcript, confidence, reviewed, itemKey } = {}) => {
    const trimmed = String(transcript || '').trim();
    if (!trimmed || !state.session?.id) return;
    clearVoiceAutoSubmitTimer();
    voiceCoordinator.pendingTranscript = { transcript: trimmed, confidence, reviewed, itemKey };
    setVoiceAnnouncement(`Answer captured. I will submit it after ${Math.round(voicePolicy.autoSubmitDelayMs / 1000)} seconds of silence.`);
    voiceCoordinator.scheduleTranscriptSubmission();
  },
  scheduleTranscriptSubmission: () => {
    if (voiceCoordinator.voiceSubmitTimer || !voiceCoordinator.pendingTranscript) return;
    voiceCoordinator.voiceSubmitTimer = window.setTimeout(() => {
      const pending = voiceCoordinator.pendingTranscript;
      voiceCoordinator.voiceSubmitTimer = null;
      voiceCoordinator.pendingTranscript = null;
      if (pending && (state.voiceConversation === 'listening' || voiceCoordinator.standaloneListening) && !state.voiceReviewPending) {
        const submission = voiceCoordinator.submitTranscript(pending);
        submission?.catch?.(error => notifyError(error));
        stopSpeechRecognition();
        return submission;
      }
    }, voicePolicy.autoSubmitDelayMs);
  },
  refreshTranscriptSilenceWindow: transcript => {
    const trimmed = String(transcript || '').trim();
    if (!trimmed || !voiceCoordinator.pendingTranscript) return;
    voiceCoordinator.pendingTranscript.transcript = trimmed;
    if (voiceCoordinator.voiceSubmitTimer) {
      window.clearTimeout(voiceCoordinator.voiceSubmitTimer);
      voiceCoordinator.voiceSubmitTimer = null;
    }
    setVoiceAnnouncement(`Answer captured. I will submit it after ${Math.round(voicePolicy.autoSubmitDelayMs / 1000)} seconds of silence.`);
    voiceCoordinator.scheduleTranscriptSubmission();
  },
  submitTranscript: async ({ transcript, confidence, reviewed, itemKey } = {}) => {
    clearVoiceAutoSubmitTimer();
    const trimmed = String(transcript || '').trim();
    if (!trimmed || !state.session?.id) return null;
    const transcriptKey = buildVoiceTurnKey({ transcript: trimmed, confidence, reviewed, itemKey });
    if (voiceCoordinator.lastTranscriptKey === transcriptKey) return null;
    const runId = voiceCoordinator.runId;
    voiceCoordinator.lastTranscriptKey = transcriptKey;
    emitAndApplyVoiceEvent('transcript_finalized', { transcript: trimmed, confidence, reviewed });
    $('#answerText').value = trimmed;
    $('#materialQuestion').value = trimmed;
    persistClientSession();
    const sendVoiceTurn = idempotencyKey => api(`/api/voice/sessions/${state.session.id}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        transcript: trimmed,
        transcriptConfidence: confidence,
        transcriptReviewed: reviewed,
        idempotencyKey: idempotencyKey
      })
    });
    let result;
    try {
      setVoiceAnnouncement(state.mode === 'materials'
        ? 'Retrieving relevant passages, digesting the material, and composing an academic response...'
        : 'Evaluating your answer and preparing the next question...');
      result = await sendVoiceTurn(transcriptKey);
      if (result?.requiresExternalConsent && await requestExternalResearchConsent()) {
        result = await sendVoiceTurn(`${transcriptKey}:research-approved`);
      }
    } catch (error) {
      voiceCoordinator.lastTranscriptKey = null;
      voiceCoordinator.failedTranscript = { transcript: trimmed, confidence, reviewed, itemKey };
      setVoiceConversationError('The academic voice response could not be completed yet. Your transcript is saved for retry.');
      throw error;
    }
    if (runId !== voiceCoordinator.runId) return null;
    voiceCoordinator.failedTranscript = null;
    const questionBeforeTurn = state.session.currentQuestion;
    if (result.countsAsAnswer !== false) state.session.turnCount = Number(state.session.turnCount || 0) + 1;
    state.session.status = result.done ? 'ready_to_complete' : 'active';
    voiceCoordinator.shouldAutoResume = !result.done;
    voiceCoordinator.lastTurnId = result?.turn?.id || null;
    voiceCoordinator.state = result?.nextState || 'speaking_answer';
    state.voiceReviewPending = false;
    if (result?.feedback) {
      renderFeedback(result.feedback, { speakFeedback: false });
      if (!state.transcript.some(turn => turn.question === questionBeforeTurn && turn.answer === trimmed)) {
        state.transcript.push({ question: questionBeforeTurn, answer: trimmed, feedback: result.feedback, voice: true });
        renderTranscript();
      }
    } else {
      const answer = renderApprovedAnswer(result, { speakAnswer: false });
      if (result.countsAsAnswer !== false) {
        state.materialHistory.push({ question: trimmed, answer });
        renderTranscript();
      }
    }
    if (result.followUp && !result.done) {
      state.session.currentQuestion = result.followUp;
      renderQuestion(result.followUp);
    }
    persistClientSession();
    emitAndApplyVoiceEvent('answer_approved', { answerSpeechText: result.answerSpeechText, result });
    voiceCoordinator.externalResearchSpeechText = buildExternalResearchSpeech(result.externalCitations || []);
    voiceCoordinator.speakApprovedAnswer({ answerSpeechText: result.answerSpeechText });
    return result;
  },
  speakApprovedAnswer: ({ answerSpeechText } = {}) => {
    const externalResearchSpeechText = voiceCoordinator.externalResearchSpeechText || '';
    if (!String(answerSpeechText || '').trim()) return;
    emitAndApplyVoiceEvent('speech_started', { answerSpeechText });
    if (voiceCoordinator.transport === 'realtime' && state.dataChannel?.readyState === 'open') {
      state.dataChannel.send(JSON.stringify(buildApprovedSpeechRequest(answerSpeechText, externalResearchSpeechText)));
      return;
    }
    speakLayeredAnswer({
      answerSpeechText,
      externalResearchSpeechText,
      oncomplete: () => {
        emitAndApplyVoiceEvent('speech_ended', { answerSpeechText });
        if (voiceCoordinator.standaloneListening) {
          voiceCoordinator.standaloneListening = false;
          voiceCoordinator.active = false;
          voiceCoordinator.state = 'idle';
          setVoiceConversationState('off');
        }
      }
    });
  }
};

voiceCoordinator.scheduleResume = () => {
  clearVoiceResumeTimer();
  if (!voiceCoordinator.active || !voiceCoordinator.shouldAutoResume) return;
  voiceCoordinator.resumeTimer = window.setTimeout(() => {
    voiceCoordinator.resumeTimer = null;
    voiceCoordinator.resume();
  }, voicePolicy.transitionDelayMs);
};

function renderQuestion(question) {
  $('#questionText').textContent = question;
  $('#answerText').value = '';
  const currentQuestion = state.session.turnCount + 1;
  const questionLimit = state.session.questionLimit;
  $('#progressLabel').textContent = `Question ${currentQuestion} of ${questionLimit}`;
  $('#progressBar').style.width = `${Math.min(100, (currentQuestion / questionLimit) * 100)}%`;
  $('#progressBar').setAttribute('aria-valuemax', String(questionLimit));
  $('#progressBar').setAttribute('aria-valuenow', String(Math.min(currentQuestion, questionLimit)));
}

function renderFeedback(feedback, { speakFeedback = true } = {}) {
  state.lastFeedback = feedback;
  $('#feedbackEmpty').classList.add('hidden');
  $('#feedbackContent').classList.remove('hidden');
  $('#replayFeedback').disabled = false;
  $('#feedbackTitle').textContent = feedback.scores.clarity >= 4 ? 'Strong foundation' : 'Useful starting point';
  $('#scoreList').innerHTML = Object.entries(feedback.scores).map(([key, value]) => `<div class="score-chip"><span>${escapeHtml(key)}</span><strong>${value}/5</strong></div>`).join('');
  const academicLabel = feedback.academicAssessment?.label ? feedback.academicAssessment.label.replace('_', ' ') : 'reviewed';
  $('#academicAssessment').textContent = `${academicLabel}: ${feedback.academicAssessment?.rationale || 'Your response was assessed against the question and topic.'}`;
  $('#academicResponse').textContent = feedback.academicResponse || 'Connect your main claim to the question and supporting evidence.';
  $('#strengths').innerHTML = feedback.strengths.map(item => `<div class="strength">${escapeHtml(item)}</div>`).join('');
  $('#improvement').textContent = feedback.improvement;
  $('#exampleAnswer').textContent = feedback.exampleAnswer;
  $('#evidenceText').textContent = feedback.evidence?.join(' ') || 'Your feedback is based on the answer you submitted.';
  if (speakFeedback) speak(`${feedback.strengths.join(' ')} ${feedback.improvement}`);
}

function replayFeedback() {
  if (!state.lastFeedback) return;
  speak(`${state.lastFeedback.strengths.join(' ')} ${state.lastFeedback.improvement}`);
}

function repeatLastSpokenLine() {
  if (!state.lastSpokenLine) {
    notify('No spoken line is available to repeat yet.');
    return;
  }
  speak(state.lastSpokenLine, {
    onerror: () => setVoiceAnnouncement('Spoken playback is unavailable, but the caption text is still visible.')
  });
}

function setLiveVoiceState(connected) {
  const button = $('#liveVoiceButton');
  button.textContent = connected ? 'Disconnect live AI voice' : 'Connect live AI voice';
  button.setAttribute('aria-pressed', String(connected));
}

function setListeningState(listening) {
  const button = $('#listenButton');
  button.textContent = listening ? '■ Stop listening' : '◎ Speak answer';
  button.setAttribute('aria-pressed', String(listening));
}

function setVoiceConversationState(mode) {
  transitionBrowserConversationState(browserStateFromLegacyVoiceMode(mode), { legacyMode: mode });
}

function setVoiceConversationError(message) {
  const paused = voiceCoordinator.state === 'paused';
  transitionBrowserConversationState(paused ? 'paused' : 'retryable-error', {
    legacyMode: 'error',
    announcement: `${message} You can type your answer instead.`
  });
  if (!paused) returnFocusToRecoveryControl({ preferRetry: Boolean(voiceCoordinator.failedTranscript || state.voiceReviewPending) });
}

function detectMobileBrowser() {
  const userAgent = String(navigator.userAgent || '');
  const touchMac = navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || touchMac;
}

function setBrowserAudioNote(message, busy = false) {
  const note = $('#browser-audio-note');
  if (!note) return;
  note.textContent = message;
  note.setAttribute('aria-busy', String(busy));
}

function setSpeechRecognitionPermission(status) {
  state.speechRecognitionPermission = status;
  syncVoiceAccessSetup();
}

function syncVoiceAccessSetup() {
  const panel = $('#voicePermissionSetup');
  if (!panel) return;
  state.isMobileBrowser = detectMobileBrowser();
  const supported = Boolean(state.recognition);
  const microphoneReady = state.microphonePermission === 'granted';
  const speechReady = state.speechRecognitionPermission === 'granted';
  const needsPreflight = state.isMobileBrowser && supported && (!microphoneReady || !speechReady);
  panel.classList.toggle('hidden', !needsPreflight);
  panel.setAttribute('aria-hidden', String(!needsPreflight));
  const button = $('#prepareVoiceButton');
  if (button) button.disabled = !needsPreflight || state.speechRecognitionProbe;
  if (!state.isMobileBrowser) {
    setBrowserAudioNote('Voice access will be requested when you start voice.');
  } else if (!supported) {
    setBrowserAudioNote('This browser does not provide browser speech recognition. Live AI voice can work when configured; typing remains available.');
  } else if (microphoneReady && speechReady) {
    setBrowserAudioNote('Mobile voice access is ready.');
  } else if (state.microphonePermission === 'denied') {
    setBrowserAudioNote('Allow microphone access in the browser settings, then tap Enable voice access.');
  } else if (state.speechRecognitionPermission === 'denied') {
    setBrowserAudioNote('Allow browser speech recognition when prompted, then tap Enable voice access again.');
  } else {
    setBrowserAudioNote('Allow microphone and browser speech recognition when prompted.');
  }
}

function setMicrophoneStatus(status, message = '') {
  const element = $('#microphoneStatus');
  if (!element) return;
  const copy = {
    unknown: 'Microphone status: not checked yet. Permission will be requested when you start voice conversation.',
    checking: 'Microphone status: checking access…',
    available: 'Microphone accessible. Voice input is ready.',
    denied: 'Microphone unavailable: access was denied. Allow it in the browser address bar and try again.',
    unavailable: 'Microphone unavailable: this browser could not access a microphone.'
  };
  state.microphonePermission = status === 'available'
    ? 'granted'
    : status === 'denied'
      ? 'denied'
      : status === 'unavailable'
        ? 'unavailable'
        : 'unknown';
  element.className = `microphone-status ${status}`;
  element.dataset.status = status;
  element.textContent = message || copy[status] || copy.unknown;
  syncVoiceAccessSetup();
}

function finishSpeechRecognitionProbe(success) {
  if (!state.speechRecognitionProbe && !state.speechRecognitionProbeResolve) return;
  const resolve = state.speechRecognitionProbeResolve;
  if (state.speechRecognitionProbeTimer) window.clearTimeout(state.speechRecognitionProbeTimer);
  state.speechRecognitionProbe = false;
  state.speechRecognitionProbeResolve = null;
  state.speechRecognitionProbePromise = null;
  state.speechRecognitionProbeTimer = null;
  setSpeechRecognitionPermission(success ? 'granted' : 'denied');
  resolve?.(success);
  if (success && state.recognition?.started) {
    try { state.recognition.stop(); } catch { /* Recognition may already be ending. */ }
  }
}

function primeBrowserSpeechRecognition() {
  if (!state.recognition) {
    setSpeechRecognitionPermission('unavailable');
    return Promise.resolve(false);
  }
  if (state.speechRecognitionPermission === 'granted') return Promise.resolve(true);
  if (state.speechRecognitionProbePromise) return state.speechRecognitionProbePromise;
  state.speechRecognitionProbe = true;
  state.speechRecognitionProbePromise = new Promise(resolve => {
    state.speechRecognitionProbeResolve = resolve;
    try {
      state.recognition.start();
    } catch {
      finishSpeechRecognitionProbe(false);
      return;
    }
    state.speechRecognitionProbeTimer = window.setTimeout(() => finishSpeechRecognitionProbe(false), 3000);
  });
  return state.speechRecognitionProbePromise;
}

async function prepareVoiceAccess() {
  const button = $('#prepareVoiceButton');
  if (!button) return;
  button.disabled = true;
  button.textContent = 'Checking voice accessâ€¦';
  setBrowserAudioNote('Please allow microphone and browser speech recognition if your browser asks.', true);
  const microphoneReady = await requestMicrophoneAccess();
  const speechReady = microphoneReady && await primeBrowserSpeechRecognition();
  if (microphoneReady && speechReady) {
    setBrowserAudioNote('Mobile voice access is ready. You can start a voice conversation.');
  } else if (microphoneReady && !state.recognition) {
    setBrowserAudioNote('Microphone access is ready. This browser has no browser speech recognition; use live AI voice when configured or type instead.');
  } else if (microphoneReady) {
    setBrowserAudioNote('Microphone access is ready, but browser speech recognition still needs permission.');
  } else {
    setBrowserAudioNote('Microphone access is still needed. Allow it in the browser settings and try again.');
  }
  syncVoiceAccessSetup();
  button.textContent = 'Enable voice access';
  button.disabled = false;
}

async function refreshMicrophoneStatus() {
  setMicrophoneStatus('unknown');
  if (!navigator.permissions?.query) return;
  try {
    const permission = await navigator.permissions.query({ name: 'microphone' });
    const update = () => {
      if (permission.state === 'granted') setMicrophoneStatus('available');
      else if (permission.state === 'denied') setMicrophoneStatus('denied');
      else setMicrophoneStatus('unknown');
    };
    update();
    permission.addEventListener?.('change', update);
  } catch {
    setMicrophoneStatus('unknown');
  }
}

async function requestMicrophoneAccess({ retainStream = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setVoiceConversationError('This browser cannot request microphone access.');
    setMicrophoneStatus('unavailable');
    return false;
  }
  setMicrophoneStatus('checking');
  setVoiceAnnouncement('Please allow microphone access when your browser asks.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints);
    if (!retainStream) stream.getTracks().forEach(track => track.stop());
    setMicrophoneStatus('available');
    return retainStream ? stream : true;
  } catch (error) {
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    const message = denied
      ? 'Microphone access was denied. Please allow microphone access in the browser address bar and try again.'
      : 'Microphone access could not be started.';
    setMicrophoneStatus(denied ? 'denied' : 'unavailable');
    setVoiceConversationError(message);
    return false;
  }
}

function scheduleVoiceListeningRetry(message) {
  if (state.voiceConversation !== 'listening' || state.voiceRecognitionRetryPending) return;
  if (state.voiceRecognitionAttempts >= voicePolicy.maxRecognitionRetries) {
    setVoiceConversationError('I could not hear a complete answer after several attempts.');
    return;
  }
  state.voiceRecognitionRetryPending = true;
  const preserveCapture = Boolean(voiceCoordinator.pendingTranscript || voiceCoordinator.captureSegments.length || voiceCoordinator.captureInterim);
  setVoiceAnnouncement(`${message} Listening again…`);
  window.setTimeout(() => {
    state.voiceRecognitionRetryPending = false;
    if (state.voiceConversation === 'listening') startVoiceListening({ preserveCapture });
  }, 250);
}

function scheduleVoiceRecognitionRestart(message = 'Voice input paused.') {
  if (state.voiceConversation !== 'listening' || state.voiceRecognitionRetryPending) return;
  state.voiceRecognitionRetryPending = true;
  const preserveCapture = Boolean(voiceCoordinator.pendingTranscript || voiceCoordinator.captureSegments.length || voiceCoordinator.captureInterim);
  setVoiceAnnouncement(`${message} Listening again…`);
  window.setTimeout(() => {
    state.voiceRecognitionRetryPending = false;
    if (state.voiceConversation === 'listening') startVoiceListening({ preserveCapture });
  }, 250);
}

function startBargeInListening() {
  if (!state.recognition || !voiceCoordinator.active || state.voiceConversation !== 'speaking') return;
  if (voiceCoordinator.bargeInListening) return;
  clearVoiceCapture();
  voiceCoordinator.bargeInListening = true;
  try {
    state.recognition.start();
  } catch {
    voiceCoordinator.bargeInListening = false;
  }
}

function startVoiceListening({ preserveCapture = false } = {}) {
  if (!state.recognition || state.voiceConversation === 'off') return;
  if (state.recognitionActive) return;
  if (!preserveCapture) clearVoiceCapture();
  emitAndApplyVoiceEvent('listening', { transport: 'browser-fallback' });
  try {
    state.recognition.start();
  } catch {
    setVoiceConversationError('Voice input could not start.');
  }
}

async function startStandaloneListening({ preserveCapture = false } = {}) {
  if (!state.recognition) {
    setVoiceConversationError('Speech recognition is unavailable in this browser.');
    return;
  }
  if (voiceCoordinator.active) return;
  clearVoiceResumeTimer();
  voiceCoordinator.standaloneListening = true;
  if (!preserveCapture && !await requestMicrophoneAccess()) {
    voiceCoordinator.standaloneListening = false;
    return;
  }
  if (voiceCoordinator.active || state.voiceConversation !== 'off') {
    voiceCoordinator.standaloneListening = false;
    return;
  }
  setVoiceAnnouncement('Listening… speak naturally, then pause.');
  try {
    state.recognition.start();
  } catch {
    voiceCoordinator.standaloneListening = false;
    setVoiceConversationError('Voice input could not start.');
  }
}

function speakQuestionAndListen(question) {
  speak(question, {
    onend: () => { startStandaloneListening().catch(notifyError); },
    onerror: () => setVoiceAnnouncement('Question playback stopped. You can use Speak answer or type instead.')
  });
}

async function startVoiceConversation() {
  state.voiceRecognitionAttempts = 0;
  state.voiceRecognitionRetryPending = false;
  try {
    // Mobile browser speech support is inconsistent across Safari, Firefox,
    // and Chromium variants. When the server has Realtime configured, prefer
    // the same WebRTC voice path on mobile instead of selecting a browser by
    // user-agent or SpeechRecognition implementation details.
    if (state.isMobileBrowser || !state.recognition) await loadServiceStatus();
    const preferRealtime = state.realtimeConfigured && (state.isMobileBrowser || !state.recognition);
    const transport = preferRealtime ? 'realtime' : 'browser-fallback';
    await voiceCoordinator.start({ transport });
  } catch (error) {
    setVoiceConversationError(error.message || 'Voice input could not start.');
  }
}

function stopVoiceConversation() {
  voiceCoordinator.stop();
  state.voiceSubmissionKey = null;
  state.voiceRecognitionAttempts = 0;
  state.voiceRecognitionRetryPending = false;
}

function stopVoiceConversationPreservingBrowserState() {
  voiceCoordinator.stop({ preserveBrowserState: true });
  state.voiceSubmissionKey = null;
  state.voiceRecognitionAttempts = 0;
  state.voiceRecognitionRetryPending = false;
}

function renderTranscript() {
  const list = $('#transcriptList');
  const turnMarkup = state.transcript.map((turn, index) => `<article class="transcript-turn"><div class="transcript-label">Question ${index + 1}</div><p class="transcript-question">${escapeHtml(turn.question)}</p><div class="transcript-label">Your answer</div><p>${escapeHtml(turn.answer)}</p>${turn.voice ? '' : `<details><summary>Coaching notes</summary><div class="transcript-strengths">${turn.feedback.strengths.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div><p><strong>Try next:</strong> ${escapeHtml(turn.feedback.improvement)}</p><details class="transcript-evidence"><summary>Why this feedback?</summary><p>${escapeHtml(turn.feedback.evidence?.join(' ') || 'Your feedback is based on the answer you submitted.')}</p></details></details>`}</article>`);
  const materialMarkup = state.materialHistory.map((item, index) => `<article class="transcript-turn material-review"><div class="transcript-label">Materials Q&amp;A ${index + 1}</div><p class="transcript-question">${escapeHtml(item.question)}</p><div class="transcript-label">Answer from materials</div><p>${escapeHtml(item.answer.answer)}</p>${(item.answer.sourceGroundedClaims || []).map(claim => `<details class="transcript-evidence"><summary>Supporting evidence from ${escapeHtml(claim.sourceName)}</summary><p>${escapeHtml(claim.evidence)}</p></details>`).join('')}</article>`);
  list.innerHTML = [...turnMarkup, ...materialMarkup].join('');
  $('#transcriptPanel').classList.toggle('hidden', state.transcript.length === 0 && state.materialHistory.length === 0);
}

function transcriptText() {
  const summaryText = state.summary ? [
    `Session: ${state.session?.topic || 'deepchat2learn coaching'}`,
    `Completed answers: ${state.summary.completedTurns}`,
    `Turn count: ${state.summary.turnCount ?? state.summary.completedTurns ?? 0}`,
    `Learned concepts: ${(state.summary.learnedConcepts || []).join('; ') || 'None recorded'}`,
    `Unresolved questions: ${(state.summary.unresolvedQuestions || []).join('; ') || 'None recorded'}`,
    'Overall scores:',
    ...Object.entries(state.summary.overallScores || {}).map(([key, value]) => `- ${key}: ${value ?? '—'}`),
    `Recurring strengths: ${(state.summary.recurringStrengths || []).join('; ') || 'None recorded'}`,
    `Recurring gaps: ${(state.summary.recurringGaps || []).join('; ') || 'None recorded'}`,
    `Materials used: ${state.summary.sourceCount ? `${state.summary.sourceCount} source${state.summary.sourceCount === 1 ? '' : 's'}: ${(state.summary.sourceNames || []).join(', ')}` : 'None'}`,
    `Next steps: ${(state.summary.nextSteps || []).join('; ') || 'None recorded'}`,
    `Next practice: ${state.summary.nextPractice}`
  ].join('\n') : '';
  const turnsText = state.transcript.map((turn, index) => [`Question ${index + 1}: ${turn.question}`, `Your answer: ${turn.answer}`, 'Strengths:', ...turn.feedback.strengths.map(item => `- ${item}`), `Try next: ${turn.feedback.improvement}`, `Why this feedback: ${turn.feedback.evidence?.join(' ') || 'Based on the answer you submitted.'}`].join('\n')).join('\n\n');
  const materialsText = state.materialHistory.map((item, index) => {
    const citations = (item.answer.sourceGroundedClaims || []).map(claim => {
      const locator = claim.locator?.type === 'character' && Number.isInteger(claim.locator.start) && Number.isInteger(claim.locator.end)
        ? ` [Text position: ${claim.locator.start + 1}-${claim.locator.end}]`
        : '';
      return `- ${claim.sourceName}${locator}: ${claim.evidence}`;
    }).join('\n');
    return [`Materials Q&A: ${index + 1}`, `Question: ${item.question}`, `Answer: ${item.answer.answer}`, citations ? `Supporting evidence:\n${citations}` : ''].filter(Boolean).join('\n');
  }).join('\n\n');
  return [summaryText, turnsText, materialsText].filter(Boolean).join('\n\n');
}

function copyTextWithFallback(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand?.('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard unavailable');
}

async function copyTranscript() {
  if (!state.transcript.length && !state.materialHistory.length) return;
  const text = transcriptText();
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else copyTextWithFallback(text);
    $('#transcriptStatus').textContent = 'Session review copied.';
  } catch {
    $('#transcriptStatus').textContent = 'Copy is unavailable in this browser.';
  }
}

function downloadTranscript() {
  if (!state.transcript.length && !state.materialHistory.length) return;
  const blob = new Blob([transcriptText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'deepchat2learn-session-review.txt';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  $('#summaryStatus').textContent = 'Session review downloaded.';
}

function hasUnsubmittedAnswer() {
  return Boolean(state.session && !$('#sessionView').classList.contains('hidden') && $('#answerText').value.trim());
}

function hasUnsubmittedMaterialsDraft() {
  return Boolean(state.session && !$('#sessionView').classList.contains('hidden') && ($('#additionalSourceFile').files?.length || $('#additionalSourceText').value.trim()));
}

function confirmLeavingWithDraft() {
  const warnings = [];
  if (hasUnsubmittedAnswer()) warnings.push('You have an unsent answer.');
  if (hasUnsubmittedMaterialsDraft()) warnings.push('You have source material waiting to be added.');
  if (!warnings.length) return true;
  return window.confirm(`${warnings.join(' ')} Leave without saving this work?`);
}

function setAnswerProcessing(submitting) {
  const button = $('#submitAnswer');
  button.disabled = submitting;
  button.setAttribute('aria-busy', String(submitting));
  button.innerHTML = submitting ? 'Reviewing your answer…' : 'Submit answer <span aria-hidden="true">→</span>';
  $('#answerText').disabled = submitting;
  setVoiceAnnouncement(submitting ? 'Reviewing your answer…' : '');
}

function setStartProcessing(processing) {
  const form = $('#setupForm');
  const button = form.querySelector('button[type="submit"]');
  form.setAttribute('aria-busy', String(processing));
  button.disabled = processing;
  button.setAttribute('aria-busy', String(processing));
  button.innerHTML = processing ? 'Preparing your session...' : 'Start conversation <span aria-hidden="true">→</span>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}

function digestMarkup(digest, sourceName = '') {
  let html = `<strong>${escapeHtml(sourceName || (digest.mode === 'model' ? 'AI digest' : 'Quick digest'))}</strong>${sourceName ? `<span class="digest-type">${digest.mode === 'model' ? 'AI digest' : 'Quick digest'}</span>` : ''}<p>${escapeHtml(digest.digestText || 'A digest is not available yet.')}</p>`;
  if (digest.keyPoints?.length) html += `<strong>Key points</strong><ul class="digest-list">${digest.keyPoints.map(point => {
    const locator = point.locator?.type === 'character' && Number.isInteger(point.locator.start) && Number.isInteger(point.locator.end)
      ? `<span class="digest-locator">Text position: ${point.locator.start + 1}–${point.locator.end}</span>`
      : '';
    return `<li>${escapeHtml(point.text || point)}${point.evidence ? `<details class="digest-evidence"><summary>Show supporting excerpt</summary>${locator ? `<p class="digest-locator-line">${locator}</p>` : ''}<p>${escapeHtml(point.evidence)}</p></details>` : ''}</li>`;
  }).join('')}</ul>`;
  if (digest.openQuestions?.length) html += `<strong>Open questions</strong><ul class="digest-list">${digest.openQuestions.map(question => `<li>${escapeHtml(question)}</li>`).join('')}</ul>`;
  return html;
}

function renderDigest(digest) {
  $('#sourceDigest').innerHTML = digestMarkup(digest);
}

function renderSourceDigests(sources) {
  const digests = sources.filter(source => source.digest);
  $('#sourceDigest').innerHTML = digests.length
    ? digests.map(source => `<section class="source-digest"><div class="digest-box">${digestMarkup(source.digest, source.name)}</div></section>`).join('')
    : '';
}

function sourceCountLabel(sources) {
  return `${sources.length} source${sources.length === 1 ? '' : 's'}`;
}

function clearSourceProcessingTimers() {
  sourceProcessingTimers.forEach(timer => window.clearTimeout(timer));
  sourceProcessingTimers = [];
}

function sourceReadyForGroundedAnswers(source, digestStatus = state.session?.digestStatus) {
  return digestStatus === 'ready' && source?.status === 'ready';
}

function friendlySourceStatus(source) {
  return {
    uploaded: 'Uploaded',
    extracting: 'Extracting',
    digesting: 'Digesting',
    ready: 'Ready',
    failed: 'Needs attention'
  }[source?.status] || 'Ready';
}

function friendlyExtractionMethod(source) {
  const method = source?.metrics?.extractionMethod || source?.metadata?.extractionMethod || '';
  if (method === 'python-enhanced') return 'Enhanced PDF extraction';
  if (method === 'node-fallback') return 'Standard PDF extraction';
  if (method === 'docx-text') return 'DOCX text extraction';
  return 'Direct text import';
}

function sourceCoverageSummary(source) {
  const metrics = source?.metrics || {};
  return [
    metrics.pages ? `${metrics.pages} page${metrics.pages === 1 ? '' : 's'}` : null,
    metrics.words ? `${metrics.words} word${metrics.words === 1 ? '' : 's'}` : null,
    Number.isInteger(metrics.tableCount) && metrics.tableCount > 0 ? `${metrics.tableCount} table${metrics.tableCount === 1 ? '' : 's'}` : null,
    Number.isInteger(metrics.figureCount) && metrics.figureCount > 0 ? `${metrics.figureCount} figure${metrics.figureCount === 1 ? '' : 's'}` : null,
    Number.isInteger(metrics.captionCount) && metrics.captionCount > 0 ? `${metrics.captionCount} caption${metrics.captionCount === 1 ? '' : 's'}` : null,
    friendlyExtractionMethod(source)
  ].filter(Boolean).join(' · ');
}

function sourceWarningsMarkup(source) {
  const warnings = Array.isArray(source?.warnings) ? source.warnings : [];
  if (!warnings.length) return '';
  return `<div class="source-warning-list">${warnings.map(warning => `<p>${escapeHtml(warning)}</p>`).join('')}</div>`;
}

async function queueDigestBuild() {
  if (!state.session?.id || sourceDigestRequest) return sourceDigestRequest;
  sourceDigestRequest = api(`/api/sessions/${state.session.id}/sources/digest`, {
    method: 'POST',
    body: JSON.stringify({})
  })
    .then(() => refreshSources())
    .catch(() => {
      $('#sourceDigestStatus').textContent = 'Materials are attached, but digesting did not finish cleanly.';
    })
    .finally(() => {
      sourceDigestRequest = null;
    });
  return sourceDigestRequest;
}

function maxSourceFiles() {
  return Number(state.sourceLimits?.maxFiles) > 0 ? Number(state.sourceLimits.maxFiles) : 10;
}

function setSourceProcessing(processing) {
  clearSourceProcessingTimers();
  const atLimit = Number(state.session?.sourceCount || 0) >= maxSourceFiles();
  $('#additionalSourceFile').disabled = processing || atLimit;
  $('#additionalSourceName').disabled = processing || atLimit;
  $('#additionalSourceText').disabled = processing || atLimit;
  $('#addSourceButton').disabled = processing || atLimit;
  $('#addSourceButton').setAttribute('aria-busy', String(processing));
  $('#addSourceButton').textContent = processing ? 'Adding source...' : 'Add source';
  if (processing) {
    $('#additionalSourceStatus').textContent = 'Validating your upload...';
    $('#sourceDigestStatus').textContent = 'Validating your upload...';
    sourceProcessingTimers.push(window.setTimeout(() => { $('#additionalSourceStatus').textContent = 'Extracting readable text and counts...'; }, 350));
    sourceProcessingTimers.push(window.setTimeout(() => { $('#sourceDigestStatus').textContent = 'Digesting your materials in the background...'; }, 800));
  }
}

function setSourceRemovalProcessing(processing) {
  document.querySelectorAll('.source-remove').forEach(button => {
    button.disabled = processing;
    button.setAttribute('aria-busy', String(processing));
    button.textContent = processing ? 'Removing...' : 'Remove';
  });
  if (processing) $('#additionalSourceStatus').textContent = 'Removing source...';
  if (!processing && $('#additionalSourceStatus').textContent === 'Removing source...') {
    $('#additionalSourceStatus').textContent = 'Source removal could not be completed.';
  }
}

function renderSourceCount(sources) {
  const label = sourceCountLabel(sources);
  const digestStatus = state.session?.digestStatus || 'queued';
  const pending = sources.some(source => !sourceReadyForGroundedAnswers(source, digestStatus));
  $('#sourceBadge').textContent = sources.length ? `${label} grounded` : 'No sources yet';
  const sourceOption = $('#materialMode').querySelector('option[value="source"]');
  sourceOption.disabled = !sources.length;
  if (!sources.length && $('#materialMode').value === 'source') $('#materialMode').value = 'general';
  const atLimit = sources.length >= maxSourceFiles();
  $('#additionalSourceFile').disabled = atLimit;
  $('#additionalSourceName').disabled = atLimit;
  $('#additionalSourceText').disabled = atLimit;
  $('#addSourceButton').disabled = atLimit;
  $('#additionalSourceStatus').textContent = atLimit
    ? `${maxSourceFiles()} sources attached. Remove one to add another.`
    : sources.length ? `${label} attached. You can keep chatting while new materials finish processing.` : 'No materials added yet.';
  $('#sourceDigestStatus').textContent = sources.length
    ? pending
      ? `${label} uploaded. Source materials are processing. Grounded answers are not ready yet, but you can keep typing or speaking.`
      : `${label} ready and available for source-grounded questions.`
    : 'Add materials to prepare source-grounded answers.';
}

function renderSkillProfileStatus(session = state.session) {
  const status = $('#skillProfileStatus');
  if (!status || !session || session.sourceMode !== 'source') return;
  const active = session.activeSkillId || 'none';
  const requested = session.skillId || 'auto';
  if (active === 'epi-research') {
    status.textContent = requested === 'auto'
      ? 'Active digest lens: Epidemiology methods critique (selected automatically). Live dialogue uses academic conversation.'
      : 'Active digest lens: Epidemiology methods critique. Live dialogue uses academic conversation.';
  } else if (active === 'academic-research') {
    status.textContent = requested === 'auto'
      ? 'Active digest lens: Academic research digest (selected automatically). Live dialogue uses academic conversation.'
      : 'Active digest lens: Academic research digest. Live dialogue uses academic conversation.';
  } else if (requested === 'none') {
    status.textContent = 'Active digest lens: None. Live dialogue still uses academic conversation.';
  } else {
    status.textContent = 'Active digest lens: General source discussion. Live dialogue uses academic conversation.';
  }
}

function renderSources(sources) {
  $('#sourceList').innerHTML = sources.length
    ? sources.map(source => `<div class="source-row"><span><strong>${escapeHtml(source.name)}</strong><small>${source.characters} characters · ${escapeHtml(source.digestStatus || 'queued')}</small></span><button type="button" class="quiet-button source-remove" aria-label="Remove ${escapeHtml(source.name)}" data-source-id="${escapeHtml(source.id)}">Remove</button></div>`).join('')
    : '<p class="help source-empty">No materials added yet. Add a file below to ask source-grounded questions.</p>';
  renderSourceCount(sources);
  renderSkillProfileStatus();
  $('#materialsPanel').classList.toggle('hidden', state.session?.sourceMode !== 'source');
  $('#sourceQuestionButton').classList.toggle('hidden', !sources.length || state.session?.sourceMode !== 'source');
}

function renderSourcesLifecycle(sources) {
  $('#sourceList').innerHTML = sources.length
    ? sources.map(source => `<div class="source-row source-row-${escapeHtml(source.status || 'ready')}"><div class="source-row-main"><div><strong>${escapeHtml(source.name)}</strong><small>${escapeHtml(friendlySourceStatus(source))} · ${escapeHtml(sourceCoverageSummary(source))}</small></div>${sourceWarningsMarkup(source)}</div><button type="button" class="quiet-button source-remove" aria-label="Remove ${escapeHtml(source.name)}" data-source-id="${escapeHtml(source.id)}">Remove</button></div>`).join('')
    : '<p class="help source-empty">No materials added yet. Add a file below to ask source-grounded questions.</p>';
  renderSourceCount(sources);
  renderSkillProfileStatus();
  $('#materialsPanel').classList.toggle('hidden', state.session?.sourceMode !== 'source');
  $('#sourceQuestionButton').classList.toggle('hidden', !sources.length || state.session?.sourceMode !== 'source');
}

async function refreshSources() {
  const result = await api(`/api/sessions/${state.session.id}/sources`);
  state.session.sourceCount = result.sources.length;
  state.session.digestStatus = result.digestStatus || (result.sources.length ? 'queued' : null);
  if (result.skillId !== undefined) state.session.skillId = result.skillId;
  if (result.activeSkillId !== undefined) state.session.activeSkillId = result.activeSkillId;
  if (result.skillSelectionReason !== undefined) state.session.skillSelectionReason = result.skillSelectionReason;
  renderSourcesLifecycle(result.sources);
  renderSourceDigests(result.sources);
  const pending = result.sources.some(source => !sourceReadyForGroundedAnswers(source, state.session.digestStatus));
  const warnings = [...(result.digestWarnings || []), ...result.sources.flatMap(source => source.warnings || [])];
  if (warnings.length) $('#sourceDigestStatus').textContent = warnings.join(' ');
  else if (pending) {
    $('#sourceDigestStatus').textContent = 'Source materials are processing. Grounded answers are not ready yet. You can keep typing or speaking while I finish the digest.';
    queueDigestBuild().catch(() => null);
  }
  return result.sources;
}

function setSourceQuestionProcessing(processing) {
  const button = $('#sourceQuestionButton');
  button.disabled = processing;
  button.setAttribute('aria-busy', String(processing));
  button.textContent = processing ? 'Generating source question...' : 'Ask from my materials';
  if (processing) setVoiceAnnouncement('Generating a question from your materials...');
}

async function askSourceQuestion() {
  const button = $('#sourceQuestionButton');
  if (button.disabled) return;
  setSourceQuestionProcessing(true);
  try {
    const result = await api(`/api/sessions/${state.session.id}/source-prompts`, { method: 'POST', body: JSON.stringify({}) });
    state.session.currentQuestion = result.question;
    renderQuestion(result.question);
    setVoiceAnnouncement('This question is based on your supplied materials.');
    speakQuestionAndListen(result.question);
  } catch (error) {
    if (!error?.handled) setVoiceAnnouncement('I could not create a materials question. Try again.');
    notifyError(error);
  }
  finally { setSourceQuestionProcessing(false); }
}

async function startSession(event) {
  event.preventDefault();
  const startButton = $('#setupForm button[type="submit"]');
  if (startButton.disabled) return;
  setStartProcessing(true);
  const topic = $('#topic').value.trim();
  try {
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ topic, goal: $('#goal').value, difficulty: $('#difficulty').value, feedbackStyle: $('#feedbackStyle').value, questionLimit: Number($('#questionLimit').value), sourceMode: state.mode === 'materials' ? 'source' : 'none', skillId: state.mode === 'materials' ? ($('#skillProfile')?.value || 'auto') : 'none', retentionMode: $('#retentionMode').value }) });
    state.session = created.session;
    state.token = created.token;
    const sourceText = $('#sourceText').value.trim();
    const sourcePayload = sourceText
      ? { name: $('#sourceName').value.trim() || 'pasted-materials.txt', text: sourceText }
      : state.pendingSource;
    let firstQuestion = created.question;
    if (state.mode === 'materials') {
      $('#materialsPanel').classList.remove('hidden');
      if (sourcePayload) {
        const uploaded = await api(`/api/sessions/${state.session.id}/sources`, { method: 'POST', body: JSON.stringify(sourcePayload) });
        if (uploaded.source.warnings?.length) $('#sourceStatus').textContent = uploaded.source.warnings.join(' ');
      }
      await refreshSources();
      if (sourcePayload) {
        const prompt = await api(`/api/sessions/${state.session.id}/source-prompts`, { method: 'POST', body: JSON.stringify({}) });
        firstQuestion = prompt.question;
        state.session.currentQuestion = firstQuestion;
      }
    }
    $('#sessionTopic').textContent = topic;
    renderQuestion(firstQuestion);
    show('sessionView');
    persistClientSession();
    await startVoiceConversation();
  } catch (error) {
    await discardFailedSession();
    state.session = null;
    state.token = null;
    clearClientSession();
    notifyError(error);
  }
  finally { setStartProcessing(false); }
}

async function readSourceFile(file) {
  const accepted = /\.(pdf|docx|txt|md)$/i.test(file.name) || ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown'].includes(file.type);
  if (!accepted) throw new Error('Choose a PDF, DOCX, TXT, or Markdown file.');
  const maxFileBytes = Number(state.sourceLimits?.maxFileBytes) > 0 ? Number(state.sourceLimits.maxFileBytes) : 20_000_000;
  if (file.size > maxFileBytes) throw new Error(`This deployment accepts source files up to ${Math.max(1, Math.floor(maxFileBytes / 1_000_000))} MB.`);
  if (/\.(pdf|docx)$/i.test(file.name) || ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.type)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { name: file.name, mimeType: file.type || (/\.docx$/i.test(file.name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf'), fileBase64: btoa(binary) };
  }
  return { name: file.name, mimeType: file.type || 'text/plain', text: (await file.text()).trim() };
}

async function loadSourceFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const sourceName = $('#sourceName');
  try {
    const payload = await readSourceFile(file);
    if (payload.fileBase64) {
      state.pendingSource = payload;
      $('#sourceText').value = '';
      $('#sourceStatus').textContent = `${file.name} ready. Text will be extracted when you start.`;
    } else {
      $('#sourceText').value = payload.text;
      state.pendingSource = null;
      if (!sourceName.value.trim() || sourceName.value === sourceName.dataset.autoName) sourceName.value = file.name;
      sourceName.dataset.autoName = file.name;
      $('#sourceStatus').textContent = `${file.name} loaded. You can edit the extracted text before starting.`;
    }
  } catch {
    state.pendingSource = null;
    $('#sourceFile').value = '';
    sourceName.dataset.autoName = '';
    $('#sourceStatus').textContent = 'The file could not be read. Paste the material instead.';
    notify('The file could not be read. Paste the material instead.');
  }
}

async function addAdditionalSource() {
  const file = $('#additionalSourceFile').files?.[0];
  const additionalText = $('#additionalSourceText').value.trim();
  if (!file && !additionalText) return notify('Choose a source file or paste source material to add.');
  setSourceProcessing(true);
  try {
    const payload = file
      ? await readSourceFile(file)
      : { name: $('#additionalSourceName').value.trim() || `pasted-materials-${(state.session.sourceCount || 0) + 1}.txt`, text: additionalText };
    const name = payload.name;
    const upload = await api(`/api/sessions/${state.session.id}/sources`, { method: 'POST', body: JSON.stringify({ ...payload, name }) });
    const sources = await refreshSources();
    clearSourceProcessingTimers();
    $('#additionalSourceStatus').textContent = sources.length >= maxSourceFiles()
      ? `${maxSourceFiles()} sources attached. Remove one to add another.`
      : `${name} added. ${friendlySourceStatus(upload.source)} · ${sourceCoverageSummary(upload.source)}.`;
    $('#additionalSourceFile').value = '';
    $('#additionalSourceName').value = '';
    $('#additionalSourceText').value = '';
    persistClientSession();
  } catch (error) {
    if (!error?.handled) $('#additionalSourceStatus').textContent = 'I could not add that source. Try again.';
    notifyError(error);
  }
  finally { setSourceProcessing(false); }
}

function sendLiveResponse(instructions) {
  if (state.dataChannel?.readyState !== 'open') return;
  state.dataChannel.send(JSON.stringify({ type: 'response.create', response: { instructions } }));
}

function normalizeRealtimeClientEvent(message) {
  if (!message || typeof message !== 'object') return null;
  if (['conversation.item.input_audio_transcription.completed', 'deepchat2learn.turn.finalized'].includes(message.type) && message.transcript?.trim()) {
    return { type: 'transcript_finalized', transcript: message.transcript.trim(), itemId: message.item_id || null };
  }
  if (message.type === 'deepchat2learn.answer.approved' && message.answerSpeechText?.trim()) {
    return {
      type: 'answer_approved',
      answerSpeechText: message.answerSpeechText.trim(),
      ...(message.externalResearchSpeechText?.trim()
        ? { externalResearchSpeechText: message.externalResearchSpeechText.trim() }
        : {})
    };
  }
  if (message.type === 'output_audio_buffer.started') return { type: 'speech_started' };
  if (message.type === 'output_audio_buffer.stopped') return { type: 'speech_ended' };
  if (message.type === 'input_audio_buffer.speech_started') return { type: 'user_speech_started' };
  if (['error', 'deepchat2learn.turn.error'].includes(message.type)) return { type: 'recoverable_error', message: message.error?.message || 'Live voice reported an error. You can continue by typing.' };
  return null;
}

async function handleVoiceTranscript(transcript, itemKey) {
  if (!transcript.trim()) return;
  const voiceInputActive = state.voiceConversation === 'listening' || voiceCoordinator.standaloneListening || voiceCoordinator.bargeInListening;
  if (!voiceInputActive || state.voiceSubmissionKey === itemKey) return;
  state.voiceSubmissionKey = itemKey;
  state.voiceRecognitionAttempts = 0;
  state.voiceRecognitionRetryPending = false;
  $('#answerText').value = transcript.trim();
  $('#materialQuestion').value = transcript.trim();
  persistClientSession();
  const reviewed = $('#reviewTranscriptToggle').checked;
  if (reviewed) {
    state.voiceReviewPending = true;
    $('#answerText').value = transcript.trim();
    $('#materialQuestion').value = transcript.trim();
    setTranscriptReviewMessage(`Review before sending is on. Edit this transcript if needed: ${transcript.trim()}`);
    setVoiceAnnouncement('Transcript ready for review before sending.');
    setVoiceConversationState('error');
    returnFocusToRecoveryControl();
    return;
  }
  if (voiceCoordinator.transport === 'realtime') {
    await voiceCoordinator.submitTranscript({ transcript, confidence: null, reviewed: false, itemKey });
  } else {
    voiceCoordinator.queueTranscript({ transcript, confidence: null, reviewed: false, itemKey });
  }
}

async function handleRecognitionResult(event) {
  const capture = collectVoiceRecognitionText(event);
  const transcript = capture.transcript;
  if (!transcript) return;
  if (state.voiceConversation === 'speaking' && voiceCoordinator.bargeInListening) await voiceCoordinator.interrupt({ bargeIn: true });
  if (state.voiceConversation === 'speaking') return;
  if (state.voiceConversation === 'listening' || voiceCoordinator.standaloneListening) {
    if (capture.hasFinal) {
      voiceCoordinator.preserveUserSpeakingUntilNextResult = false;
      handleVoiceTranscript(transcript, `${state.voiceRecognitionSessionId}:${transcript}`);
    } else {
      if (state.browserConversationState === 'user-speaking' && voiceCoordinator.preserveUserSpeakingUntilNextResult) {
        voiceCoordinator.preserveUserSpeakingUntilNextResult = false;
      } else if (state.browserConversationState === 'user-speaking') {
        transitionBrowserConversationState('listening', {
          legacyMode: 'listening',
          announcement: 'Listening… speak naturally. I will keep listening until you pause.'
        });
      }
      voiceCoordinator.refreshTranscriptSilenceWindow(transcript);
    }
  } else {
    $('#answerText').value = `${$('#answerText').value} ${transcript}`.trim();
  }
}

async function submitAnswer({ voice = false, answer: submittedAnswer } = {}) {
  voice = voice || Boolean(state.voiceReviewPending && state.peer);
  if ($('#submitAnswer').disabled) return;
  const answer = (submittedAnswer || $('#answerText').value).trim();
  if (!answer) return notify('Add an answer before submitting.');
  const question = state.session.currentQuestion;
  setAnswerProcessing(true);
  try {
    const result = await api(`/api/sessions/${state.session.id}/turns`, { method: 'POST', headers: { 'idempotency-key': `turn-${state.session.turnCount}` }, body: JSON.stringify({ answer }) });
    renderFeedback(result.feedback, { speakFeedback: !voice });
    if (!state.transcript.some(turn => turn.question === question && turn.answer === answer)) {
      state.transcript.push({ question, answer, feedback: result.feedback });
      renderTranscript();
    }
    state.voiceReviewPending = false;
    state.session.turnCount += 1;
    state.session.status = result.done ? 'ready_to_complete' : 'active';
    if (voice) {
      const spoken = result.feedback.answerSpeechText || [
        result.feedback.academicResponse,
        `One useful next step: ${result.feedback.improvement}`,
        result.nextQuestion ? `Next question: ${result.nextQuestion}` : ''
      ].filter(Boolean).join(' ');
      if (state.voiceConversation === 'submitting') {
        if (!result.done) {
          state.session.currentQuestion = result.nextQuestion;
          renderQuestion(result.nextQuestion);
          persistClientSession();
        }
        setVoiceConversationState('speaking');
        speak(spoken, {
          onend: () => {
            if (result.done) return completeSession().catch(notifyError);
            if (state.voiceConversation === 'speaking') speak(result.nextQuestion, { onend: () => startVoiceListening(), onerror: () => setVoiceConversationState('error') });
          },
          onerror: () => setVoiceConversationState('error')
        });
      } else {
        sendLiveResponse(spoken);
        persistClientSession();
        if (result.done) await completeSession();
        else { state.session.currentQuestion = result.nextQuestion; renderQuestion(result.nextQuestion); persistClientSession(); }
      }
    } else if (result.done) await completeSession();
    else { state.session.currentQuestion = result.nextQuestion; renderQuestion(result.nextQuestion); persistClientSession(); }
  } catch (error) {
    if (state.voiceConversation === 'submitting') setVoiceConversationState('error');
    notifyError(error);
  }
  finally { setAnswerProcessing(false); }
}

function setMaterialQuestionProcessing(processing) {
  const form = $('#materialQuestionForm');
  const button = $('#askQuestion');
  form.setAttribute('aria-busy', String(processing));
  $('#materialMode').disabled = processing;
  $('#materialQuestion').disabled = processing;
  button.disabled = processing;
  button.setAttribute('aria-busy', String(processing));
  button.textContent = processing ? 'Thinking...' : 'Ask';
  $('#materialAnswer').setAttribute('aria-busy', String(processing));
  if (processing) $('#materialAnswer').textContent = 'Thinking about your materials...';
}

async function askMaterialQuestion() {
  const question = $('#materialQuestion').value.trim();
  if (!question) return notify('Enter a question about your materials.');
  if ($('#askQuestion').disabled) return;
  setMaterialQuestionProcessing(true);
  try {
    const mode = $('#materialMode').value;
    const fetchAnswer = () => api(`/api/sessions/${state.session.id}/questions`, { method: 'POST', body: JSON.stringify({ mode, question }) });
    let answer = await fetchAnswer();
    if (answer?.requiresExternalConsent && await requestExternalResearchConsent()) {
      answer = await fetchAnswer();
    }
    const approved = renderApprovedAnswer(answer);
    state.materialHistory.push({ question, answer: approved });
    persistClientSession();
  } catch (error) {
    $('#materialAnswer').textContent = 'I could not answer that right now. Try again.';
    notifyError(error);
  }
  finally { setMaterialQuestionProcessing(false); }
}

async function requestExternalResearchConsent() {
  if (!state.session?.id) return false;
  const wantsResearch = window.confirm('Would you like me to add one-time external research for this question?');
  if (!wantsResearch) return false;
  await api(`/api/sessions/${state.session.id}/research-consent`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  return true;
}

async function retryVoiceAction() {
  if (state.voiceReviewPending) {
    const transcript = ($('#materialQuestion').value || $('#answerText').value).trim();
    if (!transcript) {
      notify('Add or restore a transcript before retrying.');
      return;
    }
    state.voiceReviewPending = false;
    setTranscriptReviewMessage(`Sending reviewed transcript: ${transcript}`);
    await voiceCoordinator.submitTranscript({ transcript, confidence: null, reviewed: true });
    return;
  }
  if (voiceCoordinator.failedTranscript) {
    await voiceCoordinator.submitTranscript(voiceCoordinator.failedTranscript);
    return;
  }
  if (voiceCoordinator.active) {
    setVoiceAnnouncement('Retrying the voice step.');
    await voiceCoordinator.resume();
    return;
  }
  await startVoiceConversation();
}

async function discardFailedSession() {
  const sessionId = state.session?.id;
  const token = state.token;
  if (!sessionId || !token) return;
  try {
    await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-session-token': token } });
  } catch { /* Best-effort cleanup after a partial session setup failure. */ }
}

function setLiveInputEnabled(enabled) {
  state.localStream?.getTracks().forEach(track => { track.enabled = Boolean(enabled); });
}

function stopLiveVoice({ intentional = true, preserveLocalStream = false } = {}) {
  const dataChannel = state.dataChannel;
  const peer = state.peer;
  const localStream = state.localStream;
  const remoteAudio = state.remoteAudio;
  state.peer = null;
  if (!preserveLocalStream) state.localStream = null;
  state.dataChannel = null;
  state.remoteAudio = null;
  if (intentional && dataChannel) {
    dataChannel.onopen = null;
    dataChannel.onmessage = null;
    dataChannel.onclose = null;
  }
  if (intentional && peer) {
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
  }
  dataChannel?.close();
  peer?.close();
  if (!preserveLocalStream) localStream?.getTracks().forEach(track => track.stop());
  remoteAudio?.remove();
  state.voiceReviewPending = false;
  setLiveVoiceState(false);
}

function handleRealtimeTransportMessage(message) {
  if (!message) return;
  if (message.type === 'transcript_finalized' && message.transcript) {
    const itemKey = message.itemId || buildVoiceTurnKey({ transcript: message.transcript, confidence: null, reviewed: false });
    if (message.itemId && state.processedVoiceItems.has(message.itemId)) return;
    if (message.itemId) state.processedVoiceItems.add(message.itemId);
    handleVoiceTranscript(message.transcript, itemKey);
    return;
  }
  emitAndApplyVoiceEvent(message.type, message);
}

async function openRealtimeVoiceTransport({ reconnecting = false, reusableLocalStream = null } = {}) {
  if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) throw new Error('Live voice is not supported in this browser. Use Speak answer or type instead.');
  const preserveRecordingInput = Boolean(reconnecting && recordingInputBorrowed && isRecordingActive());
  const reconnectStream = preserveRecordingInput ? state.localStream : null;
  try {
    $('#liveVoiceButton').disabled = true;
    $('#liveVoiceButton').setAttribute('aria-busy', 'true');
    setVoiceAnnouncement(reconnecting ? 'Reconnecting live AI voice…' : 'Connecting live AI voice…');
    stopLiveVoice({ preserveLocalStream: preserveRecordingInput });
    try {
      state.localStream = reconnectStream || reusableLocalStream || await navigator.mediaDevices.getUserMedia(microphoneConstraints);
      setMicrophoneStatus('available');
    } catch (error) {
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      setMicrophoneStatus(denied ? 'denied' : 'unavailable');
      throw error;
    }
    state.peer = new RTCPeerConnection();
    state.peer.ontrack = event => {
      const RemoteStreamCtor = window.MediaStream;
      const remoteStream = event.streams?.[0]
        || (RemoteStreamCtor && event.track ? new RemoteStreamCtor([event.track]) : null);
      if (!remoteStream) {
        markRecordingRemoteUnavailable('AI audio did not arrive from the live voice connection.');
        return;
      }
      if (!state.remoteAudio) {
        state.remoteAudio = document.createElement('audio');
        state.remoteAudio.autoplay = true;
        state.remoteAudio.playsInline = true;
        state.remoteAudio.setAttribute('playsinline', '');
        state.remoteAudio.setAttribute('aria-hidden', 'true');
        state.remoteAudio.className = 'voice-remote-audio';
        document.body.appendChild(state.remoteAudio);
      }
      state.remoteAudio.srcObject = remoteStream;
      tryPlayRemoteAudio();
      attachRecordingRemoteStream(remoteStream);
    };
    state.peer.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(state.peer?.connectionState)) {
        markRecordingRemoteUnavailable();
        emitAndApplyVoiceEvent('recoverable_error', { message: 'Live voice disconnected.' });
      }
    };
    state.localStream.getTracks().forEach(track => state.peer.addTrack(track, state.localStream));
    state.dataChannel = state.peer.createDataChannel('oai-events');
    state.dataChannel.onopen = () => {
      clearVoiceReconnectTimer();
      setLiveVoiceState(true);
      setVoiceAnnouncement('Live AI voice connected. You can still use the typed answer box.');
    };
    state.dataChannel.onmessage = event => {
      try {
        const raw = JSON.parse(event.data);
        if (['answer.approved', 'deepchat2learn.answer.approved'].includes(raw.type)) {
          emitAndApplyVoiceEvent('answer_approved', raw);
          voiceCoordinator.externalResearchSpeechText = raw.externalResearchSpeechText || '';
          voiceCoordinator.speakApprovedAnswer({ answerSpeechText: raw.answerSpeechText });
          return;
        }
        const message = raw.type === ['response', 'audio_transcript', 'done'].join('.')
          ? { type: 'caption_update', transcript: raw.transcript || 'Live AI voice is speaking…' }
          : normalizeRealtimeClientEvent(raw);
        if (message?.type === 'caption_update') setVoiceCaption(message.transcript);
        else handleRealtimeTransportMessage(message);
      } catch { /* Ignore non-JSON realtime events. */ }
    };
    state.dataChannel.onclose = () => emitAndApplyVoiceEvent('recoverable_error', { message: 'Live voice connection closed.' });
    const offer = await state.peer.createOffer();
    await state.peer.setLocalDescription(offer);
    const call = await api('/api/realtime/call', { method: 'POST', body: JSON.stringify({ sessionId: state.session.id, sdp: offer.sdp }) });
    await state.peer.setRemoteDescription({ type: 'answer', sdp: call.sdp });
  } catch (error) {
    stopLiveVoice({ preserveLocalStream: preserveRecordingInput });
    throw error;
  } finally { $('#liveVoiceButton').disabled = false; $('#liveVoiceButton').setAttribute('aria-busy', 'false'); }
}

function tryPlayRemoteAudio() {
  const remoteAudio = state.remoteAudio;
  if (!remoteAudio?.srcObject || typeof remoteAudio.play !== 'function') return;
  try {
    const playback = remoteAudio.play();
    playback?.catch?.(() => setVoiceAnnouncement('Live voice is connected. Tap the page once to enable audio playback.'));
  } catch {
    setVoiceAnnouncement('Live voice is connected. Tap the page once to enable audio playback.');
  }
}

async function connectLiveVoice() {
  if (voiceCoordinator.transport === 'realtime' && voiceCoordinator.active) {
    voiceCoordinator.stop();
    return;
  }
  try {
    await voiceCoordinator.start({ transport: 'realtime' });
  } catch (error) {
    stopLiveVoice();
    setVoiceAnnouncement('Live voice is unavailable. Continue by typing or use browser voice input.');
    notifyError(error);
  }
}

function setEndSessionProcessing(processing) {
  const button = $('#endSession');
  button.disabled = processing;
  button.setAttribute('aria-busy', String(processing));
  button.textContent = processing ? 'Ending session...' : 'End session';
}

function setDeleteDataProcessing(processing) {
  const button = $('#deleteData');
  button.disabled = processing;
  button.setAttribute('aria-busy', String(processing));
  button.textContent = processing ? 'Deleting session...' : 'Delete this session’s data';
}

function renderSummaryList(items, className = '') {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return '';
  return `<ul${className ? ` class="${className}"` : ''}>${values.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderSummarySection(title, items, { className = '', empty = '', formatter = null } = {}) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length && !empty) return '';
  const sectionId = `summary-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const body = values.length
    ? (formatter ? formatter(values) : renderSummaryList(values))
    : `<p class="summary-empty">${escapeHtml(empty)}</p>`;
  const classes = ['summary-section', className].filter(Boolean).join(' ');
  return `<section class="${classes}" aria-labelledby="${sectionId}"><h3 id="${sectionId}">${escapeHtml(title)}</h3>${body}</section>`;
}

function renderSourceCoverage(items) {
  return `<ul class="summary-coverage">${items.map(item => `<li><strong>${escapeHtml(item.sourceName)}</strong><span>${escapeHtml(item.note)}</span></li>`).join('')}</ul>`;
}

function renderSummary(summary) {
  const showScores = state.session?.sourceMode !== 'source';
  const scoreMarkup = showScores ? `<div class="score-grid">${Object.entries(summary.overallScores || {}).map(([key, value]) => `<div class="score"><strong>${value ?? 'â€”'}</strong><span>${key}</span></div>`).join('')}</div>` : '';
  const patterns = [
    ...(summary.recurringStrengths?.length ? [`What you did well: ${summary.recurringStrengths.join('; ')}`] : []),
    ...(summary.recurringGaps?.length ? [`Keep working on: ${summary.recurringGaps.join('; ')}`] : [])
  ];
  const sourceCount = summary.sourceCount ?? state.session?.sourceCount ?? 0;
  const sourceNames = (summary.sourceNames || []).join(', ');
  const materialsNote = sourceCount
    ? `${sourceCount} source${sourceCount === 1 ? '' : 's'} informed this session${sourceNames ? `: ${sourceNames}` : '.'}`
    : 'No supplied materials were used.';
  return [
    '<p class="card-kicker">Your progress</p>',
    `<h2>${summary.completedTurns} answer${summary.completedTurns === 1 ? '' : 's'} completed</h2>`,
    `<p class="summary-meta">Turn count: ${summary.turnCount ?? summary.completedTurns ?? 0}</p>`,
    scoreMarkup,
    renderSummarySection('Learning', summary.learnedConcepts, {
      className: 'summary-learning',
      empty: 'No learning summary was recorded for this session yet.'
    }),
    renderSummarySection('Unresolved questions', summary.unresolvedQuestions, {
      className: 'summary-unresolved'
    }),
    renderSummarySection('Source coverage', summary.sourceCoverage, {
      className: 'summary-source-coverage',
      formatter: renderSourceCoverage
    }),
    renderSummarySection('Patterns', patterns, {
      className: 'summary-patterns'
    }),
    `<p class="summary-source-note"><strong>Materials used:</strong> ${escapeHtml(materialsNote)}</p>`,
    renderSummarySection('Next steps', summary.nextSteps, {
      className: 'summary-next-steps',
      empty: summary.nextPractice || ''
    }),
    `<div class="next-practice"><strong>Next practice</strong><br>${escapeHtml(summary.nextPractice)}</div>`
  ].filter(Boolean).join('');
}

async function completeSession() {
  clearVoiceCompletionTimer();
  await stopRecordingAndKeepBlob();
  stopLiveVoice();
  stopSpeechRecognition();
  stopVoiceConversationPreservingBrowserState();
  const result = await api(`/api/sessions/${state.session.id}/complete`, { method: 'POST' });
  state.summary = result.summary;
  $('#summaryContent').innerHTML = renderSummary(result.summary);
  show('summaryView');
  $('#summaryView').focus();
  clearClientSession();
  return;
  const scores = result.summary.overallScores;
  const strengths = result.summary.recurringStrengths?.length
    ? `<div class="summary-insight"><strong>What you did well</strong><ul>${result.summary.recurringStrengths.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
    : '';
  const gaps = result.summary.recurringGaps?.length
    ? `<div class="summary-insight"><strong>Keep working on</strong><ul>${result.summary.recurringGaps.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
    : '';
  const sourceCount = result.summary.sourceCount ?? state.session?.sourceCount ?? 0;
  const sourceLabel = `${sourceCount} source${sourceCount === 1 ? '' : 's'}`;
  const sourceNames = (result.summary.sourceNames || []).join(', ');
  const sourceCoverage = `<p class="summary-source-note"><strong>Materials used:</strong> ${sourceCount ? `${sourceLabel} informed this session${sourceNames ? `: ${escapeHtml(sourceNames)}` : '.'}` : 'No supplied materials were used.'}</p>`;
  $('#summaryContent').innerHTML = `<p class="card-kicker">Your progress</p><h2>${result.summary.completedTurns} answer${result.summary.completedTurns === 1 ? '' : 's'} completed</h2><div class="score-grid">${Object.entries(scores).map(([key, value]) => `<div class="score"><strong>${value ?? '—'}</strong><span>${key}</span></div>`).join('')}</div>${strengths}${gaps}${sourceCoverage}<div class="next-practice"><strong>Next practice</strong><br>${escapeHtml(result.summary.nextPractice)}</div>`;
  show('summaryView');
  $('#summaryView').focus();
  clearClientSession();
}

async function restoreClientSession() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || sessionStorage.getItem(LEGACY_SESSION_STORAGE_KEY) || 'null');
  } catch { saved = null; }
  if (!saved?.id || !saved?.token) return;
  state.token = saved.token;
  try {
    const result = await api(`/api/sessions/${saved.id}`);
    state.session = result.session;
    state.mode = result.session.sourceMode === 'source' ? 'materials' : 'practice';
    state.transcript = Array.isArray(saved.transcript) ? saved.transcript.slice(0, result.session.turnCount) : [];
    state.materialHistory = Array.isArray(saved.materialHistory) ? saved.materialHistory.slice(-20) : [];
    $('#sessionTopic').textContent = result.session.topic;
    renderQuestion(result.session.currentQuestion);
    $('#answerText').value = typeof saved.draft === 'string' ? saved.draft : '';
    $('#additionalSourceName').value = typeof saved.additionalSourceName === 'string' ? saved.additionalSourceName : '';
    $('#additionalSourceText').value = typeof saved.additionalSourceText === 'string' ? saved.additionalSourceText : '';
    renderTranscript();
    state.lastFeedback = state.transcript.at(-1)?.feedback || null;
    $('#replayFeedback').disabled = !state.lastFeedback;
    if (state.mode === 'materials') await refreshSources();
    show('sessionView');
    if (result.session.status === 'ready_to_complete' || result.session.status === 'completed') await completeSession();
  } catch {
    clearClientSession();
    state.token = null;
  }
}

function setupSpeechRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { $('#listenButton').textContent = '◎ Voice input unavailable'; $('#listenButton').disabled = true; return; }
  setSpeechRecognitionPermission('unknown');
  state.recognition = new Recognition();
  state.recognition.lang = 'en-US';
  state.recognition.continuous = true;
  state.recognition.interimResults = true;
  state.recognition.maxAlternatives = 1;
  state.recognition.onstart = () => {
    state.recognitionActive = true;
    state.voiceRecognitionSessionId += 1;
    if (state.speechRecognitionProbe) {
      finishSpeechRecognitionProbe(true);
      return;
    }
    beginRecognitionCycle(state.voiceRecognitionSessionId);
    state.voiceRecognitionAttempts = 0;
    setVoiceAnnouncement(voiceCoordinator.bargeInListening
      ? 'AI is speaking. Speak now to interrupt.'
      : 'Listening… speak naturally, then pause.');
    setListeningState(true);
  };
  state.recognition.onresult = event => { handleRecognitionResult(event); persistClientSession(); };
  state.recognition.onerror = event => {
    state.recognitionActive = false;
    if (state.speechRecognitionProbe) {
      finishSpeechRecognitionProbe(false);
      return;
    }
    setListeningState(false);
    if (state.voiceConversation === 'off') return;
    const code = event.error || 'unknown';
    if (state.voiceConversation === 'listening' && ['aborted', 'no-speech', 'network'].includes(code)) {
      scheduleVoiceListeningRetry(code === 'no-speech' ? 'I did not hear an answer.' : 'Voice input was interrupted.');
      return;
    }
    const message = {
      'not-allowed': 'Microphone access was denied. Please allow microphone access in the browser address bar and try again.',
      'service-not-allowed': 'The browser speech service is unavailable.',
      'audio-capture': 'No working microphone was found.',
      network: 'The browser speech service could not be reached.'
    }[code] || `Voice input stopped (${code}).`;
    if (code === 'not-allowed') setMicrophoneStatus('denied');
    if (code === 'audio-capture') setMicrophoneStatus('unavailable');
    setVoiceConversationError(message);
  };
  state.recognition.onend = () => {
    state.recognitionActive = false;
    if (state.speechRecognitionProbe) {
      finishSpeechRecognitionProbe(false);
      return;
    }
    setListeningState(false);
    commitRecognitionCycle();
    if (voiceCoordinator.pendingTranscript) {
      voiceCoordinator.scheduleTranscriptSubmission();
      if (voiceCoordinator.standaloneListening && !voiceCoordinator.resumeTimer) {
        voiceCoordinator.resumeTimer = window.setTimeout(() => {
          voiceCoordinator.resumeTimer = null;
          if (voiceCoordinator.standaloneListening && voiceCoordinator.pendingTranscript && state.voiceConversation === 'off') startStandaloneListening({ preserveCapture: true });
        }, 250);
      } else if (state.voiceConversation === 'listening') {
        scheduleVoiceRecognitionRestart('Voice input paused.');
      }
      return;
    }
    if (state.voiceConversation === 'listening') {
      scheduleVoiceRecognitionRestart('Voice input paused.');
    } else if (state.voiceConversation === 'off' && !voiceCoordinator.standaloneListening) {
      setVoiceAnnouncement('You can edit the transcript before submitting.');
    }
  };
}

function stopSpeechRecognition() {
  if (!state.recognition) return;
  try { state.recognition.stop(); } catch { /* Recognition may already be idle. */ }
  state.recognitionActive = false;
  setListeningState(false);
}

document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', event => { state.mode = event.target.value; $('.mode-option.selected')?.classList.remove('selected'); event.target.closest('.mode-option').classList.add('selected'); $('#sourceSetup').classList.toggle('hidden', state.mode !== 'materials'); syncConversationDefaults(); syncQuestionLimitOptions(); }));
$('#setupForm').addEventListener('submit', startSession);
$('#prepareVoiceButton')?.addEventListener('click', () => { prepareVoiceAccess().catch(notifyError); });
$('#sourceFile').addEventListener('change', loadSourceFile);
$('#sourceName').addEventListener('input', () => { $('#sourceName').dataset.autoName = ''; });
$('#answerText').addEventListener('input', persistClientSession);
$('#additionalSourceName').addEventListener('input', persistClientSession);
$('#additionalSourceText').addEventListener('input', persistClientSession);
$('#answerText').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submitAnswer(); } });
$('#addSourceButton').addEventListener('click', addAdditionalSource);
$('#submitAnswer').addEventListener('click', submitAnswer);
$('#replayFeedback').addEventListener('click', replayFeedback);
$('#speakQuestion').addEventListener('click', () => speakQuestionAndListen($('#questionText').textContent));
$('#sourceQuestionButton').addEventListener('click', askSourceQuestion);
$('#copyTranscript').addEventListener('click', copyTranscript);
$('#downloadTranscript').addEventListener('click', downloadTranscript);
$('#recordConversationButton').addEventListener('click', () => {
  const snapshot = getRecordingSnapshot();
  if (isRecordingActive(snapshot) || snapshot.state === 'ready') {
    syncRecordingUi(snapshot);
    return;
  }
  recordingOptIn = !recordingOptIn;
  if (recordingOptIn) {
    ensureRecordingController();
    recordingController?.arm();
    if (voiceCoordinator.active && state.voiceConversation !== 'off') {
      startRecordingForVoiceTransport(voiceCoordinator.transport).catch(() => null);
      return;
    }
  } else {
    discardRecording();
  }
  syncRecordingUi(getRecordingSnapshot());
});
$('#stopRecordingButton').addEventListener('click', () => { stopRecordingAndKeepBlob().catch(() => null); });
$('#discardRecordingButton').addEventListener('click', discardRecording);
$('#downloadRecordingButton').addEventListener('click', () => { downloadRecording('recording').catch(() => null); });
$('#downloadRecordingSummaryButton').addEventListener('click', () => { downloadRecording('summary').catch(() => null); });
$('#listenButton').addEventListener('click', () => {
  if (!state.recognition) return;
  if (voiceCoordinator.standaloneListening) {
    voiceCoordinator.standaloneListening = false;
    stopSpeechRecognition();
    return;
  }
  startStandaloneListening().catch(notifyError);
});
$('#voiceConversationButton').addEventListener('click', () => { if (state.voiceConversation === 'off' || state.voiceConversation === 'error') startVoiceConversation(); else stopVoiceConversation(); });
$('#voiceInterruptButton').addEventListener('click', () => { voiceCoordinator.interrupt({ bargeIn: true }).catch(notifyError); });
$('#voicePauseButton').addEventListener('click', () => {
  if (state.voiceConversation === 'error') {
    resumeRecording();
    voiceCoordinator.resume().catch(notifyError);
  } else {
    pauseRecording();
    voiceCoordinator.pause().catch(notifyError);
  }
});
$('#voiceStopButton').addEventListener('click', stopVoiceConversation);
$('#voiceRetryButton').addEventListener('click', () => { retryVoiceAction().catch(notifyError); });
$('#repeatSpokenLine').addEventListener('click', repeatLastSpokenLine);
$('#reviewTranscriptToggle').addEventListener('change', event => {
  setTranscriptReviewMessage(event.target.checked
    ? 'Review before sending is on. Finalized voice transcripts will wait here for your approval.'
    : 'Finalized voice transcripts appear here before analysis when review before sending is on.');
});
$('#liveVoiceButton').addEventListener('click', connectLiveVoice);
window.addEventListener('pointerdown', tryPlayRemoteAudio, { passive: true });
window.addEventListener('keydown', tryPlayRemoteAudio);
$('#materialQuestionForm').addEventListener('submit', event => { event.preventDefault(); askMaterialQuestion(); });
$('#sourceList').addEventListener('click', async event => {
  const button = event.target.closest('.source-remove');
  if (!button || button.disabled || !window.confirm('Remove this source from the session?')) return;
  setSourceRemovalProcessing(true);
  try {
    await api(`/api/sessions/${state.session.id}/sources/${button.dataset.sourceId}`, { method: 'DELETE' });
    $('#sourceDigest').textContent = '';
    $('#materialAnswer').classList.add('hidden');
    $('#materialAnswer').innerHTML = '';
    await refreshSources();
  } catch (error) { notifyError(error); }
  finally { setSourceRemovalProcessing(false); }
});
$('#endSession').addEventListener('click', () => {
  if ($('#endSession').disabled || !confirmLeavingWithDraft()) return;
  setEndSessionProcessing(true);
  completeSession().catch(notifyError).finally(() => setEndSessionProcessing(false));
});
$('#sourceText').addEventListener('input', () => { state.pendingSource = null; });
$('#newSession').addEventListener('click', () => { discardRecording(); stopLiveVoice(); stopVoiceConversation(); stopSpeechRecognition(); clearClientSession(); clearAdditionalSourceDraft(); state = { ...state, session: null, token: null, mode: 'practice', sourceLimits: state.sourceLimits, recognition: state.recognition, peer: null, localStream: null, dataChannel: null, remoteAudio: null, pendingSource: null, processedVoiceItems: new Set(), voiceReviewPending: false, voiceConversation: 'off', browserConversationState: 'idle', voiceAnnouncement: '', voiceSubmissionKey: null, voiceRecognitionSessionId: 0, voiceRecognitionAttempts: 0, voiceRecognitionRetryPending: false, transcript: [], materialHistory: [], summary: null, lastFeedback: null, lastSpokenLine: '' }; $('#setupForm').reset(); syncConversationDefaults(); syncModeSelection(); syncQuestionLimitOptions(); clearSourceNameAutoMarker(); $('#sourceSetup').classList.add('hidden'); show('setupView'); renderBrowserConversationState(); syncVoiceAccessSetup(); });
$('#deleteData').addEventListener('click', async () => {
  if ($('#deleteData').disabled || !confirmLeavingWithDraft()) return;
  setDeleteDataProcessing(true);
  try {
    discardRecording();
    stopLiveVoice();
    stopVoiceConversation();
    await api(`/api/sessions/${state.session.id}`, { method: 'DELETE' });
    clearAdditionalSourceDraft();
    clearClientSession();
    state = { ...state, session: null, token: null, mode: 'practice', sourceLimits: state.sourceLimits, recognition: state.recognition, peer: null, localStream: null, dataChannel: null, remoteAudio: null, pendingSource: null, processedVoiceItems: new Set(), voiceReviewPending: false, voiceConversation: 'off', browserConversationState: 'idle', voiceAnnouncement: '', voiceSubmissionKey: null, voiceRecognitionSessionId: 0, voiceRecognitionAttempts: 0, voiceRecognitionRetryPending: false, transcript: [], materialHistory: [], summary: null, lastFeedback: null, lastSpokenLine: '' };
    show('setupView');
    notify('Session data deleted.');
  } catch (error) { notifyError(error); }
  finally { setDeleteDataProcessing(false); }
});
window.addEventListener('beforeunload', event => { if (!hasUnsubmittedAnswer() && !hasUnsubmittedMaterialsDraft()) return; event.preventDefault(); event.returnValue = ''; });
window.addEventListener('pagehide', () => { discardRecording(); });
window.voiceCoordinator = voiceCoordinator;
setVoiceConversationState('off');
renderBrowserConversationState();
setupSpeechRecognition();
syncVoiceAccessSetup();
syncRecordingUi();
syncQuestionLimitOptions();
syncConversationDefaults();
refreshMicrophoneStatus();
loadServiceStatus();
restoreClientSession();
