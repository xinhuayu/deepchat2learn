function createPrivacyArray(kind, calls, containsRecordingData, violations) {
  const target = [];
  return new Proxy(target, {
    get(array, property, receiver) {
      if (['push', 'unshift'].includes(property)) {
        return (...values) => {
          calls[kind].push(...values);
          if (values.some(value => containsRecordingData(value))) {
            const error = new Error(`Recording data reached ${kind}`);
            violations.push({ kind, value: values });
            throw error;
          }
          return Array.prototype[property].apply(array, values);
        };
      }
      return Reflect.get(array, property, receiver);
    }
  });
}

function createPrivacyDetector(recordingMarker) {
  function containsRecordingData(value, seen = new WeakSet()) {
    if (value == null) return false;
    if (typeof value === 'string') return value.includes(recordingMarker);
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (value instanceof Blob) return Boolean(value.__containsRecordingData);
    if (Array.isArray(value)) return value.some(entry => containsRecordingData(entry, seen));
    if (value instanceof Set) return [...value].some(entry => containsRecordingData(entry, seen));
    if (value instanceof Map) return [...value.values()].some(entry => containsRecordingData(entry, seen));
    return Object.values(value).some(entry => containsRecordingData(entry, seen));
  }

  return containsRecordingData;
}

export function createAudioRecordingFixtures({
  startTime = 0,
  supportedTypes = new Set(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']),
  deferRecorderStart = false,
  deferRecorderStop = false,
  recordingMarker = 'private-audio-bytes'
} = {}) {
  const containsRecordingData = createPrivacyDetector(recordingMarker);
  const privacyViolations = [];
  const privacyCalls = {
    fetch: [],
    xhr: [],
    storage: [],
    transcript: [],
    log: [],
    analytics: [],
    sqlite: []
  };

  class FixtureBlob extends Blob {
    constructor(parts = [], options = {}) {
      super(parts, options);
      this.__containsRecordingData = parts.some(part => containsRecordingData(part));
    }
  }

  class FakeMediaStreamTrack {
    constructor(kind = 'audio', label = `${kind}-track`) {
      this.kind = kind;
      this.label = label;
      this.enabled = true;
      this.readyState = 'live';
      this.stopCount = 0;
    }

    stop() {
      this.readyState = 'ended';
      this.stopCount += 1;
    }
  }

  class FakeMediaStream {
    constructor(tracks = []) {
      this.tracks = tracks.slice();
      this.id = `stream-${FakeMediaStream.nextId++}`;
    }

    getTracks() {
      return this.tracks.slice();
    }

    getAudioTracks() {
      return this.tracks.filter(track => track.kind === 'audio');
    }

    addTrack(track) {
      if (!this.tracks.includes(track)) this.tracks.push(track);
    }
  }
  FakeMediaStream.nextId = 1;

  const recorderInstances = [];
  class FakeMediaRecorder {
    static supportedTypes = supportedTypes;

    static isTypeSupported(type) {
      return FakeMediaRecorder.supportedTypes.has(type);
    }

    constructor(stream, options = {}) {
      FakeMediaRecorder.last = this;
      this.stream = stream;
      this.mimeType = options.mimeType || '';
      this.state = 'inactive';
      this.startCount = 0;
      this.pauseCount = 0;
      this.resumeCount = 0;
      this.stopCount = 0;
      this.emittedChunks = [];
      this.pendingStart = false;
      this.pendingStop = false;
      recorderInstances.push(this);
    }

    start(timeslice) {
      this.startTimeslice = timeslice;
      this.startCount += 1;
      if (deferRecorderStart) {
        this.pendingStart = true;
        return;
      }
      this.flushStart();
    }

    flushStart() {
      this.pendingStart = false;
      this.state = 'recording';
      this.onstart?.();
    }

    pause() {
      if (this.state !== 'recording') return;
      this.state = 'paused';
      this.pauseCount += 1;
      this.onpause?.();
    }

    resume() {
      if (this.state !== 'paused') return;
      this.state = 'recording';
      this.resumeCount += 1;
      this.onresume?.();
    }

    stop() {
      if (this.state === 'inactive' && !this.pendingStart) return;
      this.stopCount += 1;
      if (deferRecorderStop) {
        this.pendingStop = true;
        return;
      }
      this.flushStop();
    }

    flushStop(blob = this.emittedChunks.at(-1) || new FixtureBlob(['fixture'], { type: this.mimeType })) {
      this.pendingStop = false;
      this.state = 'inactive';
      this.ondataavailable?.({ data: blob });
      this.onstop?.();
    }

    emitChunk(bytes = 'audio-fixture') {
      const chunk = bytes instanceof Blob ? bytes : new FixtureBlob([bytes], { type: this.mimeType });
      this.emittedChunks.push(chunk);
      this.ondataavailable?.({ data: chunk });
      return chunk;
    }
  }

  const audioContexts = [];
  class FakeAudioContext {
    constructor() {
      this.destination = { kind: 'speaker-output' };
      this.closed = false;
      this.sources = [];
      this.destinations = [];
      this.connections = [];
      audioContexts.push(this);
    }

    createMediaStreamSource(stream) {
      const node = {
        kind: 'media-stream-source',
        stream,
        connections: [],
        connect: target => {
          node.connections.push(target);
          this.connections.push({ from: node, to: target });
          return target;
        }
      };
      this.sources.push(node);
      return node;
    }

    createMediaStreamDestination() {
      const node = {
        kind: 'media-stream-destination',
        stream: new FakeMediaStream([new FakeMediaStreamTrack('audio', 'mixed-track')]),
        connections: [],
        connect: target => {
          node.connections.push(target);
          this.connections.push({ from: node, to: target });
          return target;
        }
      };
      this.destinations.push(node);
      return node;
    }

    async close() {
      this.closed = true;
    }
  }

  let now = startTime;
  let nextTimerId = 1;
  const timers = new Map();
  const createdUrls = [];
  const revokedUrls = [];

  const fetchBodies = createPrivacyArray('fetch', privacyCalls, containsRecordingData, privacyViolations);
  const sessionStorageValues = createPrivacyArray('storage', privacyCalls, containsRecordingData, privacyViolations);
  const transcriptEntries = createPrivacyArray('transcript', privacyCalls, containsRecordingData, privacyViolations);
  const logEntries = createPrivacyArray('log', privacyCalls, containsRecordingData, privacyViolations);
  const analyticsCalls = createPrivacyArray('analytics', privacyCalls, containsRecordingData, privacyViolations);
  const sqliteCalls = createPrivacyArray('sqlite', privacyCalls, containsRecordingData, privacyViolations);
  const xhrBodies = createPrivacyArray('xhr', privacyCalls, containsRecordingData, privacyViolations);

  function throwIfRecordingData(kind, value) {
    if (!containsRecordingData(value)) return;
    const error = new Error(`Recording data reached ${kind}`);
    privacyViolations.push({ kind, value });
    throw error;
  }

  const fixture = {
    BlobCtor: FixtureBlob,
    MediaStreamTrackCtor: FakeMediaStreamTrack,
    MediaStreamCtor: FakeMediaStream,
    MediaRecorderCtor: FakeMediaRecorder,
    AudioContextCtor: FakeAudioContext,
    microphoneTrack: new FakeMediaStreamTrack('audio', 'microphone-track'),
    remoteTrack: new FakeMediaStreamTrack('audio', 'remote-track'),
    recorderInstances,
    audioContexts,
    privacyCalls,
    privacyViolations,
    fetchBodies,
    sessionStorageValues,
    transcriptEntries,
    logEntries,
    analyticsCalls,
    sqliteCalls,
    xhrBodies,
    now: () => now,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    setTimeoutRef(fn, delay) {
      const id = nextTimerId++;
      timers.set(id, { fn, due: now + Number(delay) });
      return id;
    },
    clearTimeoutRef(id) {
      timers.delete(id);
    },
    URLRef: {
      createObjectURL(blob) {
        const url = `blob:fixture-${createdUrls.length + 1}`;
        createdUrls.push({ url, blob });
        return url;
      },
      revokeObjectURL(url) {
        revokedUrls.push(url);
      }
    },
    createdUrls,
    revokedUrls,
    createdObjectUrls: createdUrls,
    revokedObjectUrls: revokedUrls,
    microphoneDeniedError: Object.assign(new Error('Microphone access was denied.'), { name: 'NotAllowedError' }),
    makeRecordingChunk(parts = [recordingMarker], options = { type: 'audio/webm' }) {
      return new FixtureBlob(parts, options);
    },
    containsRecordingData,
    flushRecorderStart(index = recorderInstances.length - 1) {
      const recorder = recorderInstances[index];
      recorder?.flushStart();
    },
    flushRecorderStop(index = recorderInstances.length - 1, blob) {
      const recorder = recorderInstances[index];
      recorder?.flushStop(blob);
    },
    get lastRecorder() {
      return recorderInstances.at(-1) || null;
    }
  };

  fixture.microphoneStream = new FakeMediaStream([fixture.microphoneTrack]);
  fixture.remoteStream = new FakeMediaStream([fixture.remoteTrack]);

  const fetchSpy = async (_input, init = {}) => {
    fetchBodies.push(init.body);
    return { ok: true, json: async () => ({ ok: true }) };
  };

  class FakeXMLHttpRequest {
    open(method, url) {
      this.method = method;
      this.url = url;
    }

    send(body) {
      xhrBodies.push(body);
      this.readyState = 4;
      this.status = 200;
      this.responseText = '';
      this.onload?.();
    }
  }

  const storageRef = {
    getItem() {
      return null;
    },
    setItem(key, value) {
      sessionStorageValues.push({ key, value });
    },
    removeItem() {}
  };

  const transcriptSink = {
    push(entry) {
      transcriptEntries.push(entry);
    },
    append(entry) {
      transcriptEntries.push(entry);
    }
  };

  const logSink = {
    log(entry) {
      logEntries.push(entry);
    },
    info(entry) {
      logEntries.push(entry);
    },
    warn(entry) {
      logEntries.push(entry);
    },
    error(entry) {
      logEntries.push(entry);
    }
  };

  const analyticsSink = {
    track(event, payload) {
      throwIfRecordingData('analytics', payload);
      analyticsCalls.push({ event, payload });
    }
  };

  const sqliteSink = {
    persist(payload) {
      sqliteCalls.push(payload);
    },
    insert(payload) {
      sqliteCalls.push(payload);
    }
  };

  const consoleRef = {
    log: logSink.log,
    info: logSink.info,
    warn: logSink.warn,
    error: logSink.error
  };

  fixture.fetch = fetchSpy;
  fixture.XMLHttpRequest = FakeXMLHttpRequest;
  fixture.sessionStorage = storageRef;
  fixture.localStorage = storageRef;
  fixture.transcriptSink = transcriptSink;
  fixture.logSink = logSink;
  fixture.consoleRef = consoleRef;
  fixture.analytics = analyticsSink;
  fixture.analyticsSink = analyticsSink;
  fixture.sqlite = sqliteSink;
  fixture.sqliteSink = sqliteSink;
  fixture.createVmContext = (overrides = {}) => {
    const window = {
      fetch: fetchSpy,
      XMLHttpRequest: FakeXMLHttpRequest,
      sessionStorage: storageRef,
      localStorage: storageRef,
      transcriptSink,
      analytics: analyticsSink,
      analyticsSink,
      sqlite: sqliteSink,
      sqliteSink,
      console: consoleRef,
      logSink,
      ...overrides.window
    };
    window.window = window;
    return {
      Blob: FixtureBlob,
      fetch: fetchSpy,
      XMLHttpRequest: FakeXMLHttpRequest,
      sessionStorage: storageRef,
      localStorage: storageRef,
      transcriptSink,
      analytics: analyticsSink,
      analyticsSink,
      sqlite: sqliteSink,
      sqliteSink,
      console: consoleRef,
      logSink,
      window,
      ...fixture,
      ...overrides
    };
  };

  return fixture;
}
