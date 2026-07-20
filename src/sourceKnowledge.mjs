import { HttpError } from './store.mjs';
import { resolveEvidenceExcerpt } from './evidence.mjs';

function tokenize(text) {
  return [...String(text || '').matchAll(/\S+/g)].map(match => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].length
  }));
}

function locatePage(pages, start) {
  if (!Array.isArray(pages) || !pages.length) return { page: null, section: null };
  const match = pages.find(page => start >= Number(page.start || 0) && start < Number(page.end ?? Number.MAX_SAFE_INTEGER));
  if (match) return { page: match.page ?? null, section: match.section ?? null };
  const last = pages.at(-1);
  return { page: last?.page ?? null, section: last?.section ?? null };
}

function pickSentence(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(part => part.trim()).find(Boolean) || String(text || '').trim();
}

function normalizeClaimText(value) {
  return String(value || '').trim();
}

function lexicalTerms(text) {
  return [...new Set((String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(token => !['what', 'which', 'their', 'there', 'about', 'would', 'could', 'should', 'these', 'those'].includes(token)))];
}

function scoreChunk(queryTerms, chunk) {
  const text = String(chunk?.text || '').toLowerCase();
  const sourceName = String(chunk?.sourceName || '').toLowerCase();
  const section = String(chunk?.section || '').toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (text.includes(term)) score += 3;
    if (sourceName.includes(term)) score += 5;
    if (section.includes(term)) score += 2;
  }
  const phrase = queryTerms.join(' ');
  if (phrase && text.includes(phrase)) score += 4;
  return score;
}

function overlapRatio(left, right) {
  const start = Math.max(Number(left?.start || 0), Number(right?.start || 0));
  const end = Math.min(Number(left?.end || 0), Number(right?.end || 0));
  const overlap = Math.max(0, end - start);
  const shortest = Math.max(1, Math.min(Number(left?.end || 0) - Number(left?.start || 0), Number(right?.end || 0) - Number(right?.start || 0)));
  return overlap / shortest;
}

function dedupeRetrievedChunks(chunks) {
  const chosen = [];
  for (const chunk of chunks) {
    const duplicate = chosen.find(candidate => candidate.id === chunk.id
      || (candidate.sourceId === chunk.sourceId && overlapRatio(candidate, chunk) >= 0.6));
    if (!duplicate) chosen.push(chunk);
  }
  return chosen;
}

function diversifyChunks(chunks, limit) {
  const grouped = new Map();
  for (const chunk of chunks) {
    if (!grouped.has(chunk.sourceId)) grouped.set(chunk.sourceId, []);
    grouped.get(chunk.sourceId).push(chunk);
  }
  const diversified = [];
  let added = true;
  while (diversified.length < limit && added) {
    added = false;
    for (const list of grouped.values()) {
      const next = list.shift();
      if (!next) continue;
      diversified.push(next);
      added = true;
      if (diversified.length >= limit) break;
    }
  }
  return diversified;
}

function normalizeRetrievedChunk(chunk) {
  return {
    id: chunk.id,
    sourceId: chunk.sourceId,
    sourceName: chunk.sourceName || null,
    ordinal: chunk.ordinal ?? null,
    text: chunk.text,
    page: chunk.page ?? null,
    section: chunk.section ?? null,
    start: Number(chunk.start ?? 0),
    end: Number(chunk.end ?? 0),
    relevanceScore: Number(chunk.relevanceScore ?? 0)
  };
}

function finalizeRetrievedChunks(query, chunks, limit) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 10);
  const queryTerms = lexicalTerms(query);
  if (!queryTerms.length) return [];
  const ranked = chunks
    .map(chunk => {
      const normalized = normalizeRetrievedChunk(chunk);
      return {
        ...normalized,
        relevanceScore: scoreChunk(queryTerms, normalized)
      };
    })
    .filter(chunk => chunk.relevanceScore > 0)
    .sort((left, right) => right.relevanceScore - left.relevanceScore || left.start - right.start || left.id.localeCompare(right.id));
  const deduped = dedupeRetrievedChunks(ranked);
  return diversifyChunks(deduped, safeLimit).map(normalizeRetrievedChunk);
}

function collectWarnings(sources, extraWarnings = []) {
  const readinessWarnings = (Array.isArray(sources) ? sources : []).flatMap(source => {
    if (source?.status === 'digesting' || source?.status === 'extracting' || source?.status === 'uploaded') {
      return ['Source processing is still processing, so grounded answers are not ready yet. You can keep chatting while the digest finishes.'];
    }
    if (source?.status === 'failed') {
      return ['At least one source failed to process, so grounded answers may be incomplete until you replace or remove it.'];
    }
    return [];
  });
  return [...new Set([
    ...sources.flatMap(source => Array.isArray(source?.warnings) ? source.warnings : []),
    ...readinessWarnings,
    ...(Array.isArray(extraWarnings) ? extraWarnings : [])
  ].filter(Boolean))];
}

function everyChunkMatchesAtLeastOneText(texts, chunkIds, chunkMap) {
  const normalizedTexts = texts.map(normalizeClaimText).filter(Boolean);
  if (!normalizedTexts.length || !Array.isArray(chunkIds) || !chunkIds.length) return false;
  return chunkIds.every(chunkId => {
    const chunk = chunkMap.get(chunkId);
    return chunk && normalizedTexts.some(text => Boolean(resolveEvidenceExcerpt(chunk.text, text)));
  });
}

function canonicalizeDigestEvidence(item, text, chunkMap) {
  for (const chunkId of Array.isArray(item?.chunkIds) ? item.chunkIds : []) {
    const chunk = chunkMap.get(chunkId);
    const matched = chunk ? resolveEvidenceExcerpt(chunk.text, text) : null;
    if (matched) return { chunkId, excerpt: matched.excerpt };
  }
  return null;
}

function normalizeVerifiedModelDigest(digest, chunkMap) {
  return {
    ...digest,
    keyPoints: (Array.isArray(digest?.keyPoints) ? digest.keyPoints : []).map(point => {
      const matched = canonicalizeDigestEvidence(point, point?.evidence || point?.text, chunkMap);
      return matched ? {
        ...point,
        evidence: matched.excerpt,
        chunkIds: [matched.chunkId]
      } : point;
    }),
    evidence: (Array.isArray(digest?.evidence) ? digest.evidence : []).map(item => {
      const matched = canonicalizeDigestEvidence(item, item?.claim, chunkMap);
      return matched ? {
        ...item,
        claim: matched.excerpt,
        chunkIds: [matched.chunkId]
      } : item;
    })
  };
}

function detectConflicts(chunks) {
  const negativePattern = /\b(no|not|never|without|fails?|failed|cannot|can't|doesn't|didn't|won't)\b/i;
  const seen = [];
  const conflicts = [];
  for (const chunk of chunks) {
    const claim = pickSentence(chunk.text);
    const tokens = new Set((claim.toLowerCase().match(/[a-z]{4,}/g) || []).filter(token => !['does', 'did', 'with', 'that', 'this', 'from', 'into', 'have', 'long'].includes(token)));
    const polarity = negativePattern.test(claim) ? 'negative' : 'positive';
    for (const prior of seen) {
      const overlap = [...tokens].filter(token => prior.tokens.has(token));
      if (overlap.length >= 3 && polarity !== prior.polarity) {
        conflicts.push({
          topic: overlap.slice(0, 4).join(' '),
          claims: [prior.claim, claim],
          chunkIds: [prior.chunk.id, chunk.id]
        });
      }
    }
    seen.push({ chunk, claim, tokens, polarity });
  }
  return conflicts;
}

function buildExtractiveDigest({ sources, chunks, warnings = [] }) {
  const warningsList = collectWarnings(sources, warnings);
  const chunksBySource = new Map();
  for (const chunk of chunks) {
    if (!chunksBySource.has(chunk.sourceId)) chunksBySource.set(chunk.sourceId, []);
    chunksBySource.get(chunk.sourceId).push(chunk);
  }
  const keyPoints = sources.map(source => {
    const firstChunk = chunksBySource.get(source.id)?.[0];
    if (!firstChunk) return null;
    return {
      text: pickSentence(firstChunk.text),
      sourceIds: [source.id],
      chunkIds: [firstChunk.id]
    };
  }).filter(Boolean).slice(0, 5);
  const evidence = keyPoints.map(point => ({ claim: point.text, chunkIds: point.chunkIds }));
  const conflicts = detectConflicts(chunks).slice(0, 5);
  return {
    mode: 'extractive',
    mainArgument: keyPoints[0]?.text || '',
    keyPoints,
    importantTerms: [],
    evidence,
    conflicts,
    openQuestions: [],
    warnings: warningsList
  };
}

function validateModelDigest(digest, chunkMap) {
  const keyPoints = Array.isArray(digest?.keyPoints) ? digest.keyPoints : [];
  const evidence = Array.isArray(digest?.evidence) ? digest.evidence : [];
  const conflicts = Array.isArray(digest?.conflicts) ? digest.conflicts : [];
  if (!keyPoints.length && !evidence.length) return false;
  for (const point of keyPoints) {
    if (!everyChunkMatchesAtLeastOneText([point?.evidence || point?.text], point?.chunkIds, chunkMap)) return false;
  }
  for (const item of evidence) {
    if (!everyChunkMatchesAtLeastOneText([item?.claim], item?.chunkIds, chunkMap)) return false;
  }
  for (const item of conflicts) {
    const claims = Array.isArray(item?.claims) ? item.claims : [];
    if (!everyChunkMatchesAtLeastOneText(claims, item?.chunkIds, chunkMap)) return false;
  }
  return true;
}

export function chunkSource({ sourceId, text, pages, targetWords = 700, overlapWords = 100 }) {
  const content = String(text || '');
  const words = tokenize(content);
  if (!content.trim() || !words.length) return [];
  const safeTarget = Math.max(1, Number(targetWords) || 700);
  const safeOverlap = Math.max(0, Math.min(Number(overlapWords) || 0, safeTarget - 1));
  const step = Math.max(1, safeTarget - safeOverlap);
  const chunks = [];
  for (let startWord = 0, ordinal = 1; startWord < words.length; startWord += step, ordinal += 1) {
    const endWord = Math.min(startWord + safeTarget, words.length);
    const start = words[startWord].start;
    const end = words[endWord - 1].end;
    const locator = locatePage(pages, start);
    chunks.push({
      id: `${sourceId}:chunk:${ordinal}`,
      sourceId,
      ordinal,
      text: content.slice(start, end),
      page: locator.page,
      section: locator.section,
      start,
      end
    });
    if (endWord >= words.length) break;
  }
  return chunks;
}

export async function buildConsolidatedDigest({ sources, chunks, coach, skillProfile = null }) {
  const safeSources = Array.isArray(sources) ? sources : [];
  const safeChunks = Array.isArray(chunks) ? chunks : [];
  const extractiveFallback = warnings => buildExtractiveDigest({ sources: safeSources, chunks: safeChunks, warnings });
  if (!coach || typeof coach.buildConsolidatedDigest !== 'function') return extractiveFallback();
  const candidate = await coach.buildConsolidatedDigest({ sources: safeSources, chunks: safeChunks, skillProfile });
  const chunkMap = new Map(safeChunks.map(chunk => [chunk.id, chunk]));
  if (!validateModelDigest(candidate, chunkMap)) {
    return extractiveFallback(['Model digest evidence could not be validated against exact chunk substrings, so this digest is partial.']);
  }
  const verified = normalizeVerifiedModelDigest(candidate, chunkMap);
  return {
    mode: 'model',
    mainArgument: String(verified.mainArgument || ''),
    keyPoints: Array.isArray(verified.keyPoints) ? verified.keyPoints : [],
    importantTerms: Array.isArray(verified.importantTerms) ? verified.importantTerms : [],
    evidence: Array.isArray(verified.evidence) ? verified.evidence : [],
    conflicts: Array.isArray(verified.conflicts) ? verified.conflicts : [],
    openQuestions: Array.isArray(verified.openQuestions) ? verified.openQuestions.map(String) : [],
    warnings: collectWarnings(safeSources, verified.warnings || [])
  };
}

export function buildSourceConversationDigest({ sources = [], sourceDigest = null } = {}) {
  const sourceNames = (Array.isArray(sources) ? sources : [])
    .map(source => String(source?.name || '').trim())
    .filter(Boolean)
    .slice(0, 10);
  if (sourceDigest && typeof sourceDigest === 'object' && (sourceDigest.mainArgument || sourceDigest.digestText || Array.isArray(sourceDigest.keyPoints))) {
    return {
      ...sourceDigest,
      sourceNames: Array.isArray(sourceDigest.sourceNames) && sourceDigest.sourceNames.length
        ? sourceDigest.sourceNames.slice(0, 10)
        : sourceNames
    };
  }
  const keyPoints = [];
  const evidence = [];
  const openQuestions = [];
  const importantTerms = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const digest = source?.digest;
    if (!digest || typeof digest !== 'object') continue;
    const chunks = Array.isArray(source?.chunks) ? source.chunks : [];
    for (const point of Array.isArray(digest.keyPoints) ? digest.keyPoints : []) {
      const evidenceText = String(point?.evidence || point?.text || '').trim();
      if (!evidenceText) continue;
      const chunk = chunks.find(item => String(item?.text || '').includes(evidenceText));
      const item = {
        text: String(point?.text || evidenceText).trim(),
        evidence: evidenceText,
        chunkIds: chunk?.id ? [chunk.id] : []
      };
      keyPoints.push(item);
      if (item.chunkIds.length) evidence.push({ claim: evidenceText, chunkIds: item.chunkIds });
      if (keyPoints.length >= 8) break;
    }
    openQuestions.push(...(Array.isArray(digest.openQuestions) ? digest.openQuestions.map(String).filter(Boolean) : []));
    if (keyPoints.length >= 8) break;
  }
  const firstDigest = (Array.isArray(sources) ? sources : []).map(source => source?.digest).find(digest => digest && typeof digest === 'object');
  return {
    mode: 'source_gist',
    mainArgument: String(firstDigest?.mainArgument || firstDigest?.digestText || keyPoints[0]?.text || '').trim(),
    sourceNames,
    keyPoints,
    importantTerms: importantTerms.slice(0, 12),
    evidence: evidence.slice(0, 8),
    conflicts: [],
    openQuestions: openQuestions.slice(0, 5),
    warnings: collectWarnings(Array.isArray(sources) ? sources : [])
  };
}

export async function retrieveSourceChunks({ sessionId, query, limit = 10, store, session }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 10);
  const safeQuery = String(query || '').trim();
  if (!safeQuery) return [];
  if (store && typeof store.retrieveSourceChunks === 'function') {
    const rows = await store.retrieveSourceChunks(sessionId, safeQuery, Math.max(25, safeLimit * 5));
    return finalizeRetrievedChunks(safeQuery, Array.isArray(rows) ? rows : [], safeLimit);
  }
  const activeSession = session || store?.get?.(sessionId);
  if (!activeSession) throw new HttpError(404, 'Session not found.', 'SESSION_NOT_FOUND');
  const candidates = (Array.isArray(activeSession.sources) ? activeSession.sources : [])
    .flatMap(source => (Array.isArray(source?.chunks) ? source.chunks : []).map(chunk => ({
      ...chunk,
      sourceName: source.name
    })))
  return finalizeRetrievedChunks(safeQuery, candidates, safeLimit);
}

export function getDigestStatus(sessionId, store) {
  if (!store?.get) throw new HttpError(500, 'Digest status store is not configured.', 'DIGEST_STORE_REQUIRED');
  const session = store.get(sessionId);
  if (!session) throw new HttpError(404, 'Session not found.', 'SESSION_NOT_FOUND');
  const warnings = session.digestStatus === 'queued'
    ? collectWarnings(session.sources || [], session.digestWarnings || [])
    : (session.digestWarnings || []);
  return {
    status: session.digestStatus || 'queued',
    warnings,
    digest: session.sourceDigest || null,
    error: session.digestError || null
  };
}
