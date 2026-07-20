import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoach, digestSource, sourceAnswer } from '../src/fakeCoach.mjs';

test('fake coach returns two strengths, one improvement, and a follow-up', () => {
  const coach = createCoach();
  const result = coach.evaluateAnswer({
    topic: 'Explain photosynthesis',
    question: 'What is the main idea?',
    answer: 'Photosynthesis converts light energy into chemical energy in plants.',
    turnIndex: 0
  });

  assert.equal(result.strengths.length, 2);
  assert.equal(typeof result.improvement, 'string');
  assert.equal(typeof result.exampleAnswer, 'string');
  assert.equal(typeof result.nextQuestion, 'string');
  assert.ok(['direct', 'partial', 'off_topic'].includes(result.academicAssessment.label));
  assert.equal(typeof result.academicAssessment.rationale, 'string');
  assert.match(result.academicResponse, /photosynthesis|academic|energy|plant/i);
  assert.match(result.nextQuestion, /light energy|chemical energy|photosynthesis/i);
  assert.equal(result.scores.relevance >= 1, true);
  assert.equal(result.scores.relevance <= 5, true);
});

test('fake coach gives useful recovery feedback for a short answer', () => {
  const coach = createCoach();
  const result = coach.evaluateAnswer({
    topic: 'Practice introductions',
    question: 'Tell me about yourself.',
    answer: 'I am a student.',
    turnIndex: 0
  });

  assert.match(result.improvement, /detail|example|develop/i);
  assert.match(result.nextQuestion, /example|detail|experience/i);
});

test('fake coach moves to a new related issue after an adequate direct answer', () => {
  const coach = createCoach();
  const result = coach.evaluateAnswer({
    topic: 'epidemiologic study design',
    question: 'What is a cohort study?',
    answer: 'A cohort study groups participants by exposure, follows them over time, measures incident outcomes, and compares outcome risks while considering confounding and loss to follow-up.',
    turnIndex: 0
  });

  assert.equal(result.academicAssessment.label, 'direct');
  assert.match(result.nextQuestion, /another|different|aspect|next|consider/i);
  assert.doesNotMatch(result.nextQuestion, /what evidence or example would strengthen/i);
});

test('fake coach distinguishes an off-topic answer and asks about the answer detail', () => {
  const coach = createCoach();
  const result = coach.evaluateAnswer({
    topic: 'epidemiologic study design',
    question: 'What is a cohort study?',
    answer: 'My favorite example is a good breakfast routine.',
    turnIndex: 0
  });

  assert.equal(result.academicAssessment.label, 'off_topic');
  assert.match(result.academicAssessment.rationale, /does not address|topic|question/i);
  assert.match(result.nextQuestion, /breakfast|example|cohort|question/i);
});

test('fake coach asks a comparative question when multiple sources are attached', () => {
  const coach = createCoach();
  const question = coach.sourceQuestion({
    topic: 'Compare the materials',
    sources: [
      { id: 'one', name: 'one.txt', text: 'The first source explains spaced practice.' },
      { id: 'two', name: 'two.txt', text: 'The second source explains retrieval practice.' }
    ]
  });
  assert.match(question, /compare|agree|differ/i);
});

test('fake coach applies the epidemiology skill to source questions', () => {
  const coach = createCoach();
  const question = coach.sourceQuestion({
    topic: 'Critique the paper',
    sources: [{ id: 'one', name: 'paper.txt', text: 'A cohort study reports an association.' }],
    skillProfile: { id: 'epi-research' }
  });
  assert.match(question, /target population|estimand|assumption/i);
});

test('fake coach progresses through academic framing, evidence, interpretation, and related extensions', () => {
  const coach = createCoach();
  const histories = [
    [{ question: 'Q1', answer: 'A1' }],
    [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }],
    [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }, { question: 'Q3', answer: 'A3' }],
    [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }, { question: 'Q3', answer: 'A3' }, { question: 'Q4', answer: 'A4' }],
    [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }, { question: 'Q3', answer: 'A3' }, { question: 'Q4', answer: 'A4' }, { question: 'Q5', answer: 'A5' }],
    [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }, { question: 'Q3', answer: 'A3' }, { question: 'Q4', answer: 'A4' }, { question: 'Q5', answer: 'A5' }, { question: 'Q6', answer: 'A6' }]
  ];

  const practiceQuestions = histories.map(conversationHistory => coach.nextQuestion({
    topic: 'learning science',
    conversationHistory,
    conversationTurnCount: conversationHistory.length,
    ...(conversationHistory.length >= 3 ? {
      topicDigest: {
        topic: 'learning science',
        definition: 'How people learn.',
        scope: 'Stay with learning mechanisms and examples.',
        gist: 'Within learning science, focus on mechanisms and examples.',
        keyConcepts: ['learning'],
        boundaries: ['Do not drift.'],
        anchorQuestion: 'What mechanism matters?'
      }
    } : {}),
    ...(conversationHistory.length === 3 ? { topicDigestReady: true } : {})
  }));
  const sourceQuestions = histories.map(conversationHistory => coach.sourceQuestion({
    topic: 'learning science',
    sources: [{ id: 'paper-1', name: 'paper.txt', text: 'The study reports a longitudinal cohort design with test-score outcomes.' }],
    conversationHistory
  }));

  assert.match(practiceQuestions[0], /inside|scope|leave out/i);
  assert.match(practiceQuestions[1], /specific|mechanism|example/i);
  assert.match(practiceQuestions[2], /focus|fit|explore/i);
  assert.match(practiceQuestions[3], /concept|variable|measure/i);
  assert.match(practiceQuestions[4], /result|evidence/i);
  assert.match(practiceQuestions[5], /interpret/i);
  assert.match(coach.nextQuestion({ topic: 'learning science', conversationHistory: [...histories[5], { question: 'Q7', answer: 'A7' }] }), /limitation|implication/i);

  assert.match(coach.sourceQuestion({
    topic: 'learning science',
    sources: [{ id: 'paper-1', name: 'paper.txt', text: 'The study reports a longitudinal cohort design with test-score outcomes.' }],
    conversationHistory: []
  }), /mainly about|central aim/i);
  assert.match(sourceQuestions[0], /scope|inside|outside/i);
  assert.match(sourceQuestions[1], /claim|hypothesis|question/i);
  assert.match(sourceQuestions[2], /setting|population|time/i);
  assert.match(sourceQuestions[3], /design|comparison|measure/i);
  assert.match(sourceQuestions[4], /evidence|result/i);
  assert.match(sourceQuestions[5], /interpret/i);
  assert.match(coach.sourceQuestion({
    topic: 'learning science',
    sources: [{ id: 'paper-1', name: 'paper.txt', text: 'The study reports a longitudinal cohort design with test-score outcomes.' }],
    conversationHistory: [...histories[5], { question: 'Q7', answer: 'A7' }]
  }), /limitation|implication/i);
});

test('fake coach adapts improvement wording to the selected feedback style', () => {
  const coach = createCoach();
  const direct = coach.evaluateAnswer({ topic: 'research', question: 'Why?', answer: 'It matters because it helps.', turnIndex: 0, feedbackStyle: 'direct' });
  const socratic = coach.evaluateAnswer({ topic: 'research', question: 'Why?', answer: 'It matters because it helps.', turnIndex: 0, feedbackStyle: 'socratic' });
  assert.match(direct.improvement, /Most important change:/);
  assert.match(socratic.improvement, /\?$/);
});

test('source answer flags equally relevant passages from different sources', () => {
  const result = sourceAnswer([
    { id: 'one', name: 'one.txt', text: 'Practice improves retention.' },
    { id: 'two', name: 'two.txt', text: 'Practice does not improve retention.' }
  ], 'retention');
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].sourceIds.sort(), ['one', 'two']);
});

test('source answer includes a verifiable text locator and relevance score', () => {
  const text = 'Intro. Practice improves retention. End.';
  const result = sourceAnswer([{ id: 'one', name: 'one.txt', text }], 'What improves retention?');
  const claim = result.sourceGroundedClaims[0];
  const start = text.indexOf('Practice improves retention.');
  assert.deepEqual(claim.locator, { type: 'character', start, end: start + 'Practice improves retention.'.length });
  assert.equal(claim.relevanceScore, 2);
});

test('extractive digest key points include verifiable text locators', () => {
  const text = 'Practice improves retention. The result is useful.';
  const digest = digestSource({ name: 'notes.txt', text });
  assert.deepEqual(digest.keyPoints[0].locator, { type: 'character', start: 0, end: 'Practice improves retention.'.length });
});
