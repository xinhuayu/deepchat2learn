const MAX_TOPIC_DIGEST_TEXT = 1_200;
const MAX_TOPIC_DIGEST_SCOPE = 1_600;
const MAX_TOPIC_DIGEST_ITEMS = 5;

function clean(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function uniqueStrings(values, maxItems) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = clean(value, MAX_TOPIC_DIGEST_TEXT);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxItems) break;
  }
  return result;
}

export function normalizeTopicDigest(value, topic, { mode = 'model' } = {}) {
  const normalizedTopic = clean(topic, MAX_TOPIC_DIGEST_TEXT);
  if (!normalizedTopic || !value || typeof value !== 'object') return null;

  const definition = clean(value.definition, MAX_TOPIC_DIGEST_TEXT);
  const scope = clean(value.scope, MAX_TOPIC_DIGEST_SCOPE);
  const anchorQuestion = clean(value.anchorQuestion, MAX_TOPIC_DIGEST_TEXT);
  const keyConcepts = uniqueStrings(value.keyConcepts, MAX_TOPIC_DIGEST_ITEMS);
  const boundaries = uniqueStrings(value.boundaries, 3);
  if (!definition || !scope || !anchorQuestion || !keyConcepts.length || !boundaries.length) return null;

  return {
    mode: mode === 'local' ? 'local' : 'model',
    topic: normalizedTopic,
    definition,
    scope,
    keyConcepts,
    boundaries,
    anchorQuestion
  };
}

export function buildLocalTopicDigest({ topic, goal = 'clarity' } = {}) {
  const normalizedTopic = clean(topic, MAX_TOPIC_DIGEST_TEXT) || 'the stated topic';
  const goalText = goal === 'structure'
    ? 'organize the explanation around a clear sequence'
    : goal === 'specificity'
      ? 'connect the explanation to concrete evidence or examples'
      : 'make the central idea clear and understandable';
  return normalizeTopicDigest({
    definition: `The conversation is about ${normalizedTopic}.`,
    scope: `Keep the discussion centered on the meaning of this topic, how its main idea works, and how to explain it clearly. The learning goal is to ${goalText}.`,
    keyConcepts: [normalizedTopic, 'central idea', 'supporting example'],
    boundaries: [
      `Keep every question and answer tied to ${normalizedTopic}.`,
      'When an answer is vague, ask one short clarifying question before broadening the discussion.',
      'Do not introduce an unrelated subject or an unsupported specific claim.'
    ],
    anchorQuestion: `What is the main idea or question within ${normalizedTopic}?`
  }, normalizedTopic, { mode: 'local' });
}

export function compactTopicDigest(digest) {
  const normalized = normalizeTopicDigest(digest, digest?.topic || 'the stated topic', { mode: digest?.mode || 'model' });
  if (!normalized) return null;
  return {
    definition: normalized.definition,
    scope: normalized.scope,
    keyConcepts: normalized.keyConcepts.slice(0, 5),
    boundaries: normalized.boundaries.slice(0, 3),
    anchorQuestion: normalized.anchorQuestion
  };
}
