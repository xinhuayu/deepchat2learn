import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { HttpError } from '../src/store.mjs';
import { createModelGateway } from '../src/modelGateway.mjs';
import { createModelCoach } from '../src/modelCoach.mjs';

test('model gateway routes known text tasks deterministically and rejects unknown tasks', async () => {
  const calls = [];
  const gateway = createModelGateway({
    textCoach: {
      async initialQuestion(input) {
        calls.push(['initialQuestion', input]);
        return 'Initial question';
      },
      async nextQuestion(input) {
        calls.push(['nextQuestion', input]);
        return 'Next question';
      },
      async sourceQuestion(input) {
        calls.push(['sourceQuestion', input]);
        return 'Source question';
      },
      async evaluateAnswer(input) {
        calls.push(['evaluateAnswer', input]);
        return { nextQuestion: 'Follow-up question' };
      },
      async digestSource(input) {
        calls.push(['digestSource', input]);
        return { digestText: 'Single digest', keyPoints: [], openQuestions: [] };
      },
      async buildConsolidatedDigest(input) {
        calls.push(['buildConsolidatedDigest', input]);
        return { mainArgument: 'Combined digest', keyPoints: [], importantTerms: [], evidence: [], conflicts: [], openQuestions: [] };
      },
      async composeBlendedAnswer(input) {
        calls.push(['composeBlendedAnswer', input]);
        return { answerText: 'Source answer', answerSpeechText: 'Source answer', sourceClaims: [], llmBackground: [], discussionPoints: [], suggestions: [], externalClaims: [], citations: [], externalCitations: [], confidence: 'medium', uncertainty: [], conflicts: [], followUp: 'Another question?' };
      },
      async generalAnswer(question) {
        calls.push(['generalAnswer', question]);
        return { mode: 'general', answer: 'General answer', sourceGroundedClaims: [], additionalContext: [], unsupportedOrUnresolved: [], confidence: 'medium' };
      }
    },
    realtimeFactory: {
      async createRealtimeCall() {
        throw new Error('not used in this test');
      }
    },
    config: {
      summaryHandler(input) {
        calls.push(['summaryHandler', input]);
        return { summary: `Summary for ${input.topic}` };
      }
    }
  });

  assert.equal(await gateway.runTextTask({ task: 'question', input: { mode: 'initial', topic: 'Topic' } }), 'Initial question');
  assert.equal(await gateway.runTextTask({ task: 'question', input: { mode: 'next', topic: 'Topic', previousQuestion: 'Before?' } }), 'Next question');
  assert.equal(await gateway.runTextTask({ task: 'question', input: { mode: 'source', topic: 'Topic', sources: [] } }), 'Source question');
  assert.deepEqual(await gateway.runTextTask({ task: 'practice_evaluation', input: { answer: 'An answer' } }), { nextQuestion: 'Follow-up question' });
  assert.deepEqual(await gateway.runTextTask({ task: 'source_digest', input: { id: 'source-1', name: 'paper.txt', text: 'hello world' } }), { digestText: 'Single digest', keyPoints: [], openQuestions: [] });
  assert.deepEqual(await gateway.runTextTask({ task: 'source_digest', input: { sources: [{ id: 'source-1' }], chunks: [{ id: 'chunk-1', text: 'hello world' }] } }), { mainArgument: 'Combined digest', keyPoints: [], importantTerms: [], evidence: [], conflicts: [], openQuestions: [] });
  assert.equal((await gateway.runTextTask({ task: 'source_answer', input: { userQuestion: 'What does the paper say?' } })).answerText, 'Source answer');
  assert.equal((await gateway.runTextTask({ task: 'general_answer', input: { question: 'What is structure?' } })).answer, 'General answer');
  assert.deepEqual(await gateway.runTextTask({ task: 'summary', input: { topic: 'Topic' } }), { summary: 'Summary for Topic' });

  assert.deepEqual(calls.map(([name]) => name), [
    'initialQuestion',
    'nextQuestion',
    'sourceQuestion',
    'evaluateAnswer',
    'digestSource',
    'buildConsolidatedDigest',
    'composeBlendedAnswer',
    'generalAnswer',
    'summaryHandler'
  ]);

  await assert.rejects(
    () => gateway.runTextTask({ task: 'question', input: { topic: 'Missing mode' } }),
    error => error.code === 'MODEL_GATEWAY_VALIDATION' && /question\.mode/i.test(error.message)
  );

  await assert.rejects(
    () => gateway.runTextTask({ task: 'not_a_real_task', input: {} }),
    error => error.code === 'MODEL_GATEWAY_TASK_UNSUPPORTED' && error.status === 400
  );
});

test('model gateway retries bounded transient failures and stops retrying validation failures', async () => {
  let transientAttempts = 0;
  const transientGateway = createModelGateway({
    textCoach: {
      async generalAnswer() {
        transientAttempts += 1;
        if (transientAttempts < 3) {
          throw new HttpError(502, 'Temporary upstream issue.', 'MODEL_REQUEST_FAILED');
        }
        return { mode: 'general', answer: 'Recovered answer', sourceGroundedClaims: [], additionalContext: [], unsupportedOrUnresolved: [], confidence: 'medium' };
      }
    },
    realtimeFactory: { async createRealtimeCall() { throw new Error('unused'); } },
    config: { maxTransientRetries: 2, timeoutMs: 100 }
  });

  const recovered = await transientGateway.runTextTask({ task: 'general_answer', input: { question: 'Recover?' } });
  assert.equal(recovered.answer, 'Recovered answer');
  assert.equal(transientAttempts, 3);

  let validationAttempts = 0;
  const validationGateway = createModelGateway({
    textCoach: {
      async generalAnswer() {
        validationAttempts += 1;
        throw new HttpError(502, 'The model returned invalid output.', 'MODEL_OUTPUT_INVALID');
      }
    },
    realtimeFactory: { async createRealtimeCall() { throw new Error('unused'); } },
    config: { maxTransientRetries: 3, timeoutMs: 100 }
  });

  await assert.rejects(
    () => validationGateway.runTextTask({ task: 'general_answer', input: { question: 'Retry?' } }),
    error => error.code === 'MODEL_GATEWAY_VALIDATION' && error.details?.retryable === false
  );
  assert.equal(validationAttempts, 1);
});

test('model gateway returns typed timeout errors that preserve caller input for retry', async () => {
  let underlyingAborted = false;
  const gateway = createModelGateway({
    textCoach: {
      async generalAnswer(_question, { signal } = {}) {
        return await new Promise(resolve => {
          signal?.addEventListener('abort', () => {
            underlyingAborted = true;
            resolve({});
          }, { once: true });
        });
      }
    },
    realtimeFactory: { async createRealtimeCall() { throw new Error('unused'); } },
    config: { timeoutMs: 20, maxTransientRetries: 2 }
  });

  await assert.rejects(
    () => gateway.runTextTask({ task: 'general_answer', input: { question: 'What is structure?' } }),
    error => error.status === 504
      && error.code === 'MODEL_GATEWAY_TIMEOUT'
      && error.details?.input?.question === 'What is structure?'
      && error.details?.task === 'general_answer'
  );
  assert.equal(underlyingAborted, true);
});

test('model gateway retries a gateway-owned deadline once before succeeding', async () => {
  let attempts = 0;
  const gateway = createModelGateway({
    textCoach: {
      async generalAnswer(_question, { signal } = {}) {
        attempts += 1;
        if (attempts === 1) {
          await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
          return { mode: 'general', answer: 'late', sourceGroundedClaims: [], additionalContext: [], unsupportedOrUnresolved: [], confidence: 'low' };
        }
        return { mode: 'general', answer: 'Recovered after the deadline retry.', sourceGroundedClaims: [], additionalContext: [], unsupportedOrUnresolved: [], confidence: 'high' };
      }
    },
    config: { timeoutMs: 10, maxTransientRetries: 1 }
  });

  const result = await gateway.runTextTask({ task: 'general_answer', input: { question: 'Retry a deadline.' } });
  assert.equal(result.answer, 'Recovered after the deadline retry.');
  assert.equal(attempts, 2);
});

test('model gateway forwards caller AbortSignal to the text handler', async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const gateway = createModelGateway({
    textCoach: {
      async generalAnswer(question, { signal } = {}) {
        receivedSignal = signal;
        await new Promise(resolve => setTimeout(resolve, 50));
        return { mode: 'general', answer: `Answer for ${question}`, sourceGroundedClaims: [], additionalContext: [], unsupportedOrUnresolved: [], confidence: 'medium' };
      }
    },
    config: { timeoutMs: 200 }
  });

  const pending = gateway.runTextTask({
    task: 'general_answer',
    input: { question: 'Cancel this task.' },
    signal: controller.signal
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();

  await assert.rejects(pending, error => error.code === 'MODEL_GATEWAY_TIMEOUT');
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, true);
});

test('model coach forwards gateway cancellation to its provider fetch', async () => {
  const controller = new AbortController();
  let providerSignal = null;
  let providerAborted = false;
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      providerSignal = options.signal;
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          providerAborted = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      return { ok: true, async json() { return {}; } };
    }
  });

  const pending = coach.generalAnswer('Cancel the provider request.', { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();

  await assert.rejects(pending, error => error.code === 'MODEL_TIMEOUT');
  assert.ok(providerSignal instanceof AbortSignal);
  assert.equal(providerAborted, true);
});

test('model gateway falls back deterministically after bounded transient retries', async () => {
  let primaryAttempts = 0;
  let fallbackCalls = 0;
  const gateway = createModelGateway({
    textCoach: {
      async generalAnswer() {
        primaryAttempts += 1;
        throw new HttpError(502, 'Temporary upstream issue.', 'MODEL_REQUEST_FAILED');
      }
    },
    realtimeFactory: { async createRealtimeCall() { throw new Error('unused'); } },
    config: {
      timeoutMs: 100,
      maxTransientRetries: 1,
      fallbackTextCoach: {
        async generalAnswer(question) {
          fallbackCalls += 1;
          return { mode: 'general', answer: `Fallback answer for ${question}`, sourceGroundedClaims: [], additionalContext: [], unsupportedOrUnresolved: [], confidence: 'medium' };
        }
      }
    }
  });

  const result = await gateway.runTextTask({ task: 'general_answer', input: { question: 'Fallback?' } });
  assert.equal(result.answer, 'Fallback answer for Fallback?');
  assert.equal(primaryAttempts, 2);
  assert.equal(fallbackCalls, 1);
});

test('model gateway uses a separate realtime factory and does not route realtime through text tasks', async () => {
  let textCalls = 0;
  let realtimeCalls = 0;
  const gateway = createModelGateway({
    textCoach: {
      async generalAnswer() {
        textCalls += 1;
        return { mode: 'general', answer: 'unused', sourceGroundedClaims: [], additionalContext: [], unsupportedOrUnresolved: [], confidence: 'medium' };
      }
    },
    realtimeFactory: {
      async createRealtimeCall({ session, sdp, signal }) {
        realtimeCalls += 1;
        assert.equal(session.id, 'session-1');
        assert.equal(sdp, 'v=0');
        assert.equal(signal, null);
        return { sdp: 'gateway-answer', model: 'audio-model' };
      }
    }
  });

  const call = await gateway.createRealtimeCall({ session: { id: 'session-1' }, sdp: 'v=0', signal: null });
  assert.deepEqual(call, { sdp: 'gateway-answer', model: 'audio-model' });
  assert.equal(realtimeCalls, 1);
  assert.equal(textCalls, 0);
});

test('server uses the model gateway on direct general-answer, digest, and realtime-call paths', async () => {
  const gatewayCalls = [];
  const server = createServer({
    coach: {
      async initialQuestion() {
        throw new Error('initialQuestion should not run directly when the gateway is present.');
      },
      async generalAnswer() {
        throw new Error('generalAnswer should not run directly when the gateway is present.');
      },
      async digestSource() {
        throw new Error('digestSource should not run directly when the gateway is present.');
      },
      async buildConsolidatedDigest() {
        throw new Error('buildConsolidatedDigest should not run directly when the gateway is present.');
      }
    },
    modelGateway: {
      async runTextTask({ task, input }) {
        gatewayCalls.push({ task, input });
        if (task === 'question' && input?.mode === 'initial') {
          return 'Gateway opening question?';
        }
        if (task === 'general_answer') {
          return {
            mode: 'general',
            answer: 'Gateway general answer.',
            sourceGroundedClaims: [],
            additionalContext: [],
            unsupportedOrUnresolved: [],
            confidence: 'medium'
          };
        }
        if (task === 'source_digest' && Array.isArray(input?.sources)) {
          return {
            mainArgument: 'Gateway consolidated digest.',
            keyPoints: [],
            importantTerms: [],
            evidence: [],
            conflicts: [],
            openQuestions: []
          };
        }
        if (task === 'source_digest') {
          return {
            mode: 'model',
            digestText: 'Gateway source digest.',
            keyPoints: [],
            openQuestions: []
          };
        }
        throw new Error(`Unexpected task ${task}`);
      },
      async createRealtimeCall({ session, sdp }) {
        gatewayCalls.push({ task: 'realtime_call', sessionId: session.id, sdp });
        return { sdp: 'gateway-sdp', model: 'gpt-realtime-mini' };
      }
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;

    const createdResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Gateway integration' })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(gatewayCalls[0].task, 'question');

    const answerResponse = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ mode: 'general', question: 'What is structure?' })
    });
    assert.equal(answerResponse.status, 200);
    const answerBody = await answerResponse.json();
    assert.equal(answerBody.answer, 'Gateway general answer.');

    const uploadResponse = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'The source says retrieval practice improves retention over time.' })
    });
    assert.equal(uploadResponse.status, 201);
    const uploadBody = await uploadResponse.json();
    assert.equal(uploadBody.digest.digestText, 'Gateway source digest.');

    const digestResponse = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    assert.equal(digestResponse.status, 200);
    const digestBody = await digestResponse.json();
    assert.equal(digestBody.digest.mainArgument, 'Gateway consolidated digest.');

    const realtimeResponse = await fetch(`${base}/api/realtime/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ sessionId: created.session.id, sdp: 'v=0' })
    });
    assert.equal(realtimeResponse.status, 200);
    assert.deepEqual(await realtimeResponse.json(), { sdp: 'gateway-sdp', model: 'gpt-realtime-mini' });

    assert.deepEqual(
      gatewayCalls.map(call => call.task),
      ['question', 'general_answer', 'source_digest', 'source_digest', 'realtime_call']
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
