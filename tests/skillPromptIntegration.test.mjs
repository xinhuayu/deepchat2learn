import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCoach } from '../src/modelCoach.mjs';

const skillProfile = {
  id: 'epi-research',
  name: 'epi-research',
  instructions: 'Use target, design, assumptions, estimator, diagnostics, and supported inference.',
  references: { 'critique-guideline.md': 'Evaluate selection, measurement, confounding, and missingness.' }
};

function responseFor(name) {
  if (name === 'source_digest') return { digestText: 'The study reports an association.', keyPoints: [{ text: 'The study reports an association.', evidence: 'The study reports an association.' }], openQuestions: [] };
  if (name === 'source_question') return { question: 'What is the study target and estimand?' };
  if (name === 'grounded_answer') return { answer: 'The study reports an association.', sourceGroundedClaims: [{ claim: 'The study reports an association.', sourceId: 'source-1', evidence: 'The study reports an association.' }], additionalContext: [], unsupportedOrUnresolved: [], confidence: 'high' };
  return {
    answerText: 'The study reports an association.',
    answerSpeechText: 'The study reports an association.',
    sourceClaims: [{ claim: 'The study reports an association.', chunkId: 'source-1:chunk:1', citationExcerpt: 'The study reports an association.' }],
    llmBackground: [],
    externalClaims: [],
    citations: [{ sourceId: 'source-1', chunkId: 'source-1:chunk:1', excerpt: 'The study reports an association.' }],
    uncertainty: [],
    conflicts: [],
    followUp: 'What assumption matters most?'
  };
}

test('source digestion uses the research skill while live source turns use academic conversation guidance', async () => {
  const requests = [];
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      return { ok: true, json: async () => ({ output_text: JSON.stringify(responseFor(request.text.format.name)) }) };
    }
  });
  const source = { id: 'source-1', name: 'paper.txt', text: 'The study reports an association.' };

  await coach.digestSource(source, skillProfile);
  await coach.sourceQuestion({ topic: 'Critique the paper', sources: [source], skillProfile });
  await coach.groundedAnswer({ question: 'What did the study report?', sources: [source], skillProfile });

  assert.equal(requests.length, 3);
  assert.match(requests[0].instructions, /epi-research|target, design, assumptions/i);
  assert.match(requests[0].instructions, /source evidence|supplied source|source material/i);
  for (const request of requests.slice(1)) {
    assert.match(request.instructions, /academic conversation|live turn/i);
    assert.doesNotMatch(request.instructions, /target, design, assumptions|critique-guideline/i);
  }
});

test('blended source-answer prompts include skill guidance without turning it into evidence', async () => {
  let request;
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ output_text: JSON.stringify(responseFor('blended_answer')) }) };
    }
  });
  const excerpt = 'The study reports an association.';
  const result = await coach.composeBlendedAnswer({
    userQuestion: 'Critique the study design.',
    sourceDigest: { mainArgument: excerpt, keyPoints: [], conflicts: [], openQuestions: [], warnings: [] },
    retrievedChunks: [{ id: 'source-1:chunk:1', sourceId: 'source-1', sourceName: 'paper.txt', text: excerpt, start: 0, end: excerpt.length }],
    conversationHistory: [],
    generalKnowledgeAllowed: true,
    externalResearchResult: { status: 'not_requested', results: [] },
    skillProfile
  });

  assert.equal(result.citations.length, 1);
  assert.match(request.instructions, /academic conversation|live turn/i);
  assert.doesNotMatch(request.instructions, /target, design, assumptions|critique-guideline/i);
  assert.match(request.instructions, /source chunks as the authoritative layer/i);
  assert.doesNotMatch(JSON.stringify(result.citations), /epi-research|critique-guideline/);
});

test('digest and conversation prompts accept separate skill profiles', async () => {
  const requests = [];
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      return { ok: true, json: async () => ({ output_text: JSON.stringify(responseFor(request.text.format.name)) }) };
    }
  });
  const source = { id: 'source-1', name: 'paper.txt', text: 'The study reports an association.' };
  const researchSkill = { ...skillProfile, id: 'academic-research', name: 'academic-research', instructions: 'Digest the research question, evidence, uncertainty, and open questions.', references: {} };
  const conversationSkill = { ...skillProfile, id: 'academic-conversation', name: 'academic-conversation', instructions: 'Explain unfamiliar ideas, label general knowledge, and ask a useful follow-up.', references: {} };

  await coach.digestSource(source, researchSkill);
  await coach.sourceQuestion({ topic: 'Discuss the paper', sources: [source], skillProfile: conversationSkill });
  await coach.composeBlendedAnswer({
    userQuestion: 'What does this mean?',
    sourceDigest: null,
    retrievedChunks: [{ id: 'source-1:chunk:1', sourceId: 'source-1', sourceName: 'paper.txt', text: 'The study reports an association.', start: 0, end: 37 }],
    conversationHistory: [],
    generalKnowledgeAllowed: true,
    externalResearchResult: { status: 'not_requested', results: [] },
    skillProfile: conversationSkill
  });

  assert.match(requests[0].instructions, /academic-research|open questions/i);
  assert.match(requests[1].instructions, /academic-conversation|follow-up/i);
  assert.match(requests[2].instructions, /academic-conversation|follow-up/i);
});
