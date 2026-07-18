export function locateEvidence(sourceText, evidence, fromIndex = 0) {
  const content = String(sourceText || '');
  const excerpt = String(evidence || '');
  const start = content.indexOf(excerpt, Math.max(0, fromIndex));
  return start < 0 ? null : { type: 'character', start, end: start + excerpt.length };
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
