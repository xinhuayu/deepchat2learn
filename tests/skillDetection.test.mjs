import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSkillId, resolveSkillSelection } from '../src/skillDetection.mjs';

const registry = {
  get(id) {
    return ['epi-research', 'academic-research', 'academic-conversation'].includes(id) ? { id, name: id } : null;
  }
};

test('automatic detection selects epidemiology review for a clear methods critique request', () => {
  const result = detectSkillId({
    topic: 'Critique this epidemiology cohort study',
    sourceNames: ['paper.pdf']
  });
  assert.equal(result.skillId, 'epi-research');
  assert.match(result.reason, /automatic/i);
});

test('automatic detection stays general for an unrelated source discussion', () => {
  const result = detectSkillId({
    topic: 'Explain the main idea in these lecture notes',
    sourceText: 'The paper describes a classroom activity and student reflection.'
  });
  assert.equal(result.skillId, 'none');
});

test('explicit selection overrides automatic detection', () => {
  const none = resolveSkillSelection({
    requestedSkillId: 'none',
    sourceMode: 'source',
    topic: 'Critique this epidemiology cohort study',
    registry
  });
  assert.equal(none.activeSkillId, 'none');
  assert.equal(none.conversationSkillId, 'academic-conversation');

  const epi = resolveSkillSelection({
    requestedSkillId: 'epi-research',
    sourceMode: 'source',
    topic: 'Discuss this article',
    registry
  });
  assert.equal(epi.activeSkillId, 'epi-research');
  assert.equal(epi.conversationSkillId, 'academic-conversation');
});

test('explicit registered custom skills remain selected', () => {
  const customRegistry = {
    get(id) {
      if (id === 'custom-demo') return { id, name: 'Custom Demo', sourceOnly: true };
      if (id === 'academic-conversation') return { id, name: id };
      return null;
    }
  };
  const result = resolveSkillSelection({
    requestedSkillId: 'custom-demo',
    sourceMode: 'source',
    topic: 'Discuss the supplied material',
    registry: customRegistry
  });
  assert.equal(result.requestedSkillId, 'custom-demo');
  assert.equal(result.activeSkillId, 'custom-demo');
  assert.equal(result.conversationSkillId, 'academic-conversation');
});

test('general source sessions select academic research for digestion and academic conversation for dialogue', () => {
  const result = resolveSkillSelection({
    requestedSkillId: 'auto',
    sourceMode: 'source',
    topic: 'Help me understand this research paper',
    registry
  });
  assert.equal(result.activeSkillId, 'academic-research');
  assert.equal(result.conversationSkillId, 'academic-conversation');
});

test('automatic selection falls back when the requested profile is unavailable', () => {
  const result = resolveSkillSelection({
    requestedSkillId: 'epi-research',
    sourceMode: 'source',
    topic: 'Critique this epidemiology cohort study',
    registry: { get() { return null; } }
  });
  assert.equal(result.activeSkillId, 'none');
  assert.equal(result.conversationSkillId, 'none');
  assert.match(result.warning, /general source discussion/i);
});

test('practice sessions always use academic conversation for dialogue', () => {
  const result = resolveSkillSelection({
    requestedSkillId: 'epi-research',
    sourceMode: 'none',
    topic: 'Critique this epidemiology cohort study',
    registry
  });
  assert.equal(result.activeSkillId, 'none');
  assert.equal(result.conversationSkillId, 'academic-conversation');
  assert.match(result.reason, /practice/i);
});
