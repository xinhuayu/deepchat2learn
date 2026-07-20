import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEvidenceExcerpt } from '../src/evidence.mjs';

test('resolveEvidenceExcerpt preserves the original PDF text while accepting harmless formatting differences', () => {
  const source = 'The “cognitive decline” score was\nmeasured over a long–term follow-up.';
  const requested = 'The "cognitive decline" score was measured over a long-term follow-up.';

  const matched = resolveEvidenceExcerpt(source, requested);

  assert.ok(matched);
  assert.equal(matched.excerpt, source);
  assert.deepEqual(matched.locator, { type: 'character', start: 0, end: source.length });
});

test('resolveEvidenceExcerpt rejects a substantive paraphrase', () => {
  const source = 'Retrieval practice boosts long-term retention in this course.';
  assert.equal(resolveEvidenceExcerpt(source, 'Retrieval practice causes better learning.'), null);
});
