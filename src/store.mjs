import crypto from 'node:crypto';
import { getRetentionConfig, getSessionBudgetConfig, maxQuestionsForSourceMode } from './config.mjs';

const SOURCE_STATUSES = new Set(['uploaded', 'extracting', 'digesting', 'ready', 'failed']);

function normalizeExtractionMethod(source) {
  const explicit = String(source?.metrics?.extractionMethod || source?.metadata?.extractionMethod || '').trim();
  if (explicit) return explicit;
  const mimeType = String(source?.mimeType || '').toLowerCase();
  if (mimeType === 'application/pdf') return 'node-fallback';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx-text';
  return 'text-direct';
}

export function deriveSourceMetrics(source) {
  const text = String(source?.text || '');
  const metadata = source?.metadata || {};
  return {
    bytes: Number.isInteger(source?.byteCount) ? source.byteCount : Buffer.byteLength(text, 'utf8'),
    words: Number.isInteger(source?.wordCount) ? source.wordCount : (text.match(/\S+/g) || []).length,
    pages: Number.isInteger(source?.pageCount) ? source.pageCount : null,
    chunkCount: Array.isArray(source?.chunks) ? source.chunks.length : Number(source?.metrics?.chunkCount || 0),
    tableCount: Number(metadata.tableCount || source?.metrics?.tableCount || 0),
    figureCount: Number(metadata.figureCount || source?.metrics?.figureCount || 0),
    captionCount: Number(metadata.captionCount || source?.metrics?.captionCount || 0),
    extractionMethod: normalizeExtractionMethod(source)
  };
}

export function sourceReadyForGroundedAnswers(source, sessionDigestStatus = null) {
  return sessionDigestStatus === 'ready' && source?.status === 'ready';
}

export function deriveSourceDigestStatus(source, sessionDigestStatus = null) {
  if (source?.status === 'failed' || sessionDigestStatus === 'failed') return 'failed';
  if (sourceReadyForGroundedAnswers(source, sessionDigestStatus)) return 'ready';
  return sessionDigestStatus === 'queued' ? 'queued' : 'processing';
}

export function ensureSourceContract(source, sessionDigestStatus = null) {
  if (!source || typeof source !== 'object') return source;
  const hasDigestMaterial = Boolean(source.digest || (Array.isArray(source.chunks) && source.chunks.length));
  const fallbackStatus = sourceReadyForGroundedAnswers(source, sessionDigestStatus)
    ? 'ready'
    : source?.status === 'failed' || sessionDigestStatus === 'failed'
      ? 'failed'
      : hasDigestMaterial || ['queued', 'processing'].includes(sessionDigestStatus)
        ? 'digesting'
        : 'uploaded';
  source.status = SOURCE_STATUSES.has(source.status) ? source.status : fallbackStatus;
  if (!Array.isArray(source.warnings)) source.warnings = [];
  if (!Array.isArray(source.chunks)) source.chunks = [];
  source.metrics = deriveSourceMetrics(source);
  return source;
}

export function countCompletedTurns(session) {
  const typedTurns = Array.isArray(session?.turns) ? session.turns.length : 0;
  const answeredVoiceTurns = Array.isArray(session?.voiceTurns)
    ? session.voiceTurns.filter(turn => turn?.status === 'answered' && !['control', 'new_question'].includes(turn?.intent)).length
    : 0;
  return typedTurns + answeredVoiceTurns;
}

function uniqueStrings(values, limit = Infinity) {
  const seen = new Set();
  const unique = [];
  for (const value of values || []) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(text);
    if (unique.length >= limit) break;
  }
  return unique;
}

function averageScores(feedbackEntries, key) {
  if (!feedbackEntries.length) return null;
  return Math.round((feedbackEntries.reduce((sum, feedback) => sum + Number(feedback?.scores?.[key] || 0), 0) / feedbackEntries.length) * 10) / 10;
}

function voiceReplayResults(session) {
  const results = session?.voiceIdempotency instanceof Map
    ? [...session.voiceIdempotency.values()]
    : Array.isArray(session?.voiceIdempotency)
      ? session.voiceIdempotency.map(([, value]) => value)
      : [];
  return results
    .filter(result => result?.turn?.id)
    .sort((left, right) => {
      const leftSequence = Number.isInteger(left?.turn?.sequence) ? left.turn.sequence : Number.MAX_SAFE_INTEGER;
      const rightSequence = Number.isInteger(right?.turn?.sequence) ? right.turn.sequence : Number.MAX_SAFE_INTEGER;
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
      return String(left?.turn?.createdAt || '').localeCompare(String(right?.turn?.createdAt || ''));
    });
}

function practiceFeedbackEntries(session) {
  const typedFeedback = (Array.isArray(session?.turns) ? session.turns : [])
    .map(turn => turn?.feedback)
    .filter(Boolean);
  const voiceFeedback = voiceReplayResults(session)
    .filter(result => result?.countsAsAnswer !== false && result?.feedback)
    .map(result => result.feedback);
  return [...typedFeedback, ...voiceFeedback];
}

function sourceConversationTurns(session) {
  return (Array.isArray(session?.voiceTurns) ? session.voiceTurns : [])
    .filter(turn => turn?.status === 'answered' && !['control', 'new_question'].includes(turn?.intent));
}

function legacyNextPractice(session, turnCount) {
  if (session?.sourceMode === 'source') {
    return turnCount
      ? 'Ask a focused follow-up question that connects the supplied materials to a broader idea.'
      : 'Ask one focused question about the supplied materials.';
  }
  return turnCount
    ? 'Give one answer using a clear main point, one example, and a final takeaway.'
    : 'Complete one short answer and review the feedback.';
}

function digestReferenceCounts(session) {
  const counts = new Map();
  const add = sourceId => {
    if (!sourceId) return;
    counts.set(sourceId, 1);
  };
  const digest = session?.sourceDigest;
  const registerItem = item => {
    for (const sourceId of Array.isArray(item?.sourceIds) ? item.sourceIds : []) add(sourceId);
    for (const chunkId of Array.isArray(item?.chunkIds) ? item.chunkIds : []) add(String(chunkId || '').split(':chunk:')[0]);
  };
  for (const point of Array.isArray(digest?.keyPoints) ? digest.keyPoints : []) registerItem(point);
  for (const evidence of Array.isArray(digest?.evidence) ? digest.evidence : []) registerItem(evidence);
  for (const conflict of Array.isArray(digest?.conflicts) ? digest.conflicts : []) registerItem(conflict);
  for (const source of Array.isArray(session?.sources) ? session.sources : []) {
    const sourceDigest = source?.digest;
    if (sourceDigest && (sourceDigest.digestText || sourceDigest.mainArgument || (Array.isArray(sourceDigest.keyPoints) && sourceDigest.keyPoints.length))) {
      add(source.id);
    }
  }
  return counts;
}

function summarizeSourceCoverage(session, sourceTurns) {
  const digestCounts = digestReferenceCounts(session);
  return (Array.isArray(session?.sources) ? session.sources : []).map(source => {
    const citedTurns = sourceTurns.filter(turn => Array.isArray(turn?.citations) && turn.citations.some(citation => citation?.sourceId === source.id));
    const citationCount = citedTurns.reduce((count, turn) => count + turn.citations.filter(citation => citation?.sourceId === source.id).length, 0);
    const digestReferenceCount = digestCounts.get(source.id) || 0;
    const status = source.status === 'failed'
      ? 'failed'
      : citationCount > 0
        ? 'cited'
      : ['uploaded', 'extracting', 'digesting'].includes(source.status) && digestReferenceCount === 0
        ? 'processing'
        : 'available';
    const note = status === 'failed'
      ? 'Needs to be replaced or removed before grounded answers are reliable.'
      : status === 'processing'
        ? 'Still processing before grounded answers are ready.'
        : status === 'cited'
          ? `Cited in ${citedTurns.length} grounded answer${citedTurns.length === 1 ? '' : 's'}.`
          : 'Ready for source-grounded discussion.';
    return {
      sourceId: source.id,
      sourceName: source.name,
      status,
      groundedAnswerCount: citedTurns.length,
      citationCount,
      digestReferenceCount,
      note
    };
  });
}

function isSourceExcerpt(session, text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length < 24) return false;
  return (Array.isArray(session?.sources) ? session.sources : []).some(source => String(source?.text || '').replace(/\s+/g, ' ').includes(normalized));
}

function summarizePracticeLearnedConcepts(feedbackEntries) {
  const concepts = uniqueStrings(feedbackEntries.map(feedback => feedback?.academicResponse), 3);
  if (concepts.length) return concepts;
  if (!feedbackEntries.length) return [];
  return ['A strong response answers the question directly, adds a concrete example, and ends with a clear takeaway.'];
}

function summarizeSourceLearnedConcepts(session, sourceCoverage) {
  const digest = session?.sourceDigest;
  if (digest) {
    const mainArgument = String(digest.mainArgument || '').trim();
    if (mainArgument) return [mainArgument];
    const concepts = uniqueStrings(
      [...(Array.isArray(digest.keyPoints) ? digest.keyPoints.map(point => point?.text) : [])]
        .filter(Boolean),
      3
    );
    if (concepts.length) return concepts;
  }
  if (sourceCoverage.some(source => source.status === 'cited')) {
    return ['You practiced grounding your answers in the supplied materials.'];
  }
  if (sourceCoverage.length) {
    return ['You reviewed the supplied material set and prepared it for source-grounded discussion.'];
  }
  return [];
}

function summarizeSourceUnresolvedQuestions(session, sourceTurns) {
  const digest = session?.sourceDigest;
  const fromDigest = digest
    ? (Array.isArray(digest.openQuestions) ? digest.openQuestions : [])
    : [];
  const fromTurns = sourceTurns.flatMap(turn => turn?.unsupportedOrUnresolved || []);
  return uniqueStrings([...fromDigest, ...fromTurns], 3);
}

function summarizeSourceStrengths(sourceTurns) {
  const strengths = [];
  if (sourceTurns.some(turn => Array.isArray(turn?.citations) && turn.citations.length)) {
    strengths.push('Grounded answers in the supplied materials.');
  }
  if (sourceTurns.filter(turn => turn?.academicAssessment?.label === 'direct').length >= 2) {
    strengths.push('Kept answers closely aligned with the current source-backed question.');
  }
  return strengths.slice(0, 3);
}

function summarizeSourceGaps(sourceTurns) {
  const gaps = [];
  if (sourceTurns.some(turn => ['pending', 'not_in_sources', 'digest_only'].includes(turn?.sourceSupportStatus))) {
    gaps.push('Ask narrower questions that the supplied materials can answer directly.');
  }
  if (sourceTurns.some(turn => ['partial', 'off_topic'].includes(turn?.academicAssessment?.label))) {
    gaps.push('Tie each response back to the exact source-backed question before broadening the discussion.');
  }
  return gaps.slice(0, 3);
}

function summarizePracticeNextSteps(feedbackEntries, fallback) {
  const steps = uniqueStrings(feedbackEntries.map(feedback => feedback?.improvement), 3);
  return steps.length ? steps : [fallback];
}

function summarizeSourceNextSteps(session, sourceTurns, unresolvedQuestions, fallback) {
  const suggestions = uniqueStrings(sourceTurns.flatMap(turn => turn?.suggestions || []), 3);
  if (suggestions.length) return suggestions;
  if (unresolvedQuestions.length) return ['Pick one unresolved question and answer it with a specific source-backed claim.'];
  if (Array.isArray(session?.sources) && session.sources.length) return [fallback];
  return [];
}

export function buildSessionSummary(session) {
  ensureSessionCollections(session);
  const turnCount = countCompletedTurns(session);
  const feedbackEntries = practiceFeedbackEntries(session);
  const sourceTurns = sourceConversationTurns(session);
  const sourceCoverage = summarizeSourceCoverage(session, sourceTurns);
  const recurringStrengths = session.sourceMode === 'source'
    ? summarizeSourceStrengths(sourceTurns)
    : uniqueStrings(feedbackEntries.flatMap(feedback => feedback?.strengths || []), 3);
  const recurringGaps = session.sourceMode === 'source'
    ? summarizeSourceGaps(sourceTurns)
    : uniqueStrings(feedbackEntries.map(feedback => feedback?.improvement), 3);
  const unresolvedQuestions = session.sourceMode === 'source'
    ? summarizeSourceUnresolvedQuestions(session, sourceTurns)
    : [];
  const fallbackNextPractice = legacyNextPractice(session, turnCount);
  const nextSteps = session.sourceMode === 'source'
    ? summarizeSourceNextSteps(session, sourceTurns, unresolvedQuestions, fallbackNextPractice)
    : summarizePracticeNextSteps(feedbackEntries, fallbackNextPractice);
  return {
    completedTurns: turnCount,
    turnCount,
    overallScores: Object.fromEntries(['clarity', 'relevance', 'structure', 'completeness', 'specificity'].map(key => [key, averageScores(feedbackEntries, key)])),
    learnedConcepts: session.sourceMode === 'source'
      ? summarizeSourceLearnedConcepts(session, sourceCoverage)
      : summarizePracticeLearnedConcepts(feedbackEntries),
    unresolvedQuestions,
    sourceCoverage,
    recurringStrengths,
    recurringGaps,
    nextSteps,
    sourceCount: Array.isArray(session?.sources) ? session.sources.length : 0,
    sourceNames: (Array.isArray(session?.sources) ? session.sources : []).map(source => source.name),
    nextPractice: nextSteps[0] || fallbackNextPractice
  };
}

export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class InMemoryStore {
  constructor({
    sessionTtlMs = getRetentionConfig().sessionTtlMs,
    shortExpiryMs = getRetentionConfig().shortExpiryMs,
    defaultRetentionMode = getRetentionConfig().defaultMode,
    turnBudget = getSessionBudgetConfig().turnBudget,
    modelTokenBudget = getSessionBudgetConfig().modelTokenBudget
  } = {}) {
    this.sessionTtlMs = sessionTtlMs;
    this.shortExpiryMs = shortExpiryMs;
    this.defaultRetentionMode = defaultRetentionMode;
    this.turnBudget = turnBudget;
    this.modelTokenBudget = modelTokenBudget;
    this.sessions = new Map();
  }

  createSession(input) {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const retentionMode = normalizeRetentionMode(input.retentionMode, this.defaultRetentionMode);
    const sourceMode = input.sourceMode || 'none';
    const maxQuestions = maxQuestionsForSourceMode(sourceMode);
    const defaultTurnBudget = sourceMode === 'source' ? Math.max(this.turnBudget, maxQuestions) : this.turnBudget;
    const sourceDefaults = sourceMode === 'source';
    const session = {
      id,
      topic: input.topic,
      goal: input.goal || (sourceDefaults ? 'structure' : 'clarity'),
      difficulty: input.difficulty || (sourceDefaults ? 'intermediate' : 'beginner'),
      feedbackStyle: input.feedbackStyle || (sourceDefaults ? 'socratic' : 'supportive'),
      questionLimit: Math.min(Math.max(Number(input.questionLimit) || maxQuestions, 1), maxQuestions),
      sourceMode,
      skillId: input.skillId || (sourceMode === 'source' ? 'auto' : 'none'),
      activeSkillId: input.activeSkillId || 'none',
      conversationSkillId: input.conversationSkillId || (sourceMode === 'source' ? 'academic-conversation' : 'none'),
      skillSelectionReason: input.skillSelectionReason || 'No source-review skill selected.',
      status: 'active',
      currentQuestion: '',
      turns: [],
      sources: [],
      sourceDigest: null,
      digestStatus: null,
      digestWarnings: [],
      digestError: null,
      researchConsent: null,
      idempotency: new Map(),
      voiceTurns: [],
      voiceIdempotency: new Map(),
      retentionMode,
      audioStorage: 'never',
      turnBudget: normalizePositiveInteger(input.turnBudget, defaultTurnBudget),
      modelTokenBudget: normalizePositiveInteger(input.modelTokenBudget, this.modelTokenBudget),
      modelTokensUsed: 0,
      createdAt: new Date(now).toISOString(),
      expiresAt: computeExpiry(now, retentionMode, { sessionTtlMs: this.sessionTtlMs, shortExpiryMs: this.shortExpiryMs }),
      capabilityToken: token
    };
    this.sessions.set(id, session);
    return { session: this.publicSession(session), token };
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    ensureSessionCollections(session);
    return session;
  }

  authorize(id, token) {
    const session = this.get(id);
    return Boolean(session && token && session.capabilityToken === token && (session.expiresAt === null || session.expiresAt > Date.now()));
  }

  requireAuthorized(id, token) {
    const session = this.get(id);
    if (!session) throw new HttpError(404, 'Session not found.', 'SESSION_NOT_FOUND');
    if (session.expiresAt !== null && session.expiresAt <= Date.now()) throw new HttpError(410, 'This session has expired.', 'SESSION_EXPIRED');
    if (!this.authorize(id, token)) throw new HttpError(401, 'Session authorization is invalid.', 'UNAUTHORIZED');
    return session;
  }

  publicSession(session) {
    return {
      id: session.id,
      topic: session.topic,
      goal: session.goal,
      difficulty: session.difficulty,
      feedbackStyle: session.feedbackStyle,
      questionLimit: session.questionLimit,
      sourceMode: session.sourceMode,
      skillId: session.skillId || (session.sourceMode === 'source' ? 'auto' : 'none'),
      activeSkillId: session.activeSkillId || 'none',
      conversationSkillId: session.conversationSkillId || (session.sourceMode === 'source' ? 'academic-conversation' : 'none'),
      skillSelectionReason: session.skillSelectionReason || 'No source-review skill selected.',
      status: session.status,
      currentQuestion: session.currentQuestion,
      turnCount: countCompletedTurns(session),
      sourceCount: session.sources.length,
      retentionMode: session.retentionMode,
      audioStorage: session.audioStorage || 'never',
      turnBudget: session.turnBudget,
      modelTokenBudget: session.modelTokenBudget,
      modelTokensUsed: session.modelTokensUsed || 0,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt === null ? null : new Date(session.expiresAt).toISOString()
    };
  }

  delete(id) {
    return this.deleteSession(id);
  }

  deleteSession(id) {
    return this.sessions.delete(id);
  }

  save(_session) {
    // The in-memory adapter already holds the live session object.
    ensureSessionCollections(_session);
  }

  getVoiceTurnReplay(session, idempotencyKey) {
    ensureSessionCollections(session);
    return session.voiceIdempotency.get(idempotencyKey) || null;
  }

  recordVoiceTurnResult(session, idempotencyKey, result) {
    ensureSessionCollections(session);
    const existing = this.getVoiceTurnReplay(session, idempotencyKey);
    if (existing) return existing;
    if (result?.turn && !session.voiceTurns.some(turn => turn.id === result.turn.id)) {
      session.voiceTurns.push(result.turn);
    }
    session.voiceIdempotency.set(idempotencyKey, result);
    this.save(session);
    return result;
  }

  cleanupExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt !== null && session.expiresAt <= now) {
        this.deleteSession(id);
        removed += 1;
      }
    }
    return removed;
  }

  searchSources(id, _query, limit = 5) {
    const sources = this.get(id)?.sources || [];
    const tokens = String(_query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    if (!tokens.length) return [];
    const ranked = sources.map(source => {
      const content = source.text.toLowerCase();
      return { source, score: tokens.filter(token => content.includes(token)).length };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit).map(item => item.source);
  }

  getDigestStatus(id) {
    const session = this.get(id);
    if (!session) return null;
    return {
      status: session.digestStatus || 'queued',
      warnings: session.digestWarnings || [],
      digest: session.sourceDigest || null,
      error: session.digestError || null
    };
  }

  sessionSummary(session) {
    return buildSessionSummary(session);
  }
}

function ensureSessionCollections(session) {
  if (!Array.isArray(session.turns)) session.turns = [];
  if (!Array.isArray(session.sources)) session.sources = [];
  if (!Array.isArray(session.digestWarnings)) session.digestWarnings = [];
  if (!('sourceDigest' in session)) session.sourceDigest = null;
  if (!('digestStatus' in session)) session.digestStatus = null;
  if (!('digestError' in session)) session.digestError = null;
  if (!('researchConsent' in session)) session.researchConsent = null;
  if (!('retentionMode' in session)) session.retentionMode = 'session';
  if (!('audioStorage' in session)) session.audioStorage = 'never';
  if (!('skillId' in session)) session.skillId = session.sourceMode === 'source' ? 'auto' : 'none';
  if (!('activeSkillId' in session)) session.activeSkillId = 'none';
  if (!('conversationSkillId' in session)) session.conversationSkillId = session.sourceMode === 'source' ? 'academic-conversation' : 'none';
  if (!('skillSelectionReason' in session)) session.skillSelectionReason = 'No source-review skill selected.';
  if (!('turnBudget' in session)) session.turnBudget = getSessionBudgetConfig().turnBudget;
  if (!('modelTokenBudget' in session)) session.modelTokenBudget = getSessionBudgetConfig().modelTokenBudget;
  if (!('modelTokensUsed' in session)) session.modelTokensUsed = 0;
  for (const source of session.sources) {
    ensureSourceContract(source, session.digestStatus);
  }
  if (!(session.idempotency instanceof Map)) session.idempotency = new Map(session.idempotency || []);
  if (!Array.isArray(session.voiceTurns)) session.voiceTurns = [];
  if (!(session.voiceIdempotency instanceof Map)) session.voiceIdempotency = new Map(session.voiceIdempotency || []);
  return session;
}

function normalizeRetentionMode(value, fallback = 'session') {
  return ['session', 'until_deleted', 'short_expiry'].includes(value) ? value : fallback;
}

function computeExpiry(now, retentionMode, { sessionTtlMs, shortExpiryMs }) {
  if (retentionMode === 'until_deleted') return null;
  if (retentionMode === 'short_expiry') return now + shortExpiryMs;
  return now + sessionTtlMs;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
