import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { composeBlendedAnswer, createModelCoach, createResilientCoach } from '../src/modelCoach.mjs';
import { createCoach } from '../src/fakeCoach.mjs';

test('model coach source inspection uses the patient shared voice timeout by default', async () => {
  const source = await fs.readFile(new URL('../src/modelCoach.mjs', import.meta.url), 'utf8');
  assert.match(source, /getVoiceConfig\(\)\.textTimeoutMs/);
  assert.match(source, /sourceDigestTimeoutMs/);
});

test('interactive model requests use bounded output budgets', async () => {
  let request = null;
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ question: 'What is the main question?' }) }) };
    }
  });

  await coach.initialQuestion({ topic: 'A research paper' });

  assert.equal(request.max_output_tokens, 160);
});

test('practice coaching uses a smaller output budget for concise spoken feedback', async () => {
  let request = null;
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ output_text: JSON.stringify({
        strengths: ['Clear point.', 'Relevant detail.'],
        improvement: 'Add one example.',
        exampleAnswer: 'A concise example answer.',
        scores: { clarity: 4, relevance: 4, structure: 3, completeness: 3, specificity: 3 },
        evidence: ['Clear point.'],
        academicAssessment: { label: 'direct', rationale: 'The response addresses the question.' },
        academicResponse: 'Your answer is relevant.',
        answerSpeechText: 'Your answer is relevant. Next question: what evidence supports it?',
        nextQuestion: 'What evidence supports it?'
      }) }) };
    }
  });

  await coach.evaluateAnswer({ topic: 'A research paper', question: 'What is the main question?', answer: 'It asks whether the exposure predicts the outcome.' });

  assert.equal(request.text.format.name, 'coaching_feedback');
  assert.equal(request.max_output_tokens, 500);
  assert.match(request.instructions, /two or three short sentences|brief spoken/i);
});

test('source digestion keeps a patient timeout separate from interactive turns', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    timeoutMs: 10,
    sourceDigestTimeoutMs: 100,
    fetchImpl: async (_url, options) => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ digestText: 'A short digest.', keyPoints: [], openQuestions: [] }) }) };
    }
  });

  const result = await coach.digestSource({ id: 'source-1', name: 'paper.txt', text: 'A short source.' });
  assert.equal(result.digestText, 'A short digest.');
});

function fakeFetch(_url, options) {
  const request = JSON.parse(options.body);
  const json = request.text.format.name === 'grounded_answer'
    ? { answer: 'Spaced practice improves memory.', sourceGroundedClaims: [{ claim: 'Spaced practice improves memory.', sourceId: 'source-1', evidence: 'Spaced practice improves memory.' }], additionalContext: [], unsupportedOrUnresolved: [], confidence: 'high' }
    : request.text.format.name === 'coaching_feedback'
    ? { strengths: ['A clear point.', 'A relevant detail.'], improvement: 'Add a conclusion.', exampleAnswer: 'A stronger answer ends with why it matters.', scores: { clarity: 4, relevance: 4, structure: 3, completeness: 3, specificity: 4 }, evidence: ['I explained the main point.'], nextQuestion: 'What would you do next?' }
    : request.text.format.name === 'coaching_question'
      ? { question: 'What is the main idea?' }
      : { answer: 'General context.', sourceGroundedClaims: [], additionalContext: [{ claim: 'General context.' }], unsupportedOrUnresolved: [], confidence: 'medium' };
  return Promise.resolve({ ok: true, json: async () => ({ output_text: JSON.stringify(json) }) });
}

test('model coach converts structured Responses output into the app contract', async () => {
  const coach = createModelCoach({ apiKey: 'test-key', fetchImpl: fakeFetch });
  assert.equal(await coach.initialQuestion({ topic: 'Presentations' }), 'What is the main idea?');
  const feedback = await coach.evaluateAnswer({ topic: 'Presentations', question: 'Why?', answer: 'I explained the main point.' });
  assert.equal(feedback.strengths.length, 2);
  assert.equal(feedback.scores.clarity, 4);
  assert.equal(feedback.academicAssessment.label, 'partial');
  assert.match(feedback.academicResponse, /academic/i);
  const answer = await coach.generalAnswer('What is structure?');
  assert.equal(answer.mode, 'general');
  assert.equal(answer.sourceGroundedClaims.length, 0);
  const grounded = await coach.groundedAnswer({ question: 'What improves memory?', sources: [{ id: 'source-1', name: 'paper.txt', text: 'Spaced practice improves memory.' }] });
  assert.equal(grounded.mode, 'source');
  assert.equal(grounded.sourceGroundedClaims[0].sourceName, 'paper.txt');
  assert.deepEqual(grounded.sourceGroundedClaims[0].locator, { type: 'character', start: 0, end: 'Spaced practice improves memory.'.length });
  assert.equal(grounded.sourceGroundedClaims[0].relevanceScore, null);
});

test('practice feedback exposes a bounded spoken response separate from the detailed scorecard', async () => {
  const coach = createModelCoach({ apiKey: 'test-key', fetchImpl: fakeFetch });
  const feedback = await coach.evaluateAnswer({
    topic: 'Presentations',
    question: 'What is the main point?',
    answer: 'I explained the main point.'
  });

  assert.equal(typeof feedback.answerSpeechText, 'string');
  assert.ok(feedback.answerSpeechText.length <= 600);
  assert.match(feedback.answerSpeechText, /next question|What would you do next/i);
  assert.doesNotMatch(feedback.answerSpeechText, /clarity|relevance|specificity|score/i);
});

test('ordinary source turns use compact academic dialogue guidance and at most two prior turns', async () => {
  let request = null;
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ output_text: JSON.stringify({
        answerText: 'The source describes a longitudinal study.',
        answerSpeechText: 'It describes a longitudinal study. Why might that design matter?',
        sourceClaims: [],
        llmBackground: [],
        discussionPoints: [],
        suggestions: [],
        externalClaims: [],
        citations: [],
        externalCitations: [],
        confidence: 'medium',
        uncertainty: [],
        conflicts: [],
        followUp: 'Why might that design matter?'
      }) }) };
    }
  });

  await coach.composeBlendedAnswer({
    userQuestion: 'What does the design mean?',
    currentQuestion: 'What study design did the researchers use?',
    sourceDigest: { mainArgument: 'A longitudinal study follows participants over time.' },
    retrievedChunks: [{ id: 'chunk-1', sourceId: 'source-1', text: 'A longitudinal study follows participants over time.', start: 0, end: 53 }],
    conversationHistory: Array.from({ length: 6 }, (_, index) => ({ question: `Q${index}`, answer: `A${index}` })),
    generalKnowledgeAllowed: true,
    skillProfile: {
      id: 'epi-research',
      name: 'Epidemiology review',
      instructions: 'FULL REVIEW GUIDANCE '.repeat(500),
      references: { guideline: 'FULL REVIEW REFERENCE '.repeat(500) }
    }
  });

  assert.ok(request);
  const input = JSON.parse(request.input);
  assert.equal(input.conversationHistory.length, 2);
  assert.match(request.instructions, /academic conversation/i);
  assert.doesNotMatch(request.instructions, /FULL REVIEW GUIDANCE|FULL REVIEW REFERENCE/);
});

test('resilient coach falls back to local academic coaching when the text model fails', async () => {
  const primary = {
    async initialQuestion() { throw Object.assign(new Error('upstream unavailable'), { code: 'MODEL_REQUEST_FAILED' }); },
    async evaluateAnswer() { throw Object.assign(new Error('upstream unavailable'), { code: 'MODEL_REQUEST_FAILED' }); }
  };
  const fallbackEvents = [];
  const coach = createResilientCoach(primary, createCoach(), {
    onFallback: event => fallbackEvents.push(event)
  });

  const question = await coach.initialQuestion({ topic: 'a research paper' });
  const feedback = await coach.evaluateAnswer({
    topic: 'a research paper',
    question,
    answer: 'The paper studies an exposure and a later outcome.'
  });

  assert.match(question, /paper about|main research question/i);
  assert.notEqual(feedback.academicAssessment.label, 'off_topic');
  assert.deepEqual(fallbackEvents.map(event => event.method), ['initialQuestion', 'evaluateAnswer']);
  assert.equal(fallbackEvents[0].error.code, 'MODEL_REQUEST_FAILED');
});

test('opening and follow-up prompts require a gradual academic conversation', async () => {
  const requests = [];
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ question: 'What is the main research question?' }) }) };
    }
  });

  await coach.initialQuestion({ topic: 'Cognitive trajectories in older adults' });
  await coach.nextQuestion({
    topic: 'Cognitive trajectories in older adults',
    previousQuestion: 'What is this paper about?',
    conversationHistory: [
      { question: 'What is this paper about?', answer: 'It studies cognitive change and later health.' },
      { question: 'What is the main research question?', answer: 'Whether the trajectory predicts later outcomes.' },
      { question: 'What design did the researchers use?', answer: 'A longitudinal cohort.' },
      { question: 'How was cognition measured?', answer: 'With repeated cognitive assessments.' }
    ]
  });

  assert.match(requests[0].instructions, /opening|orientation|main research question|paper is about/i);
  assert.match(requests[1].instructions, /gradual|progress|evidence|interpretation|complex/i);
  assert.match(requests[1].instructions, /one concise|short|brief/i);
  assert.match(requests[1].instructions, /do not.*abstract|do not.*restat|avoid.*long/i);
});

test('model coach advances through orientation, design, population, measures, findings, interpretation, and limitations stages', async () => {
  const seenStages = [];
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const input = JSON.parse(request.input);
      if (request.text.format.name === 'source_question' || request.text.format.name === 'coaching_question') {
        const stage = input.stage || 'orientation';
        seenStages.push({ name: request.text.format.name, stage, instructions: request.instructions });
        return { ok: true, json: async () => ({ output_text: JSON.stringify({ question: `Stage check: ${stage}` }) }) };
      }
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ question: 'unused' }) }) };
    }
  });

  const histories = [
    [{ question: 'Q1', answer: 'A1' }],
    [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }],
    [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }, { question: 'Q3', answer: 'A3' }],
    [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }, { question: 'Q3', answer: 'A3' }, { question: 'Q4', answer: 'A4' }],
    [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }, { question: 'Q3', answer: 'A3' }, { question: 'Q4', answer: 'A4' }, { question: 'Q5', answer: 'A5' }],
    [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }, { question: 'Q3', answer: 'A3' }, { question: 'Q4', answer: 'A4' }, { question: 'Q5', answer: 'A5' }, { question: 'Q6', answer: 'A6' }]
  ];

  const practiceQuestions = [];
  const sourceQuestions = [];
  for (const conversationHistory of histories) {
    practiceQuestions.push(await coach.nextQuestion({ topic: 'learning science', conversationHistory }));
    sourceQuestions.push(await coach.sourceQuestion({
      topic: 'learning science',
      sources: [{ id: 'paper-1', name: 'paper.txt', text: 'The study follows students over time and measures later recall.' }],
      conversationHistory
    }));
  }
  practiceQuestions.push(await coach.nextQuestion({ topic: 'learning science', conversationHistory: [...histories[5], { question: 'Q7', answer: 'A7' }] }));
  sourceQuestions.push(await coach.sourceQuestion({
    topic: 'learning science',
    sources: [{ id: 'paper-1', name: 'paper.txt', text: 'The study follows students over time and measures later recall.' }],
    conversationHistory: [...histories[5], { question: 'Q7', answer: 'A7' }]
  }));

  assert.deepEqual(practiceQuestions, [
    'Stage check: orientation',
    'Stage check: design',
    'Stage check: population',
    'Stage check: measures',
    'Stage check: findings',
    'Stage check: interpretation',
    'Stage check: limitations, implications, or application'
  ]);
  assert.deepEqual(sourceQuestions, [
    'Stage check: orientation',
    'Stage check: design',
    'Stage check: population',
    'Stage check: measures',
    'Stage check: findings',
    'Stage check: interpretation',
    'Stage check: limitations, implications, or application'
  ]);
  assert.ok(seenStages.some(entry => entry.name === 'coaching_question' && /population/i.test(entry.instructions)));
  assert.ok(seenStages.some(entry => entry.name === 'source_question' && /population/i.test(entry.instructions)));
});

test('model coach rejects citations that are not exact source substrings', async () => {
  const coach = createModelCoach({ apiKey: 'test-key', fetchImpl: async (_url, options) => ({ ok: true, json: async () => ({ output_text: JSON.stringify({ answer: 'Unsupported.', sourceGroundedClaims: [{ claim: 'Unsupported.', sourceId: 'source-1', evidence: 'not in source' }], additionalContext: [], unsupportedOrUnresolved: [], confidence: 'high' }) }) }) });
  const answer = await coach.groundedAnswer({ question: 'What?', sources: [{ id: 'source-1', name: 'paper.txt', text: 'Only this is supported.' }] });
  assert.equal(answer.confidence, 'low');
  assert.equal(answer.sourceGroundedClaims.length, 0);
});

test('model coach keeps general answers separate from supplied-source citations', async () => {
  const coach = createModelCoach({ apiKey: 'test-key', fetchImpl: async (_url, options) => ({
    ok: true,
    json: async () => ({ output_text: JSON.stringify({
      answer: 'General context.',
      sourceGroundedClaims: [{ claim: 'This should not be shown as source evidence.' }],
      additionalContext: [{ claim: 'General context.' }],
      unsupportedOrUnresolved: [],
      confidence: 'high'
    }) })
  }) });
  const answer = await coach.generalAnswer('What is structure?');
  assert.deepEqual(answer.sourceGroundedClaims, []);
  assert.deepEqual(answer.additionalContext, [{ claim: 'General context.', label: 'Additional context' }]);
  assert.equal(answer.confidence, 'high');
});

test('model coach converts an upstream timeout into a typed error', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => {
      await new Promise((resolve, reject) => {
        if (!signal) return reject(new Error('missing abort signal'));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
  });
  await assert.rejects(() => coach.generalAnswer('What is structure?'), error => error.status === 504 && error.code === 'MODEL_TIMEOUT');
});

test('model coach creates a source digest with validated evidence points', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.text.format.name, 'source_digest');
      return { ok: true, json: async () => ({ output_text: JSON.stringify({
        digestText: 'The study found that spaced practice improves retention.',
        keyPoints: [{ text: 'Spaced practice improves retention.', evidence: 'Spaced practice improves retention.' }],
        openQuestions: ['How large was the effect?']
      }) }) };
    }
  });
  const digest = await coach.digestSource({ id: 'source-1', name: 'paper.txt', text: 'Spaced practice improves retention.' });
  assert.equal(digest.mode, 'model');
  assert.equal(digest.digestText, 'The study found that spaced practice improves retention.');
  assert.equal(digest.keyPoints[0].sourceName, 'paper.txt');
  assert.equal(digest.keyPoints[0].evidence, 'Spaced practice improves retention.');
  assert.deepEqual(digest.keyPoints[0].locator, { type: 'character', start: 0, end: 'Spaced practice improves retention.'.length });
  assert.deepEqual(digest.openQuestions, ['How large was the effect?']);
});

test('model coach builds a consolidated digest from source chunks with exact chunk evidence', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.text.format.name, 'consolidated_source_digest');
      const input = JSON.parse(request.input);
      assert.equal(input.chunks.length, 2);
      return { ok: true, json: async () => ({ output_text: JSON.stringify({
        mainArgument: 'The study reports an association.',
        keyPoints: [{ text: 'The study reports an association.', chunkIds: ['paper-1:chunk:1'] }],
        importantTerms: ['association'],
        evidence: [{ claim: 'The study reports an association.', chunkIds: ['paper-1:chunk:1'] }],
        conflicts: [],
        openQuestions: ['What assumptions matter?']
      }) }) };
    }
  });
  const result = await coach.buildConsolidatedDigest({
    sources: [{ id: 'paper-1', name: 'paper.pdf', text: 'The study reports an association. The design is observational.' }],
    chunks: [
      { id: 'paper-1:chunk:1', sourceId: 'paper-1', text: 'The study reports an association.' },
      { id: 'paper-1:chunk:2', sourceId: 'paper-1', text: 'The design is observational.' }
    ]
  });
  assert.equal(result.mainArgument, 'The study reports an association.');
  assert.deepEqual(result.keyPoints[0].chunkIds, ['paper-1:chunk:1']);
});

test('model coach digests later source chunks through staged coverage', async () => {
  const calls = [];
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const input = JSON.parse(request.input);
      calls.push({ name: request.text.format.name, ids: input.chunks.map(chunk => chunk.id) });
      const evidenceId = input.chunks[input.chunks.length - 1].id;
      const evidenceText = input.chunks[input.chunks.length - 1].text;
      return { ok: true, json: async () => ({ output_text: JSON.stringify({
        mainArgument: evidenceText,
        keyPoints: [{ text: evidenceText, chunkIds: [evidenceId] }],
        importantTerms: [],
        evidence: [{ claim: evidenceText, chunkIds: [evidenceId] }],
        conflicts: [],
        openQuestions: []
      }) }) };
    }
  });
  const chunks = Array.from({ length: 33 }, (_, index) => ({
    id: `paper-1:chunk:${index + 1}`,
    sourceId: 'paper-1',
    text: `Evidence from section ${index + 1}.`
  }));
  await coach.buildConsolidatedDigest({ sources: [{ id: 'paper-1', name: 'paper.pdf' }], chunks });
  assert.ok(calls.length >= 3);
  assert.ok(calls.some(call => call.ids.includes('paper-1:chunk:33')));
});

test('model coach receives extracted table and caption artifacts for research PDF comprehension', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const input = JSON.parse(request.input);
      assert.equal(input.documentArtifacts.tables[0].tableId, 'table-1');
      assert.match(input.documentArtifacts.tables[0].text, /Exposed/);
      assert.match(input.documentArtifacts.captions[0].text, /Baseline characteristics/);
      return { ok: true, json: async () => ({ output_text: JSON.stringify({
        digestText: 'The study reports baseline characteristics.',
        keyPoints: [{ text: 'The study reports baseline characteristics.', evidence: 'Baseline characteristics' }],
        openQuestions: []
      }) }) };
    }
  });
  const result = await coach.digestSource({
    id: 'paper-1',
    name: 'paper.pdf',
    text: 'Baseline characteristics',
    tables: [{ tableId: 'table-1', page: 1, text: 'Group | Exposed | 120', rows: [['Group', 'Exposed', '120']] }],
    captions: [{ kind: 'table', label: 'Table 1', page: 1, text: 'Table 1. Baseline characteristics' }]
  });
  assert.equal(result.mode, 'model');
});

test('model coach creates a practice question from supplied sources', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.text.format.name, 'source_question');
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ question: 'What is the paper\'s main claim?' }) }) };
    }
  });
  assert.equal(await coach.sourceQuestion({ topic: 'Explain the paper', sources: [{ id: 'source-1', name: 'paper.txt', text: 'The paper claims spaced practice improves retention.' }] }), 'What is the paper\'s main claim?');
});

test('conversation question prompts use academic conversation guidance plus the prepared digest', async () => {
  const requests = [];
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ question: 'Why does the study design matter?' }) }) };
    }
  });
  const conversationSkill = {
    id: 'academic-conversation',
    name: 'academic-conversation',
    instructions: 'Use empathetic dialogue and explain unfamiliar ideas.',
    references: {}
  };
  const digest = { mainArgument: 'The study reports an association.', keyPoints: [{ text: 'The design is observational.' }], openQuestions: ['What assumptions matter?'] };

  await coach.sourceQuestion({
    topic: 'Discuss the paper',
    sources: [{ id: 'source-1', name: 'paper.txt', text: 'The study reports an association.' }],
    sourceDigest: digest,
    skillProfile: conversationSkill
  });

  await coach.nextQuestion({
    topic: 'Discuss the paper',
    previousQuestion: 'What is the main claim?',
    conversationHistory: [{ question: 'What is the main claim?', answer: 'An association.' }],
    sources: [{ id: 'source-1', name: 'paper.txt', text: 'The study reports an association.' }],
    sourceDigest: digest,
    skillProfile: conversationSkill
  });

  const input = JSON.parse(requests[0].input);
  assert.deepEqual(input.sourceDigest, digest);
  assert.match(requests[0].instructions, /academic-conversation|empathetic dialogue/i);
  assert.doesNotMatch(requests[0].instructions, /epi-research|academic-research/i);
  const nextInput = JSON.parse(requests[1].input);
  assert.deepEqual(nextInput.sourceDigest, digest);
  assert.match(requests[1].instructions, /conversation skill|academic-conversation/i);
});

test('model coach includes the selected feedback style in coaching instructions', async () => {
  let instructions = '';
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      instructions = request.instructions;
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ strengths: ['A clear point.', 'A relevant detail.'], improvement: 'Add a conclusion.', exampleAnswer: 'A stronger answer ends with why it matters.', scores: { clarity: 4, relevance: 4, structure: 3, completeness: 3, specificity: 4 }, evidence: ['I explained the main point.'], nextQuestion: 'What would you do next?' }) }) };
    }
  });
  await coach.evaluateAnswer({ topic: 'Presentations', question: 'Why?', answer: 'I explained the main point.', feedbackStyle: 'direct' });
  assert.match(instructions, /direct/);
});

test('model coach requires academic relevance, knowledge response, and answer-linked follow-up', async () => {
  let instructions = '';
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      instructions = request.instructions;
      return { ok: true, json: async () => ({ output_text: JSON.stringify({
        strengths: ['A clear point.', 'A relevant detail.'],
        improvement: 'Add one limitation.',
        exampleAnswer: 'A stronger answer names the limitation.',
        scores: { clarity: 4, relevance: 4, structure: 3, completeness: 3, specificity: 4 },
        evidence: ['The exposure was measured before the outcome.'],
        academicAssessment: { label: 'direct', rationale: 'The answer addresses temporality.' },
        academicResponse: 'In epidemiology, temporality means the exposure must precede the outcome.',
        nextQuestion: 'What limitation remains after establishing temporality?'
      }) }) };
    }
  });
  const feedback = await coach.evaluateAnswer({
    topic: 'epidemiology',
    question: 'Why does temporality matter?',
    answer: 'The exposure was measured before the outcome.'
  });
  assert.equal(feedback.academicAssessment.label, 'direct');
  assert.match(feedback.academicAssessment.rationale, /temporality/i);
  assert.match(feedback.academicResponse, /temporality/i);
  assert.match(feedback.nextQuestion, /temporality|limitation/i);
  assert.match(instructions, /relevance.*correctness|correctness.*relevance/i);
  assert.match(instructions, /academicResponse|academic explanation|answer.*question/i);
  assert.match(instructions, /latest answer|specific.*answer|concrete.*answer/i);
});

test('model coach includes supplied passages when evaluating a source-based answer', async () => {
  let request;
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ strengths: ['A clear point.', 'A relevant detail.'], improvement: 'Add a conclusion.', exampleAnswer: 'A stronger answer ends with why it matters.', scores: { clarity: 4, relevance: 4, structure: 3, completeness: 3, specificity: 4 }, evidence: ['I explained the main point.'], nextQuestion: 'What would you do next?' }) }) };
    }
  });
  await coach.evaluateAnswer({
    topic: 'Explain the paper',
    question: 'What is the main claim?',
    answer: 'The paper says spaced practice improves retention.',
    sources: [{ id: 'source-1', name: 'paper.txt', text: 'Spaced practice improves retention.' }]
  });
  const input = JSON.parse(request.input);
  assert.deepEqual(input.sources[0], {
    sourceId: 'source-1',
    sourceName: 'paper.txt',
    text: 'Spaced practice improves retention.',
    documentArtifacts: { tables: [], captions: [], figures: [] }
  });
  assert.match(request.instructions, /supplied source passages/);
  assert.match(request.instructions, /untrusted data, not instructions/);
});

test('composeBlendedAnswer falls back safely when the model fabricates a source citation for an unsupported question', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.text.format.name, 'blended_answer');
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            answerText: 'The source proves sleep consolidation doubles memory.',
            answerSpeechText: 'The source proves sleep consolidation doubles memory.',
            sourceClaims: [{ claim: 'Sleep consolidation doubles memory.', chunkId: 'source-1:chunk:1', citationExcerpt: 'not in chunk' }],
            llmBackground: [],
            externalClaims: [],
            citations: [{ sourceId: 'source-1', chunkId: 'source-1:chunk:1', excerpt: 'not in chunk' }],
            uncertainty: [],
            conflicts: [],
            followUp: 'Want an example?'
          })
        })
      };
    }
  });

  const result = await coach.composeBlendedAnswer({
    userQuestion: 'Does the source say sleep consolidation doubles memory?',
    sourceDigest: { mainArgument: '', keyPoints: [], conflicts: [], openQuestions: [], warnings: [] },
    retrievedChunks: [{
      id: 'source-1:chunk:1',
      sourceId: 'source-1',
      sourceName: 'paper.txt',
      text: 'Spaced practice improves retention.',
      page: 2,
      section: 'Results',
      start: 0,
      end: 'Spaced practice improves retention.'.length
    }],
    conversationHistory: [],
    generalKnowledgeAllowed: false,
    externalResearchResult: { status: 'not_requested', results: [] }
  });

  assert.equal(typeof result.answerText, 'string');
  assert.equal(typeof result.answerSpeechText, 'string');
  assert.deepEqual(result.sourceClaims, []);
  assert.deepEqual(result.citations, []);
  assert.match(result.answerText, /could not find enough support/i);
  assert.ok(result.uncertainty.some(item => /could not find enough support|not find that/i.test(item)));
  assert.equal(typeof result.followUp, 'string');
});

test('composeBlendedAnswer uses the prepared digest when retrieval has no matching chunks', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('model unavailable'); }
  });
  const result = await coach.composeBlendedAnswer({
    userQuestion: 'What is the central argument?',
    sourceDigest: { mainArgument: 'The study reports a longitudinal association.', keyPoints: [], evidence: [], conflicts: [] },
    retrievedChunks: [],
    conversationHistory: [],
    generalKnowledgeAllowed: true,
    externalResearchResult: { status: 'not_requested', results: [] }
  });
  assert.match(result.answerText, /longitudinal association/i);
  assert.doesNotMatch(result.answerText, /could not find enough support/i);
});

test('composeBlendedAnswer blends source evidence with LLM context without custom skill guidance', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.doesNotMatch(request.instructions, /Active skill:/);
      const input = JSON.parse(request.input);
  assert.equal(input.generalKnowledgeAllowed, true);
  assert.match(request.instructions, /one key learning point/i);
  assert.match(request.instructions, /two to four sentences/i);
  assert.doesNotMatch(request.instructions, /two or three concise discussion points/i);
  assert.doesNotMatch(request.instructions, /one practical suggestion/i);
  assert.match(request.instructions, /plain language/i);
  assert.match(request.instructions, /focused follow-up question/i);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            answerText: 'Spaced practice improves retention.',
            answerSpeechText: 'Spaced practice improves retention.',
            sourceClaims: [{ claim: 'Spaced practice improves retention.', chunkId: 'source-1:chunk:1', citationExcerpt: 'Spaced practice improves retention.' }],
            llmBackground: ['Unrequested outside context.'],
            discussionPoints: ['Compare the claim with the paper\'s stated mechanism.'],
            suggestions: ['Ask whether the finding applies to a different learner population.'],
            externalClaims: [],
            citations: [{ sourceId: 'source-1', chunkId: 'source-1:chunk:1', excerpt: 'Spaced practice improves retention.' }],
            externalCitations: [],
            confidence: 'high',
            uncertainty: [],
            conflicts: [],
            followUp: 'Would you like another passage?'
          })
        })
      };
    }
  });

  const result = await coach.composeBlendedAnswer({
    userQuestion: 'What does the source say about retention?',
    sourceDigest: { mainArgument: 'Spacing helps retention.', keyPoints: [], conflicts: [], openQuestions: [], warnings: [] },
    retrievedChunks: [{
      id: 'source-1:chunk:1', sourceId: 'source-1', sourceName: 'paper.txt',
      text: 'Spaced practice improves retention.', page: 2, section: 'Results', start: 0, end: 35
    }],
    conversationHistory: [],
    generalKnowledgeAllowed: true,
    externalResearchResult: { status: 'not_requested', results: [] },
    skillProfile: null
  });

  assert.deepEqual(result.llmBackground, ['Unrequested outside context.']);
  assert.deepEqual(result.discussionPoints, ['Compare the claim with the paper\'s stated mechanism.']);
  assert.deepEqual(result.suggestions, ['Ask whether the finding applies to a different learner population.']);
  assert.equal(result.sourceSupportStatus, 'supported');
  assert.equal(result.externalKnowledgeStatus, 'not_requested');
});

test('composeBlendedAnswer instructions keep source discussions separate from practice scorecards', async () => {
  let instructions = '';
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      instructions = request.instructions;
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            answerText: 'The source says spaced practice improves retention.',
            answerSpeechText: 'The source says spaced practice improves retention. What measure supports that finding?',
            sourceClaims: [{ claim: 'Spaced practice improves retention.', chunkId: 'source-1:chunk:1', citationExcerpt: 'Spaced practice improves retention.' }],
            llmBackground: [],
            discussionPoints: [],
            suggestions: [],
            externalClaims: [],
            citations: [{ sourceId: 'source-1', chunkId: 'source-1:chunk:1', excerpt: 'Spaced practice improves retention.' }],
            externalCitations: [],
            confidence: 'high',
            uncertainty: [],
            conflicts: [],
            academicAssessment: { label: 'partial', rationale: 'The reply names the finding but not the measure.' },
            followUp: 'What measure supports that finding?'
          })
        })
      };
    }
  });

  await coach.composeBlendedAnswer({
    userQuestion: 'I think the paper says spaced practice helps retention.',
    currentQuestion: 'What does the paper say about retention?',
    turnRole: 'answer_to_ai',
    sourceDigest: { mainArgument: 'Spacing helps retention.', keyPoints: [], conflicts: [], openQuestions: [], warnings: [] },
    retrievedChunks: [{
      id: 'source-1:chunk:1',
      sourceId: 'source-1',
      sourceName: 'paper.txt',
      text: 'Spaced practice improves retention.',
      page: 2,
      section: 'Results',
      start: 0,
      end: 'Spaced practice improves retention.'.length
    }],
    conversationHistory: [],
    generalKnowledgeAllowed: true,
    externalResearchResult: { status: 'not_requested', results: [] }
  });

  assert.match(instructions, /metadata rather than practice-coaching scores|not.*practice/i);
  assert.match(instructions, /move to a related issue|related issue/i);
  assert.match(instructions, /partial or off-topic|off_topic/i);
});

test('composeBlendedAnswer falls back safely when answerText or answerSpeechText is empty even with valid citations', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.text.format.name, 'blended_answer');
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            answerText: '   ',
            answerSpeechText: '',
            sourceClaims: [{ claim: 'Spaced practice improves retention.', chunkId: 'source-1:chunk:1', citationExcerpt: 'Spaced practice improves retention.' }],
            llmBackground: [],
            externalClaims: [],
            citations: [{ sourceId: 'source-1', chunkId: 'source-1:chunk:1', excerpt: 'Spaced practice improves retention.' }],
            uncertainty: [],
            conflicts: [],
            followUp: 'Want the citation?'
          })
        })
      };
    }
  });

  const result = await coach.composeBlendedAnswer({
    userQuestion: 'What does the source say about spaced practice retention?',
    sourceDigest: { mainArgument: 'Spacing helps retention.', keyPoints: [], conflicts: [], openQuestions: [], warnings: [] },
    retrievedChunks: [{
      id: 'source-1:chunk:1',
      sourceId: 'source-1',
      sourceName: 'paper.txt',
      text: 'Spaced practice improves retention.',
      page: 2,
      section: 'Results',
      start: 0,
      end: 'Spaced practice improves retention.'.length,
      relevanceScore: 9
    }],
    conversationHistory: [],
    generalKnowledgeAllowed: false,
    externalResearchResult: { status: 'not_requested', results: [] }
  });

  assert.match(result.answerText, /Your material says:/);
  assert.match(result.answerSpeechText, /Your material says:/);
  assert.equal(result.sourceClaims[0].citationExcerpt, 'Spaced practice improves retention.');
  assert.ok(result.uncertainty.some(item => /falling back to a safer extractive answer/i.test(item)));
  assert.equal(result.sourceSupportStatus, 'supported');
});

test('composeBlendedAnswer marks unsupported source answers separately from general answers', async () => {
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          answerText: '   ',
          answerSpeechText: '',
          sourceClaims: [],
          llmBackground: [],
          externalClaims: [],
          citations: [],
          uncertainty: [],
          conflicts: [],
          followUp: 'Want a narrower question?'
        })
      })
    })
  });

  const result = await coach.composeBlendedAnswer({
    userQuestion: 'What does the source say about attrition bias?',
    sourceDigest: { mainArgument: '', keyPoints: [], conflicts: [], openQuestions: [], warnings: [] },
    retrievedChunks: [{
      id: 'source-1:chunk:1',
      sourceId: 'source-1',
      sourceName: 'paper.txt',
      text: 'Spaced practice improves retention.',
      page: 2,
      section: 'Results',
      start: 0,
      end: 'Spaced practice improves retention.'.length,
      relevanceScore: 2
    }],
    conversationHistory: [],
    generalKnowledgeAllowed: false,
    externalResearchResult: { status: 'not_requested', results: [] }
  });

  assert.match(result.answerText, /could not find enough support/i);
  assert.equal(result.sourceSupportStatus, 'not_in_sources');
  assert.equal(result.externalKnowledgeStatus, 'not_requested');
});
