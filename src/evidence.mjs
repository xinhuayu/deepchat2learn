export function locateEvidence(sourceText, evidence, fromIndex = 0) {
  const content = String(sourceText || '');
  const excerpt = String(evidence || '');
  const start = content.indexOf(excerpt, Math.max(0, fromIndex));
  return start < 0 ? null : { type: 'character', start, end: start + excerpt.length };
}

function canonicalEvidenceCharacter(value) {
  if (/\s/u.test(value)) return ' ';
  if ('‐‑‒–—―−'.includes(value)) return '-';
  if ('‘’‚‛'.includes(value)) return "'";
  if ('“”„‟'.includes(value)) return '"';
  return value.toLocaleLowerCase();
}

function canonicalEvidenceWithOffsets(value) {
  const content = String(value || '');
  const characters = [];
  let previousWasSpace = true;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '\u00ad') continue;
    const normalized = canonicalEvidenceCharacter(character);
    if (normalized === ' ') {
      if (previousWasSpace) continue;
      characters.push({ character: ' ', start: index, end: index + 1 });
      previousWasSpace = true;
      continue;
    }
    characters.push({ character: normalized, start: index, end: index + 1 });
    previousWasSpace = false;
  }
  while (characters.at(-1)?.character === ' ') characters.pop();
  return characters;
}

function canonicalEvidenceText(value) {
  return canonicalEvidenceWithOffsets(value).map(item => item.character).join('');
}

/**
 * Finds an evidence excerpt while tolerating only harmless PDF-extraction
 * formatting differences (case, whitespace, smart quotes, dash variants, and
 * soft hyphens). The returned excerpt is always the exact original substring.
 */
export function resolveEvidenceExcerpt(sourceText, evidence) {
  const content = String(sourceText || '');
  const requested = String(evidence || '').trim();
  if (!content || !requested) return null;

  const exact = locateEvidence(content, requested);
  if (exact) return { excerpt: content.slice(exact.start, exact.end), locator: exact };

  const sourceCharacters = canonicalEvidenceWithOffsets(content);
  const normalizedSource = sourceCharacters.map(item => item.character).join('');
  const normalizedEvidence = canonicalEvidenceText(requested);
  if (!normalizedSource || !normalizedEvidence) return null;
  const normalizedStart = normalizedSource.indexOf(normalizedEvidence);
  if (normalizedStart < 0) return null;
  const normalizedEnd = normalizedStart + normalizedEvidence.length;
  const start = sourceCharacters[normalizedStart]?.start;
  const end = sourceCharacters[normalizedEnd - 1]?.end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
  return {
    excerpt: content.slice(start, end),
    locator: { type: 'character', start, end }
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeExternalCitationKey(citation) {
  return normalizeText(citation?.id || citation?.url || citation?.title).toLowerCase();
}

export function exactSubstringLocator(sourceText, excerpt) {
  const text = normalizeText(sourceText);
  const needle = normalizeText(excerpt);
  if (!text || !needle) return null;
  return locateEvidence(text, needle);
}

export function validateAnswerEvidence(answer, retrievedChunks, externalCitations = []) {
  const errors = [];
  const chunkMap = new Map(asArray(retrievedChunks).map(chunk => [chunk.id, chunk]));
  const sourceCitationKeys = new Set();
  const normalizedExternal = new Map(asArray(externalCitations).map(citation => [normalizeExternalCitationKey(citation), citation]));

  for (const [index, citation] of asArray(answer?.citations).entries()) {
    const chunk = chunkMap.get(citation?.chunkId);
    const excerpt = normalizeText(citation?.excerpt);
    if (!chunk) {
      errors.push(`citations[${index}] references an unknown chunkId.`);
      continue;
    }
    if (citation?.sourceId && citation.sourceId !== chunk.sourceId) {
      errors.push(`citations[${index}] sourceId does not match the retrieved chunk.`);
    }
    const locator = exactSubstringLocator(chunk.text, excerpt);
    if (!excerpt || !locator) {
      errors.push(`citations[${index}] must include an exact excerpt from the retrieved chunk.`);
      continue;
    }
    const absoluteStart = chunk.start + locator.start;
    const absoluteEnd = chunk.start + locator.end;
    if (citation?.start !== undefined && Number(citation.start) !== absoluteStart) {
      errors.push(`citations[${index}] start offset does not match the exact excerpt location.`);
    }
    if (citation?.end !== undefined && Number(citation.end) !== absoluteEnd) {
      errors.push(`citations[${index}] end offset does not match the exact excerpt location.`);
    }
    sourceCitationKeys.add(`${chunk.id}::${excerpt}`);
  }

  for (const [index, claim] of asArray(answer?.sourceClaims).entries()) {
    const chunk = chunkMap.get(claim?.chunkId);
    const excerpt = normalizeText(claim?.citationExcerpt);
    if (!chunk) {
      errors.push(`sourceClaims[${index}] references an unknown chunkId.`);
      continue;
    }
    if (!excerpt || !chunk.text.includes(excerpt)) {
      errors.push(`sourceClaims[${index}] must include an exact supporting substring.`);
      continue;
    }
    if (!sourceCitationKeys.has(`${chunk.id}::${excerpt}`)) {
      errors.push(`sourceClaims[${index}] must be backed by a matching source citation.`);
    }
  }

  for (const [index, claim] of asArray(answer?.externalClaims).entries()) {
    const key = normalizeExternalCitationKey({
      id: claim?.externalCitationId,
      url: claim?.url,
      title: claim?.title
    });
    if (!key || !normalizedExternal.has(key)) {
      errors.push(`externalClaims[${index}] must reference a normalized external citation.`);
    }
  }

  return { valid: errors.length === 0, errors };
}
