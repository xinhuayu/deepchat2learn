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

test('createVoiceTurn stores a cleaned transcript for model processing', () => {
  const turn = createVoiceTurn({
    sessionId: 'session-clean',
    inputMode: 'voice',
    transcript: 'Um, what is what is the distribution uh of the outcome?',
    transcriptReviewed: false
  });

  assert.equal(turn.transcript, 'what is the distribution of the outcome?');
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

test('voice coaching speaks the academic response before a response-linked follow-up', async () => {
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
  assert.match(result.answerSpeechText, /Academically, a cohort study/i);
  assert.match(result.answerSpeechText, /What outcome would you measure/i);
  assert.equal(result.feedback.academicAssessment.label, 'direct');
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
  let receivedAgenda = null;
  const baseCoach = {
    async evaluateAnswer(input) {
      receivedSkillProfile = input.skillProfile;
      receivedAgenda = input.agenda;
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
  assert.equal(receivedAgenda.currentStage, 'orientation');
  assert.equal(receivedAgenda.nextStage, 'design');
});

test('conversation context keeps source and practice histories separate and bounded', () => {
  const sourceSession = {
    sourceMode: 'source',
    turns: [
      { mode: 'practice', question: 'Practice question', answer: 'Practice answer' },
      { mode: 'source', question: 'Source question one', answer: 'Source answer one' },
      { mode: 'source', question: 'Source question two', answer: 'Source answer two' }
    ],
    voiceTurns: [
      { intent: 'source_question', transcript: 'Source voice question', answerText: 'Source voice answer' },
      { intent: 'coaching', transcript: 'Practice voice answer', answerText: 'Practice response' },
      { mode: 'source', intent: 'source_answer', status: 'interrupted', transcript: 'Interrupted source question', answerText: 'Interrupted source answer' }
    ]
  };
  const sourceHistory = buildConversationHistory(sourceSession);
  assert.equal(sourceHistory.length, 3);
  assert.ok(sourceHistory.every(item => item.mode === 'source'));
  assert.doesNotMatch(JSON.stringify(sourceHistory), /Interrupted source/);

  const practiceSession = { ...sourceSession, sourceMode: 'none' };
  const practiceHistory = buildConversationHistory(practiceSession);
  assert.equal(practiceHistory.length, 3);
  assert.ok(practiceHistory.every(item => item.mode === 'practice'));
});

test('source retrieval query uses only immediate prior exchanges for a short follow-up', async () => {
  const session = {
    id: 'source-history-3', sourceMode: 'source', currentQuestion: 'What does this result mean?',
    turns: [],
    voiceTurns: [
      { id: 'oldest', mode: 'source', intent: 'source_answer', transcript: 'oldest answer', answerText: 'oldest explanation' },
      { id: 'q1', mode: 'source', intent: 'source_answer', transcript: 'first prior answer', answerText: 'first explanation' },
      { id: 'q2', mode: 'source', intent: 'source_answer', transcript: 'second prior answer', answerText: 'second explanation' },
      { id: 'q3', mode: 'source', intent: 'source_answer', transcript: 'third prior answer', answerText: 'third explanation' }
    ],
    sources: [{ id: 'paper', name: 'paper.txt', chunks: [{ id: 'paper:1', sourceId: 'paper', sourceName: 'paper.txt', text: 'The study reports an association.', start: 0, end: 37 }] }],
    sourceDigest: null
  };
  let query;
  const store = {
    retrieveSourceChunks(_sessionId, value) { query = value; return session.sources[0].chunks; },
    recordVoiceTurnResult(_session, _key, result) { return result; }
  };
  const coach = {
    async composeBlendedAnswer() {
      return {
        answerText: 'The source reports an association.', answerSpeechText: 'The source reports an association.',
        sourceClaims: [], llmBackground: [], discussionPoints: [], suggestions: [], externalClaims: [], citations: [], externalCitations: [],
        confidence: 'medium', uncertainty: [], conflicts: [], followUp: 'What limitation should we examine next?'
      };
    }
  };
  await answerVoiceTurn({
    session, transcript: 'Why?', idempotencyKey: 'history-3', store, coach,
    externalResearch: { approved: false },
    skillRegistry: { get(id) { return { id, instructions: 'Use academic conversation guidance.' }; } }
  });

  assert.match(query, /What does this result mean\?/);
  assert.match(query, /Why\?/);
  assert.doesNotMatch(query, /oldest answer|oldest explanation/);
  assert.match(query, /second prior answer|second explanation/);
  assert.match(query, /third prior answer|third explanation/);
});

test('source retrieval query keeps a substantive turn focused on the current question and answer', async () => {
  const session = {
    id: 'source-focused-query', sourceMode: 'source', currentQuestion: 'What limitation did the authors identify?',
    turns: [],
    voiceTurns: [
      { id: 'prior-1', mode: 'source', intent: 'source_answer', transcript: 'The design was longitudinal.', answerText: 'It followed participants over time.' },
      { id: 'prior-2', mode: 'source', intent: 'source_answer', transcript: 'The sample included older adults.', answerText: 'The participants were drawn from a national cohort.' }
    ],
    sources: [{ id: 'paper', name: 'paper.txt', chunks: [{ id: 'paper:1', sourceId: 'paper', sourceName: 'paper.txt', text: 'The study reports an association.', start: 0, end: 37 }] }],
    sourceDigest: null
  };
  let query;
  const store = {
    retrieveSourceChunks(_sessionId, value) { query = value; return session.sources[0].chunks; },
    recordVoiceTurnResult(_session, _key, result) { return result; }
  };
  const coach = {
    async composeBlendedAnswer() {
      return {
        answerText: 'The main limitation concerns the observational design.', answerSpeechText: 'The main limitation concerns the observational design.',
        sourceClaims: [], llmBackground: [], discussionPoints: [], suggestions: [], externalClaims: [], citations: [], externalCitations: [],
        confidence: 'medium', uncertainty: [], conflicts: [], followUp: 'What assumption matters most?'
      };
    }
  };
  await answerVoiceTurn({
    session, transcript: 'The authors note that residual confounding may remain because the study is observational.',
    idempotencyKey: 'focused-query-1', store, coach,
    externalResearch: { approved: false },
    skillRegistry: { get(id) { return { id, instructions: 'Use academic conversation guidance.' }; } }
  });

  assert.match(query, /limitation|residual confounding|observational/i);
  assert.doesNotMatch(query, /longitudinal|national cohort|older adults/i);
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

test('close phrases request completion without consuming an answer round', async () => {
  const session = {
    id: 'session-close-request',
    topic: 'research methods',
    sourceMode: 'source',
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
    transcript: "I'm done with this conversation.",
    idempotencyKey: 'close-request-1',
    store,
    coach: {
      async composeBlendedAnswer() { throw new Error('close requests must not analyze source content'); },
      async generalAnswer() { throw new Error('close requests must not call the general answer model'); }
    }
  });

  assert.equal(result.closeRequested, true);
  assert.equal(result.countsAsAnswer, false);
  assert.equal(result.nextState, 'completed');
  assert.equal(result.turn.intent, 'close');
  assert.equal(countCompletedTurns(session), 0);
});

test('move-on language selects a new question without consuming an answer round', async () => {
  const session = {
    id: 'session-move-on-language',
    topic: 'research methods',
    sourceMode: 'source',
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
    transcript: "Let's check another point.",
    idempotencyKey: 'move-on-language-1',
    store,
    coach: {
      async nextQuestion() { return 'What outcome measure did the researchers use?'; }
    },
    skillRegistry: { get(id) { return { id, instructions: `Use ${id} guidance.` }; } }
  });

  assert.equal(result.turn.intent, 'new_question');
  assert.equal(result.countsAsAnswer, false);
  assert.equal(result.followUp, 'What outcome measure did the researchers use?');
  assert.equal(countCompletedTurns(session), 0);
});

test('practice explanatory questions receive direct general answers', async () => {
  const session = {
    id: 'session-explanatory-question',
    topic: 'epidemiologic study design',
    sourceMode: 'none',
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
  let called = false;
  const result = await answerVoiceTurn({
    session,
    transcript: 'Can you provide an example of a cohort study?',
    idempotencyKey: 'explanatory-question-1',
    store,
    coach: {
      async generalAnswer(question) {
        called = true;
        assert.match(question, /provide an example/i);
        return { answer: 'For example, follow smokers and nonsmokers to compare later lung disease.' };
      }
    }
  });

  assert.equal(called, true);
  assert.equal(result.turn.intent, 'general_question');
  assert.match(result.answerText, /follow smokers/i);
  assert.equal(result.countsAsAnswer, true);
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
  assert.deepEqual(first.llmBackground, ['This supports the paper’s learning recommendation.']);
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
          answerSpeechText: 'The paper uses a longitudinal cohort design.',
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
  assert.equal(result.strengths, undefined);
  assert.equal(result.improvement, undefined);
  assert.equal(result.exampleAnswer, undefined);
  assert.equal(result.scores, undefined);
  assert.equal(received.currentQuestion, session.currentQuestion);
  assert.equal(received.turnRole, 'answer_to_ai');
});

test('source conversation uses extracted chunks while the cross-source digest is still processing', async () => {
  const chunk = {
    id: 'source-ready:chunk:1',
    sourceId: 'source-ready',
    sourceName: 'paper.txt',
    text: 'The cohort study followed adults for eight years and measured cognition annually.',
    page: 2,
    section: 'Methods',
    start: 0,
    end: 78
  };
  const session = {
    id: 'session-source-pending-digest',
    topic: 'Cohort study methods',
    sourceMode: 'source',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    currentQuestion: 'What design did the paper use?',
    digestStatus: 'processing',
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sources: [{
      id: 'source-ready',
      name: 'paper.txt',
      status: 'digesting',
      chunks: [chunk],
      digest: { digestText: 'A longitudinal cohort study.' }
    }]
  };
  const store = {
    async retrieveSourceChunks() { return [chunk]; },
    getVoiceTurnReplay() { return null; },
    recordVoiceTurnResult(activeSession, key, result) {
      activeSession.voiceTurns.push(result.turn);
      if (key) activeSession.voiceIdempotency.set(key, result);
      return result;
    }
  };
  let composed = false;
  const result = await answerVoiceTurn({
    session,
    transcript: 'What design did the paper use?',
    transcriptConfidence: 0.95,
    transcriptReviewed: true,
    idempotencyKey: 'pending-digest-turn',
    store,
    coach: {
      async composeBlendedAnswer() {
        composed = true;
        return {
          answerText: 'It used a longitudinal cohort design.',
          answerSpeechText: 'It used a longitudinal cohort design.',
          sourceClaims: [{
            claim: 'The cohort study followed adults for eight years and measured cognition annually.',
            chunkId: chunk.id,
            citationExcerpt: chunk.text
          }],
          llmBackground: [],
          discussionPoints: [],
          suggestions: [],
          externalClaims: [],
          citations: [{ sourceId: chunk.sourceId, chunkId: chunk.id, excerpt: chunk.text, page: 2, section: 'Methods', start: 0, end: 78 }],
          externalCitations: [],
          confidence: 'high',
          uncertainty: [],
          conflicts: [],
          followUp: 'What feature makes it longitudinal?'
        };
      }
    },
    skillRegistry: { get(id) { return { id, instructions: 'Discuss the paper clearly.' }; } }
  });

  assert.equal(composed, true);
  assert.equal(result.answerText, 'It used a longitudinal cohort design.');
  assert.deepEqual(result.knowledgeLayers, ['source']);
  assert.match(result.sourceDigestStatus, /fuller cross-source overview/i);
});

test('source conversation passes a ready per-source digest when the consolidated digest is absent', async () => {
  const chunk = {
    id: 'source-ready-digest:chunk:1',
    sourceId: 'source-ready-digest',
    sourceName: 'paper.txt',
    text: 'The study evaluates whether cognitive trajectories predict later health outcomes.',
    page: 1,
    section: 'Abstract',
    start: 0,
    end: 78
  };
  const session = {
    id: 'session-source-per-source-digest',
    topic: 'Cognitive trajectories',
    sourceMode: 'source',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    currentQuestion: 'What is the paper about?',
    digestStatus: 'queued',
    turns: [],
    voiceTurns: [],
    voiceIdempotency: new Map(),
    sourceDigest: null,
    sources: [{
      id: 'source-ready-digest',
      name: 'paper.txt',
      status: 'digesting',
      chunks: [chunk],
      digest: {
        digestText: 'The paper evaluates whether cognitive trajectories predict later health outcomes.',
        keyPoints: [{ text: 'The study evaluates a longitudinal association.', evidence: 'The study evaluates whether cognitive trajectories predict later health outcomes.' }],
        openQuestions: ['Does change add value beyond baseline cognition?']
      }
    }]
  };
  const store = {
    async retrieveSourceChunks() { return [chunk]; },
    getVoiceTurnReplay() { return null; },
    recordVoiceTurnResult(activeSession, key, value) {
      activeSession.voiceTurns.push(value.turn);
      if (key) activeSession.voiceIdempotency.set(key, value);
      return value;
    }
  };
  let receivedDigest = null;
  const result = await answerVoiceTurn({
    session,
    transcript: 'What is the paper mainly trying to learn?',
    transcriptConfidence: 0.95,
    transcriptReviewed: true,
    idempotencyKey: 'per-source-digest-turn',
    store,
    coach: {
      async composeBlendedAnswer(input) {
        receivedDigest = input.sourceDigest;
        return {
          answerText: 'The paper evaluates whether cognitive trajectories predict later health outcomes.',
          answerSpeechText: 'The paper evaluates whether cognitive trajectories predict later health outcomes.',
          sourceClaims: [{ claim: chunk.text, chunkId: chunk.id, citationExcerpt: chunk.text }],
          llmBackground: [], discussionPoints: [], suggestions: [], externalClaims: [],
          citations: [{ sourceId: chunk.sourceId, chunkId: chunk.id, excerpt: chunk.text, start: 0, end: chunk.text.length }],
          externalCitations: [], confidence: 'high', uncertainty: [], conflicts: [],
          followUp: 'What population did the authors study?'
        };
      }
    },
    skillRegistry: { get(id) { return { id, instructions: `Use ${id} guidance.` }; } }
  });

  assert.equal(result.turn.status, 'answered');
  assert.equal(receivedDigest.mainArgument, 'The paper evaluates whether cognitive trajectories predict later health outcomes.');
  assert.equal(receivedDigest.keyPoints[0].text, 'The study evaluates a longitudinal association.');
  assert.deepEqual(receivedDigest.openQuestions, ['Does change add value beyond baseline cognition?']);
});

test('source retrieval includes the latest source answer so short follow-ups stay grounded', async () => {
  const chunk = {
    id: 'source-follow-up:chunk:1',
    sourceId: 'source-follow-up',
    sourceName: 'paper.txt',
    text: 'A cohort design follows exposure-defined groups over time.',
    page: 2,
    section: 'Methods',
    start: 0,
    end: 58
  };
  const session = {
    id: 'session-source-follow-up',
    topic: 'Study design',
    sourceMode: 'source',
    activeSkillId: 'epi-research',
    conversationSkillId: 'academic-conversation',
    currentQuestion: 'What should we examine next?',
    turns: [],
    voiceTurns: [{ mode: 'source', intent: 'source_answer', transcript: 'It uses a cohort design.', answerText: 'The paper follows exposure-defined groups over time.' }],
    voiceIdempotency: new Map(),
    sources: [{ id: 'source-follow-up', name: 'paper.txt', chunks: [chunk] }],
    sourceDigest: { mainArgument: 'The paper uses a cohort design.', keyPoints: [], evidence: [], conflicts: [], openQuestions: [] }
  };
  let retrievalQuery = '';
  const result = await answerVoiceTurn({
    session,
    transcript: 'Why?',
    transcriptReviewed: true,
    idempotencyKey: 'source-follow-up-turn',
    store: {
      async retrieveSourceChunks(_sessionId, query) { retrievalQuery = query; return [chunk]; },
      getVoiceTurnReplay() { return null; },
      recordVoiceTurnResult(activeSession, key, value) {
        activeSession.voiceTurns.push(value.turn);
        if (key) activeSession.voiceIdempotency.set(key, value);
        return value;
      }
    },
    coach: {
      async composeBlendedAnswer() {
        return {
          answerText: 'The design matters because it preserves the time order between exposure and outcome.',
          answerSpeechText: 'The design matters because it preserves the time order between exposure and outcome.',
          sourceClaims: [{ claim: chunk.text, chunkId: chunk.id, citationExcerpt: chunk.text }],
          llmBackground: [], discussionPoints: [], suggestions: [], externalClaims: [],
          citations: [{ sourceId: chunk.sourceId, chunkId: chunk.id, excerpt: chunk.text, start: 0, end: chunk.text.length }],
          externalCitations: [], confidence: 'high', uncertainty: [], conflicts: [],
          followUp: 'What limitation remains?'
        };
      }
    },
    skillRegistry: { get(id) { return { id, instructions: `Use ${id} guidance.` }; } }
  });

  assert.equal(result.turn.status, 'answered');
  assert.match(retrievalQuery, /cohort design/i);
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
  assert.match(result.answerSpeechText, /The paper reports that spaced practice improves retention\./);
  assert.match(result.answerSpeechText, /Compare this result with the study design\./);
  assert.equal((result.answerSpeechText.match(/\?/g) || []).length, 1);
  const spokenSentences = result.answerSpeechText.match(/[^.!?]+[.!?]+/g) || [];
  assert.ok(spokenSentences.length >= 4);
  assert.ok(spokenSentences.length <= 6);
  assert.doesNotMatch(result.answerSpeechText, /Discussion point:|Suggestion:|Next question:/);
  assert.equal(result.feedback, undefined);
});

test('source voice answers expand a short model response with useful synthesized context', async () => {
  const chunk = {
    id: 'source-expand:chunk:1',
    sourceId: 'source-expand',
    sourceName: 'paper.txt',
    text: 'The cohort design follows participants over time.',
    page: 2,
    section: 'Methods',
    start: 0,
    end: 'The cohort design follows participants over time.'.length,
    relevanceScore: 9
  };
  const result = await answerVoiceTurn({
    session: {
      id: 'session-source-expand',
      topic: 'epidemiology',
      sourceMode: 'source',
      activeSkillId: 'epi-research',
      conversationSkillId: 'academic-conversation',
      currentQuestion: 'What design did the authors use?',
      turns: [], voiceTurns: [], voiceIdempotency: new Map(),
      sources: [{ id: chunk.sourceId, name: chunk.sourceName, chunks: [chunk] }]
    },
    transcript: 'The authors used a cohort design.',
    idempotencyKey: 'source-expand-1',
    store: {
      retrieveSourceChunks() { return [chunk]; },
      getVoiceTurnReplay() { return null; },
      recordVoiceTurnResult(_session, _key, value) { return value; }
    },
    coach: {
      async composeBlendedAnswer() {
        return {
          answerText: 'The study uses a cohort design. Participants are followed over time. This preserves the temporal order between exposure and outcome.',
          answerSpeechText: 'The study uses a cohort design. It follows participants over time.',
          sourceClaims: [{ claim: chunk.text, chunkId: chunk.id, citationExcerpt: chunk.text }],
          llmBackground: ['This design can clarify temporal ordering, although it does not remove confounding.'],
          discussionPoints: ['That distinction matters when interpreting the results as associations rather than causal effects.'],
          suggestions: [], externalClaims: [],
          citations: [{ sourceId: chunk.sourceId, chunkId: chunk.id, excerpt: chunk.text, start: 0, end: chunk.text.length }],
          externalCitations: [], confidence: 'high', uncertainty: [], conflicts: [],
          followUp: 'What limitation remains?'
        };
      }
    }
  });
  const sentences = result.answerSpeechText.match(/[^.!?]+[.!?]+/g) || [];
  assert.ok(sentences.length >= 4);
  assert.ok(sentences.length <= 6);
  assert.match(result.answerSpeechText, /temporal ordering|confounding|associations/i);
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
