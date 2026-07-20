import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillRegistry } from '../src/skillRegistry.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('bundled epi-research skill loads with its reference guidance', () => {
  const registry = loadSkillRegistry({ rootDir: projectRoot });
  const skill = registry.get('epi-research');

  assert.equal(skill.id, 'epi-research');
  assert.match(skill.instructions, /Epidemiologic Methods Critique/);
  assert.match(skill.references['critique-guideline.md'], /Question, target, and design/);
  assert.equal('path' in skill, false);
  assert.equal('rootDir' in skill, false);
  assert.match(registry.promptContext('epi-research'), /Skill guidance/);
  assert.match(registry.promptContext('epi-research'), /Doctoral Guide/);
});

test('bundled academic skills load for digestion and source conversation', () => {
  const registry = loadSkillRegistry({ rootDir: projectRoot });
  const research = registry.get('academic-research');
  const conversation = registry.get('academic-conversation');

  assert.equal(research.id, 'academic-research');
  assert.match(research.instructions, /research question/i);
  assert.equal(conversation.id, 'academic-conversation');
  assert.match(conversation.instructions, /general knowledge/i);
  assert.match(conversation.instructions, /follow-up/i);
  assert.match(conversation.instructions, /one key learning point/i);
  assert.match(conversation.instructions, /two to four sentences/i);
  assert.match(research.instructions, /source digestion|research summary/i);
  assert.match(research.instructions, /not.*conversation round|not.*follow-up/i);
  assert.match(registry.get('epi-research').instructions, /explicit.*review|methods review/i);
  assert.match(registry.get('epi-research').instructions, /not.*conversation round|not.*follow-up/i);
});

test('academic conversation skill requires empathetic, explanatory teaching feedback', () => {
  const registry = loadSkillRegistry({ rootDir: projectRoot });
  const conversation = registry.get('academic-conversation');

  assert.match(conversation.instructions, /acknowledge|validate/i);
  assert.match(conversation.instructions, /empathetic|empath/i);
  assert.match(conversation.instructions, /explain why|explain the issue|reasoning/i);
  assert.match(conversation.instructions, /example|next step/i);
  assert.match(conversation.instructions, /student|learner/i);
  assert.match(conversation.instructions, /main dialogue skill.*practice and source conversation/i);
  assert.match(conversation.instructions, /digest|prepared digest/i);
  assert.match(conversation.instructions, /definition|orientation/i);
  assert.match(conversation.instructions, /scope|boundaries/i);
  assert.match(conversation.instructions, /research aim|main question/i);
  assert.match(conversation.instructions, /hypothesis|central claim/i);
  assert.match(conversation.instructions, /setting|population/i);
  assert.match(conversation.instructions, /progress|gradual|stage/i);
  assert.match(conversation.instructions, /short|concise/i);
  assert.match(conversation.instructions, /abstract|restat/i);
});

test('registry ignores invalid skill files and returns null for unknown skills', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-skills-'));
  await fs.mkdir(path.join(rootDir, 'skills', 'invalid'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'skills', 'invalid', 'SKILL.md'), '');

  const registry = loadSkillRegistry({ rootDir });
  assert.equal(registry.get('invalid'), null);
  assert.equal(registry.get('missing'), null);
  assert.deepEqual(registry.list(), []);
});
