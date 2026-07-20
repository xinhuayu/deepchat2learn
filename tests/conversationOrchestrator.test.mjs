import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationOrchestrator } from '../src/conversationOrchestrator.mjs';
import { InMemoryStore } from '../src/store.mjs';

function createSkillRegistry() {
  return {
    get(id) {
      return id ? { id, instructions: `Use ${id}.` } : null;
    }
  };
}

test('startSession creates a session, seeds the first question, and preserves the public session shape', async () => {
  const store = new InMemoryStore();
  let receivedSkillProfile = null;
  const orchestrator = createConversationOrchestrator({
    store,
    coach: {
      async initialQuestion(input) {
        receivedSkillProfile = input.skillProfile;
        return 'What is the central claim?';
      }
    },
    skillRegistry: createSkillRegistry(),
    researchAdapter: { enabled: false }
  });

  const created = await orchestrator.startSession({
    topic: 'Explain the paper',
    sourceMode: 'source'
  });

  assert.equal(created.question, 'What is the central claim?');
  assert.ok(created.token);
  assert.equal(created.session.topic, 'Explain the paper');
  assert.equal(created.session.currentQuestion, 'What is the central claim?');
  assert.equal(created.session.sourceMode, 'source');
  assert.equal(receivedSkillProfile.id, 'academic-conversation');
});

test('handleTurn routes practice answers through evaluateAnswer and advances the next question', async () => {
  const store = new InMemoryStore();
  const { session } = store.createSession({ topic: 'Practice topic' });
  const liveSession = store.get(session.id);
  liveSession.currentQuestion = 'What is the main idea?';
  let receivedSkillProfile = null;
  const orchestrator = createConversationOrchestrator({
    store,
    coach: {
      async evaluateAnswer(input) {
        receivedSkillProfile = input.skillProfile;
        return {
          strengths: ['clear focus'],
          improvement: 'add one example',
          exampleAnswer: 'Lead with one idea and support it with one example.',
          scores: { clarity: 4, relevance: 4, structure: 4, completeness: 3, specificity: 3 },
          evidence: [],
          nextQuestion: 'How would you support that point with evidence?'
        };
      }
    },
    skillRegistry: createSkillRegistry(),
    researchAdapter: { enabled: false }
  });

  const result = await orchestrator.handleTurn({
    session: liveSession,
    route: 'practice_answer',
    payload: { answer: 'I would explain the main idea first.' }
  });

  assert.equal(result.turn.answer, 'I would explain the main idea first.');
  assert.equal(result.feedback.improvement, 'add one example');
  assert.equal(result.nextQuestion, 'How would you support that point with evidence?');
  assert.equal(result.done, false);
  assert.equal(liveSession.currentQuestion, 'How would you support that point with evidence?');
  assert.equal(liveSession.turns.length, 1);
  assert.equal(receivedSkillProfile.id, 'academic-conversation');
});

test('typed practice evaluation receives the topic and five most recent exchanges', async () => {
  const store = new InMemoryStore();
  const { session } = store.createSession({ topic: 'Cognitive trajectories and health' });
  const liveSession = store.get(session.id);
  liveSession.currentQuestion = 'How do the trajectories relate to later health?';
  liveSession.turns = Array.from({ length: 6 }, (_, index) => ({
    index,
    question: `Earlier question ${index}`,
    answer: `Earlier answer ${index}`,
    createdAt: `2026-07-19T12:0${index}:00.000Z`
  }));
  let received = null;
  const orchestrator = createConversationOrchestrator({
    store,
    coach: {
      async evaluateAnswer(input) {
        received = input;
        return {
          strengths: ['clear focus', 'relevant connection'],
          improvement: 'Name the health outcome.',
          exampleAnswer: 'The trajectory predicts the later health outcome.',
          scores: { clarity: 4, relevance: 4, structure: 4, completeness: 3, specificity: 3 },
          evidence: [],
          nextQuestion: 'Which health outcome is most relevant?'
        };
      }
    },
    skillRegistry: createSkillRegistry(),
    researchAdapter: { enabled: false }
  });

  await orchestrator.handleTurn({
    session: liveSession,
    route: 'practice_answer',
    payload: { answer: 'The cognitive trajectories are associated with later health status.' }
  });

  assert.equal(received.topic, 'Cognitive trajectories and health');
  assert.equal(Array.isArray(received.conversationHistory), true);
  assert.equal(received.conversationHistory.length, 5);
  assert.deepEqual(received.conversationHistory.map(turn => turn.question), [
    'Earlier question 1',
    'Earlier question 2',
    'Earlier question 3',
    'Earlier question 4',
    'Earlier question 5'
  ]);
});

test('a typed ending request completes the session without evaluating an answer or asking another question', async () => {
  const store = new InMemoryStore();
  const { session } = store.createSession({ topic: 'Practice topic' });
  const liveSession = store.get(session.id);
  liveSession.currentQuestion = 'What is the main idea?';
  let evaluations = 0;
  const orchestrator = createConversationOrchestrator({
    store,
    coach: {
      async evaluateAnswer() {
        evaluations += 1;
        throw new Error('Ending requests must not be evaluated.');
      }
    },
    skillRegistry: createSkillRegistry(),
    researchAdapter: { enabled: false }
  });

  const result = await orchestrator.handleTurn({
    session: liveSession,
    route: 'practice_answer',
    payload: { answer: 'I am done. Please finish the conversation.' }
  });

  assert.equal(result.done, true);
  assert.equal(result.sessionEnded, true);
  assert.equal(result.nextQuestion, null);
  assert.match(result.closingMessage, /session is complete/i);
  assert.equal(evaluations, 0);
  assert.equal(liveSession.turns.length, 0);
  assert.equal(liveSession.status, 'ready_to_complete');
});

test('handleTurn routes typed source questions through the shared answer boundary and preserves the legacy question payload', async () => {
  const store = new InMemoryStore();
  const { session } = store.createSession({
    topic: 'Source topic',
    sourceMode: 'source',
    skillId: 'epi-research',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    skillSelectionReason: 'Chosen for source mode.'
  });
  const liveSession = store.get(session.id);
  liveSession.sources.push({
    id: 'source-1',
    name: 'paper.txt',
    text: 'The paper says retrieval practice improves retention.',
    status: 'digesting',
    warnings: [],
    byteCount: 53,
    wordCount: 7,
    pageCount: null,
    metadata: { pageCount: null, sectionCount: 0 },
    figures: [],
    tables: [],
    captions: [],
    createdAt: '2026-07-17T12:00:00.000Z'
  });
  liveSession.digestStatus = 'processing';
  let receivedArgs = null;
  const orchestrator = createConversationOrchestrator({
    store,
    coach: {},
    skillRegistry: createSkillRegistry(),
    researchAdapter: { enabled: false },
    config: {
      answerTurn: async args => {
        receivedArgs = args;
        return {
          turn: { id: 'typed-source-1', intent: 'source_question', status: 'answered' },
          answerText: 'The source argues for retrieval practice.',
          answerSpeechText: 'The source argues for retrieval practice.',
          knowledgeLayers: ['source'],
          citations: [],
          externalCitations: [],
          discussionPoints: [],
          suggestions: [],
          unsupportedOrUnresolved: [],
          conflicts: [],
          confidence: 'high',
          followUp: 'Would you like the exact supporting passage?',
          sourceSupportStatus: 'supported',
          externalKnowledgeStatus: 'not_requested',
          nextState: 'speaking_answer',
          legacyAnswer: {
            mode: 'source',
            answer: 'The source argues for retrieval practice.',
            sourceGroundedClaims: [],
            additionalContext: [],
            unsupportedOrUnresolved: [],
            confidence: 'high'
          }
        };
      }
    }
  });

  const result = await orchestrator.handleTurn({
    session: liveSession,
    route: 'typed_question',
    payload: { mode: 'source', question: 'What does the source say?' }
  });

  assert.equal(receivedArgs.inputMode, 'typed');
  assert.equal(receivedArgs.intentHint, 'source_question');
  assert.equal(receivedArgs.transcriptReviewed, true);
  assert.equal(receivedArgs.transcriptConfidence, 1);
  assert.equal(result.mode, 'source');
  assert.equal(result.answer, 'The source argues for retrieval practice.');
  assert.equal(result.sourceDigestStatus, 'Your materials are still processing, so grounded answers are not ready yet. You can keep chatting while the digest finishes.');
  assert.equal(result.session.id, liveSession.id);
});

test('handleTurn routes voice source answers through the shared answer boundary and updates the current question from the follow-up', async () => {
  const store = new InMemoryStore();
  const { session } = store.createSession({
    topic: 'Voice source topic',
    sourceMode: 'source',
    skillId: 'epi-research',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    skillSelectionReason: 'Chosen for source mode.'
  });
  const liveSession = store.get(session.id);
  liveSession.currentQuestion = 'What study design did the researchers use?';
  liveSession.voiceTurns = [];
  liveSession.voiceIdempotency = new Map();
  liveSession.sources.push({
    id: 'source-1',
    name: 'paper.txt',
    text: 'The researchers used a cohort design.',
    status: 'ready',
    warnings: [],
    byteCount: 37,
    wordCount: 6,
    pageCount: null,
    metadata: { pageCount: null, sectionCount: 0 },
    figures: [],
    tables: [],
    captions: [],
    createdAt: '2026-07-17T12:00:00.000Z'
  });
  let receivedArgs = null;
  const orchestrator = createConversationOrchestrator({
    store,
    coach: {},
    skillRegistry: createSkillRegistry(),
    researchAdapter: { enabled: false },
    config: {
      answerTurn: async args => {
        receivedArgs = args;
        return {
          turn: { id: 'voice-source-1', intent: 'source_answer', status: 'answered' },
          answerText: 'The paper uses a cohort design.',
          answerSpeechText: 'The paper uses a cohort design.',
          knowledgeLayers: ['source'],
          citations: [],
          externalCitations: [],
          discussionPoints: [],
          suggestions: [],
          unsupportedOrUnresolved: [],
          conflicts: [],
          confidence: 'high',
          followUp: 'How does that design establish temporality?',
          sourceSupportStatus: 'supported',
          externalKnowledgeStatus: 'not_requested',
          nextState: 'speaking_answer'
        };
      }
    }
  });

  const result = await orchestrator.handleTurn({
    session: liveSession,
    route: 'voice_turn',
    payload: {
      transcript: 'The researchers used a cohort design.',
      transcriptConfidence: 0.95,
      transcriptReviewed: true,
      idempotencyKey: 'voice-source-1'
    }
  });

  assert.equal(receivedArgs.inputMode, 'voice');
  assert.equal(receivedArgs.intentHint, null);
  assert.equal(result.turn.intent, 'source_answer');
  assert.equal(result.done, false);
  assert.equal(liveSession.currentQuestion, 'How does that design establish temporality?');
  assert.equal(liveSession.voiceState, 'speaking_answer');
});

test('handleTurn preserves control and new-question voice behavior without consuming a practice round', async () => {
  const store = new InMemoryStore();
  const { session } = store.createSession({
    topic: 'Voice controls',
    sourceMode: 'source',
    skillId: 'epi-research',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    skillSelectionReason: 'Chosen for source mode.'
  });
  const liveSession = store.get(session.id);
  liveSession.currentQuestion = 'What is the main result?';
  liveSession.voiceTurns = [];
  liveSession.voiceIdempotency = new Map();
  const orchestrator = createConversationOrchestrator({
    store,
    coach: {},
    skillRegistry: createSkillRegistry(),
    researchAdapter: { enabled: false },
    config: {
      answerTurn: async ({ transcript }) => {
        if (transcript === 'pause') {
          return {
            turn: { id: 'voice-control-1', intent: 'control', status: 'answered' },
            answerText: 'Voice control acknowledged: pause.',
            answerSpeechText: 'Voice control acknowledged: pause.',
            knowledgeLayers: ['llm'],
            citations: [],
            externalCitations: [],
            discussionPoints: [],
            suggestions: [],
            unsupportedOrUnresolved: [],
            conflicts: [],
            confidence: 'high',
            followUp: null,
            sourceSupportStatus: 'not_applicable',
            externalKnowledgeStatus: 'not_requested',
            nextState: 'paused',
            countsAsAnswer: false
          };
        }
        return {
          turn: { id: 'voice-new-question-1', intent: 'new_question', status: 'answered' },
          answerText: 'Let us move to a new question.',
          answerSpeechText: 'Let us move to a new question. What assumption matters most here?',
          knowledgeLayers: ['llm'],
          citations: [],
          externalCitations: [],
          discussionPoints: [],
          suggestions: [],
          unsupportedOrUnresolved: [],
          conflicts: [],
          confidence: 'high',
          followUp: 'What assumption matters most here?',
          sourceSupportStatus: 'not_applicable',
          externalKnowledgeStatus: 'not_requested',
          nextState: 'speaking_answer',
          countsAsAnswer: false,
          newQuestion: true
        };
      }
    }
  });

  const controlResult = await orchestrator.handleTurn({
    session: liveSession,
    route: 'voice_turn',
    payload: {
      transcript: 'pause',
      transcriptConfidence: 0.81,
      transcriptReviewed: true,
      idempotencyKey: 'voice-control-1'
    }
  });

  assert.equal(controlResult.turn.intent, 'control');
  assert.equal(controlResult.done, false);
  assert.equal(liveSession.currentQuestion, 'What is the main result?');
  assert.equal(liveSession.voiceState, 'paused');

  const newQuestionResult = await orchestrator.handleTurn({
    session: liveSession,
    route: 'voice_turn',
    payload: {
      transcript: 'move on',
      transcriptConfidence: 0.84,
      transcriptReviewed: true,
      idempotencyKey: 'voice-new-question-1'
    }
  });

  assert.equal(newQuestionResult.turn.intent, 'new_question');
  assert.equal(newQuestionResult.countsAsAnswer, false);
  assert.equal(liveSession.currentQuestion, 'What assumption matters most here?');
});

test('server reuses orchestrator-owned routing helpers instead of redefining them', async () => {
  const [serverSource, orchestratorSource] = await Promise.all([
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/conversationOrchestrator.mjs', import.meta.url), 'utf8')
  ]);

  const sharedHelpers = [
    'validateSessionInput',
    'refreshSkillSelection',
    'handleVoiceTurn',
    'handleTypedQuestion',
    'translateLegacyQuestionAnswer',
    'sourceProcessingMessage',
    'serializeSource',
    'lookupExternalResearch'
  ];

  for (const helperName of sharedHelpers) {
    assert.match(orchestratorSource, new RegExp(`export\\s+(?:async\\s+)?function\\s+${helperName}\\b`));
    assert.doesNotMatch(serverSource, new RegExp(`(?:async\\s+)?function\\s+${helperName}\\b`));
  }

  assert.match(serverSource, /from '\.\/conversationOrchestrator\.mjs';/);
  assert.match(serverSource, /\brefreshSkillSelection\b/);
  assert.match(serverSource, /\bserializeSource\b/);
});

test('getSourceStatus returns source-list and digest views without an HTTP server', () => {
  const store = new InMemoryStore();
  const { session } = store.createSession({
    topic: 'Source status',
    sourceMode: 'source',
    skillId: 'epi-research',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    skillSelectionReason: 'Chosen for source mode.'
  });
  const liveSession = store.get(session.id);
  liveSession.digestStatus = 'ready';
  liveSession.digestWarnings = ['Digest note'];
  liveSession.digestError = null;
  liveSession.sourceDigest = { keyPoints: [{ text: 'Key point' }], conflicts: [], warnings: [] };
  liveSession.sources.push({
    id: 'source-1',
    name: 'paper.txt',
    text: 'The source text.',
    status: 'ready',
    warnings: [],
    byteCount: 16,
    wordCount: 3,
    pageCount: null,
    metrics: {
      bytes: 16,
      words: 3,
      pages: null,
      chunkCount: 1,
      tableCount: 0,
      figureCount: 0,
      captionCount: 0,
      extractionMethod: 'text-direct'
    },
    metadata: { pageCount: null, sectionCount: 0 },
    figures: [],
    tables: [],
    captions: [],
    chunks: [{ id: 'chunk-1' }],
    createdAt: '2026-07-17T12:00:00.000Z'
  });
  const orchestrator = createConversationOrchestrator({
    store,
    coach: {},
    skillRegistry: createSkillRegistry(),
    researchAdapter: { enabled: false }
  });

  const listView = orchestrator.getSourceStatus({ session: liveSession, view: 'sources' });
  const digestView = orchestrator.getSourceStatus({ session: liveSession, view: 'digest' });

  assert.equal(listView.digestStatus, 'ready');
  assert.equal(listView.sources[0].digestStatus, 'ready');
  assert.equal(listView.sources[0].chunkCount, 1);
  assert.equal(listView.skillId, 'epi-research');
  assert.equal(digestView.status, 'ready');
  assert.equal(digestView.sourceCount, 1);
  assert.deepEqual(digestView.digest, liveSession.sourceDigest);
});

test('buildSummary completes the session and returns the existing summary contract', () => {
  const store = new InMemoryStore();
  const { session } = store.createSession({ topic: 'Summary topic' });
  const liveSession = store.get(session.id);
  liveSession.turns.push({
    index: 0,
    question: 'What is the main idea?',
    answer: 'The main idea is retrieval practice.',
    feedback: {
      strengths: ['clear point'],
      improvement: 'add evidence',
      academicResponse: 'Retrieval practice supports retention.'
    },
    createdAt: '2026-07-17T12:00:00.000Z'
  });
  const orchestrator = createConversationOrchestrator({
    store,
    coach: {},
    skillRegistry: createSkillRegistry(),
    researchAdapter: { enabled: false }
  });

  const result = orchestrator.buildSummary({ session: liveSession });

  assert.equal(liveSession.status, 'completed');
  assert.equal(result.summary.turnCount, 1);
  assert.deepEqual(result.summary.recurringStrengths, ['clear point']);
});
