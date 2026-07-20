import test from 'node:test';
import assert from 'node:assert/strict';
import { approveVoiceAnswer, answerVoiceTurn, buildConversationHistory, createVoiceTurn, validateVoiceState } from '../src/voiceSession.mjs';
import { countCompletedTurns } from '../src/store.mjs';

test('voice answers with source knowledge require at least one citation', () => {
  const turn = createVoiceTurn({
    sessionId: 'session-1',
    inputMode: 'voice',
    transcript: 'Explain the second argument.',
    transcriptConfidence: 0.91,
    transcriptReviewed: false,
    idempotencyKey: 'voice-turn-1'
  });

  assert.throws(() => approveVoiceAnswer(turn, {
    answerText: 'The second argument is about transfer effects.',
    answerSpeechText: 'The second argument is about transfer effects.',
    knowledgeLayers: ['source'],
    citations: [],
    externalCitations: [],
    confidence: 'high',
    followUp: 'Would you like the supporting passage?'
  }), /citation/i);
});

test('createVoiceTurn normalizes a pending voice turn', () => {
  const turn = createVoiceTurn({
    sessionId: 'session-2',
    inputMode: 'typed',
    transcript: '  What is external validity?  ',
    transcriptConfidence: 2,
    transcriptReviewed: 'yes',
    idempotencyKey: 'typed-turn-1'
  });

  assert.ok(turn.id);
  assert.equal(turn.sessionId, 'session-2');
  assert.equal(turn.sequence, null);
  assert.equal(turn.inputMode, 'typed');
  assert.equal(turn.transcript, 'What is external validity?');
  assert.equal(turn.transcriptConfidence, 1);
  assert.equal(turn.transcriptReviewed, true);
  assert.equal(turn.intent, 'general_question');
  assert.equal(turn.status, 'pending');
  assert.deepEqual(turn.knowledgeLayers, []);
  assert.deepEqual(turn.citations, []);
  assert.deepEqual(turn.externalCitations, []);
  assert.equal(turn.idempotencyKey, 'typed-turn-1');
  assert.equal(typeof turn.createdAt, 'string');
});

test('approveVoiceAnswer returns an answered turn with normalized metadata', () => {
  const pending = createVoiceTurn({
    sessionId: 'session-3',
    inputMode: 'voice',
    transcript: 'Summarize the source.',
    transcriptConfidence: 0.51,
    transcriptReviewed: true
  });

  const answered = approveVoiceAnswer(pending, {
    answerText: 'Your material defines the term narrowly.',
    answerSpeechText: 'Your material defines the term narrowly.',
    knowledgeLayers: ['source', 'llm'],
    citations: [{ sourceId: 'source-1', page: 4, section: 'Results', start: 12, end: 64 }],
    externalCitations: [],
    confidence: 'medium',
    followUp: 'Want the exact quote?'
  });

  assert.equal(answered.id, pending.id);
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answerText, 'Your material defines the term narrowly.');
  assert.equal(answered.answerSpeechText, 'Your material defines the term narrowly.');
  assert.deepEqual(answered.knowledgeLayers, ['source', 'llm']);
  assert.equal(answered.confidence, 'medium');
  assert.equal(answered.followUp, 'Want the exact quote?');
  assert.ok(answered.answeredAt);
});

test('approveVoiceAnswer rejects fabricated source excerpts and accepts exact supporting substrings', () => {
  const pending = createVoiceTurn({
    sessionId: 'session-4',
    inputMode: 'voice',
    transcript: 'What does the source claim?',
    transcriptConfidence: 0.73,
    transcriptReviewed: false
  });

  assert.throws(() => approveVoiceAnswer(pending, {
    answerText: 'The source says learning improves transfer.',
    answerSpeechText: 'The source says learning improves transfer.',
    knowledgeLayers: ['source'],
    citations: [{
      sourceId: 'source-9',
      start: 0,
      end: 17,
      excerpt: 'invented evidence',
      sourceText: 'learning improves transfer across contexts'
    }],
    externalCitations: [],
    confidence: 'high',
    followUp: null
  }), /exact supporting substring/i);

  const answered = approveVoiceAnswer(pending, {
    answerText: 'The source says learning improves transfer.',
    answerSpeechText: 'The source says learning improves transfer.',
    knowledgeLayers: ['source'],
    citations: [{
      sourceId: 'source-9',
      start: 0,
      end: 26,
      excerpt: 'learning improves transfer',
      sourceText: 'learning improves transfer across contexts'
    }],
    externalCitations: [],
    confidence: 'high',
    followUp: null
  });

  assert.equal(answered.citations[0].excerpt, 'learning improves transfer');
});

test('validateVoiceState only allows declared transitions', () => {
  assert.equal(validateVoiceState('idle', 'permission_pending'), true);
  assert.equal(validateVoiceState('speaking_answer', 'awaiting_user'), true);
  assert.equal(validateVoiceState('awaiting_user', 'connecting'), false);
  assert.equal(validateVoiceState('made_up_state', 'idle'), false);
});

test('voice coaching keeps academic response notes out of spoken feedback', async () => {
  const session = {
    id: 'session-coaching-1',
    topic: 'epidemiology',
    sourceMode: 'none',
    activeSkillId: 'none',
    currentQuestion: 'What is a cohort study?',
    questionLimit: 50,
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: []
  };
  const store = {
    getVoiceTurnReplay() { return null; },
    recordVoiceTurnResult(activeSession, key, result) {
      activeSession.voiceTurns.push(result.turn);
      if (key) activeSession.voiceIdempotency.set(key, result);
      return result;
    }
  };
  const result = await answerVoiceTurn({
    session,
    transcript: 'A cohort study follows exposed and unexposed groups over time.',
    transcriptConfidence: 0.9,
    transcriptReviewed: false,
    idempotencyKey: 'coaching-1',
    externalResearch: { approved: false },
    store,
    coach: {
      async evaluateAnswer() {
        return {
          strengths: ['You identified the longitudinal comparison.', 'You named exposed and unexposed groups.'],
          improvement: 'Add the outcome definition.',
          exampleAnswer: 'A cohort study follows groups defined by exposure to compare later outcomes.',
          scores: { clarity: 4, relevance: 5, structure: 4, completeness: 3, specificity: 4 },
          evidence: ['follows exposed and unexposed groups over time'],
          academicAssessment: { label: 'direct', rationale: 'The answer is directly relevant.' },
          academicResponse: 'Academically, a cohort study defines groups by exposure and observes outcomes over time.',
          nextQuestion: 'What outcome would you measure, and when would you measure it?'
        };
      }
    }
  });
  assert.doesNotMatch(result.answerSpeechText, /Academically, a cohort study/i);
  assert.match(result.answerSpeechText, /Add the outcome definition/i);
  assert.match(result.answerSpeechText, /What outcome would you measure/i);
  assert.equal(result.feedback.academicAssessment.label, 'direct');
});

test('voice coaching receives the topic and five most recent exchanges', async () => {
  const session = {
    id: 'session-coaching-context',
    topic: 'Cognitive trajectories and health',
    sourceMode: 'none',
    activeSkillId: 'none',
    currentQuestion: 'How do cognitive trajectories relate to later health?',
    questionLimit: 50,
    turns: Array.from({ length: 6 }, (_, index) => ({
      index,
      question: `Earlier question ${index}`,
      answer: `Earlier answer ${index}`,
      createdAt: `2026-07-19T12:0${index}:00.000Z`
    })),
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: []
  };
  const store = {
    getVoiceTurnReplay() { return null; },
    recordVoiceTurnResult(activeSession, key, result) {
      activeSession.voiceTurns.push(result.turn);
      if (key) activeSession.voiceIdempotency.set(key, result);
      return result;
    }
  };
  let received = null;

  await answerVoiceTurn({
    session,
    transcript: 'The trajectories may predict later health differences.',
    idempotencyKey: 'coaching-context-1',
    store,
    coach: {
      async evaluateAnswer(input) {
        received = input;
        return {
          strengths: ['You kept the relationship clear.', 'You connected cognition and health.'],
          improvement: 'Name one specific later health outcome.',
          exampleAnswer: 'A trajectory may be associated with a later health outcome.',
          scores: { clarity: 4, relevance: 5, structure: 4, completeness: 3, specificity: 4 },
          evidence: ['predict later health differences'],
          academicAssessment: { label: 'direct', rationale: 'The response stays on the current topic.' },
          academicResponse: 'The response links the cognitive pattern to a later health outcome.',
          nextQuestion: 'Which later health outcome would clarify that association?'
        };
      }
    }
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

test('voice coaching limits the spoken next step to one concise action before the next question', async () => {
  const session = {
    id: 'session-coaching-concise',
    topic: 'epidemiology',
    sourceMode: 'none',
    activeSkillId: 'none',
    currentQuestion: 'What is a cohort study?',
    questionLimit: 50,
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: []
  };
  const store = {
    getVoiceTurnReplay() { return null; },
    recordVoiceTurnResult(activeSession, key, result) {
      activeSession.voiceTurns.push(result.turn);
      if (key) activeSession.voiceIdempotency.set(key, result);
      return result;
    }
  };

  const result = await answerVoiceTurn({
    session,
    transcript: 'It follows exposure-defined groups and compares later outcomes.',
    idempotencyKey: 'coaching-concise-1',
    store,
    coach: {
      async evaluateAnswer() {
        return {
          strengths: ['You named the exposure groups.', 'You described the time sequence.'],
          improvement: 'Name one specific outcome before moving on. This extra sentence should not be spoken because it introduces an unrelated and overly broad suggestion about statistical modeling.',
          exampleAnswer: 'A cohort study follows exposure-defined groups and compares a later outcome.',
          scores: { clarity: 4, relevance: 5, structure: 4, completeness: 3, specificity: 4 },
          evidence: ['exposure-defined groups'],
          academicAssessment: { label: 'direct', rationale: 'The answer addresses the question.' },
          academicResponse: 'The response correctly describes the basic cohort design.',
          nextQuestion: 'Which outcome would you define for this study?'
        };
      }
    }
  });

  assert.match(result.answerSpeechText, /Name one specific outcome before moving on\./);
  assert.doesNotMatch(result.answerSpeechText, /statistical modeling/i);
  assert.match(result.answerSpeechText, /Which outcome would you define/i);
});

test('explicit ending phrases close a voice session without coaching or a follow-up question', async () => {
  const session = {
    id: 'session-ending-1',
    topic: 'epidemiology',
    sourceMode: 'none',
    activeSkillId: 'none',
    currentQuestion: 'What is a cohort study?',
    questionLimit: 50,
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: []
  };
  const store = {
    getVoiceTurnReplay() { return null; },
    recordVoiceTurnResult(activeSession, key, result) {
      activeSession.voiceTurns.push(result.turn);
      if (key) activeSession.voiceIdempotency.set(key, result);
      return result;
    }
  };

  const result = await answerVoiceTurn({
    session,
    transcript: 'I am done. Please wrap up the conversation.',
    inputMode: 'typed',
    intentHint: 'source_question',
    idempotencyKey: 'ending-1',
    store,
    coach: {
      async evaluateAnswer() {
        throw new Error('An ending request must not be evaluated.');
      }
    }
  });

  assert.equal(result.turn.intent, 'end_session');
  assert.equal(result.sessionEnded, true);
  assert.equal(result.countsAsAnswer, false);
  assert.equal(result.nextState, 'completed');
  assert.equal(result.followUp, null);
  assert.match(result.answerText, /session is complete/i);
  assert.equal(countCompletedTurns(session), 0);
});

test('practice voice evaluation receives the academic conversation skill', async () => {
  const session = {
    id: 'session-practice-skill',
    topic: 'epidemiology',
    sourceMode: 'none',
    activeSkillId: 'none',
    currentQuestion: 'What is a cohort study?',
    questionLimit: 50,
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: []
  };
  const store = {
    getVoiceTurnReplay() { return null; },
    recordVoiceTurnResult(activeSession, key, result) {
      activeSession.voiceTurns.push(result.turn);
      if (key) activeSession.voiceIdempotency.set(key, result);
      return result;
    }
  };
  let receivedSkillProfile = null;
  const baseCoach = {
    async evaluateAnswer(input) {
      receivedSkillProfile = input.skillProfile;
      return {
        strengths: ['You named the comparison.', 'You used a temporal sequence.'],
        improvement: 'Add the outcome definition.',
        exampleAnswer: 'A cohort study follows exposure-defined groups to compare later outcomes.',
        scores: { clarity: 4, relevance: 5, structure: 4, completeness: 3, specificity: 4 },
        evidence: ['follows exposed and unexposed groups over time'],
        academicAssessment: { label: 'direct', rationale: 'The answer is directly relevant.' },
        academicResponse: 'Academically, a cohort study defines groups by exposure and observes outcomes over time.',
        nextQuestion: 'What outcome would you measure next?'
      };
    }
  };

  await answerVoiceTurn({
    session,
    transcript: 'A cohort study follows exposed and unexposed groups over time.',
    idempotencyKey: 'practice-skill-1',
    store,
    coach: baseCoach,
    skillRegistry: { get(id) { return { id, instructions: `Use ${id} guidance.` }; } }
  });

  assert.equal(receivedSkillProfile.id, 'academic-conversation');
});

test('conversation context keeps source and practice histories separate and bounded to five turns', () => {
  const sourceSession = {
    sourceMode: 'source',
    turns: [
      { mode: 'practice', question: 'Practice question', answer: 'Practice answer' },
      { mode: 'source', question: 'Source question one', answer: 'Source answer one' },
      { mode: 'source', question: 'Source question two', answer: 'Source answer two' }
    ],
    voiceTurns: [
      { mode: 'source', intent: 'source_question', transcript: 'Source voice question', answerText: 'Source voice answer' },
      { mode: 'practice', intent: 'coaching', transcript: 'Practice voice answer', answerText: 'Practice response' }
    ]
  };
  const sourceHistory = buildConversationHistory(sourceSession);
  assert.equal(sourceHistory.length, 3);
  assert.ok(sourceHistory.length <= 5);
  assert.ok(sourceHistory.every(item => item.mode === 'source'));

  const practiceSession = { ...sourceSession, sourceMode: 'none' };
  const practiceHistory = buildConversationHistory(practiceSession);
  assert.equal(practiceHistory.length, 2);
  assert.ok(practiceHistory.length <= 5);
  assert.ok(practiceHistory.every(item => item.mode === 'practice'));
});

test('new question requests generate a fresh question without consuming an answer round', async () => {
  const session = {
    id: 'session-new-question',
    topic: 'epidemiologic study design',
    sourceMode: 'none',
    activeSkillId: 'none',
    conversationSkillId: 'academic-conversation',
    currentQuestion: 'What is a cohort study?',
    questionLimit: 50,
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: []
  };
  const store = {
    getVoiceTurnReplay() { return null; },
    recordVoiceTurnResult(activeSession, key, result) {
      activeSession.voiceTurns.push(result.turn);
      if (key) activeSession.voiceIdempotency.set(key, result);
      return result;
    }
  };
  const result = await answerVoiceTurn({
    session,
    transcript: 'Ask something new.',
    idempotencyKey: 'new-question-1',
    store,
    coach: { async nextQuestion() { return 'What is another important issue in cohort-study validity?'; } },
    skillRegistry: { get(id) { return { id, instructions: `Use ${id} guidance.` }; } }
  });

  assert.equal(result.turn.intent, 'new_question');
  assert.equal(result.countsAsAnswer, false);
  assert.equal(result.followUp, 'What is another important issue in cohort-study validity?');
  assert.equal(session.currentQuestion, result.followUp);
  assert.equal(countCompletedTurns(session), 0);
});

test('source conversation new-question requests keep the academic dialogue skill', async () => {
  const session = {
    id: 'session-source-new-question',
    topic: 'research methods',
    sourceMode: 'source',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    currentQuestion: 'What is the study design?',
    questionLimit: 200,
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: [{ id: 'source-1', name: 'paper.txt', text: 'The cohort study reports an association.' }]
  };
  const store = {
    getVoiceTurnReplay() { return null; },
    recordVoiceTurnResult(activeSession, key, result) {
      activeSession.voiceTurns.push(result.turn);
      if (key) activeSession.voiceIdempotency.set(key, result);
      return result;
    }
  };
  let receivedSkillProfile = null;
  const result = await answerVoiceTurn({
    session,
    transcript: 'Another issue, please.',
    idempotencyKey: 'source-new-question-1',
    store,
    coach: {
      async nextQuestion(input) {
        receivedSkillProfile = input.skillProfile;
        return 'What assumption matters most for interpreting this association?';
      }
    },
    skillRegistry: { get(id) { return { id, instructions: `Use ${id} guidance.` }; } }
  });

  assert.equal(result.turn.intent, 'new_question');
  assert.equal(receivedSkillProfile.id, 'academic-conversation');
  assert.equal(result.followUp, 'What assumption matters most for interpreting this association?');
  assert.equal(countCompletedTurns(session), 0);
});

test('answerVoiceTurn returns the approved source answer envelope and replays duplicate idempotency keys', async () => {
  const session = {
    id: 'session-voice-1',
    topic: 'Explain the source',
    sourceMode: 'source',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    currentQuestion: '',
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: [{
      id: 'source-1',
      name: 'paper.txt',
      chunks: [{
        id: 'source-1:chunk:1',
        sourceId: 'source-1',
        sourceName: 'paper.txt',
        ordinal: 1,
        text: 'The second argument is that spaced practice improves long-term retention.',
        page: 4,
        section: 'Results',
        start: 120,
        end: 191,
        relevanceScore: 8
      }]
    }],
    sourceDigest: {
      keyPoints: [{ text: 'Spaced practice improves long-term retention.', sourceIds: ['source-1'], chunkIds: ['source-1:chunk:1'] }],
      conflicts: [],
      warnings: []
    }
  };
  const store = {
    retrieveSourceChunks() {
      return session.sources[0].chunks;
    },
    getVoiceTurnReplay(activeSession, key) {
      return activeSession.voiceIdempotency.get(key) || null;
    },
    recordVoiceTurnResult(activeSession, key, result) {
      const existing = activeSession.voiceIdempotency.get(key);
      if (existing) return existing;
      activeSession.voiceTurns.push(result.turn);
      activeSession.voiceIdempotency.set(key, result);
      return result;
    }
  };
  let receivedSkillProfile = null;
  let receivedGeneralKnowledgeAllowed = null;
  const coach = {
    async composeBlendedAnswer(input) {
      receivedSkillProfile = input.skillProfile;
      receivedGeneralKnowledgeAllowed = input.generalKnowledgeAllowed;
      return {
        answerText: 'The second argument is that spaced practice improves long-term retention.',
        answerSpeechText: 'The second argument is that spaced practice improves long-term retention.',
        sourceClaims: [{
          claim: 'The second argument is that spaced practice improves long-term retention.',
          chunkId: 'source-1:chunk:1',
          citationExcerpt: 'The second argument is that spaced practice improves long-term retention.'
        }],
        llmBackground: ['This supports the paper’s learning recommendation.'],
        discussionPoints: ['Compare the argument with the study design.'],
        suggestions: ['Check whether the evidence generalizes to your setting.'],
        externalClaims: [],
        citations: [{
          sourceId: 'source-1',
          chunkId: 'source-1:chunk:1',
          excerpt: 'The second argument is that spaced practice improves long-term retention.',
          page: 4,
          section: 'Results',
          start: 120,
          end: 191
        }],
        externalCitations: [],
        confidence: 'high',
        uncertainty: [],
        conflicts: [],
        followUp: 'Would you like the exact supporting passage?'
      };
    }
  };

  const first = await answerVoiceTurn({
    session,
    transcript: 'Explain the second argument in my paper.',
    transcriptConfidence: 0.93,
    transcriptReviewed: false,
    idempotencyKey: 'voice-turn-1',
    externalResearch: { approved: false },
    store,
    coach,
    skillRegistry: {
      get(id) {
        return { id, instructions: `Use ${id} guidance.` };
      }
    }
  });

  assert.equal(first.turn.status, 'answered');
  assert.equal(first.turn.intent, 'source_question');
  assert.match(first.answerSpeechText, /The second argument is that spaced practice improves long-term retention\./);
  assert.equal((first.answerSpeechText.match(/\?/g) || []).length, 1);
  assert.doesNotMatch(first.answerSpeechText, /Discussion point:|Suggestion:|Next question:/);
  assert.match(first.answerSpeechText, /Would you like the exact supporting passage\?/);
  assert.deepEqual(first.knowledgeLayers, ['source', 'llm']);
  assert.deepEqual(first.discussionPoints, ['Compare the argument with the study design.']);
  assert.deepEqual(first.suggestions, ['Check whether the evidence generalizes to your setting.']);
  assert.equal(first.citations[0].page, 4);
  assert.equal(first.confidence, 'high');
  assert.equal(first.nextState, 'speaking_answer');
  assert.equal(receivedSkillProfile.id, 'academic-conversation');
  assert.equal(receivedGeneralKnowledgeAllowed, true);
  assert.equal(first.requiresExternalConsent, false);
  assert.equal(session.voiceTurns.length, 1);

  const replay = await answerVoiceTurn({
    session,
    transcript: 'Explain the second argument in my paper.',
    transcriptConfidence: 0.1,
    transcriptReviewed: true,
    idempotencyKey: 'voice-turn-1',
    externalResearch: { approved: false },
    store,
    coach
  });

  assert.deepEqual(replay, first);
  assert.equal(session.voiceTurns.length, 1);
});

test('source conversation evaluates an answer against the active question without switching to practice coaching', async () => {
  const session = {
    id: 'session-source-answer',
    topic: 'epidemiologic study design',
    sourceMode: 'source',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    currentQuestion: 'What study design did the researchers use?',
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: [{ id: 'source-1', name: 'paper.txt', text: 'The researchers used a longitudinal cohort design.' }]
  };
  const chunk = {
    id: 'source-1:chunk:1',
    sourceId: 'source-1',
    sourceName: 'paper.txt',
    text: 'The researchers used a longitudinal cohort design.',
    page: 1,
    section: 'Methods',
    start: 0,
    end: 51,
    relevanceScore: 9
  };
  let received = null;
  const result = await answerVoiceTurn({
    session,
    transcript: 'The researchers used a longitudinal cohort design.',
    idempotencyKey: 'source-answer-1',
    store: {
      retrieveSourceChunks() { return [chunk]; },
      getVoiceTurnReplay() { return null; },
      recordVoiceTurnResult(activeSession, key, value) {
        activeSession.voiceTurns.push(value.turn);
        activeSession.voiceIdempotency.set(key, value);
        return value;
      }
    },
    coach: {
      async composeBlendedAnswer(input) {
        received = input;
        return {
          answerText: 'The paper uses a longitudinal cohort design.',
          answerSpeechText: 'Your answer is directly relevant. The paper uses a longitudinal cohort design.',
          sourceClaims: [{ claim: 'The researchers used a longitudinal cohort design.', chunkId: chunk.id, citationExcerpt: chunk.text }],
          llmBackground: [],
          discussionPoints: ['Now consider how the design supports temporality.'],
          suggestions: [],
          externalClaims: [],
          citations: [{ sourceId: chunk.sourceId, chunkId: chunk.id, excerpt: chunk.text, page: 1, section: 'Methods', start: 0, end: chunk.end }],
          externalCitations: [],
          confidence: 'high',
          uncertainty: [],
          conflicts: [],
          academicAssessment: { label: 'direct', rationale: 'The answer directly identifies the study design.' },
          followUp: 'How does this design establish the time order between exposure and outcome?'
        };
      }
    },
    skillRegistry: { get(id) { return { id, instructions: `Use ${id} guidance.` }; } }
  });

  assert.equal(result.turn.intent, 'source_answer');
  assert.equal(result.feedback, undefined);
  assert.equal(result.academicAssessment.label, 'direct');
  assert.doesNotMatch(result.answerSpeechText, /directly relevant/i);
  assert.match(result.answerSpeechText, /longitudinal cohort design/i);
  assert.equal(result.strengths, undefined);
  assert.equal(result.improvement, undefined);
  assert.equal(result.exampleAnswer, undefined);
  assert.equal(result.scores, undefined);
  assert.equal(received.currentQuestion, session.currentQuestion);
  assert.equal(received.turnRole, 'answer_to_ai');
});

test('source voice replies stay concise and avoid repeating the follow-up question', async () => {
  const session = {
    id: 'session-source-concise',
    topic: 'learning science',
    sourceMode: 'source',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    currentQuestion: 'What is the main finding?',
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: [{ id: 'source-1', name: 'paper.txt', text: 'Spaced practice improves retention.' }]
  };
  const chunk = {
    id: 'source-1:chunk:1',
    sourceId: 'source-1',
    sourceName: 'paper.txt',
    text: 'Spaced practice improves retention.',
    page: 2,
    section: 'Results',
    start: 0,
    end: 'Spaced practice improves retention.'.length,
    relevanceScore: 9
  };

  const result = await answerVoiceTurn({
    session,
    transcript: 'The paper says spaced practice improves retention.',
    idempotencyKey: 'source-concise-1',
    store: {
      retrieveSourceChunks() { return [chunk]; },
      getVoiceTurnReplay() { return null; },
      recordVoiceTurnResult(activeSession, key, value) {
        activeSession.voiceTurns.push(value.turn);
        activeSession.voiceIdempotency.set(key, value);
        return value;
      }
    },
    coach: {
      async composeBlendedAnswer() {
        return {
          answerText: 'The paper reports that spaced practice improves retention.',
          answerSpeechText: 'The paper reports that spaced practice improves retention. What outcome measure supports that finding?',
          sourceClaims: [{ claim: chunk.text, chunkId: chunk.id, citationExcerpt: chunk.text }],
          llmBackground: [],
          discussionPoints: ['Compare this result with the study design.'],
          suggestions: ['Check whether the finding generalizes to another population.'],
          externalClaims: [],
          citations: [{ sourceId: chunk.sourceId, chunkId: chunk.id, excerpt: chunk.text, page: 2, section: 'Results', start: 0, end: chunk.end }],
          externalCitations: [],
          confidence: 'high',
          uncertainty: [],
          conflicts: [],
          academicAssessment: { label: 'direct', rationale: 'The answer identifies the main finding.' },
          followUp: 'What outcome measure supports that finding?'
        };
      }
    }
  });

  assert.equal(result.turn.intent, 'source_answer');
  assert.equal(result.answerSpeechText, 'The paper reports that spaced practice improves retention. What outcome measure supports that finding?');
  assert.equal((result.answerSpeechText.match(/\?/g) || []).length, 1);
  assert.doesNotMatch(result.answerSpeechText, /Discussion point:|Suggestion:|Next question:/);
  assert.equal(result.feedback, undefined);
});

test('source voice answers keep not-in-source status separate from ordinary LLM answers', async () => {
  const session = {
    id: 'session-source-unsupported',
    topic: 'learning science',
    sourceMode: 'source',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    currentQuestion: 'What does the source say about attrition bias?',
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: [{ id: 'source-1', name: 'paper.txt', text: 'Spaced practice improves retention.' }]
  };
  const chunk = {
    id: 'source-1:chunk:1',
    sourceId: 'source-1',
    sourceName: 'paper.txt',
    text: 'Spaced practice improves retention.',
    page: 2,
    section: 'Results',
    start: 0,
    end: 'Spaced practice improves retention.'.length,
    relevanceScore: 4
  };

  const result = await answerVoiceTurn({
    session,
    transcript: 'What does the source say about attrition bias?',
    idempotencyKey: 'source-unsupported-1',
    externalResearch: { approved: false },
    store: {
      retrieveSourceChunks() { return [chunk]; },
      getVoiceTurnReplay() { return null; },
      recordVoiceTurnResult(activeSession, key, value) {
        activeSession.voiceTurns.push(value.turn);
        activeSession.voiceIdempotency.set(key, value);
        return value;
      }
    },
    coach: {
      async composeBlendedAnswer() {
        return {
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
          academicAssessment: { label: 'partial', rationale: 'The question is source-related, but the answer is unsupported.' },
          followUp: 'Would you like to ask about something the sources mention more directly?'
        };
      }
    }
  });

  assert.equal(result.turn.intent, 'source_question');
  assert.deepEqual(result.knowledgeLayers, ['llm']);
  assert.equal(result.sourceSupportStatus, 'not_in_sources');
  assert.equal(result.externalKnowledgeStatus, 'not_requested');
  assert.ok(result.unsupportedOrUnresolved.some(item => /could not find enough support/i.test(item)));
});

test('move on requests in source mode ask a new question without consuming an answer round', async () => {
  const session = {
    id: 'session-source-move-on',
    topic: 'research methods',
    sourceMode: 'source',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    currentQuestion: 'What is the main research question?',
    questionLimit: 200,
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: [{ id: 'source-1', name: 'paper.txt', text: 'The study tracks exposure and later outcomes.' }]
  };
  const store = {
    getVoiceTurnReplay() { return null; },
    recordVoiceTurnResult(activeSession, key, result) {
      activeSession.voiceTurns.push(result.turn);
      if (key) activeSession.voiceIdempotency.set(key, result);
      return result;
    }
  };

  const result = await answerVoiceTurn({
    session,
    transcript: 'Move on.',
    idempotencyKey: 'source-move-on-1',
    store,
    coach: {
      async nextQuestion() {
        return 'What measure did the researchers use for the outcome?';
      }
    },
    skillRegistry: { get(id) { return { id, instructions: `Use ${id} guidance.` }; } }
  });

  assert.equal(result.turn.intent, 'new_question');
  assert.equal(result.countsAsAnswer, false);
  assert.equal(result.followUp, 'What measure did the researchers use for the outcome?');
  assert.equal(session.currentQuestion, result.followUp);
  assert.equal(countCompletedTurns(session), 0);
});

test('answerVoiceTurn rejects an empty transcript before persistence', async () => {
  await assert.rejects(() => answerVoiceTurn({
    session: {
      id: 'session-voice-2',
      topic: 'Empty transcript',
      currentQuestion: '',
      turns: [],
      voiceTurns: [],
      voiceIdempotency: new Map(),
      sources: []
    },
    transcript: '   ',
    transcriptConfidence: 0.4,
    transcriptReviewed: false,
    idempotencyKey: 'voice-empty-1',
    externalResearch: { approved: false },
    store: {
      getVoiceTurnReplay() { return null; },
      recordVoiceTurnResult() { throw new Error('should not persist'); }
    },
    coach: {}
  }), /transcript is required/i);
});

test('answerVoiceTurn rejects a fabricated source excerpt before persistence when retrieved chunk evidence is available', async () => {
  const session = {
    id: 'session-voice-3',
    topic: 'Grounding check',
    sourceMode: 'source',
    currentQuestion: '',
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: [{
      id: 'source-1',
      name: 'paper.txt',
      chunks: [{
        id: 'source-1:chunk:1',
        sourceId: 'source-1',
        sourceName: 'paper.txt',
        ordinal: 1,
        text: 'Spaced practice improves long-term retention for learners.',
        page: 2,
        section: 'Results',
        start: 15,
        end: 70,
        relevanceScore: 9
      }]
    }],
    sourceDigest: null
  };
  let persisted = false;
  const store = {
    retrieveSourceChunks() {
      return session.sources[0].chunks;
    },
    getVoiceTurnReplay() {
      return null;
    },
    recordVoiceTurnResult() {
      persisted = true;
      throw new Error('should not persist malformed grounded answer');
    }
  };
  const coach = {
    async composeBlendedAnswer() {
      return {
        answerText: 'The paper says retrieval beats massing.',
        answerSpeechText: 'The paper says retrieval beats massing.',
        sourceClaims: [{
          claim: 'The paper says retrieval beats massing.',
          chunkId: 'source-1:chunk:1',
          citationExcerpt: 'retrieval beats massing'
        }],
        llmBackground: [],
        externalClaims: [],
        citations: [{
          sourceId: 'source-1',
          chunkId: 'source-1:chunk:1',
          excerpt: 'retrieval beats massing'
        }],
        externalCitations: [],
        confidence: 'high',
        uncertainty: [],
        conflicts: [],
        followUp: 'Want the exact line?'
      };
    }
  };

  await assert.rejects(() => answerVoiceTurn({
    session,
    transcript: 'What does the paper say?',
    transcriptConfidence: 0.92,
    transcriptReviewed: true,
    idempotencyKey: 'grounding-failure-1',
    externalResearch: { approved: false },
    store,
    coach
  }), /exact excerpt|exact supporting substring|ground/i);

  assert.equal(persisted, false);
  assert.equal(session.voiceTurns.length, 0);
});

test('punctuation-free spoken questions use the general-answer path instead of coaching', async () => {
  const session = {
    id: 'session-spoken-question',
    topic: 'memory science',
    sourceMode: 'none',
    currentQuestion: 'What helps people remember information?',
    questionLimit: 5,
    topicDigest: {
      mode: 'model',
      topic: 'memory science',
      definition: 'How memory forms and changes.',
      scope: 'Stay with memory mechanisms and evidence.',
      keyConcepts: ['memory', 'consolidation'],
      boundaries: ['Do not switch to unrelated topics.'],
      anchorQuestion: 'What is the key mechanism?'
    },
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: []
  };
  let coachingCalls = 0;
  let generalAnswerCalls = 0;

  const result = await answerVoiceTurn({
    session,
    transcript: 'Could you explain memory consolidation clearly',
    coach: {
      async evaluateAnswer() {
        coachingCalls += 1;
        throw new Error('A spoken question must not be evaluated as an answer.');
      },
      async generalAnswer(_question, { context } = {}) {
        generalAnswerCalls += 1;
        assert.equal(context.topic, 'memory science');
        assert.equal(context.topicDigest.scope, 'Stay with memory mechanisms and evidence.');
        return {
          answer: 'Memory consolidation is the process of stabilizing a new memory over time.',
          additionalContext: [],
          unsupportedOrUnresolved: [],
          confidence: 'medium'
        };
      }
    }
  });

  assert.equal(result.turn.intent, 'general_question');
  assert.equal(generalAnswerCalls, 1);
  assert.equal(coachingCalls, 0);
});

test('voice coaching records the active question and feedback without an idempotency key', async () => {
  const session = {
    id: 'session-voice-record',
    topic: 'research methods',
    sourceMode: 'none',
    currentQuestion: 'How would you define a cohort study?',
    questionLimit: 5,
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: []
  };
  const feedback = {
    strengths: ['You identified the time dimension.', 'You described comparison groups.'],
    improvement: 'Name the outcome that is measured later.',
    exampleAnswer: 'A cohort study follows exposure-defined groups to compare later outcomes.',
    scores: { clarity: 4, relevance: 5, structure: 4, completeness: 3, specificity: 4 },
    evidence: ['follows groups over time'],
    academicAssessment: { label: 'direct', rationale: 'The response answers the active question.' },
    academicResponse: 'Cohort studies observe groups over time to compare outcomes.',
    nextQuestion: 'Which outcome would the study measure?'
  };

  const result = await answerVoiceTurn({
    session,
    transcript: 'A cohort study follows groups over time and compares later outcomes.',
    coach: { async evaluateAnswer() { return feedback; } }
  });

  assert.equal(result.turn.question, 'How would you define a cohort study?');
  assert.deepEqual(result.turn.feedback, feedback);
  assert.deepEqual(session.voiceTurns[0].feedback, feedback);
});

test('conversation history preserves chronological order across typed and voice turns', () => {
  const history = buildConversationHistory({
    sourceMode: 'source',
    turns: [{
      mode: 'source',
      question: 'What limitation matters most?',
      answer: 'The sample is narrow.',
      createdAt: '2026-07-19T12:02:00.000Z'
    }],
    voiceTurns: [{
      mode: 'source',
      intent: 'source_answer',
      question: 'What did the researchers measure?',
      transcript: 'They measured retention after one week.',
      answerText: 'That is the reported outcome.',
      status: 'answered',
      sequence: 0,
      createdAt: '2026-07-19T12:01:00.000Z'
    }]
  });

  assert.deepEqual(history.map(turn => turn.question || turn.transcript), [
    'What did the researchers measure?',
    'What limitation matters most?'
  ]);
});
