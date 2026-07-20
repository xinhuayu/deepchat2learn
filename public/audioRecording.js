(function attachAudioRecordingController(globalScope) {
  const globalObject = globalScope && globalScope.window ? globalScope.window : globalScope;
  const MIME_PRIORITY = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const ACTIVE_STATES = new Set(['starting', 'recording', 'paused', 'stopping']);
  const RECORDER_TIMESLICE_MS = 2000;

  function uniqueTracks(streams) {
    const tracks = [];
    const seen = new Set();
    streams.forEach(stream => {
      if (!stream || typeof stream.getTracks !== 'function') return;
      stream.getTracks().forEach(track => {
        if (!track || seen.has(track)) return;
        seen.add(track);
        tracks.push(track);
      });
    });
    return tracks;
  }

  function getAudioTracks(stream) {
    if (!stream || typeof stream.getAudioTracks !== 'function') return [];
    return stream.getAudioTracks().filter(track => track && track.readyState !== 'ended');
  }

  function extensionForMimeType(mimeType) {
    return /mp4/i.test(String(mimeType || '')) ? 'mp4' : 'webm';
  }

  function buildFilename(now, captureMode, mimeType) {
    const timestamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    return `deepchat2learn-${captureMode}-${timestamp}.${extensionForMimeType(mimeType)}`;
  }

  function selectMimeType(MediaRecorderCtor) {
    if (!MediaRecorderCtor) return null;
    if (typeof MediaRecorderCtor.isTypeSupported !== 'function') return '';
    for (let index = 0; index < MIME_PRIORITY.length; index += 1) {
      const mimeType = MIME_PRIORITY[index];
      if (MediaRecorderCtor.isTypeSupported(mimeType)) return mimeType;
    }
    return null;
  }

  function createController({
    MediaRecorderCtor,
    AudioContextCtor,
    URLRef,
    now = Date.now,
    setTimeoutRef = globalObject.setTimeout.bind(globalObject),
    clearTimeoutRef = globalObject.clearTimeout.bind(globalObject),
    maxDurationMs = 60 * 60 * 1000,
    warningDurationMs = 55 * 60 * 1000,
    maxBytes = 128 * 1024 * 1024
  } = {}) {
    const listeners = new Set();
    const seenChunks = new WeakSet();
    const runtime = {
      destroyed: false,
      microphoneStream: null,
      microphoneError: null,
      remoteStream: null,
      recorder: null,
      recordingStream: null,
      audioContext: null,
      mixedDestination: null,
      mixedSources: [],
      ownedTracks: [],
      chunks: [],
      totalBytes: 0,
      startResolver: null,
      startPromise: null,
      stopResolver: null,
      stopPromise: null,
      elapsedBeforePauseMs: 0,
      activeElapsedStartedAt: null,
      recordingStartedAt: null,
      warningTimerId: null,
      limitTimerId: null,
      disableAudioContext: false
    };
    const state = {
      state: 'idle',
      captureMode: 'microphone-only',
      modeLabel: 'Microphone only',
      mimeType: '',
      elapsedMs: 0,
      blob: null,
      filename: null,
      warning: false,
      limitReached: false,
      byteLimitReached: false,
      error: null,
      message: null,
      reason: null
    };

    function isActiveState(value) {
      return ACTIVE_STATES.has(value);
    }

    function computeElapsedMs() {
      if (runtime.recordingStartedAt == null) return state.elapsedMs;
      return Math.max(state.elapsedMs, Math.max(0, now() - runtime.recordingStartedAt));
    }

    function snapshot(extra) {
      return {
        state: state.state,
        captureMode: state.captureMode,
        modeLabel: state.modeLabel,
        mimeType: state.mimeType,
        elapsedMs: computeElapsedMs(),
        blob: state.blob,
        filename: state.filename,
        warning: state.warning,
        limitReached: state.limitReached,
        byteLimitReached: state.byteLimitReached,
        error: state.error,
        message: state.message,
        reason: state.reason,
        ...(extra || {})
      };
    }

    function emit(extra) {
      const currentSnapshot = snapshot(extra);
      listeners.forEach(listener => {
        try {
          listener(currentSnapshot);
        } catch (_error) {
          // Ignore subscriber failures so UI callbacks never break the controller.
        }
      });
      return currentSnapshot;
    }

    function patchState(updates) {
      let changed = false;
      Object.keys(updates || {}).forEach(key => {
        if (state[key] === updates[key]) return;
        state[key] = updates[key];
        changed = true;
      });
      if (changed) emit();
      return changed;
    }

    function setCaptureMode(captureMode) {
      patchState({
        captureMode,
        modeLabel: captureMode === 'complete-conversation' ? 'Complete conversation' : 'Microphone only'
      });
    }

    function clearTimers() {
      if (runtime.warningTimerId != null) {
        clearTimeoutRef(runtime.warningTimerId);
        runtime.warningTimerId = null;
      }
      if (runtime.limitTimerId != null) {
        clearTimeoutRef(runtime.limitTimerId);
        runtime.limitTimerId = null;
      }
    }

    function finalizeElapsed() {
      if (runtime.recordingStartedAt == null) return state.elapsedMs;
      state.elapsedMs = Math.max(state.elapsedMs, Math.max(0, now() - runtime.recordingStartedAt));
      runtime.activeElapsedStartedAt = null;
      return state.elapsedMs;
    }

    function closeAudioGraph() {
      const context = runtime.audioContext;
      runtime.audioContext = null;
      runtime.mixedDestination = null;
      runtime.mixedSources = [];
      if (context && typeof context.close === 'function') {
        Promise.resolve(context.close()).catch(() => null);
      }
    }

    function stopOwnedTracks() {
      runtime.ownedTracks.forEach(track => {
        if (!track || track.readyState === 'ended' || typeof track.stop !== 'function') return;
        try {
          track.stop();
        } catch (_error) {
          // Ignore cleanup errors.
        }
      });
      runtime.ownedTracks = [];
    }

    function detachRecorderHandlers() {
      if (!runtime.recorder) return;
      runtime.recorder.onstart = null;
      runtime.recorder.onpause = null;
      runtime.recorder.onresume = null;
      runtime.recorder.ondataavailable = null;
      runtime.recorder.onstop = null;
      runtime.recorder.onerror = null;
    }

    function releaseCaptureResources() {
      clearTimers();
      detachRecorderHandlers();
      runtime.recorder = null;
      runtime.recordingStream = null;
      runtime.recordingStartedAt = null;
      runtime.activeElapsedStartedAt = null;
      closeAudioGraph();
      stopOwnedTracks();
    }

    function resetRecordingData() {
      runtime.chunks = [];
      runtime.totalBytes = 0;
      state.blob = null;
      state.filename = null;
      state.mimeType = '';
      state.elapsedMs = 0;
      state.warning = false;
      state.limitReached = false;
      state.byteLimitReached = false;
      state.error = null;
      state.message = null;
      state.reason = null;
    }

    function setUnavailable(reason, error) {
      releaseCaptureResources();
      patchState({
        state: 'unavailable',
        error: error || reason || 'Recording unavailable.',
        message: reason || error || 'Recording unavailable.',
        reason: reason || error || 'Recording unavailable.'
      });
      if (runtime.startResolver) {
        runtime.startResolver(snapshot());
        runtime.startResolver = null;
        runtime.startPromise = null;
      }
    }

    function setError(error) {
      releaseCaptureResources();
      const message = error && error.message ? error.message : String(error || 'Recording failed.');
      patchState({
        state: 'error',
        error: message,
        message,
        reason: message
      });
      if (runtime.startResolver) {
        runtime.startResolver(snapshot());
        runtime.startResolver = null;
        runtime.startPromise = null;
      }
      if (runtime.stopResolver) {
        runtime.stopResolver(snapshot());
        runtime.stopResolver = null;
        runtime.stopPromise = null;
      }
    }

    function scheduleTimers() {
      clearTimers();
      if (warningDurationMs > 0 && warningDurationMs < maxDurationMs) {
        runtime.warningTimerId = setTimeoutRef(() => {
          runtime.warningTimerId = null;
          if (!isActiveState(state.state) || state.warning) return;
          state.warning = true;
          emit({ warning: true });
        }, warningDurationMs);
      }
      if (maxDurationMs > 0) {
        runtime.limitTimerId = setTimeoutRef(() => {
          runtime.limitTimerId = null;
          if (!isActiveState(state.state)) return;
          patchState({ limitReached: true });
          controller.stop();
        }, maxDurationMs);
      }
    }

    function canMixCompleteConversation(remoteStream) {
      return Boolean(AudioContextCtor && getAudioTracks(runtime.microphoneStream).length && getAudioTracks(remoteStream).length);
    }

    function attachRemoteStreamToAudioGraph(remoteStream) {
      if (!runtime.audioContext || !runtime.mixedDestination || !getAudioTracks(remoteStream).length) return false;
      if (runtime.mixedSources.some(source => source && source.stream === remoteStream)) return true;
      try {
        const remoteSource = runtime.audioContext.createMediaStreamSource(remoteStream);
        remoteSource.connect(runtime.mixedDestination);
        runtime.mixedSources.push(remoteSource);
        return true;
      } catch (_error) {
        return false;
      }
    }

    function buildCaptureStream() {
      const microphoneStream = runtime.microphoneStream;
      const remoteStream = runtime.remoteStream;
      releaseCaptureResources();
      runtime.microphoneStream = microphoneStream;
      runtime.remoteStream = remoteStream;
      let recordingStream = microphoneStream;
      let captureMode = 'microphone-only';

      const microphoneTracks = getAudioTracks(microphoneStream);
      const remoteTracks = getAudioTracks(remoteStream);

      if (AudioContextCtor && microphoneTracks.length && !runtime.disableAudioContext) {
        try {
          runtime.audioContext = new AudioContextCtor();
          runtime.mixedDestination = runtime.audioContext.createMediaStreamDestination();
          const microphoneSource = runtime.audioContext.createMediaStreamSource(microphoneStream);
          microphoneSource.connect(runtime.mixedDestination);
          runtime.mixedSources = [microphoneSource];
          recordingStream = runtime.mixedDestination.stream;
          if (remoteTracks.length && attachRemoteStreamToAudioGraph(remoteStream)) {
            captureMode = 'complete-conversation';
          }
        } catch (_error) {
          closeAudioGraph();
          recordingStream = microphoneStream;
          captureMode = 'microphone-only';
        }
      }

      runtime.recordingStream = recordingStream;
      runtime.ownedTracks = uniqueTracks(
        recordingStream && recordingStream !== microphoneStream && recordingStream !== remoteStream
          ? [recordingStream]
          : []
      );
      setCaptureMode(captureMode);
      return recordingStream;
    }

    function finalizeReadyState() {
      finalizeElapsed();
      const mimeType = state.mimeType || runtime.chunks.find(chunk => chunk && chunk.type)?.type || '';
      const blob = new Blob(runtime.chunks, mimeType ? { type: mimeType } : {});
      state.blob = blob;
      state.filename = buildFilename(now, state.captureMode, mimeType);
      releaseCaptureResources();
      patchState({ state: 'ready' });
      if (runtime.startResolver) {
        runtime.startResolver(snapshot());
        runtime.startResolver = null;
        runtime.startPromise = null;
      }
      if (runtime.stopResolver) {
        runtime.stopResolver(snapshot());
        runtime.stopResolver = null;
        runtime.stopPromise = null;
      }
    }

    function beginStop() {
      if (!['starting', 'recording', 'paused'].includes(state.state)) return Promise.resolve(snapshot());
      if (state.state === 'recording') finalizeElapsed();
      runtime.activeElapsedStartedAt = null;
      patchState({ state: 'stopping' });
      clearTimers();
      if (!runtime.stopPromise) {
        runtime.stopPromise = new Promise(resolve => {
          runtime.stopResolver = resolve;
        });
      }
      try {
        runtime.recorder.stop();
      } catch (error) {
        setError(error);
      }
      return runtime.stopPromise;
    }

    const controller = {
      arm({ microphoneStream = null, microphoneError = null, disableAudioContext = false } = {}) {
        if (runtime.destroyed) return snapshot();
        if (isActiveState(state.state) && state.state !== 'ready') return snapshot();
        releaseCaptureResources();
        runtime.microphoneStream = microphoneStream;
        runtime.microphoneError = microphoneError;
        runtime.disableAudioContext = Boolean(disableAudioContext);
        resetRecordingData();
        setCaptureMode('microphone-only');
        patchState({ state: 'armed' });
        return snapshot();
      },

      async start() {
        if (runtime.destroyed) return snapshot();
        if (!['armed', 'ready', 'unavailable', 'error', 'idle'].includes(state.state)) {
          return runtime.startPromise || snapshot();
        }
        if (state.state === 'ready') {
          controller.discard();
          patchState({ state: 'armed' });
        }
        if (state.state === 'idle') return snapshot();
        if (!MediaRecorderCtor) {
          setUnavailable('Recording unavailable: MediaRecorder is not supported.', 'MediaRecorder unavailable');
          return snapshot();
        }
        if (runtime.microphoneError) {
          const message = runtime.microphoneError.message || 'Microphone access was denied.';
          setUnavailable(message, message);
          return snapshot();
        }
        if (!runtime.microphoneStream) {
          setUnavailable('Microphone unavailable.', 'Microphone unavailable');
          return snapshot();
        }
        resetRecordingData();
        const mimeType = selectMimeType(MediaRecorderCtor);
        if (mimeType == null) {
          setUnavailable('Recording unavailable: no supported audio format.', 'Unsupported audio format');
          return snapshot();
        }
        const recordingStream = buildCaptureStream();
        try {
          runtime.recorder = new MediaRecorderCtor(
            recordingStream,
            mimeType ? { mimeType } : {}
          );
        } catch (error) {
          setUnavailable('Recording unavailable in this browser.', error && error.message ? error.message : null);
          return snapshot();
        }

        runtime.startPromise = new Promise(resolve => {
          runtime.startResolver = resolve;
        });
        patchState({
          state: 'starting',
          mimeType: mimeType || runtime.recorder.mimeType || ''
        });

        runtime.recorder.onstart = function handleStart() {
          runtime.recordingStartedAt = now();
          runtime.activeElapsedStartedAt = runtime.recordingStartedAt;
          scheduleTimers();
          patchState({ state: 'recording', mimeType: state.mimeType || runtime.recorder.mimeType || '' });
          if (runtime.startResolver) {
            runtime.startResolver(snapshot());
            runtime.startResolver = null;
            runtime.startPromise = null;
          }
        };
        runtime.recorder.onpause = function handlePause() {
          if (state.state !== 'recording') return;
          finalizeElapsed();
          patchState({ state: 'paused' });
        };
        runtime.recorder.onresume = function handleResume() {
          if (state.state !== 'paused') return;
          runtime.activeElapsedStartedAt = now();
          patchState({ state: 'recording' });
        };
        runtime.recorder.ondataavailable = function handleDataAvailable(event) {
          const chunk = event && event.data;
          if (!chunk || typeof chunk.size !== 'number' || chunk.size <= 0) return;
          if (state.byteLimitReached) return;
          if (typeof chunk === 'object' && seenChunks.has(chunk)) return;
          if (typeof chunk === 'object') seenChunks.add(chunk);
          if (runtime.totalBytes + chunk.size > maxBytes) {
            patchState({ byteLimitReached: true });
            beginStop();
            return;
          }
          runtime.chunks.push(chunk);
          runtime.totalBytes += chunk.size;
          if (runtime.totalBytes >= maxBytes) {
            patchState({ byteLimitReached: true });
            beginStop();
          }
        };
        runtime.recorder.onstop = function handleStop() {
          finalizeReadyState();
        };
        runtime.recorder.onerror = function handleRecorderError(event) {
          const error = event && event.error ? event.error : event;
          setError(error || new Error('Recording failed.'));
        };

        try {
          runtime.recorder.start(RECORDER_TIMESLICE_MS);
        } catch (error) {
          setError(error);
          return snapshot();
        }
        return runtime.startPromise;
      },

      attachRemoteStream(remoteStream) {
        if (runtime.destroyed) return snapshot();
        runtime.remoteStream = remoteStream || null;
        if (isActiveState(state.state)) {
          if (canMixCompleteConversation(runtime.remoteStream) && attachRemoteStreamToAudioGraph(runtime.remoteStream)) {
            setCaptureMode('complete-conversation');
          }
        } else {
          setCaptureMode(canMixCompleteConversation(runtime.remoteStream) ? 'complete-conversation' : 'microphone-only');
        }
        return snapshot();
      },

      detachRemoteStream() {
        if (runtime.destroyed) return snapshot();
        runtime.remoteStream = null;
        setCaptureMode('microphone-only');
        return snapshot();
      },

      pause() {
        if (runtime.destroyed || state.state !== 'recording' || !runtime.recorder) return snapshot();
        try {
          runtime.recorder.pause();
        } catch (_error) {
          // Ignore invalid recorder pause transitions.
        }
        return snapshot();
      },

      resume() {
        if (runtime.destroyed || state.state !== 'paused' || !runtime.recorder) return snapshot();
        try {
          runtime.recorder.resume();
        } catch (_error) {
          // Ignore invalid recorder resume transitions.
        }
        return snapshot();
      },

      stop() {
        if (runtime.destroyed) return Promise.resolve(snapshot());
        return beginStop();
      },

      discard() {
        if (runtime.destroyed) return snapshot();
        clearTimers();
        if (runtime.recorder) {
          detachRecorderHandlers();
          try {
            if (runtime.recorder.state !== 'inactive' || runtime.recorder.pendingStart) runtime.recorder.stop();
          } catch (_error) {
            // Ignore recorder cleanup failures.
          }
        }
        releaseCaptureResources();
        runtime.microphoneStream = null;
        runtime.microphoneError = null;
        runtime.disableAudioContext = false;
        runtime.startResolver = null;
        runtime.startPromise = null;
        runtime.stopResolver = null;
        runtime.stopPromise = null;
        resetRecordingData();
        setCaptureMode('microphone-only');
        patchState({ state: 'idle' });
        return snapshot();
      },

      async download() {
        if (!state.blob || !URLRef || typeof URLRef.createObjectURL !== 'function') return null;
        const filename = state.filename || buildFilename(now, state.captureMode, state.mimeType);
        const url = URLRef.createObjectURL(state.blob);
        let cleaned = false;
        const cleanup = function cleanupObjectUrl() {
          if (cleaned) return;
          cleaned = true;
          if (URLRef && typeof URLRef.revokeObjectURL === 'function') {
            URLRef.revokeObjectURL(url);
          }
        };
        const documentRef = globalObject.document;
        if (documentRef && typeof documentRef.createElement === 'function' && documentRef.body && typeof documentRef.body.appendChild === 'function') {
          const link = documentRef.createElement('a');
          link.href = url;
          link.download = filename;
          documentRef.body.appendChild(link);
          try {
            if (typeof link.click === 'function') link.click();
          } finally {
            if (typeof link.remove === 'function') link.remove();
            cleanup();
          }
        }
        return { filename, url, cleanup };
      },

      snapshot() {
        return snapshot();
      },

      subscribe(listener) {
        if (typeof listener !== 'function') return function noop() {};
        listeners.add(listener);
        return function unsubscribe() {
          listeners.delete(listener);
        };
      },

      destroy() {
        if (runtime.destroyed) return snapshot();
        controller.discard();
        runtime.destroyed = true;
        listeners.clear();
        return snapshot();
      }
    };

    return controller;
  }

  globalObject.deepchat2learnRecording = {
    createController
  };
}(typeof window !== 'undefined' ? window : globalThis));
