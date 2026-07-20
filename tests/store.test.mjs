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

test('store summaries include durable voice coaching feedback without idempotency replay data', () => {
  const store = new InMemoryStore();
  const created = store.createSession({ topic: 'Voice feedback records' });
  const session = store.get(created.session.id);
  session.voiceTurns.push({
    id: 'voice-feedback-1',
    sessionId: session.id,
    sequence: 0,
    inputMode: 'voice',
    question: 'What is the main claim?',
    transcript: 'The main claim is that spaced practice improves retention.',
    intent: 'coaching',
    status: 'answered',
    answerText: 'Good start.',
    answerSpeechText: 'Add one concrete example next.',
    knowledgeLayers: ['llm'],
    citations: [],
    externalCitations: [],
    feedback: {
      strengths: ['Clear main claim.', 'Relevant explanation.'],
      improvement: 'Add one concrete example.',
      exampleAnswer: 'Spaced practice improves retention because review is distributed over time.',
      scores: { clarity: 4, relevance: 5, structure: 4, completeness: 3, specificity: 3 },
      evidence: ['spaced practice improves retention'],
      academicAssessment: { label: 'direct', rationale: 'The answer addresses the question.' },
      academicResponse: 'The response gives the main claim.',
      nextQuestion: 'Which result best supports that claim?'
    },
    confidence: 'medium',
    followUp: 'Which result best supports that claim?',
    createdAt: new Date().toISOString(),
    answeredAt: new Date().toISOString()
  });

  const summary = store.sessionSummary(session);

  assert.equal(summary.completedTurns, 1);
  assert.equal(summary.overallScores.clarity, 4);
  assert.deepEqual(summary.recurringStrengths, ['Clear main claim.', 'Relevant explanation.']);
  assert.deepEqual(summary.recurringGaps, ['Add one concrete example.']);
});

test('authorized public sessions expose a bounded review record for typed and voice coaching turns', () => {
  const store = new InMemoryStore();
  const created = store.createSession({ topic: 'Restore records' });
  const session = store.get(created.session.id);
  const feedback = {
    strengths: ['Clear claim.', 'Relevant evidence.'],
    improvement: 'Explain the causal link.',
    exampleAnswer: 'The claim follows from the evidence.',
    scores: { clarity: 4, relevance: 4, structure: 3, completeness: 3, specificity: 3 },
    evidence: ['the evidence'],
    academicAssessment: { label: 'direct', rationale: 'The answer is on topic.' },
    academicResponse: 'The answer is relevant.',
    nextQuestion: 'What evidence supports it?'
  };
  session.turns.push({
    index: 0,
    question: 'What is the claim?',
    answer: 'The claim is clear.',
    feedback,
    createdAt: '2026-07-19T12:00:00.000Z'
  });
  session.voiceTurns.push({
    id: 'voice-review-1',
    sessionId: session.id,
    sequence: 0,
    inputMode: 'voice',
    question: 'What evidence supports it?',
    transcript: 'The results table supports it.',
    intent: 'coaching',
    status: 'answered',
    answerText: 'Good evidence choice.',
    answerSpeechText: 'Name the relevant result.',
    knowledgeLayers: ['llm'],
    citations: [],
    externalCitations: [],
    feedback,
    confidence: 'medium',
    followUp: 'How does the result support the claim?',
    createdAt: '2026-07-19T12:01:00.000Z',
    answeredAt: '2026-07-19T12:01:10.000Z'
  });

  const review = store.publicSession(session).review;

  assert.equal(review.transcript.length, 2);
  assert.deepEqual(review.transcript.map(turn => turn.question), [
    'What is the claim?',
    'What evidence supports it?'
  ]);
  assert.equal(review.transcript[1].voice, true);
  assert.deepEqual(review.transcript[1].feedback, feedback);
});
