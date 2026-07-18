import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRealtimeCall, createRealtimeSession, buildApprovedSpeechRequest, normalizeRealtimeEvent } from '../src/realtime.mjs';
import { createServer } from '../src/server.mjs';

test('realtime adapter source inspection uses the patient shared voice timeout by default', async () => {
  const source = await fs.readFile(new URL('../src/realtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /const defaultVoiceConfig = getVoiceConfig\(\)/);
  assert.match(source, /defaultVoiceConfig\.realtimeTimeoutMs/);
  assert.match(source, /defaultVoiceConfig\.realtimeSilenceMs/);
});

test('realtime adapter explains when server credentials are not configured', async () => {
  await assert.rejects(
    () => createRealtimeSession({ apiKey: '', topic: 'Practice a presentation' }),
    error => error.status === 503 && /not configured/i.test(error.message)
  );
});

test('realtime call configures transcription and server VAD before voice feedback', async () => {
  const result = await createRealtimeCall({
    apiKey: 'test-key',
    sdp: 'v=0',
    topic: 'Presentations',
    fetchImpl: async (_url, options) => {
      const session = JSON.parse(options.body.get('session'));
      assert.equal(session.audio.input.transcription.language, 'en');
      assert.equal(session.audio.input.turn_detection.create_response, false);
      assert.equal(session.audio.input.turn_detection.silence_duration_ms, 5_000);
      assert.equal(session.audio.output.voice, 'marin');
      assert.match(session.instructions, /wait for the browser turn-taking gate/i);
      return { ok: true, text: async () => 'v=0 answer' };
    }
  });
  assert.equal(result.sdp, 'v=0 answer');
});

test('realtime adapter defaults to the current practice round cap', async () => {
  let requestBody;
  await createRealtimeSession({
    apiKey: 'test-key',
    topic: 'Presentations',
    fetchImpl: async (_url, options) => {
      assert.match(_url, /\/v1\/realtime\/client_secrets$/);
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ value: 'ephemeral-secret', expires_at: 123 }) };
    }
  });
  assert.equal(requestBody.session.type, 'realtime');
  assert.match(requestBody.session.instructions, /at most 50 questions/);
});

test('realtime audio transport accepts an audio model independently of the text model', async () => {
  let requestBody;
  await createRealtimeSession({
    apiKey: 'test-key',
    topic: 'Research discussion',
    model: 'gpt-realtime-mini',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ value: 'ephemeral-secret' }) };
    }
  });
  assert.equal(requestBody.session.model, 'gpt-realtime-mini');
  assert.notEqual(requestBody.session.model, 'gpt-5-mini');
});

test('realtime session failure retains only safe upstream diagnostics', async () => {
  await assert.rejects(
    () => createRealtimeSession({
      apiKey: 'test-key',
      topic: 'Research discussion',
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { code: 'rate_limit_exceeded', message: 'Do not expose this provider detail.' } })
      })
    }),
    error => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'REALTIME_INIT_FAILED');
      assert.deepEqual(error.details, { upstreamStatus: 429, providerCode: 'rate_limit_exceeded' });
      assert.doesNotMatch(JSON.stringify(error.details), /provider detail/i);
      return true;
    }
  );
});

test('realtime call converts an upstream timeout into a typed error', async () => {
  await assert.rejects(
    () => createRealtimeCall({
      apiKey: 'test-key',
      sdp: 'v=0',
      topic: 'Presentations',
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        await new Promise((resolve, reject) => {
          if (!signal) return reject(new Error('missing abort signal'));
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      }
    }),
    error => error.status === 504 && error.code === 'REALTIME_TIMEOUT'
  );
});

test('realtime route requires a valid session and gives a typed fallback without a key', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Practice a presentation' })
    });
    const created = await create.json();
    const response = await fetch(`${base}/api/realtime/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ sessionId: created.session.id })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'REALTIME_NOT_CONFIGURED');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('realtime adapter normalizes transcript, playback, and recoverable-error events to the shared client contract', async () => {
  assert.deepEqual(
    normalizeRealtimeEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'What does the paper conclude?', item_id: 'item-1' }),
    { type: 'transcript_finalized', transcript: 'What does the paper conclude?', itemId: 'item-1' }
  );
  assert.deepEqual(
    normalizeRealtimeEvent({ type: 'output_audio_buffer.started' }),
    { type: 'speech_started' }
  );
  assert.deepEqual(
    normalizeRealtimeEvent({ type: 'output_audio_buffer.stopped' }),
    { type: 'speech_ended' }
  );
  assert.deepEqual(
    normalizeRealtimeEvent({ type: 'error', error: { message: 'Temporary disconnect' } }),
    { type: 'recoverable_error', message: 'Temporary disconnect' }
  );
});

test('realtime adapter creates a speak-only approved answer request from backend speech text', async () => {
  assert.deepEqual(
    buildApprovedSpeechRequest('Use spaced retrieval across several short sessions.'),
    {
      type: 'response.create',
      response: {
        instructions: 'Speak exactly this approved answer. Do not add or change anything: Use spaced retrieval across several short sessions.'
      }
    }
  );
});

test('realtime adapter appends a clearly separate external-research segment when provided', async () => {
  assert.deepEqual(
    buildApprovedSpeechRequest(
      'Use spaced retrieval across several short sessions.',
      'External research. From Example Journal retrieved 2026-07-14T12:00:00.000Z: Spacing improves retention over time.'
    ),
    {
      type: 'response.create',
      response: {
        instructions: 'Speak exactly this approved answer, then clearly say the separate external-research segment. Do not add or change anything: Use spaced retrieval across several short sessions. External research. From Example Journal retrieved 2026-07-14T12:00:00.000Z: Spacing improves retention over time.'
      }
    }
  );
});

test('realtime adapter also normalizes planned deepchat2learn namespaced data-channel events', async () => {
  assert.deepEqual(
    normalizeRealtimeEvent({ type: 'deepchat2learn.turn.finalized', transcript: 'Summarize the paper.', item_id: 'ns-1' }),
    { type: 'transcript_finalized', transcript: 'Summarize the paper.', itemId: 'ns-1' }
  );
  assert.deepEqual(
    normalizeRealtimeEvent({
      type: 'deepchat2learn.answer.approved',
      answerSpeechText: 'The paper supports spaced retrieval.',
      externalResearchSpeechText: 'External research. From Example Journal: Spacing improves retention over time.'
    }),
    {
      type: 'answer_approved',
      answerSpeechText: 'The paper supports spaced retrieval.',
      externalResearchSpeechText: 'External research. From Example Journal: Spacing improves retention over time.'
    }
  );
  assert.deepEqual(
    normalizeRealtimeEvent({ type: 'deepchat2learn.turn.error', error: { message: 'Try again shortly.' } }),
    { type: 'recoverable_error', message: 'Try again shortly.' }
  );
});
