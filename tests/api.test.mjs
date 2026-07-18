import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { InMemoryStore, HttpError } from '../src/store.mjs';

async function withServer(run) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await run(`http://${address.address}:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function withEnv(overrides, run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('static PNG assets have an image content type', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/brand-logo.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^image\/png(?:;|$)/i);
  });
});

test('health reports unavailable realtime after a sanitized initialization failure', async () => {
  const entries = [];
  const realtimeSessionFactory = async () => {
    const error = new HttpError(502, 'Live AI voice could not be initialized. Continue by typing.', 'REALTIME_INIT_FAILED');
    error.details = { upstreamStatus: 429, providerCode: 'rate_limit_exceeded', rawProviderMessage: 'sk-live-secret-value' };
    throw error;
  };
  const server = createServer({ realtimeSessionFactory, logger: { info: entry => entries.push(entry) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const created = await (await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Realtime availability' })
    })).json();
    const failed = await fetch(`${base}/api/realtime/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ sessionId: created.session.id })
    });
    assert.equal(failed.status, 502);
    const failedBody = await failed.json();
    assert.equal(failedBody.error.upstreamStatus, 429);
    assert.equal(failedBody.error.providerCode, 'rate_limit_exceeded');
    assert.doesNotMatch(JSON.stringify(failedBody), /sk-live-secret-value/);

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.connection.realtimeVoice, 'unavailable');
    assert.equal(health.connection.realtimeLastError, 'REALTIME_INIT_FAILED');
    assert.equal(health.connection.realtimeUpstreamStatus, 429);
    const failureLog = entries.find(entry => entry.path === '/api/realtime/session');
    assert.equal(failureLog?.errorCode, 'REALTIME_INIT_FAILED');
    assert.equal(failureLog?.realtimeUpstreamStatus, 429);
    assert.equal(failureLog?.realtimeProviderCode, 'rate_limit_exceeded');
    assert.doesNotMatch(JSON.stringify(failureLog), /sk-live-secret-value/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('failed initial question generation does not orphan a created session', async () => {
  const store = new InMemoryStore();
  const server = createServer({ store, coach: { initialQuestion: async () => { throw new Error('model unavailable'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://${address.address}:${address.port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Explain a difficult concept' })
    });
    assert.equal(response.status, 500);
    assert.equal(store.sessions.size, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('walking skeleton completes topic, answer, feedback, follow-up, and summary', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Explain a difficult concept' })
    });
    assert.equal(create.status, 201);
    const created = await create.json();
    assert.ok(created.session.id);
    assert.ok(created.token);

    const turn = await fetch(`${base}/api/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-token': created.token,
        'idempotency-key': 'turn-1'
      },
      body: JSON.stringify({ answer: 'I would start with the main idea and then provide a concrete example.' })
    });
    assert.equal(turn.status, 200);
    const turnBody = await turn.json();
    assert.equal(turnBody.feedback.strengths.length, 2);
    assert.ok(turnBody.feedback.academicAssessment);
    assert.equal(typeof turnBody.feedback.academicResponse, 'string');
    assert.ok(turnBody.nextQuestion);

    const repeated = await fetch(`${base}/api/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-token': created.token,
        'idempotency-key': 'turn-1'
      },
      body: JSON.stringify({ answer: 'This should return the first result.' })
    });
    assert.deepEqual(await repeated.json(), turnBody);

    const summary = await fetch(`${base}/api/sessions/${created.session.id}/complete`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(summary.status, 200);
    const summaryBody = await summary.json();
    assert.equal(summaryBody.summary.completedTurns, 1);
    assert.equal(summaryBody.summary.turnCount, 1);
    assert.deepEqual(summaryBody.summary.learnedConcepts, [turnBody.feedback.academicResponse]);
    assert.deepEqual(summaryBody.summary.unresolvedQuestions, []);
    assert.deepEqual(summaryBody.summary.sourceCoverage, []);
    assert.deepEqual(summaryBody.summary.recurringStrengths, turnBody.feedback.strengths);
    assert.deepEqual(summaryBody.summary.recurringGaps, [turnBody.feedback.improvement]);
    assert.deepEqual(summaryBody.summary.nextSteps, [turnBody.feedback.improvement]);
    assert.ok(summaryBody.summary.nextPractice);
  });
});

test('session creation supports up to fifty answer rounds', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Extended voice practice', questionLimit: 50 })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.session.questionLimit, 50);
  });
});

test('new sessions default to the mode-specific round limit when none is supplied', async () => {
  await withServer(async base => {
    const practiceResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Default practice limit' })
    });
    assert.equal(practiceResponse.status, 201);
    const practice = await practiceResponse.json();
    assert.equal(practice.session.questionLimit, 50);

    const sourceResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Default source limit', sourceMode: 'source' })
    });
    assert.equal(sourceResponse.status, 201);
    const source = await sourceResponse.json();
    assert.equal(source.session.questionLimit, 200);
    assert.equal(source.session.goal, 'structure');
    assert.equal(source.session.difficulty, 'intermediate');
    assert.equal(source.session.feedbackStyle, 'socratic');
  });
});

test('source sessions resolve explicit and automatic skill selection', async () => {
  await withServer(async base => {
    const explicit = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Discuss this paper', sourceMode: 'source', skillId: 'epi-research' })
    });
    assert.equal(explicit.status, 201);
    const explicitBody = await explicit.json();
    assert.equal(explicitBody.session.skillId, 'epi-research');
    assert.equal(explicitBody.session.activeSkillId, 'epi-research');
    assert.equal(explicitBody.session.conversationSkillId, 'academic-conversation');

    const automatic = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Critique this epidemiology cohort study', sourceMode: 'source' })
    });
    assert.equal(automatic.status, 201);
    const automaticBody = await automatic.json();
    assert.equal(automaticBody.session.skillId, 'auto');
    assert.equal(automaticBody.session.activeSkillId, 'epi-research');
    assert.equal(automaticBody.session.conversationSkillId, 'academic-conversation');
    assert.match(automaticBody.session.skillSelectionReason, /automatic/i);

    const general = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Explain these lecture notes', sourceMode: 'source', skillId: 'none' })
    });
    assert.equal(general.status, 201);
    const generalBody = await general.json();
    assert.equal(generalBody.session.activeSkillId, 'none');
    assert.equal(generalBody.session.conversationSkillId, 'academic-conversation');
  });
});

test('session creation rejects unsupported skill ids', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Review this paper', sourceMode: 'source', skillId: 'unknown-skill' })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'SKILL_INVALID');
  });
});

test('source sessions support up to two hundred answer rounds and receive a matching turn budget', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Long source conversation', sourceMode: 'source', questionLimit: 200 })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.session.questionLimit, 200);
    assert.equal(body.session.turnBudget, 200);
  });
});

test('practice sessions reject a question limit above fifty', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Practice limit', sourceMode: 'none', questionLimit: 51 })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'QUESTION_LIMIT_INVALID');
  });
});

test('completed sessions reject new answer submissions', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Finish a session', questionLimit: 3 })
    });
    const created = await create.json();
    const complete = await fetch(`${base}/api/sessions/${created.session.id}/complete`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(complete.status, 200);

    const turn = await fetch(`${base}/api/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ answer: 'This answer should be rejected after completion.' })
    });
    assert.equal(turn.status, 409);
    assert.equal((await turn.json()).error.code, 'SESSION_COMPLETED');
  });
});

test('completed sessions reject new source-question prompts', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Finish source practice', sourceMode: 'source' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'notes.txt', text: 'The source explains a useful study method.' })
    });
    await fetch(`${base}/api/sessions/${created.session.id}/complete`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });

    const prompt = await fetch(`${base}/api/sessions/${created.session.id}/source-prompts`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(prompt.status, 409);
    assert.equal((await prompt.json()).error.code, 'SESSION_COMPLETED');
  });
});

test('completed sessions reject new source uploads', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Freeze source materials' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/complete`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });

    const source = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'late.txt', text: 'This source should not be added after completion.' })
    });
    assert.equal(source.status, 409);
    assert.equal((await source.json()).error.code, 'SESSION_COMPLETED');
  });
});

test('sessions at the question limit reject source uploads before completion', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Lock after final answer', questionLimit: 1 })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ answer: 'The main point is clear and supported by one example.' })
    });

    const source = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'late.txt', text: 'This source arrives after the final answer.' })
    });
    assert.equal(source.status, 409);
    assert.equal((await source.json()).error.code, 'SESSION_COMPLETE');
  });
});

test('completed sessions reject source deletion', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Keep source materials' })
    });
    const created = await create.json();
    const source = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'keep.txt', text: 'This source should remain after completion.' })
    });
    const sourceBody = await source.json();
    await fetch(`${base}/api/sessions/${created.session.id}/complete`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });

    const deleted = await fetch(`${base}/api/sessions/${created.session.id}/sources/${sourceBody.source.id}`, {
      method: 'DELETE',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(deleted.status, 409);
    assert.equal((await deleted.json()).error.code, 'SESSION_COMPLETED');
  });
});

test('health endpoint reports service readiness without a session token', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      service: 'deepchat2learn',
      capabilities: { textCoach: 'local-demo', realtimeVoice: false, storage: 'memory' },
      connection: { textModel: 'local-demo', realtimeVoice: 'not_configured' },
      voice: {
        autoSubmitDelayMs: 5_000,
        transitionDelayMs: 750,
        realtimeSilenceMs: 5_000,
        realtimeWatchdogMs: 0,
        maxRecognitionRetries: 8,
        transcriptMaxCharacters: 12_000,
        textTimeoutMs: 120_000,
        sourceDigestTimeoutMs: 300_000,
        realtimeTimeoutMs: 120_000
      },
      sourceLimits: {
        maxFiles: 10,
        maxFileBytes: 20_000_000,
        maxCombinedBytes: 50_000_000,
        maxPages: 300,
        maxWords: 150_000,
        maxPastedCharacters: 200_000
      },
      privacy: {
        defaultRetentionMode: 'session',
        audioStorage: 'never'
      },
      budgets: {
        turnBudget: 50,
        modelTokenBudget: 120_000
      }
    });
  });
});

test('API maintenance prunes rate limits and expired sessions before handling requests', async () => {
  const store = new InMemoryStore();
  let cleanupCalls = 0;
  const cleanup = store.cleanupExpired.bind(store);
  store.cleanupExpired = () => {
    cleanupCalls += 1;
    return cleanup();
  };
  let pruneCalls = 0;
  const server = createServer({
    store,
    rateLimiter: { prune() { pruneCalls += 1; }, check() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://${address.address}:${address.port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Maintenance check' })
    });
    assert.equal(response.status, 201);
    assert.equal(pruneCalls, 1);
    assert.equal(cleanupCalls, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('health endpoint advertises model and realtime readiness when a server key is configured', async () => {
  await withEnv({ OPENAI_API_KEY: 'test-only-placeholder' }, async () => {
    await withServer(async base => {
      const response = await fetch(`${base}/api/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.capabilities.textCoach, 'model');
      assert.equal(body.capabilities.realtimeVoice, true);
      assert.equal(body.connection.textModel, 'configured');
      assert.equal(body.connection.realtimeVoice, 'configured');
      assert.equal(body.capabilities.storage, 'memory');
    });
  });
});

test('API and static responses include baseline browser security headers', async () => {
  await withServer(async base => {
    const apiResponse = await fetch(`${base}/api/health`);
    const pageResponse = await fetch(`${base}/`);
    for (const response of [apiResponse, pageResponse]) {
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('permissions-policy'), 'microphone=(self)');
      assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
  });
});

test('source question endpoint distinguishes source evidence from general context', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Study a paper' })
    });
    const created = await create.json();
    const source = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'notes.txt', text: 'The paper argues that spaced practice improves long-term retention.' })
    });
    assert.equal(source.status, 201);
    const sourceBody = await source.json();
    assert.equal(sourceBody.source.status, 'digesting');
    assert.equal(sourceBody.source.digestStatus, 'queued');
    assert.deepEqual(sourceBody.source.metrics, {
      bytes: Buffer.byteLength('The paper argues that spaced practice improves long-term retention.', 'utf8'),
      words: 9,
      pages: null,
      chunkCount: 1,
      tableCount: 0,
      figureCount: 0,
      captionCount: 0,
      extractionMethod: 'text-direct'
    });

    const sources = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(sources.status, 200);
    const sourcesBody = await sources.json();
    assert.deepEqual(sourcesBody.sources.map(item => item.name), ['notes.txt']);
    assert.equal(sourcesBody.digestStatus, 'queued');
    assert.equal(sourcesBody.sources[0].status, 'digesting');
    assert.equal(sourcesBody.sources[0].digestStatus, 'queued');
    assert.equal(sourcesBody.sources[0].metrics.chunkCount, 1);
    assert.match(sourcesBody.sources[0].digest.digestText, /spaced practice improves/);

    const digest = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    assert.equal(digest.status, 200);
    assert.equal((await digest.json()).status, 'ready');

    const answer = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ mode: 'source', question: 'What does the paper say improves retention?' })
    });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.equal(body.mode, 'source');
    assert.ok(body.sourceGroundedClaims.length > 0);
    assert.match(body.answer, /spaced practice improves/i);
    assert.equal(body.sourceDigestStatus || '', '');
  });
});

test('source and general questions preserve their answer modes', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Study a paper', sourceMode: 'source' })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'notes.txt', text: 'Spaced practice improves long-term retention.' })
    });
    const digest = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    });
    assert.equal(digest.status, 200);
    assert.equal((await digest.json()).status, 'ready');

    const sourceResponse = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST', headers, body: JSON.stringify({ mode: 'source', question: 'What improves retention?' })
    });
    const sourceAnswer = await sourceResponse.json();
    assert.equal(sourceAnswer.mode, 'source');
    assert.equal(sourceAnswer.sourceGroundedClaims.length, 1);

    const generalResponse = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST', headers, body: JSON.stringify({ mode: 'general', question: 'What is one useful study habit?' })
    });
    const generalAnswer = await generalResponse.json();
    assert.equal(generalAnswer.mode, 'general');
    assert.deepEqual(generalAnswer.sourceGroundedClaims, []);
  });
});

test('typed source questions enforce the selected question limit', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Typed source limit', sourceMode: 'source', questionLimit: 1 })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'notes.txt', text: 'The source explains a useful study method.' })
    });

    const first = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST', headers,
      body: JSON.stringify({ mode: 'source', question: 'What does the source explain?' })
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.done, true);
    assert.equal(firstBody.session.status, 'ready_to_complete');
    assert.equal(firstBody.session.turnCount, 1);

    const second = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST', headers,
      body: JSON.stringify({ mode: 'source', question: 'What should I compare next?' })
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, 'SESSION_COMPLETE');
  });
});

test('duplicate typed source questions replay before consuming model budget', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Typed idempotency', sourceMode: 'source' })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'notes.txt', text: 'The source describes a longitudinal study design.' })
    });
    const body = JSON.stringify({ mode: 'source', question: 'What is the main idea?', idempotencyKey: 'typed-replay-1' });

    const firstResponse = await fetch(`${base}/api/sessions/${created.session.id}/questions`, { method: 'POST', headers, body });
    const first = await firstResponse.json();
    const firstTokens = first.session.modelTokensUsed;
    const secondResponse = await fetch(`${base}/api/sessions/${created.session.id}/questions`, { method: 'POST', headers, body });
    const second = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(second.turn, first.turn);
    assert.equal(second.session.modelTokensUsed, firstTokens);
  });
});

test('typed source questions reject completed sessions', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Completed typed source session', sourceMode: 'source' })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'notes.txt', text: 'The source explains a useful study method.' })
    });
    await fetch(`${base}/api/sessions/${created.session.id}/complete`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });

    const response = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST', headers,
      body: JSON.stringify({ mode: 'source', question: 'Can I ask after completion?' })
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'SESSION_COMPLETED');
  });
});

test('turn evaluation receives the session sources for grounded coaching', async () => {
  let evaluation;
  const coach = {
    initialQuestion: async () => 'What is the main claim?',
    evaluateAnswer: async input => {
      evaluation = input;
      return {
        strengths: ['A clear claim.', 'A relevant explanation.'],
        improvement: 'Add one supporting detail.',
        exampleAnswer: 'A stronger answer adds evidence.',
        scores: { clarity: 4, relevance: 4, structure: 3, completeness: 3, specificity: 3 },
        evidence: ['The paper says...'],
        nextQuestion: 'What evidence supports that claim?'
      };
    }
  };
  const server = createServer({ coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Explain a paper', sourceMode: 'source', skillId: 'epi-research' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'The paper says spaced practice improves retention.' })
    });
    await fetch(`${base}/api/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ answer: 'The paper says spaced practice improves retention.' })
    });
    assert.equal(evaluation.sources[0].name, 'paper.txt');
    assert.match(evaluation.sources[0].text, /spaced practice improves retention/i);
    assert.equal(evaluation.skillProfile.id, 'academic-conversation');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('voice turns enforce the selected question limit and mark the session complete', async () => {
  const coach = {
    initialQuestion: async () => 'Explain the main idea.',
    evaluateAnswer: async () => ({
      strengths: ['Clear point.', 'Relevant detail.'],
      improvement: 'Add one example.',
      exampleAnswer: 'A stronger answer adds one example.',
      scores: { clarity: 4, relevance: 4, structure: 4, completeness: 3, specificity: 3 },
      evidence: [],
      nextQuestion: 'What is one example?'
    })
  };
  const server = createServer({ coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Voice limit', questionLimit: 1 })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    const first = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST', headers,
      body: JSON.stringify({ transcript: 'The main idea is clear and useful.', idempotencyKey: 'voice-limit-1' })
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstBody.done, true);
    const second = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST', headers,
      body: JSON.stringify({ transcript: 'Here is another answer.', idempotencyKey: 'voice-limit-2' })
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, 'SESSION_COMPLETE');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('voice turn endpoint answers a spoken material question with the approved response envelope and idempotent replay', async () => {
  const coach = {
    initialQuestion: async () => 'What is the main claim?',
    composeBlendedAnswer: async ({ retrievedChunks }) => ({
      answerText: 'The paper says spaced practice improves long-term retention.',
      answerSpeechText: 'The paper says spaced practice improves long-term retention.',
      sourceClaims: [{
        claim: 'The paper says spaced practice improves long-term retention.',
        chunkId: retrievedChunks[0].id,
        citationExcerpt: 'Spaced practice improves long-term retention.'
      }],
      llmBackground: ['This is a study strategy claim.'],
      externalClaims: [],
      citations: [{
        sourceId: retrievedChunks[0].sourceId,
        chunkId: retrievedChunks[0].id,
        excerpt: 'Spaced practice improves long-term retention.'
      }],
      externalCitations: [],
      confidence: 'high',
      uncertainty: [],
      conflicts: [],
      followUp: 'Would you like the page reference too?'
    })
  };
  const store = new InMemoryStore();
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Study a paper', sourceMode: 'source' })
    });
    const created = await create.json();
    const source = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'Spaced practice improves long-term retention.' })
    });
    const sourceBody = await source.json();
    assert.equal(source.status, 201);
    const digest = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    assert.equal(digest.status, 200);
    assert.equal((await digest.json()).status, 'ready');

    const answer = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        idempotencyKey: 'voice-api-turn-1',
        transcript: 'Explain the main point in my paper.',
        transcriptConfidence: 0.92,
        transcriptReviewed: false
      })
    });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.equal(body.turn.status, 'answered');
    assert.equal(body.turn.intent, 'source_question');
    assert.equal(body.answerSpeechText, 'The paper says spaced practice improves long-term retention. This is a study strategy claim. Would you like the page reference too?');
    assert.deepEqual(body.knowledgeLayers, ['source', 'llm']);
    assert.equal(body.citations[0].sourceId, sourceBody.source.id);
    assert.equal(body.confidence, 'high');
    assert.equal(body.nextState, 'speaking_answer');
    assert.equal(body.requiresExternalConsent, false);

    const sessionResponse = await fetch(`${base}/api/sessions/${created.session.id}`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(sessionResponse.status, 200);
    const sessionAfterFirstTurn = await sessionResponse.json();
    assert.equal(sessionAfterFirstTurn.session.turnCount, 1);
    const modelTokensAfterFirstTurn = sessionAfterFirstTurn.session.modelTokensUsed;

    const replay = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        idempotencyKey: 'voice-api-turn-1',
        transcript: 'A different transcript should replay the original result.',
        transcriptConfidence: 0.1,
        transcriptReviewed: true
      })
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), body);
    assert.equal(store.get(created.session.id).voiceTurns.length, 1);
    assert.equal(store.get(created.session.id).modelTokensUsed, modelTokensAfterFirstTurn);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('source questions use extracted material while the consolidated digest is still building', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Digest readiness', sourceMode: 'source' })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'notes.txt', text: 'The source explains why retrieval practice helps memory.' })
    });

    const answer = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: 'source', question: 'What does the source say about memory?' })
    });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.equal(body.mode, 'source');
    assert.ok(body.sourceGroundedClaims.length > 0);
    assert.match(body.sourceDigestStatus, /fuller cross-source overview/i);
  });
});

test('voice source questions use extracted material while the consolidated digest is still building', async () => {
  const coach = {
    initialQuestion: async () => 'What is the main claim?',
    composeBlendedAnswer: async ({ retrievedChunks }) => {
      const chunk = retrievedChunks[0];
      const excerpt = chunk.text;
      return {
        answerText: 'The paper says retrieval practice improves learning outcomes.',
        answerSpeechText: 'The paper says retrieval practice improves learning outcomes.',
        sourceClaims: [{ claim: excerpt, chunkId: chunk.id, citationExcerpt: excerpt }],
        llmBackground: [],
        discussionPoints: [],
        suggestions: [],
        externalClaims: [],
        citations: [{ sourceId: chunk.sourceId, chunkId: chunk.id, excerpt }],
        externalCitations: [],
        confidence: 'high',
        uncertainty: [],
        conflicts: [],
        followUp: 'What outcome did the paper emphasize?'
      };
    }
  };
  const server = createServer({ coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Voice digest readiness', sourceMode: 'source' })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'paper.txt', text: 'Retrieval practice improves learning outcomes.' })
    });

    const answer = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'voice-pending-digest-1',
        transcript: 'What does my paper say?',
        transcriptConfidence: 0.91,
        transcriptReviewed: true
      })
    });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.deepEqual(body.knowledgeLayers, ['source']);
    assert.match(body.sourceDigestStatus, /fuller cross-source overview/i);
    assert.equal(body.citations.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('source voice answers report unsupported materials separately from service failures or external consent', async () => {
  const coach = {
    initialQuestion: async () => 'What does the source say about attrition bias?',
    composeBlendedAnswer: async () => ({
      answerText: 'I could not find enough support in your supplied materials to answer that confidently.',
      answerSpeechText: 'I could not find enough support in your supplied materials to answer that confidently.',
      sourceClaims: [],
      llmBackground: [],
      discussionPoints: [],
      suggestions: ['Ask about a passage the supplied materials mention more directly.'],
      externalClaims: [],
      citations: [],
      externalCitations: [],
      confidence: 'low',
      uncertainty: ['I could not find enough support in your supplied materials to answer that confidently.'],
      conflicts: [],
      followUp: 'Would you like to ask about something the sources mention more directly?'
    })
  };
  const server = createServer({ coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Unsupported source answer', sourceMode: 'source' })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'paper.txt', text: 'Spaced practice improves retention.' })
    });
    const digest = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    });
    assert.equal(digest.status, 200);

    const answer = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'voice-source-unsupported-1',
        transcript: 'What does the source say about attrition bias?',
        transcriptConfidence: 0.9,
        transcriptReviewed: true
      })
    });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.equal(body.sourceSupportStatus, 'not_in_sources');
    assert.equal(body.externalKnowledgeStatus, 'not_requested');
    assert.equal(body.requiresExternalConsent, false);
    assert.deepEqual(body.citations, []);
    assert.match(body.answerText, /could not find enough support/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('temporary voice-turn failure does not consume a completed round and the same transcript can be retried with the same idempotency key', async () => {
  let attempts = 0;
  const coach = {
    initialQuestion: async () => 'What is the main idea?',
    generalAnswer: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new HttpError(503, 'The academic voice service is temporarily unavailable.', 'VOICE_TEMPORARY_FAILURE');
      }
      return {
        mode: 'general',
        answer: 'Start with the main idea, then add one example.',
        sourceGroundedClaims: [],
        additionalContext: [],
        unsupportedOrUnresolved: [],
        confidence: 'medium'
      };
    }
  };
  const store = new InMemoryStore();
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Retryable voice failure' })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    const transcript = 'What is one useful study habit?';

    const failed = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'voice-retryable-1',
        transcript,
        transcriptConfidence: 0.88,
        transcriptReviewed: true
      })
    });
    assert.equal(failed.status, 503);
    const failedBody = await failed.json();
    assert.equal(failedBody.error.code, 'VOICE_TEMPORARY_FAILURE');

    const afterFailure = await fetch(`${base}/api/sessions/${created.session.id}`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(afterFailure.status, 200);
    const sessionAfterFailure = await afterFailure.json();
    assert.equal(sessionAfterFailure.session.turnCount, 0);
    assert.equal(sessionAfterFailure.session.currentQuestion, 'What is the main idea?');
    assert.equal(store.get(created.session.id).voiceTurns.length, 0);

    const retry = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'voice-retryable-1',
        transcript,
        transcriptConfidence: 0.88,
        transcriptReviewed: true
      })
    });
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.turn.transcript, transcript);
    assert.equal(retryBody.turn.status, 'answered');

    const afterRetry = await fetch(`${base}/api/sessions/${created.session.id}`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(afterRetry.status, 200);
    const sessionAfterRetry = await afterRetry.json();
    assert.equal(sessionAfterRetry.session.turnCount, 1);
    assert.equal(store.get(created.session.id).voiceTurns.length, 1);
    assert.equal(store.get(created.session.id).voiceTurns[0].transcript, transcript);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('duplicate voice-turn replay after interruption cannot overwrite the newer active question, transcript, or latest answer', async () => {
  const coach = {
    initialQuestion: async () => 'What is a cohort study?',
    evaluateAnswer: async ({ answer }) => ({
      strengths: [`Strength tied to: ${answer}`],
      improvement: `Improve: ${answer}`,
      exampleAnswer: `Example for: ${answer}`,
      scores: { clarity: 4, relevance: 4, structure: 4, completeness: 3, specificity: 3 },
      evidence: [answer],
      academicAssessment: { label: 'direct', rationale: `Relevant to: ${answer}` },
      academicResponse: `Feedback for: ${answer}`,
      nextQuestion: answer.includes('unexposed')
        ? 'What outcome would you measure next?'
        : 'How would you handle confounding?'
    })
  };
  const store = new InMemoryStore();
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Voice duplicate replay' })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };

    const first = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'voice-stale-1',
        transcript: 'A cohort study follows exposed and unexposed groups over time.',
        transcriptConfidence: 0.9,
        transcriptReviewed: true
      })
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();

    const interrupt = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns/${firstBody.turn.id}/interrupt`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(interrupt.status, 200);

    const secondTranscript = 'The outcome could be disease incidence measured after one year.';
    const second = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'voice-stale-2',
        transcript: secondTranscript,
        transcriptConfidence: 0.91,
        transcriptReviewed: true
      })
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();

    const replay = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'voice-stale-1',
        transcript: 'This stale duplicate should replay without overwriting newer state.',
        transcriptConfidence: 0.1,
        transcriptReviewed: false
      })
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), firstBody);

    const sessionResponse = await fetch(`${base}/api/sessions/${created.session.id}`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(sessionResponse.status, 200);
    const sessionBody = await sessionResponse.json();
    assert.equal(sessionBody.session.currentQuestion, 'How would you handle confounding?');
    assert.equal(sessionBody.session.turnCount, 2);

    const events = await fetch(`${base}/api/voice/sessions/${created.session.id}/events`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(events.status, 200);
    const eventsBody = await events.json();
    assert.equal(eventsBody.lastTranscript, secondTranscript);
    assert.equal(eventsBody.lastTurn.id, secondBody.turn.id);
    assert.equal(eventsBody.lastTurn.answerSpeechText, secondBody.answerSpeechText);

    const storedSession = store.get(created.session.id);
    assert.equal(storedSession.voiceTurns.length, 2);
    assert.equal(storedSession.voiceTurns.at(-1).transcript, secondTranscript);
    assert.equal(storedSession.voiceTurns.at(-1).answerText, secondBody.answerText);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('source voice summaries count interactions without inventing coaching scores', async () => {
  const coach = {
    initialQuestion: async () => 'What is the main claim?',
    composeBlendedAnswer: async ({ retrievedChunks }) => ({
      answerText: retrievedChunks[0].text,
      answerSpeechText: retrievedChunks[0].text,
      sourceClaims: [{ claim: retrievedChunks[0].text, chunkId: retrievedChunks[0].id, citationExcerpt: retrievedChunks[0].text }],
      llmBackground: [],
      discussionPoints: ['What evidence supports this claim?'],
      suggestions: ['Compare this claim with another source.'],
      externalClaims: [],
      citations: [{ sourceId: retrievedChunks[0].sourceId, chunkId: retrievedChunks[0].id, excerpt: retrievedChunks[0].text }],
      externalCitations: [],
      confidence: 'high',
      uncertainty: [],
      conflicts: [],
      followUp: 'What evidence supports this claim?'
    })
  };
  const server = createServer({ coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Voice source summary', sourceMode: 'source', questionLimit: 1 })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'notes.txt', text: 'The source explains a useful study method.' })
    });
    const answer = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST', headers,
      body: JSON.stringify({ transcript: 'What does the source explain?', idempotencyKey: 'summary-voice-1' })
    });
    assert.equal(answer.status, 200);
    const complete = await fetch(`${base}/api/sessions/${created.session.id}/complete`, {
      method: 'POST', headers: { 'x-session-token': created.token }
    });
    assert.equal(complete.status, 200);
    const summary = (await complete.json()).summary;
    assert.equal(summary.completedTurns, 1);
    assert.deepEqual(summary.overallScores, {
      clarity: null,
      relevance: null,
      structure: null,
      completeness: null,
      specificity: null
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('voice control routes update server state without deleting the latest transcript', async () => {
  const coach = {
    initialQuestion: async () => 'What is the main claim?',
    composeBlendedAnswer: async () => ({
      answerText: 'A supported answer.',
      answerSpeechText: 'A supported answer.',
      sourceClaims: [],
      llmBackground: ['General explanation.'],
      externalClaims: [],
      citations: [],
      externalCitations: [],
      confidence: 'medium',
      uncertainty: [],
      conflicts: [],
      followUp: 'Want another example?'
    })
  };
  const store = new InMemoryStore();
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Voice controls' })
    });
    const created = await create.json();
    const turn = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        idempotencyKey: 'voice-controls-1',
        transcript: 'What is one useful study habit?',
        transcriptConfidence: 0.88,
        transcriptReviewed: true
      })
    });
    const turnBody = await turn.json();

    const pause = await fetch(`${base}/api/voice/sessions/${created.session.id}/pause`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(pause.status, 200);
    assert.equal((await pause.json()).state, 'paused');

    const interrupt = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns/${turnBody.turn.id}/interrupt`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(interrupt.status, 200);
    const interruptBody = await interrupt.json();
    assert.equal(interruptBody.state, 'listening');
    assert.equal(interruptBody.turn.id, turnBody.turn.id);
    assert.equal(interruptBody.turn.status, 'interrupted');

    const events = await fetch(`${base}/api/voice/sessions/${created.session.id}/events`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(events.status, 200);
    const eventsBody = await events.json();
    assert.equal(eventsBody.lastTranscript, 'What is one useful study habit?');
    assert.equal(eventsBody.turnCount, 1);

    const stop = await fetch(`${base}/api/voice/sessions/${created.session.id}/stop`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(stop.status, 200);
    assert.equal((await stop.json()).state, 'completed');

    const restored = store.get(created.session.id);
    assert.equal(restored.voiceTurns.length, 1);
    assert.equal(restored.voiceTurns[0].transcript, 'What is one useful study habit?');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('voice turn endpoint normalizes a general answer speech string when the coach only returns raw answer text', async () => {
  const coach = {
    initialQuestion: async () => 'What is the main idea?',
    generalAnswer: async () => ({
      mode: 'general',
      answer: 'Start with the main idea, then add one example.',
      sourceGroundedClaims: [],
      additionalContext: [{ claim: 'This is general background.', label: 'Additional context' }],
      unsupportedOrUnresolved: [],
      confidence: 'medium'
    })
  };
  const server = createServer({ coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'General voice question' })
    });
    const created = await create.json();

    const response = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        idempotencyKey: 'general-voice-1',
        transcript: 'What is one useful study habit?',
        transcriptConfidence: 0.89,
        transcriptReviewed: true
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.turn.intent, 'general_question');
    assert.equal(body.answerText, 'Start with the main idea, then add one example.');
    assert.equal(body.answerSpeechText, 'Start with the main idea, then add one example.');
    assert.deepEqual(body.knowledgeLayers, ['llm']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('research consent approves one turn, expires, and only then allows external research into answers', async () => {
  const coach = {
    initialQuestion: async () => 'What is the main idea?',
    generalAnswer: async () => ({
      mode: 'general',
      answer: 'Spaced practice usually improves long-term retention.',
      sourceGroundedClaims: [],
      additionalContext: [{ claim: 'This is general background.', label: 'Additional context' }],
      unsupportedOrUnresolved: [],
      confidence: 'medium'
    })
  };
  let providerCalls = 0;
  const researchAdapter = {
    approveConsent: () => ({
      approved: true,
      approvedAt: '2026-07-14T12:00:00.000Z',
      expiresAt: '2026-07-14T12:01:00.000Z',
      usesRemaining: 1
    }),
    async lookup({ consent }) {
      if (!consent?.approved || !consent?.usesRemaining) {
        return {
          status: 'consent_required',
          requested: true,
          approved: false,
          requiresExternalConsent: true,
          results: [],
          nextConsent: consent || { approved: false, usesRemaining: 0 }
        };
      }
      providerCalls += 1;
      return {
        status: 'approved',
        requested: true,
        approved: true,
        requiresExternalConsent: false,
        results: [{
          id: 'https://example.test/spacing-effect',
          title: 'Spacing effect overview',
          url: 'https://example.test/spacing-effect',
          publisher: 'Example Journal',
          provider: 'Example Journal',
          retrievedAt: '2026-07-14T12:00:00.000Z',
          excerpt: 'Spacing improves retention over time.'
        }],
        nextConsent: {
          approved: false,
          approvedAt: consent.approvedAt,
          expiresAt: consent.expiresAt,
          usesRemaining: 0
        }
      };
    }
  };
  const server = createServer({ coach, researchAdapter });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'External research voice question' })
    });
    const created = await create.json();

    const blocked = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        mode: 'general',
        question: 'What study habit helps memory over time?'
      })
    });
    assert.equal(blocked.status, 200);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.requiresExternalConsent, true);
    assert.deepEqual(blockedBody.externalCitations, []);
    assert.deepEqual(blockedBody.knowledgeLayers, ['llm']);
    assert.equal(blockedBody.externalKnowledgeStatus, 'consent_required');
    assert.equal(providerCalls, 0);

    const consent = await fetch(`${base}/api/sessions/${created.session.id}/research-consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    assert.equal(consent.status, 200);
    const consentBody = await consent.json();
    assert.equal(consentBody.approved, true);
    assert.equal(consentBody.expiresAt, '2026-07-14T12:01:00.000Z');

    const approved = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        mode: 'general',
        question: 'What study habit helps memory over time?'
      })
    });
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json();
    assert.deepEqual(approvedBody.knowledgeLayers, ['llm', 'external']);
    assert.equal(approvedBody.externalCitations.length, 1);
    assert.equal(approvedBody.externalCitations[0].title, 'Spacing effect overview');
    assert.equal(approvedBody.externalCitations[0].publisher, 'Example Journal');
    assert.equal(approvedBody.externalCitations[0].retrievedAt, '2026-07-14T12:00:00.000Z');
    assert.equal(approvedBody.externalCitations[0].excerpt, 'Spacing improves retention over time.');
    assert.equal(approvedBody.requiresExternalConsent, false);
    assert.equal(approvedBody.externalKnowledgeStatus, 'included');
    assert.equal(providerCalls, 1);

    const consumed = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        mode: 'general',
        question: 'What study habit helps memory over time?'
      })
    });
    assert.equal(consumed.status, 200);
    const consumedBody = await consumed.json();
    assert.equal(consumedBody.requiresExternalConsent, true);
    assert.deepEqual(consumedBody.externalCitations, []);
    assert.equal(consumedBody.externalKnowledgeStatus, 'consent_required');
    assert.equal(providerCalls, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('source prompt endpoint creates a coaching question from attached materials', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Study a paper', sourceMode: 'source' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'The paper argues that spaced practice improves long-term retention.' })
    });
    const response = await fetch(`${base}/api/sessions/${created.session.id}/source-prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 200);
    const prompt = await response.json();
    assert.match(prompt.question, /paper\.txt/i);
    const session = await fetch(`${base}/api/sessions/${created.session.id}`, { headers: { 'x-session-token': created.token } });
    assert.equal((await session.json()).session.currentQuestion, prompt.question);
  });
});

test('session summary reports the supplied material coverage', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Summarize a paper', sourceMode: 'source' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'This paper explains a useful study method.' })
    });
    const completed = await fetch(`${base}/api/sessions/${created.session.id}/complete`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    const body = await completed.json();
    assert.equal(body.summary.turnCount, 0);
    assert.deepEqual(body.summary.learnedConcepts, ['You reviewed the supplied material set and prepared it for source-grounded discussion.']);
    assert.deepEqual(body.summary.unresolvedQuestions, []);
    assert.equal(body.summary.sourceCount, 1);
    assert.deepEqual(body.summary.sourceNames, ['paper.txt']);
    assert.equal(body.summary.sourceCoverage.length, 1);
    assert.deepEqual(body.summary.sourceCoverage[0], {
      sourceId: body.summary.sourceCoverage[0].sourceId,
      sourceName: 'paper.txt',
      status: 'available',
      groundedAnswerCount: 0,
      citationCount: 0,
      digestReferenceCount: 1,
      note: 'Ready for source-grounded discussion.'
    });
  });
});

test('source session summary keeps legacy fields while adding unresolved questions and next steps', async () => {
  const coach = {
    initialQuestion: async () => 'What is the main claim?',
    digestSource: async source => ({ digestText: source.text, keyPoints: [], openQuestions: [] }),
    buildConsolidatedDigest: async ({ sources, chunks }) => ({
      mainArgument: 'The source argues that retrieval practice supports retention.',
      keyPoints: [{
        text: 'Retrieval practice supports retention in the course.',
        sourceIds: [sources[0].id],
        chunkIds: [chunks[0].id]
      }],
      importantTerms: [],
      evidence: [{
        claim: 'Retrieval practice supports retention in the course.',
        chunkIds: [chunks[0].id]
      }],
      conflicts: [],
      openQuestions: ['What evidence best supports the main claim?']
    })
  };
  const server = createServer({ coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Source summary contract', sourceMode: 'source' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'Retrieval practice supports retention in the course.' })
    });
    const digest = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    assert.equal(digest.status, 200);

    const completed = await fetch(`${base}/api/sessions/${created.session.id}/complete`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(completed.status, 200);
    const body = await completed.json();
    assert.deepEqual(body.summary.overallScores, {
      clarity: null,
      relevance: null,
      structure: null,
      completeness: null,
      specificity: null
    });
    assert.deepEqual(body.summary.learnedConcepts, ['The source argues that retrieval practice supports retention.']);
    assert.deepEqual(body.summary.unresolvedQuestions, ['What evidence best supports the main claim?']);
    assert.deepEqual(body.summary.nextSteps, ['Pick one unresolved question and answer it with a specific source-backed claim.']);
    assert.equal(body.summary.nextPractice, 'Pick one unresolved question and answer it with a specific source-backed claim.');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('source upload accepts a text PDF payload and reports extraction warnings', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Read a paper' })
    });
    const created = await create.json();
    const pdf = Buffer.from('%PDF-1.4\nBT (The main claim is testable) Tj ET\n%%EOF', 'latin1').toString('base64');
    const upload = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.pdf', mimeType: 'application/pdf', fileBase64: pdf })
    });
    assert.equal(upload.status, 201);
    const body = await upload.json();
    assert.equal(body.source.mimeType, 'application/pdf');
    assert.equal(body.source.warnings.length, 2);
    assert.match(body.source.warnings[0], /Python was not detected|configured/i);
    assert.deepEqual(body.source.tables, []);
    assert.deepEqual(body.source.captions, []);
  });
});

test('source digest endpoints expose queued status, consolidated digests, and stored chunks', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Digest sources' })
    });
    const created = await create.json();
    const upload = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'Spaced practice improves long-term retention for learners in this experiment.' })
    });
    const uploadBody = await upload.json();
    assert.equal(upload.status, 201);

    const queued = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(queued.status, 200);
    const queuedBody = await queued.json();
    assert.equal(queuedBody.status, 'queued');

    const built = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    assert.equal(built.status, 200);
    const builtBody = await built.json();
    assert.equal(builtBody.status, 'ready');
    assert.equal(builtBody.digest.keyPoints.length, 1);
    assert.equal(builtBody.digest.evidence.length, 1);

    const chunkResponse = await fetch(`${base}/api/sessions/${created.session.id}/sources/${uploadBody.source.id}/chunks`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(chunkResponse.status, 200);
    const chunkBody = await chunkResponse.json();
    assert.equal(chunkBody.status, 'ready');
    assert.equal(chunkBody.chunks.length, 1);
    assert.equal(chunkBody.chunks[0].sourceId, uploadBody.source.id);
  });
});

test('digest routes expose processing status while a digest build is in flight', async () => {
  let releaseDigest;
  const digestStarted = new Promise(resolve => {
    releaseDigest = resolve;
  });
  const coach = {
    initialQuestion: async () => 'What is the main idea?',
    digestSource: async source => ({ digestText: source.text, keyPoints: [], openQuestions: [] }),
    buildConsolidatedDigest: async () => {
      await digestStarted;
      return {
        mainArgument: 'Spaced practice improves long-term retention.',
        keyPoints: [{ text: 'Spaced practice improves long-term retention.', sourceIds: ['pending'], chunkIds: ['pending:chunk:1'] }],
        importantTerms: [],
        evidence: [{ claim: 'Spaced practice improves long-term retention.', chunkIds: ['pending:chunk:1'] }],
        conflicts: [],
        openQuestions: [],
        warnings: []
      };
    }
  };
  const store = new InMemoryStore();
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Digest processing state' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'pending.txt', text: 'Spaced practice improves long-term retention.' })
    });
    const pendingPost = fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    let status = null;
    let statusBody = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      status = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
        headers: { 'x-session-token': created.token }
      });
      statusBody = await status.json();
      if (statusBody.status === 'processing') break;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(status?.status, 200);
    assert.equal(statusBody?.status, 'processing');
    releaseDigest();
    await pendingPost;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('digest routes keep an extractive source digest ready when model consolidation fails', async () => {
  const coach = {
    initialQuestion: async () => 'What is the main idea?',
    digestSource: async source => ({ digestText: source.text, keyPoints: [], openQuestions: [] }),
    buildConsolidatedDigest: async () => {
      throw new HttpError(502, 'Digest model unavailable.', 'DIGEST_MODEL_FAILED');
    }
  };
  const store = new InMemoryStore();
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Digest failure state' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'broken.txt', text: 'Spaced practice improves long-term retention.' })
    });

    const built = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    assert.equal(built.status, 200);
    const builtBody = await built.json();
    assert.equal(builtBody.status, 'ready');
    assert.equal(builtBody.digest.mode, 'extractive');
    assert.match(builtBody.digest.warnings.join(' '), /AI digest unavailable/i);

    const status = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.status, 'ready');
    assert.equal(statusBody.digest.mode, 'extractive');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('source deletion removes one material without deleting the session', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Manage sources' })
    });
    const created = await create.json();
    const source = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'remove-me.txt', text: 'This source is only here to test deletion.' })
    });
    const sourceBody = await source.json();
    const deleted = await fetch(`${base}/api/sessions/${created.session.id}/sources/${sourceBody.source.id}`, {
      method: 'DELETE',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(deleted.status, 200);
    const session = await fetch(`${base}/api/sessions/${created.session.id}`, { headers: { 'x-session-token': created.token } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).session.sourceCount, 0);
  });
});

test('duplicate source uploads are rejected within a session', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Avoid duplicates' })
    });
    const created = await create.json();
    const payload = { name: 'same.txt', text: 'The same source should not be indexed twice.' };
    const first = await fetch(`${base}/api/sessions/${created.session.id}/sources`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': created.token }, body: JSON.stringify(payload) });
    const second = await fetch(`${base}/api/sessions/${created.session.id}/sources`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': created.token }, body: JSON.stringify({ ...payload, name: 'renamed.txt' }) });
    assert.equal(first.status, 201);
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, 'SOURCE_DUPLICATE');
  });
});

test('session creation rejects unsupported advanced settings', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Validation', goal: 'invented-goal', questionLimit: 9 })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'GOAL_INVALID');
  });
});

test('turn and source-question endpoints reject oversized text', async () => {
  await withServer(async base => {
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Length limits' })
    });
    const created = await create.json();
    const answer = await fetch(`${base}/api/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ answer: 'x'.repeat(12_001) })
    });
    const question = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ mode: 'general', question: 'x'.repeat(2_001) })
    });
    assert.equal(answer.status, 413);
    assert.equal((await answer.json()).error.code, 'ANSWER_TOO_LONG');
    assert.equal(question.status, 413);
    assert.equal((await question.json()).error.code, 'QUESTION_TOO_LONG');
  });
});

test('source limits allow ten files and reject an eleventh with measured and configured values', async () => {
  let digestCalls = 0;
  const coach = {
    initialQuestion: async () => 'What is the main idea?',
    digestSource: async source => {
      digestCalls += 1;
      return { digestText: `Digest for ${source.name}` };
    },
    evaluateAnswer: async () => ({
      strengths: ['clear'],
      improvement: 'add detail',
      exampleAnswer: 'Example',
      scores: { clarity: 4, relevance: 4, structure: 4, completeness: 4, specificity: 4 },
      evidence: [],
      nextQuestion: 'Next?'
    })
  };
  const server = createServer({ coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Relaxed source limits' })
    });
    const created = await create.json();
    const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `source-${index + 1}.txt`, text: `Source ${index + 1} includes enough words to pass the minimum text length.` })
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.source.status, 'digesting');
      assert.equal(body.source.digestStatus, 'queued');
    }

    const eleventh = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'source-11.txt', text: 'This eleventh source should be rejected before any digest call runs.' })
    });
    assert.equal(eleventh.status, 413);
    const body = await eleventh.json();
    assert.equal(body.error.code, 'SOURCE_LIMIT');
    assert.equal(body.error.limitName, 'maxFiles');
    assert.equal(body.error.measuredValue, 11);
    assert.equal(body.error.configuredLimit, 10);
    assert.equal(digestCalls, 10);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('source upload reports failed status for maxFileBytes and skips digest work', async () => {
  await withEnv({ MAX_SOURCE_FILE_BYTES: '8' }, async () => {
    let digestCalls = 0;
    const coach = {
      initialQuestion: async () => 'What is the main idea?',
      digestSource: async source => {
        digestCalls += 1;
        return { digestText: `Digest for ${source.name}` };
      }
    };
    const server = createServer({ coach });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const base = `http://${address.address}:${address.port}`;
      const create = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'File byte limit' })
      });
      const created = await create.json();
      const upload = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': created.token },
        body: JSON.stringify({ name: 'tiny.txt', mimeType: 'text/plain', fileBase64: Buffer.from('123456789', 'utf8').toString('base64') })
      });
      assert.equal(upload.status, 413);
      const body = await upload.json();
      assert.equal(body.status, 'failed');
      assert.equal(body.error.status, 'failed');
      assert.equal(body.error.code, 'SOURCE_LIMIT');
      assert.equal(body.error.limitName, 'maxFileBytes');
      assert.equal(body.error.measuredValue, 9);
      assert.equal(body.error.configuredLimit, 8);
      assert.equal(digestCalls, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('source upload reports failed status for maxCombinedBytes and skips digest work on the rejected file', async () => {
  await withEnv({ MAX_SOURCE_COMBINED_BYTES: '40' }, async () => {
    let digestCalls = 0;
    const coach = {
      initialQuestion: async () => 'What is the main idea?',
      digestSource: async source => {
        digestCalls += 1;
        return { digestText: `Digest for ${source.name}` };
      }
    };
    const server = createServer({ coach });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const base = `http://${address.address}:${address.port}`;
      const create = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'Combined byte limit' })
      });
      const created = await create.json();
      const headers = { 'content-type': 'application/json', 'x-session-token': created.token };
      const first = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'first.txt', text: '1234567890123456789012345' })
      });
      assert.equal(first.status, 201);
      const second = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'second.txt', text: 'abcdefghijabcdefghijabcde' })
      });
      assert.equal(second.status, 413);
      const body = await second.json();
      assert.equal(body.status, 'failed');
      assert.equal(body.error.status, 'failed');
      assert.equal(body.error.limitName, 'maxCombinedBytes');
      assert.equal(body.error.measuredValue, 50);
      assert.equal(body.error.configuredLimit, 40);
      assert.equal(digestCalls, 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('source upload reports failed status for maxPages and skips digest work', async () => {
  await withEnv({ MAX_SOURCE_PAGES: '1' }, async () => {
    let digestCalls = 0;
    const coach = {
      initialQuestion: async () => 'What is the main idea?',
      digestSource: async source => {
        digestCalls += 1;
        return { digestText: `Digest for ${source.name}` };
      }
    };
    const server = createServer({ coach });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const base = `http://${address.address}:${address.port}`;
      const create = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'Page limit' })
      });
      const created = await create.json();
      const pdf = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n2 0 obj <</Type /Page>> endobj\nBT (Main idea) Tj ET\n%%EOF', 'latin1').toString('base64');
      const upload = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': created.token },
        body: JSON.stringify({ name: 'paper.pdf', mimeType: 'application/pdf', fileBase64: pdf })
      });
      assert.equal(upload.status, 413);
      const body = await upload.json();
      assert.equal(body.status, 'failed');
      assert.equal(body.error.status, 'failed');
      assert.equal(body.error.limitName, 'maxPages');
      assert.equal(body.error.measuredValue, 2);
      assert.equal(body.error.configuredLimit, 1);
      assert.equal(digestCalls, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('source upload reports failed status for maxWords and skips digest work', async () => {
  await withEnv({ MAX_SOURCE_WORDS: '4' }, async () => {
    let digestCalls = 0;
    const coach = {
      initialQuestion: async () => 'What is the main idea?',
      digestSource: async source => {
        digestCalls += 1;
        return { digestText: `Digest for ${source.name}` };
      }
    };
    const server = createServer({ coach });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const base = `http://${address.address}:${address.port}`;
      const create = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'Word limit' })
      });
      const created = await create.json();
      const upload = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': created.token },
        body: JSON.stringify({ name: 'notes.txt', text: 'one two three four five' })
      });
      assert.equal(upload.status, 413);
      const body = await upload.json();
      assert.equal(body.status, 'failed');
      assert.equal(body.error.status, 'failed');
      assert.equal(body.error.limitName, 'maxWords');
      assert.equal(body.error.measuredValue, 5);
      assert.equal(body.error.configuredLimit, 4);
      assert.equal(digestCalls, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('health endpoint reports privacy defaults and audio is never stored', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      service: 'deepchat2learn',
      capabilities: { textCoach: 'local-demo', realtimeVoice: false, storage: 'memory' },
      connection: { textModel: 'local-demo', realtimeVoice: 'not_configured' },
      voice: {
        autoSubmitDelayMs: 5_000,
        transitionDelayMs: 750,
        realtimeSilenceMs: 5_000,
        realtimeWatchdogMs: 0,
        maxRecognitionRetries: 8,
        transcriptMaxCharacters: 12_000,
        textTimeoutMs: 120_000,
        sourceDigestTimeoutMs: 300_000,
        realtimeTimeoutMs: 120_000
      },
      sourceLimits: {
        maxFiles: 10,
        maxFileBytes: 20_000_000,
        maxCombinedBytes: 50_000_000,
        maxPages: 300,
        maxWords: 150_000,
        maxPastedCharacters: 200_000
      },
      privacy: {
        defaultRetentionMode: 'session',
        audioStorage: 'never'
      },
      budgets: {
        turnBudget: 50,
        modelTokenBudget: 120_000
      }
    });
  });
});

test('session creation accepts retentionMode and exposes privacy-safe session settings', async () => {
  const store = new InMemoryStore({ sessionTtlMs: 60_000, shortExpiryMs: 10_000 });
  const server = createServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Privacy choices', retentionMode: 'short_expiry' })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.session.retentionMode, 'short_expiry');
    assert.equal(body.session.audioStorage, 'never');
    assert.equal(body.session.turnBudget, 50);
    assert.equal(body.session.modelTokenBudget, 120_000);
    assert.match(body.session.expiresAt, /\d{4}-\d{2}-\d{2}T/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('voice and typed question routes return a clear turn-budget limit response', async () => {
  const store = new InMemoryStore({ sessionTtlMs: 60_000, turnBudget: 1 });
  const server = createServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Budget guard' })
    });
    const created = await create.json();
    const first = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ mode: 'general', question: 'What is one useful study habit?' })
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        idempotencyKey: 'budget-voice-2',
        transcript: 'What should I do next?',
        transcriptConfidence: 0.8,
        transcriptReviewed: true
      })
    });
    assert.equal(second.status, 429);
    const body = await second.json();
    assert.equal(body.error.code, 'SESSION_TURN_BUDGET_EXCEEDED');
    assert.match(body.error.message, /turn limit/i);
    assert.match(body.error.spokenMessage, /turn limit/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('question routes return a clear model-budget limit response before generating an answer', async () => {
  const store = new InMemoryStore({ sessionTtlMs: 60_000, modelTokenBudget: 10 });
  const coach = {
    initialQuestion: async () => 'What is the topic?',
    generalAnswer: async () => {
      throw new Error('The model budget should block this call before the coach runs.');
    }
  };
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Model budget guard' })
    });
    const created = await create.json();
    const answer = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ mode: 'general', question: 'Please explain this with enough detail to exceed a tiny token budget.' })
    });
    assert.equal(answer.status, 429);
    const body = await answer.json();
    assert.equal(body.error.code, 'SESSION_MODEL_BUDGET_EXCEEDED');
    assert.match(body.error.message, /model budget/i);
    assert.match(body.error.spokenMessage, /model budget/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('structured request logging omits transcripts, source text, provider results, and API keys', async () => {
  const entries = [];
  const logger = { info: entry => entries.push(entry) };
  const server = createServer({
    logger,
    coach: {
      initialQuestion: async () => 'What is the main idea?',
      generalAnswer: async () => ({
        mode: 'general',
        answer: 'Keep one main idea and one example.',
        sourceGroundedClaims: [],
        additionalContext: [],
        unsupportedOrUnresolved: [],
        confidence: 'medium'
      })
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Logging privacy' })
    });
    const created = await create.json();
    const transcript = 'My transcript mentions sk-live-secret-value and the paper says hidden retention result.';
    const answer = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        mode: 'general',
        question: transcript
      })
    });
    assert.equal(answer.status, 200);
    assert.ok(entries.length >= 2);
    const serialized = JSON.stringify(entries);
    assert.match(serialized, /sessionId/);
    assert.match(serialized, /statusCode/);
    assert.match(serialized, /durationMs/);
    assert.doesNotMatch(serialized, /My transcript mentions/);
    assert.doesNotMatch(serialized, /hidden retention result/);
    assert.doesNotMatch(serialized, /sk-live-secret-value/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
