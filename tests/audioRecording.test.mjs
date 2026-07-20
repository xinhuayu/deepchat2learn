import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createAudioRecordingFixtures } from './helpers/audioRecordingFixtures.mjs';

const RECORDER_PATH = new URL('../public/audioRecording.js', import.meta.url);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_BYTES = 128 * 1024 * 1024;

function createFixture(options = {}) {
  return createAudioRecordingFixtures(options);
}

async function createController(fixture = createFixture(), options = {}) {
  const { contextOverrides = {}, ...controllerOptions } = options;
  const source = await fs.readFile(RECORDER_PATH, 'utf8');
  const context = fixture.createVmContext(contextOverrides);
  vm.runInNewContext(source, context, { filename: RECORDER_PATH.pathname });
  return context.window.deepchat2learnRecording.createController({
    MediaRecorderCtor: Object.hasOwn(controllerOptions, 'MediaRecorderCtor') ? controllerOptions.MediaRecorderCtor : fixture.MediaRecorderCtor,
    AudioContextCtor: Object.hasOwn(controllerOptions, 'AudioContextCtor') ? controllerOptions.AudioContextCtor : fixture.AudioContextCtor,
    MediaStreamCtor: Object.hasOwn(controllerOptions, 'MediaStreamCtor') ? controllerOptions.MediaStreamCtor : fixture.MediaStreamCtor,
    URLRef: fixture.URLRef,
    now: fixture.now,
    setTimeoutRef: fixture.setTimeoutRef,
    clearTimeoutRef: fixture.clearTimeoutRef,
    maxDurationMs: HOUR,
    warningDurationMs: 55 * MINUTE,
    maxBytes: MAX_BYTES,
    ...controllerOptions
  });
}

async function startRecording(fixture, options = {}) {
  const { armOptions = {}, beforeStart, ...controllerOptions } = options;
  const controller = await createController(fixture, controllerOptions);
  controller.arm({ microphoneStream: fixture.microphoneStream, ...armOptions });
  await beforeStart?.(controller, fixture);
  const startPromise = controller.start();
  if (fixture.lastRecorder?.pendingStart) fixture.flushRecorderStart();
  await startPromise;
  return controller;
}

test('selects the first supported MIME type in the approved order', async () => {
  const fixture = createFixture({ supportedTypes: new Set(['audio/mp4']) });
  const controller = await startRecording(fixture);
  assert.equal(controller.snapshot().mimeType, 'audio/mp4');
});

test('does not request or start recording before explicit opt-in', async () => {
  const fixture = createFixture();
  const controller = await createController(fixture);
  assert.equal(controller.snapshot().state, 'idle');
  assert.equal(controller.snapshot().captureMode, 'microphone-only');
  assert.equal(fixture.recorderInstances.length, 0);
});

test('transitions through armed, starting, recording, paused, stopping, and ready', async () => {
  const fixture = createFixture({ deferRecorderStart: true, deferRecorderStop: true });
  const controller = await createController(fixture);
  const stateSnapshots = [];
  controller.subscribe(snapshot => stateSnapshots.push(snapshot.state));
  assert.equal(controller.snapshot().state, 'idle');
  controller.arm({ microphoneStream: fixture.microphoneStream });
  assert.equal(controller.snapshot().state, 'armed');
  const startPromise = controller.start();
  assert.equal(controller.snapshot().state, 'starting');
  fixture.flushRecorderStart();
  await startPromise;
  assert.equal(controller.snapshot().state, 'recording');
  controller.pause();
  assert.equal(controller.snapshot().state, 'paused');
  controller.resume();
  assert.equal(controller.snapshot().state, 'recording');
  const stopPromise = controller.stop();
  assert.equal(controller.snapshot().state, 'stopping');
  fixture.flushRecorderStop();
  await stopPromise;
  assert.equal(controller.snapshot().state, 'ready');
  assert.deepEqual(
    stateSnapshots.filter((state, index) => index === 0 || state !== stateSnapshots[index - 1]),
    ['armed', 'starting', 'recording', 'paused', 'recording', 'stopping', 'ready']
  );
});

test('starts MediaRecorder with a bounded two-second timeslice', async () => {
  const fixture = createFixture();
  await startRecording(fixture);
  assert.equal(fixture.lastRecorder.startTimeslice, 2000);
});

test('falls back to microphone-only when no AI stream or audio context is available', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture, { AudioContextCtor: null });
  assert.equal(controller.snapshot().captureMode, 'microphone-only');
  assert.match(controller.snapshot().modeLabel, /microphone only/i);
  assert.equal(fixture.lastRecorder.stream, fixture.microphoneStream);
  assert.equal(fixture.audioContexts.length, 0);
});

test('mixes microphone and remote AI audio as a complete conversation', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture, {
    beforeStart(controllerRef) {
      controllerRef.attachRemoteStream(fixture.remoteStream);
    }
  });
  assert.equal(controller.snapshot().captureMode, 'complete-conversation');
  const audioContext = fixture.audioContexts.at(-1);
  assert.ok(audioContext);
  assert.equal(fixture.lastRecorder.stream, audioContext.destinations[0].stream);
  assert.deepEqual(
    audioContext.sources.map(source => source.stream),
    [fixture.microphoneStream, fixture.remoteStream]
  );
  assert.equal(audioContext.sources[0].connections[0], audioContext.destinations[0]);
  assert.equal(audioContext.sources[1].connections[0], audioContext.destinations[0]);
});

test('attaches late remote AI audio to an active recorder without restarting it', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture);
  const recorder = fixture.lastRecorder;
  const audioContext = fixture.audioContexts.at(-1);
  const initialStream = recorder.stream;

  assert.ok(audioContext, 'microphone-only recording should keep an audio context available for late remote audio');
  assert.equal(recorder.stream, audioContext.destinations[0].stream);
  assert.equal(controller.snapshot().captureMode, 'microphone-only');

  controller.attachRemoteStream(fixture.remoteStream);

  assert.equal(controller.snapshot().captureMode, 'complete-conversation');
  assert.equal(fixture.recorderInstances.length, 1);
  assert.equal(fixture.lastRecorder, recorder);
  assert.equal(recorder.startCount, 1);
  assert.equal(recorder.stream, initialStream);
  assert.deepEqual(
    audioContext.sources.map(source => source.stream),
    [fixture.microphoneStream, fixture.remoteStream]
  );
  assert.equal(audioContext.sources[1].connections[0], audioContext.destinations[0]);
});

test('remote AI audio detachment relabels an active recording as microphone-only', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture, {
    beforeStart(controllerRef) {
      controllerRef.attachRemoteStream(fixture.remoteStream);
    }
  });

  assert.equal(controller.snapshot().captureMode, 'complete-conversation');
  controller.detachRemoteStream();

  assert.equal(controller.snapshot().captureMode, 'microphone-only');
  assert.match(controller.snapshot().modeLabel, /microphone only/i);
});

test('late remote AI audio remains microphone-only when no audio context exists', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture, { AudioContextCtor: null });
  const recorder = fixture.lastRecorder;

  controller.attachRemoteStream(fixture.remoteStream);

  assert.equal(controller.snapshot().captureMode, 'microphone-only');
  assert.equal(fixture.audioContexts.length, 0);
  assert.equal(fixture.lastRecorder, recorder);
  assert.equal(recorder.stream, fixture.microphoneStream);
});

test('pause and resume preserve one recording session', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture);
  controller.pause();
  controller.resume();
  assert.equal(controller.snapshot().state, 'recording');
  assert.equal(controller.snapshot().elapsedMs, 0);
});

test('elapsedMs and the 60-minute limit follow wall-clock time while paused', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture);
  const snapshots = [];
  controller.subscribe(snapshot => snapshots.push(snapshot));

  fixture.advance(10 * MINUTE);
  controller.pause();
  assert.equal(controller.snapshot().state, 'paused');

  fixture.advance(45 * MINUTE);
  assert.equal(controller.snapshot().elapsedMs, 55 * MINUTE);
  assert.equal(snapshots.filter(snapshot => snapshot.warning).length, 1);

  fixture.advance(5 * MINUTE);
  assert.equal(controller.snapshot().state, 'ready');
  assert.equal(controller.snapshot().limitReached, true);
  assert.equal(controller.snapshot().elapsedMs, 60 * MINUTE);
});

test('stop finalizes an in-memory blob and releases owned mixer tracks without stopping borrowed inputs', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture, {
    beforeStart(controllerRef) {
      controllerRef.attachRemoteStream(fixture.remoteStream);
    }
  });
  await controller.stop();
  assert.equal(controller.snapshot().state, 'ready');
  assert.ok(controller.snapshot().blob);
  const mixedTrack = fixture.audioContexts.at(-1)?.destinations[0]?.stream.getAudioTracks()[0];
  assert.equal(fixture.microphoneTrack.stopCount, 0);
  assert.equal(fixture.remoteTrack.stopCount, 0);
  assert.equal(mixedTrack?.stopCount, 1);
});

test('download returns a product filename and explicit cleanup for non-DOM callers', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture);
  await controller.stop();
  const download = await controller.download();
  assert.match(download.filename, /^deepchat2learn-.*\.(webm|mp4)$/);
  assert.equal(fixture.createdObjectUrls.length, 1);
  assert.deepEqual(fixture.revokedObjectUrls, []);
  download.cleanup();
  assert.deepEqual(fixture.revokedObjectUrls, [fixture.createdObjectUrls[0].url]);
});

test('download keeps the object URL valid through anchor click and revokes it afterward', async () => {
  const fixture = createFixture();
  const clickObservations = [];
  const fakeDocument = {
    body: {
      appendChild(node) {
        this.node = node;
        return node;
      }
    },
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return {
        href: '',
        download: '',
        click() {
          clickObservations.push({
            href: this.href,
            revokedDuringClick: fixture.revokedObjectUrls.includes(this.href)
          });
        },
        remove() {}
      };
    }
  };
  const controller = await startRecording(fixture, {
    contextOverrides: {
      window: {
        document: fakeDocument
      }
    }
  });
  await controller.stop();
  const download = await controller.download();
  assert.equal(clickObservations.length, 1);
  assert.equal(clickObservations[0].href, download.url);
  assert.equal(clickObservations[0].revokedDuringClick, false);
  assert.deepEqual(fixture.revokedObjectUrls, [download.url]);
});

test('discard and destroy clean up controller state and owned mixer resources', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture, {
    beforeStart(controllerRef) {
      controllerRef.attachRemoteStream(fixture.remoteStream);
    }
  });
  const mixedTrack = fixture.audioContexts.at(-1)?.destinations[0]?.stream.getAudioTracks()[0];
  controller.discard();
  assert.equal(controller.snapshot().state, 'idle');
  assert.equal(controller.snapshot().blob, null);
  assert.equal(fixture.microphoneTrack.stopCount, 0);
  assert.equal(fixture.remoteTrack.stopCount, 0);
  assert.equal(mixedTrack?.stopCount, 1);
  controller.destroy();
  assert.equal(fixture.microphoneTrack.stopCount, 0);
});

test('stop, discard, and destroy preserve caller-owned microphone tracks by default', async () => {
  for (const action of ['stop', 'discard', 'destroy']) {
    const fixture = createFixture();
    const controller = await startRecording(fixture);
    if (action === 'stop') await controller.stop();
    else controller[action]();
    assert.equal(fixture.microphoneTrack.stopCount, 0, `${action} should not stop the caller microphone track`);
  }
});

test('warns once at 55 minutes and stops at the 60-minute wall-clock limit', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture);
  const snapshots = [];
  controller.subscribe(snapshot => snapshots.push(snapshot));
  fixture.advance(55 * MINUTE);
  assert.equal(snapshots.filter(snapshot => snapshot.warning).length, 1);
  fixture.advance(5 * MINUTE);
  assert.equal(controller.snapshot().state, 'ready');
  assert.equal(controller.snapshot().limitReached, true);
});

test('stops before accumulated chunks exceed the 128 MiB byte budget', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture);
  fixture.lastRecorder.emitChunk(new fixture.BlobCtor([new Uint8Array(MAX_BYTES)]));
  assert.equal(controller.snapshot().state, 'ready');
  assert.equal(controller.snapshot().byteLimitReached, true);
});

test('drops the overflow chunk and finalizes only bounded bytes when the byte budget is exceeded', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture, { maxBytes: 10 });
  const boundedChunk = fixture.makeRecordingChunk([new Uint8Array(6)]);
  const overflowChunk = fixture.makeRecordingChunk([new Uint8Array(5)]);

  fixture.lastRecorder.emitChunk(boundedChunk);
  fixture.lastRecorder.emitChunk(overflowChunk);

  assert.equal(controller.snapshot().state, 'ready');
  assert.equal(controller.snapshot().byteLimitReached, true);
  assert.equal(controller.snapshot().error, null);
  assert.equal(controller.snapshot().blob.size, boundedChunk.size);
  assert.ok(controller.snapshot().blob.size <= 10);
  assert.equal(fixture.lastRecorder.stopCount, 1);
});

test('attachRemoteStream keeps microphone-only mode for truthy streams that cannot be mixed', async () => {
  const fixture = createFixture();
  const controller = await createController(fixture, { AudioContextCtor: null });
  controller.arm({ microphoneStream: fixture.microphoneStream });
  controller.attachRemoteStream(fixture.remoteStream);
  assert.equal(controller.snapshot().captureMode, 'microphone-only');

  const tracklessController = await createController(createFixture());
  tracklessController.arm({ microphoneStream: fixture.microphoneStream });
  tracklessController.attachRemoteStream(new fixture.MediaStreamCtor([]));
  assert.equal(tracklessController.snapshot().captureMode, 'microphone-only');
});

test('reports unsupported MediaRecorder and denied microphone environments without partial capture', async () => {
  const unsupported = createFixture();
  const unavailable = await createController(unsupported, { MediaRecorderCtor: null });
  unavailable.arm({ microphoneStream: unsupported.microphoneStream });
  await unavailable.start();
  assert.equal(unavailable.snapshot().state, 'unavailable');

  const denied = createFixture();
  const deniedController = await createController(denied);
  deniedController.arm({ microphoneError: denied.microphoneDeniedError });
  await deniedController.start();
  assert.equal(deniedController.snapshot().state, 'unavailable');
  assert.match(
    `${deniedController.snapshot().error || deniedController.snapshot().message || deniedController.snapshot().reason || ''}`,
    /microphone|permission|denied/i
  );
  assert.equal(denied.recorderInstances.length, 0);
});

test('keeps recording bytes out of application sinks', async () => {
  const fixture = createFixture();
  const controller = await startRecording(fixture);
  fixture.lastRecorder.emitChunk(fixture.makeRecordingChunk());
  await controller.stop();
  assert.deepEqual(fixture.privacyViolations, []);
  assert.deepEqual(fixture.fetchBodies, []);
  assert.deepEqual(fixture.sessionStorageValues, []);
  assert.deepEqual(fixture.transcriptEntries, []);
  assert.deepEqual(fixture.logEntries, []);
  assert.deepEqual(fixture.analyticsCalls, []);
  assert.deepEqual(fixture.sqliteCalls, []);
  assert.deepEqual(fixture.xhrBodies, []);
});
