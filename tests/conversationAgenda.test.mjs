import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationAgenda } from '../src/conversationAgenda.mjs';
import { createCoach } from '../src/fakeCoach.mjs';

test('conversation agenda advances through distinct academic stages and retains short recent-question context', () => {
  assert.deepEqual(
    createConversationAgenda({
      completedTurns: 4,
      currentQuestion: 'What did the study find?',
      recentQuestions: ['What is the research question?', 'What is the study design?', 'What is the research question?']
    }),
    {
      currentStage: 'findings',
      nextStage: 'interpretation',
      recentQuestions: ['What is the research question?', 'What is the study design?', 'What did the study find?']
    }
  );
});

test('fallback source questions advance beyond design when the session has completed later turns', () => {
  const coach = createCoach();
  const question = coach.sourceQuestion({
    sources: [{ id: 'paper-1', name: 'paper.txt', text: 'The cohort followed participants and measured mortality.' }],
    conversationHistory: [{ question: 'What is this paper about?', answer: 'A cohort study.' }],
    conversationTurnCount: 5
  });

  assert.match(question, /result|evidence|interpret/i);
  assert.doesNotMatch(question, /study design|approach/i);
});
