import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { InMemoryStore } from '../src/store.mjs';
import { createLifecycleRecorder } from '../src/lifecycleEvents.mjs';

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await run(`http://${address.address}:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function createSession(base, payload = {}) {
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'Lifecycle event study', ...payload })
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('lifecycle recorder retains the newest events in insertion order', async () => {
  const recorder = createLifecycleRecorder({ maxEvents: 2 });
  recorder.record({ event: 'session.created', timestamp: '2026-07-16T12:00:00.000Z', sessionId: 'session-1', mode: 'practice' });
  recorder.record({ event: 'voice.started', timestamp: '2026-07-16T12:00:01.000Z', sessionId: 'session-1', status: 'listening' });
  recorder.record({ event: 'voice.submitted', timestamp: '2026-07-16T12:00:02.000Z', sessionId: 'session-1', transcriptLength: 12 });

  assert.deepEqual(recorder.snapshot(), [
    { event: 'voice.started', timestamp: '2026-07-16T12:00:01.000Z', sessionId: 'session-1', status: 'listening' },
    { event: 'voice.submitted', timestamp: '2026-07-16T12:00:02.000Z', sessionId: 'session-1', transcriptLength: 12 }
  ]);
});

test('lifecycle recorder keeps only safe normalized fields and returns an isolated snapshot', () => {
  const recorder = createLifecycleRecorder({ maxEvents: 4 });
  recorder.record({
    event: 'response.failed',
    timestamp: 'not-a-date',
    sessionId: 42,
    mode: ' source ',
    status: ' failed ',
    sourceCount: '3',
    transcriptLength: '18',
    errorCode: ' MODEL_TIMEOUT ',
    apiKey: 'sk-secret',
    rawAudio: Buffer.from('audio'),
    transcript: 'full private transcript',
    prompt: 'private prompt',
    providerOutput: 'private provider output'
  });

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].event, 'response.failed');
  assert.match(snapshot[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(snapshot[0], {
    event: 'response.failed',
    timestamp: snapshot[0].timestamp,
    sessionId: '42',
    mode: 'source',
    status: 'failed',
    sourceCount: 3,
    transcriptLength: 18,
    errorCode: 'MODEL_TIMEOUT'
  });

  snapshot[0].status = 'mutated';
  assert.equal(recorder.snapshot()[0].status, 'failed');
});

test('injected lifecycle recorder observes safe session, voice, source, digest, and response events', async () => {
  const recorder = createLifecycleRecorder({ maxEvents: 50 });
  const store = new InMemoryStore();
  await withServer({ store, lifecycleRecorder: recorder }, async base => {
    const created = await createSession(base, { sourceMode: 'source' });
    const headers = {
      'content-type': 'application/json',
      'x-session-token': created.token
    };

    const voiceStart = await fetch(`${base}/api/voice/sessions/${created.session.id}/start`, { method: 'POST', headers });
    assert.equal(voiceStart.status, 200);

    const voiceTurn = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ transcript: 'What is the main idea?', transcriptReviewed: true, idempotencyKey: 'lifecycle-voice-1' })
    });
    assert.equal(voiceTurn.status, 200);

    const source = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'notes.txt', text: 'The study used a cohort design to estimate association.' })
    });
    assert.equal(source.status, 201);

    const digest = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    });
    assert.equal(digest.status, 200);
  });

  const events = recorder.snapshot();
  const names = events.map(event => event.event);
  assert.ok(names.includes('session.created'));
  assert.ok(names.includes('voice.started'));
  assert.ok(names.includes('voice.submitted'));
  assert.ok(names.includes('response.completed'));
  assert.ok(names.includes('source.extraction.completed'));
  assert.ok(names.includes('source.digest.completed'));
  assert.ok(events.every(event => !('transcript' in event) && !('rawAudio' in event) && !('prompt' in event)));
});

test('server behavior and responses remain unchanged when no lifecycle recorder is supplied', async () => {
  const store = new InMemoryStore();
  await withServer({ store }, async base => {
    const created = await createSession(base);
    const response = await fetch(`${base}/api/sessions/${created.session.id}`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.session.id, created.session.id);
    assert.equal(body.session.topic, 'Lifecycle event study');

    const diagnostics = await fetch(`${base}/api/diagnostics`);
    assert.equal(diagnostics.status, 404);
  });
});
