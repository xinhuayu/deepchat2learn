import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { SqliteStore } from '../src/sqliteStore.mjs';
import { HttpError } from '../src/store.mjs';

test('server answers source questions through SQLite FTS retrieval', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-api-'));
  const store = new SqliteStore({ path: path.join(directory, 'app.sqlite'), sessionTtlMs: 60_000 });
  const server = createServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Study a paper' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'Spaced practice improves long-term memory.' })
    });
    const digest = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ forceModelConsolidation: true })
    });
    assert.equal(digest.status, 200);
    assert.equal((await digest.json()).status, 'ready');
    const answer = await fetch(`${base}/api/sessions/${created.session.id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ mode: 'source', question: 'What improves memory?' })
    });
    const body = await answer.json();
    assert.equal(answer.status, 200);
    assert.equal(body.sourceGroundedClaims[0].sourceName, 'paper.txt');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite-backed digest endpoints persist consolidated digests and chunks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-digest-'));
  const store = new SqliteStore({ path: path.join(directory, 'app.sqlite'), sessionTtlMs: 60_000 });
  const server = createServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Digest persistence' })
    });
    const created = await create.json();
    const upload = await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'Retrieval practice improves durable learning outcomes in the course.' })
    });
    const uploadBody = await upload.json();
    assert.equal(upload.status, 201);
    assert.equal(uploadBody.source.status, 'ready');
    assert.equal(uploadBody.source.digestStatus, 'ready');
    assert.equal(uploadBody.source.metrics.chunkCount, 1);
    assert.equal(uploadBody.source.metrics.extractionMethod, 'text-direct');

    const digest = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    assert.equal(digest.status, 200);
    const digestBody = await digest.json();
    assert.equal(digestBody.status, 'ready');
    assert.equal(digestBody.digest.evidence.length, 1);

    const status = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, 'ready');

    const chunks = await fetch(`${base}/api/sessions/${created.session.id}/sources/${uploadBody.source.id}/chunks`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(chunks.status, 200);
    const chunkBody = await chunks.json();
    assert.equal(chunkBody.chunks.length, 1);

    const restored = store.get(created.session.id);
    assert.equal(restored.digestStatus, 'ready');
    assert.equal(restored.sourceDigest.evidence.length, 1);
    assert.equal(restored.sources[0].chunks.length, 1);
    assert.equal(restored.sources[0].status, 'ready');
    assert.equal(restored.sources[0].metrics.chunkCount, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite-backed completion returns the learner summary contract for source sessions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-summary-'));
  const store = new SqliteStore({ path: path.join(directory, 'app.sqlite'), sessionTtlMs: 60_000 });
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
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'SQLite summary', sourceMode: 'source' })
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
      body: JSON.stringify({ forceModelConsolidation: true })
    });
    assert.equal(digest.status, 200);

    const complete = await fetch(`${base}/api/sessions/${created.session.id}/complete`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(complete.status, 200);
    const body = await complete.json();
    assert.deepEqual(body.summary.learnedConcepts, ['The source argues that retrieval practice supports retention.']);
    assert.deepEqual(body.summary.unresolvedQuestions, ['What evidence best supports the main claim?']);
    assert.equal(body.summary.sourceCoverage.length, 1);
    assert.equal(body.summary.sourceCoverage[0].sourceName, 'paper.txt');
    assert.equal(body.summary.sourceCoverage[0].status, 'available');
    assert.equal(body.summary.sourceCoverage[0].digestReferenceCount, 1);
    assert.deepEqual(body.summary.nextSteps, ['Pick one unresolved question and answer it with a specific source-backed claim.']);

    const restored = store.get(created.session.id);
    assert.equal(store.sessionSummary(restored).sourceCoverage[0].sourceName, 'paper.txt');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite-backed digest status persists processing and failed states', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-digest-failure-'));
  const store = new SqliteStore({ path: path.join(directory, 'app.sqlite'), sessionTtlMs: 60_000 });
  let releaseDigest;
  let markDigestStarted;
  const waitForDigest = new Promise(resolve => {
    releaseDigest = resolve;
  });
  const digestStarted = new Promise(resolve => {
    markDigestStarted = resolve;
  });
  const coach = {
    initialQuestion: async () => 'What is the main idea?',
    digestSource: async source => ({ digestText: source.text, keyPoints: [], openQuestions: [] }),
    buildConsolidatedDigest: async () => {
      markDigestStarted();
      await waitForDigest;
      throw new HttpError(502, 'Digest model unavailable.', 'DIGEST_MODEL_FAILED');
    }
  };
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Digest durability' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'Retrieval practice improves durable learning outcomes.' })
    });

    const pendingPost = fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ forceModelConsolidation: true })
    });
    await digestStarted;

    const processing = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      headers: { 'x-session-token': created.token }
    });
    const processingBody = await processing.json();
    assert.equal(processing.status, 200);
    assert.equal(processingBody.status, 'processing');

    releaseDigest();
    const failed = await pendingPost;
    const failedBody = await failed.json();
    assert.equal(failed.status, 200);
    assert.equal(failedBody.status, 'failed');
    assert.equal(failedBody.error.code, 'DIGEST_MODEL_FAILED');

    const restored = store.get(created.session.id);
    assert.equal(restored.digestStatus, 'failed');
    assert.equal(restored.digestError.code, 'DIGEST_MODEL_FAILED');
  } finally {
    releaseDigest?.();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite-backed voice turn endpoint persists the approved turn and replays duplicate idempotency keys', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-voice-api-'));
  const store = new SqliteStore({ path: path.join(directory, 'app.sqlite'), sessionTtlMs: 60_000 });
  const coach = {
    initialQuestion: async () => 'What is the main point?',
    composeBlendedAnswer: async ({ retrievedChunks }) => ({
      answerText: 'The source says retrieval practice improves durable learning outcomes.',
      answerSpeechText: 'The source says retrieval practice improves durable learning outcomes.',
      sourceClaims: [{
        claim: 'The source says retrieval practice improves durable learning outcomes.',
        chunkId: retrievedChunks[0].id,
        citationExcerpt: 'Retrieval practice improves durable learning outcomes'
      }],
      llmBackground: [],
      externalClaims: [],
      citations: [{
        sourceId: retrievedChunks[0].sourceId,
        chunkId: retrievedChunks[0].id,
        excerpt: 'Retrieval practice improves durable learning outcomes'
      }],
      externalCitations: [],
      confidence: 'high',
      uncertainty: [],
      conflicts: [],
      followUp: 'Would you like the exact passage?'
    })
  };
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Study a paper', sourceMode: 'source' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'Retrieval practice improves durable learning outcomes in the course.' })
    });
    const digest = await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    assert.equal(digest.status, 200);
    assert.equal((await digest.json()).status, 'ready');

    const first = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        idempotencyKey: 'sqlite-voice-turn-1',
        transcript: 'What improves learning outcomes in the paper?',
        transcriptConfidence: 0.91,
        transcriptReviewed: false
      })
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.turn.status, 'answered');
    assert.equal(firstBody.confidence, 'high');

    const replay = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        idempotencyKey: 'sqlite-voice-turn-1',
        transcript: 'This should replay the first result.',
        transcriptConfidence: 0.2,
        transcriptReviewed: true
      })
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), firstBody);

    const restored = store.get(created.session.id);
    assert.equal(restored.voiceTurns.length, 1);
    assert.equal(restored.voiceTurns[0].transcript, 'What improves learning outcomes in the paper?');
    assert.equal(restored.voiceTurns[0].answerSpeechText, 'The source says retrieval practice improves durable learning outcomes. Would you like the exact passage?');
    assert.equal(restored.voiceIdempotency.get('sqlite-voice-turn-1').turn.id, restored.voiceTurns[0].id);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite-backed voice event routes preserve the stored transcript while voice state changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-voice-events-'));
  const store = new SqliteStore({ path: path.join(directory, 'app.sqlite'), sessionTtlMs: 60_000 });
  const coach = {
    initialQuestion: async () => 'What is the main point?',
    generalAnswer: async () => ({
      mode: 'general',
      answer: 'Start with the central idea and one concrete example.',
      sourceGroundedClaims: [],
      additionalContext: [{ claim: 'This is general background.', label: 'Additional context' }],
      unsupportedOrUnresolved: [],
      confidence: 'medium'
    })
  };
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Voice event persistence' })
    });
    const created = await create.json();

    const turn = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        idempotencyKey: 'sqlite-voice-events-1',
        transcript: 'What is one useful study habit?',
        transcriptConfidence: 0.84,
        transcriptReviewed: true
      })
    });
    const turnBody = await turn.json();

    const pause = await fetch(`${base}/api/voice/sessions/${created.session.id}/pause`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(pause.status, 200);

    const interrupt = await fetch(`${base}/api/voice/sessions/${created.session.id}/turns/${turnBody.turn.id}/interrupt`, {
      method: 'POST',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(interrupt.status, 200);

    const events = await fetch(`${base}/api/voice/sessions/${created.session.id}/events`, {
      headers: { 'x-session-token': created.token }
    });
    assert.equal(events.status, 200);
    const eventsBody = await events.json();
    assert.equal(eventsBody.lastTranscript, 'What is one useful study habit?');
    assert.equal(eventsBody.turnCount, 1);

    const restored = store.get(created.session.id);
    assert.equal(restored.voiceTurns.length, 1);
    assert.equal(restored.voiceTurns[0].transcript, 'What is one useful study habit?');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite session deletion cascades through transcripts, digests, chunks, citations, idempotency, and FTS rows', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-delete-'));
  const store = new SqliteStore({ path: path.join(directory, 'app.sqlite'), sessionTtlMs: 60_000 });
  const coach = {
    initialQuestion: async () => 'What is the main point?',
    composeBlendedAnswer: async ({ retrievedChunks }) => ({
      answerText: 'The source says retrieval practice improves durable learning outcomes.',
      answerSpeechText: 'The source says retrieval practice improves durable learning outcomes.',
      sourceClaims: [{
        claim: 'The source says retrieval practice improves durable learning outcomes.',
        chunkId: retrievedChunks[0].id,
        citationExcerpt: 'Retrieval practice improves durable learning outcomes'
      }],
      llmBackground: [],
      externalClaims: [{
        claim: 'External support agrees.',
        externalCitationId: 'external-1'
      }],
      citations: [{
        sourceId: retrievedChunks[0].sourceId,
        chunkId: retrievedChunks[0].id,
        excerpt: 'Retrieval practice improves durable learning outcomes'
      }],
      externalCitations: [{
        title: 'Example Journal',
        url: 'https://example.com/journal',
        publisher: 'Example Publisher',
        retrievedAt: '2026-07-14T12:00:00.000Z',
        snippet: 'Spacing improves retention over time.'
      }],
      confidence: 'high',
      uncertainty: [],
      conflicts: [],
      followUp: 'Would you like the exact passage?'
    })
  };
  const server = createServer({ store, coach });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Delete private data', sourceMode: 'source', retentionMode: 'until_deleted' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'Retrieval practice improves durable learning outcomes in the course.' })
    });
    await fetch(`${base}/api/sessions/${created.session.id}/sources/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({})
    });
    await fetch(`${base}/api/voice/sessions/${created.session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({
        idempotencyKey: 'sqlite-delete-voice-1',
        transcript: 'What improves learning outcomes in the paper?',
        transcriptConfidence: 0.91,
        transcriptReviewed: true
      })
    });

    const before = {
      sessions: store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
      sources: store.db.prepare('SELECT COUNT(*) AS count FROM sources').get().count,
      turns: store.db.prepare('SELECT COUNT(*) AS count FROM voice_turns').get().count,
      idempotency: store.db.prepare('SELECT COUNT(*) AS count FROM voice_idempotency').get().count,
      chunks: store.db.prepare('SELECT COUNT(*) AS count FROM source_chunks').get().count,
      sourceFts: store.db.prepare('SELECT COUNT(*) AS count FROM source_fts').get().count,
      chunkFts: store.db.prepare('SELECT COUNT(*) AS count FROM source_chunks_fts').get().count
    };
    assert.equal(before.sessions, 1);
    assert.equal(before.sources, 1);
    assert.equal(before.turns, 1);
    assert.equal(before.idempotency, 1);
    assert.equal(before.chunks, 1);
    assert.equal(before.sourceFts, 1);
    assert.equal(before.chunkFts, 1);

    const deleted = await fetch(`${base}/api/sessions/${created.session.id}`, {
      method: 'DELETE',
      headers: { 'x-session-token': created.token }
    });
    assert.equal(deleted.status, 200);

    const after = {
      sessions: store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
      sources: store.db.prepare('SELECT COUNT(*) AS count FROM sources').get().count,
      turns: store.db.prepare('SELECT COUNT(*) AS count FROM voice_turns').get().count,
      idempotency: store.db.prepare('SELECT COUNT(*) AS count FROM voice_idempotency').get().count,
      chunks: store.db.prepare('SELECT COUNT(*) AS count FROM source_chunks').get().count,
      sourceFts: store.db.prepare('SELECT COUNT(*) AS count FROM source_fts').get().count,
      chunkFts: store.db.prepare('SELECT COUNT(*) AS count FROM source_chunks_fts').get().count
    };
    assert.deepEqual(after, {
      sessions: 0,
      sources: 0,
      turns: 0,
      idempotency: 0,
      chunks: 0,
      sourceFts: 0,
      chunkFts: 0
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite expiry pruning removes short-expiry sessions and their derived source rows', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-expiry-'));
  const store = new SqliteStore({ path: path.join(directory, 'app.sqlite'), sessionTtlMs: 60_000, shortExpiryMs: 5_000 });
  const server = createServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const create = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Short expiry cleanup', retentionMode: 'short_expiry' })
    });
    const created = await create.json();
    await fetch(`${base}/api/sessions/${created.session.id}/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': created.token },
      body: JSON.stringify({ name: 'paper.txt', text: 'Retrieval practice improves durable learning outcomes.' })
    });
    const session = store.get(created.session.id);
    session.expiresAt = Date.now() - 1;
    store.save(session);

    assert.equal(store.cleanupExpired(), 1);
    assert.equal(store.get(created.session.id), undefined);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM sources').get().count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM source_chunks').get().count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM source_fts').get().count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM source_chunks_fts').get().count, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
