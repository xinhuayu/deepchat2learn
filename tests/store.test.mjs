import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../src/store.mjs';

test('store creates a session with a session-scoped capability token', () => {
  const store = new InMemoryStore();
  const created = store.createSession({ topic: 'Practice speaking' });

  assert.ok(created.session.id);
  assert.ok(created.token);
  assert.equal(store.authorize(created.session.id, created.token), true);
  assert.equal(store.authorize(created.session.id, 'wrong-token'), false);
});

test('store persists skill selection metadata in public sessions', () => {
  const store = new InMemoryStore();
  const created = store.createSession({ topic: 'Critique a cohort study', sourceMode: 'source', skillId: 'epi-research', activeSkillId: 'epi-research', conversationSkillId: 'academic-conversation', skillSelectionReason: 'Explicit: epidemiology methods review.' });
  const session = store.get(created.session.id);

  assert.equal(session.skillId, 'epi-research');
  assert.equal(session.activeSkillId, 'epi-research');
  assert.equal(session.conversationSkillId, 'academic-conversation');
  assert.equal(session.skillSelectionReason, 'Explicit: epidemiology methods review.');
  assert.equal(created.session.activeSkillId, 'epi-research');
  assert.equal(created.session.conversationSkillId, 'academic-conversation');
});

test('store rejects expired or unknown sessions', () => {
  const store = new InMemoryStore({ sessionTtlMs: 1000 });
  const created = store.createSession({ topic: 'Test' });
  const session = store.requireAuthorized(created.session.id, created.token);
  session.expiresAt = Date.now() - 1;
  assert.throws(() => store.requireAuthorized(created.session.id, created.token), /expired/i);
});

test('in-memory cleanup removes expired sessions', () => {
  const store = new InMemoryStore({ sessionTtlMs: 1000 });
  const created = store.createSession({ topic: 'Cleanup' });
  const session = store.get(created.session.id);
  session.expiresAt = Date.now() - 1;
  assert.equal(store.cleanupExpired(), 1);
  assert.equal(store.get(created.session.id), undefined);
});

test('store keeps voice turns and voice idempotency separate from legacy turns', () => {
  const store = new InMemoryStore();
  const created = store.createSession({ topic: 'Voice session' });
  const session = store.get(created.session.id);
  session.turns.push({ index: 0, question: 'Legacy question?', answer: 'Legacy answer.', feedback: { scores: { clarity: 4 } }, createdAt: new Date().toISOString() });
  session.idempotency.set('legacy-turn-1', { done: true });
  session.voiceTurns.push({
    id: 'voice-turn-1',
    sessionId: created.session.id,
    sequence: 1,
    inputMode: 'voice',
    transcript: 'Explain the source.',
    transcriptConfidence: 0.92,
    transcriptReviewed: false,
    intent: 'source_question',
    status: 'pending',
    answerText: null,
    answerSpeechText: null,
    knowledgeLayers: [],
    citations: [],
    externalCitations: [],
    confidence: null,
    followUp: null,
    idempotencyKey: 'voice-turn-1',
    createdAt: new Date().toISOString(),
    answeredAt: null
  });
  session.voiceIdempotency.set('voice-turn-1', { turnId: 'voice-turn-1', nextState: 'retrieving' });

  const restored = store.get(created.session.id);
  assert.equal(restored.turns.length, 1);
  assert.equal(restored.idempotency.get('legacy-turn-1').done, true);
  assert.equal(restored.voiceTurns.length, 1);
  assert.equal(restored.voiceTurns[0].transcript, 'Explain the source.');
  assert.deepEqual(restored.voiceIdempotency.get('voice-turn-1'), { turnId: 'voice-turn-1', nextState: 'retrieving' });
});

test('store replays a duplicate voice idempotency key without duplicating the voice turn', () => {
  const store = new InMemoryStore();
  const created = store.createSession({ topic: 'Voice replay' });
  const session = store.get(created.session.id);
  const originalResult = {
    turn: {
      id: 'voice-turn-1',
      sessionId: created.session.id,
      sequence: 1,
      inputMode: 'voice',
      transcript: 'Explain this source.',
      transcriptConfidence: 0.9,
      transcriptReviewed: false,
      intent: 'source_question',
      status: 'answered',
      answerText: 'Here is the grounded answer.',
      answerSpeechText: 'Here is the grounded answer.',
      knowledgeLayers: ['source'],
      citations: [{ sourceId: 'source-1', start: 0, end: 12 }],
      externalCitations: [],
      confidence: 'high',
      followUp: null,
      idempotencyKey: 'voice-turn-1',
      createdAt: new Date().toISOString(),
      answeredAt: new Date().toISOString()
    },
    nextState: 'speaking_answer'
  };

  const first = store.recordVoiceTurnResult(session, 'voice-turn-1', originalResult);
  const duplicate = store.recordVoiceTurnResult(session, 'voice-turn-1', {
    ...originalResult,
    turn: { ...originalResult.turn, id: 'voice-turn-2' }
  });

  assert.deepEqual(first, originalResult);
  assert.deepEqual(duplicate, originalResult);
  assert.equal(session.voiceTurns.length, 1);
  assert.equal(session.voiceTurns[0].id, 'voice-turn-1');
  assert.deepEqual(store.getVoiceTurnReplay(session, 'voice-turn-1'), originalResult);
});
