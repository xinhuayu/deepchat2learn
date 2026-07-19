import crypto from 'node:crypto';
import { HttpError } from './store.mjs';
import { retrieveSourceChunks } from './sourceKnowledge.mjs';
import { validateAnswerEvidence } from './evidence.mjs';

const INPUT_MODES = new Set(['voice', 'typed']);
const KNOWLEDGE_LAYERS = new Set(['source', 'llm', 'external']);
const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high']);
const CONTROL_TRANSCRIPTS = new Set(['stop', 'pause', 'repeat', 'skip', 'continue']);
const SUPPORTED_INTENTS = new Set(['coaching', 'source_question', 'source_answer', 'general_question', 'control', 'new_question']);

function recordLifecycle(recorder, event) {
  try { recorder?.record?.(event); } catch { /* optional diagnostics must never affect voice behavior */ }
}

export const VOICE_SESSION_STATES = new Set([
  'idle',
  'permission_pending',
  'connecting',
  'speaking_question',
  'listening',
  'finalizing_transcript',
  'reviewing_transcript',
  'retrieving',
  'composing_answer',
  'speaking_answer',
  'awaiting_user',
  'paused',
  'error',
  'completed'
]);

const VALID_STATE_TRANSITIONS = new Map([
  ['idle', new Set(['idle', 'permission_pending'])],
  ['permission_pending', new Set(['permission_pending', 'connecting', 'idle', 'error'])],
  ['connecting', new Set(['connecting', 'speaking_question', 'listening', 'error', 'idle'])],
  ['speaking_question', new Set(['speaking_question', 'listening', 'finalizing_transcript', 'paused', 'error'])],
  ['listening', new Set(['listening', 'finalizing_transcript', 'paused', 'error', 'awaiting_user'])],
  ['finalizing_transcript', new Set(['finalizing_transcript', 'reviewing_transcript', 'retrieving', 'error'])],
  ['reviewing_transcript', new Set(['reviewing_transcript', 'retrieving', 'awaiting_user', 'error'])],
  ['retrieving', new Set(['retrieving', 'composing_answer', 'awaiting_user', 'error'])],
  ['composing_answer', new Set(['composing_answer', 'speaking_answer', 'awaiting_user', 'error'])],
  ['speaking_answer', new Set(['speaking_answer', 'awaiting_user', 'listening', 'paused', 'error', 'completed'])],
  ['awaiting_user', new Set(['awaiting_user', 'listening', 'reviewing_transcript', 'retrieving', 'paused', 'completed', 'error'])],
  ['paused', new Set(['paused', 'listening', 'awaiting_user', 'completed', 'error'])],
  ['error', new Set(['error', 'idle', 'permission_pending', 'paused', 'completed'])],
  ['completed', new Set(['completed', 'idle'])]
]);

export function createVoiceTurn({
  sessionId,
  inputMode,
  transcript,
  transcriptConfidence,
  transcriptReviewed,
  idempotencyKey,
  id = crypto.randomUUID(),
  sequence = null,
  intent,
  createdAt = new Date().toISOString()
} = {}) {
  const normalizedSessionId = requireNonEmptyString(sessionId, 'sessionId');
  const normalizedInputMode = normalizeInputMode(inputMode);
  const normalizedTranscript = requireNonEmptyString(transcript, 'transcript');

  return {
    id,
    sessionId: normalizedSessionId,
    sequence: Number.isInteger(sequence) ? sequence : null,
    inputMode: normalizedInputMode,
    transcript: normalizedTranscript,
    transcriptConfidence: normalizeConfidenceScore(transcriptConfidence),
    transcriptReviewed: Boolean(transcriptReviewed),
    intent: intent || inferIntent(normalizedTranscript),
    status: 'pending',
    answerText: null,
    answerSpeechText: null,
    knowledgeLayers: [],
    citations: [],
    externalCitations: [],
    discussionPoints: [],
    suggestions: [],
    unsupportedOrUnresolved: [],
    conflicts: [],
    confidence: null,
    followUp: null,
    sourceSupportStatus: 'not_applicable',
    externalKnowledgeStatus: 'not_requested',
    idempotencyKey: normalizeOptionalString(idempotencyKey),
    createdAt,
    answeredAt: null
  };
}

export function approveVoiceAnswer(turn, {
  answerText,
  answerSpeechText,
  knowledgeLayers,
  citations,
  sourceClaims = [],
  externalClaims = [],
  externalCitations,
  discussionPoints = [],
  suggestions = [],
  unsupportedOrUnresolved = [],
  conflicts = [],
  academicAssessment = null,
  confidence,
  followUp,
  sourceSupportStatus = 'not_applicable',
  externalKnowledgeStatus = 'not_requested'
}, {
  retrievedChunks = [],
  availableExternalCitations = []
} = {}) {
  if (!turn || turn.status !== 'pending') {
    throw new TypeError('Only pending voice turns can be approved.');
  }

  if (Array.isArray(retrievedChunks) && retrievedChunks.length) {
    const validation = validateAnswerEvidence({
      citations: Array.isArray(citations) ? citations : [],
      sourceClaims: Array.isArray(sourceClaims) ? sourceClaims : [],
      externalClaims: Array.isArray(externalClaims) ? externalClaims : []
    }, retrievedChunks, availableExternalCitations);
    if (!validation.valid) {
      throw new TypeError(validation.errors[0] || 'Source grounding could not be validated.');
    }
  }

  const normalizedKnowledgeLayers = normalizeKnowledgeLayers(knowledgeLayers);
  const normalizedCitations = normalizeCitations(citations);
  const normalizedExternalCitations = normalizeExternalCitations(externalCitations);

  if (normalizedKnowledgeLayers.includes('source') && normalizedCitations.length === 0) {
    throw new TypeError('Source-backed voice answers require at least one citation.');
  }
  if (normalizedKnowledgeLayers.includes('external') && normalizedExternalCitations.length === 0) {
    throw new TypeError('External-research voice answers require at least one external citation.');
  }

  return {
    ...turn,
    status: 'answered',
    answerText: requireNonEmptyString(answerText, 'answerText'),
    answerSpeechText: requireNonEmptyString(answerSpeechText, 'answerSpeechText'),
    knowledgeLayers: normalizedKnowledgeLayers,
    citations: normalizedCitations,
    externalCitations: normalizedExternalCitations,
    discussionPoints: normalizeStringList(discussionPoints, 3),
    suggestions: normalizeStringList(suggestions, 3),
    unsupportedOrUnresolved: normalizeStringList(unsupportedOrUnresolved, 3),
    conflicts: normalizeConflictList(conflicts, 3),
    ...(academicAssessment ? { academicAssessment: normalizeAcademicAssessment(academicAssessment) } : {}),
    confidence: normalizeAnswerConfidence(confidence),
    followUp: normalizeOptionalString(followUp),
    sourceSupportStatus: normalizeSourceSupportStatus(sourceSupportStatus),
    externalKnowledgeStatus: normalizeExternalKnowledgeStatus(externalKnowledgeStatus),
    answeredAt: new Date().toISOString()
  };
}

export function validateVoiceState(previous, next) {
  if (!VOICE_SESSION_STATES.has(previous) || !VOICE_SESSION_STATES.has(next)) {
    return false;
  }
  return VALID_STATE_TRANSITIONS.get(previous)?.has(next) || false;
}

export async function answerVoiceTurn({
  session,
  transcript,
  transcriptConfidence,
  transcriptReviewed,
  idempotencyKey,
  externalResearch,
  store = null,
  coach = null,
  skillRegistry = null,
  inputMode = 'voice',
  intentHint = null,
  lifecycleRecorder = null
} = {}) {
  if (!session || typeof session !== 'object') {
    throw new TypeError('session is required.');
  }

  const normalizedIdempotencyKey = normalizeOptionalString(idempotencyKey);
  if (normalizedIdempotencyKey && store?.getVoiceTurnReplay) {
    const replay = store.getVoiceTurnReplay(session, normalizedIdempotencyKey);
    if (replay) return replay;
  }

  const turn = createVoiceTurn({
    sessionId: session.id,
    inputMode,
    transcript,
    transcriptConfidence,
    transcriptReviewed,
    idempotencyKey: normalizedIdempotencyKey,
    sequence: Array.isArray(session.voiceTurns) ? session.voiceTurns.length : 0,
    intent: detectVoiceIntent({ session, transcript, intentHint })
  });

  recordLifecycle(lifecycleRecorder, {
    event: 'voice.submitted',
    sessionId: session.id,
    mode: session.sourceMode === 'source' ? 'source' : 'practice',
    status: turn.intent,
    sourceCount: Array.isArray(session.sources) ? session.sources.length : 0,
    transcriptLength: turn.transcript.length
  });
  const complete = result => {
    recordLifecycle(lifecycleRecorder, {
      event: 'response.completed',
      sessionId: session.id,
      mode: session.sourceMode === 'source' ? 'source' : 'practice',
      status: result?.nextState || 'completed',
      sourceCount: Array.isArray(session.sources) ? session.sources.length : 0,
      transcriptLength: turn.transcript.length
    });
    return result;
  };

  try {
    if (turn.intent === 'control') {
      const controlResult = buildControlResult(turn);
      return complete(persistVoiceTurnResult({ session, store, idempotencyKey: normalizedIdempotencyKey, result: controlResult }));
    }

    if (turn.intent === 'new_question') {
      const newQuestionResult = await buildNewQuestionResult({ turn, session, coach, skillRegistry });
      return complete(persistVoiceTurnResult({ session, store, idempotencyKey: normalizedIdempotencyKey, result: newQuestionResult }));
    }

    if (turn.intent === 'coaching') {
      const coachingResult = await buildCoachingResult({ turn, session, coach, skillProfile: getConversationSkill(skillRegistry, session) });
      return complete(persistVoiceTurnResult({ session, store, idempotencyKey: normalizedIdempotencyKey, result: coachingResult }));
    }

    const researchContext = normalizeExternalResearch(externalResearch);
    const sourceTurn = turn.intent === 'source_question' || turn.intent === 'source_answer';
    const retrievedChunks = sourceTurn
      ? await retrieveSourceChunks({ sessionId: session.id, query: `${session.currentQuestion || ''} ${turn.transcript}`, limit: 10, store, session })
      : [];

    const result = sourceTurn
      ? await buildSourceAnswerResult({ turn, session, store, coach, retrievedChunks, researchContext, skillProfile: getConversationSkill(skillRegistry, session) })
      : await buildGeneralAnswerResult({ turn, session, coach, researchContext });

    return complete(persistVoiceTurnResult({ session, store, idempotencyKey: normalizedIdempotencyKey, result }));
  } catch (error) {
    recordLifecycle(lifecycleRecorder, {
      event: 'response.failed',
      sessionId: session.id,
      mode: session.sourceMode === 'source' ? 'source' : 'practice',
      status: 'failed',
      sourceCount: Array.isArray(session.sources) ? session.sources.length : 0,
      transcriptLength: turn.transcript.length,
      errorCode: error?.code || 'VOICE_RESPONSE_FAILED'
    });
    throw error;
  }
}

function inferIntent(transcript) {
  return CONTROL_TRANSCRIPTS.has(transcript.toLowerCase()) ? 'control' : 'general_question';
}

function detectVoiceIntent({ session, transcript, intentHint }) {
  const hinted = normalizeOptionalString(intentHint);
  if (hinted && SUPPORTED_INTENTS.has(hinted)) return hinted;

  const normalizedTranscript = requireNonEmptyString(transcript, 'transcript');
  if (CONTROL_TRANSCRIPTS.has(normalizedTranscript.toLowerCase())) return 'control';
  if (looksLikeNewQuestionRequest(normalizedTranscript)) return 'new_question';

  if (session?.sourceMode === 'source' && Array.isArray(session?.sources) && session.sources.length) {
    if (looksLikeQuestion(normalizedTranscript)) return 'source_question';
    if (session.currentQuestion) return 'source_answer';
    return 'source_question';
  }
  if (Array.isArray(session?.sources) && session.sources.length && looksLikeSourceQuestion(normalizedTranscript)) return 'source_question';
  if (looksLikeCoachingTurn({ session, transcript: normalizedTranscript })) return 'coaching';
  return 'general_question';
}

function looksLikeNewQuestionRequest(transcript) {
  const value = String(transcript || '').toLowerCase().replace(/[.!?,]/g, ' ').replace(/\s+/g, ' ').trim();
  return /\b(?:new question|ask (?:me )?something new|another issue|different question|different topic|new topic|something else|move on|move to another question|change the topic)\b/.test(value);
}

function looksLikeQuestion(transcript) {
  const value = String(transcript || '').trim();
  if (/[?]$/.test(value)) return true;
  return /^(?:what|why|how|when|where|who|which|can|could|would|is|are|do|does|did|please|explain|tell me)\b/i.test(value);
}

function pendingSourceProcessingMessage(session) {
  if (!session?.sources?.length) return '';
  if (session.digestStatus === 'failed') return 'One or more materials failed to finish processing, so grounded answers may be incomplete.';
  if (session.digestStatus === 'queued' || session.digestStatus === 'processing' || session.sources.some(source => ['uploaded', 'extracting', 'digesting'].includes(source?.status))) {
    return 'Your materials are still processing, so grounded answers are not ready yet. You can keep chatting while the digest finishes.';
  }
  return '';
}

function normalizeInputMode(inputMode) {
  const normalized = normalizeOptionalString(inputMode);
  if (!INPUT_MODES.has(normalized)) {
    throw new TypeError('inputMode must be "voice" or "typed".');
  }
  return normalized;
}

async function buildSourceAnswerResult({ turn, session, store, coach, retrievedChunks, researchContext, skillProfile }) {
  const readinessMessage = pendingSourceProcessingMessage(session);
  if (readinessMessage) {
    const raw = typeof coach?.generalAnswer === 'function'
      ? await coach.generalAnswer(turn.transcript)
      : {
        mode: 'general',
        answer: 'I can still help with the topic in general terms while your materials finish processing.',
        additionalContext: [],
        unsupportedOrUnresolved: [],
        confidence: 'low'
      };
    const generalAnswer = requireNonEmptyString(raw.answer, 'answerText');
    const approved = approveVoiceAnswer(turn, {
      answerText: `${readinessMessage} ${generalAnswer}`.trim(),
      answerSpeechText: `${readinessMessage} ${generalAnswer}`.trim(),
      knowledgeLayers: ['llm'],
      citations: [],
      sourceClaims: [],
      externalClaims: [],
      externalCitations: [],
      unsupportedOrUnresolved: [readinessMessage],
      confidence: 'low',
      followUp: '',
      sourceSupportStatus: 'pending',
      externalKnowledgeStatus: 'not_requested'
    });
    const response = buildAnsweredResponse(approved, {
      nextState: 'speaking_answer',
      requiresExternalConsent: false,
      sourceDigestStatus: readinessMessage,
      ingestionWarnings: session.sources.flatMap(source => Array.isArray(source?.warnings) ? source.warnings : []),
      legacyAnswer: {
        mode: 'general',
        answer: approved.answerText,
        sourceGroundedClaims: [],
        additionalContext: [{ claim: 'This answer uses general discussion while your materials finish processing.', label: 'Additional context' }],
        unsupportedOrUnresolved: []
      }
    });
    session.voiceState = response.nextState;
    return response;
  }
  const conversationHistory = buildConversationHistory(session);
  const raw = typeof coach?.composeBlendedAnswer === 'function'
    ? await coach.composeBlendedAnswer({
      userQuestion: turn.transcript,
      currentQuestion: session.currentQuestion || null,
      turnRole: turn.intent === 'source_answer' ? 'answer_to_ai' : 'user_question',
      sourceDigest: session.sourceDigest || null,
      retrievedChunks,
      conversationHistory,
      skillProfile,
      generalKnowledgeAllowed: true,
      externalResearchResult: researchContext.approved
        ? { status: 'approved', results: researchContext.results }
        : { status: researchContext.requiresExternalConsent ? 'consent_required' : 'not_requested', results: [] }
    })
    : await buildFallbackSourceAnswer({ turn, session, store, coach, retrievedChunks, skillProfile });

  const normalized = normalizeBlendedResult(raw, { retrievedChunks, researchContext, generalKnowledgeAllowed: true });
  const approved = approveVoiceAnswer(turn, {
    ...normalized,
    answerSpeechText: buildSourceSpeechText(normalized)
  }, {
    retrievedChunks,
    availableExternalCitations: researchContext.results
  });
  const response = buildAnsweredResponse(approved, {
    nextState: 'speaking_answer',
    requiresExternalConsent: researchContext.requiresExternalConsent,
    legacyAnswer: raw?.mode === 'source' ? raw : buildLegacySourceAnswer(approved, retrievedChunks)
  });
  session.voiceState = response.nextState;
  return response;
}

async function buildNewQuestionResult({ turn, session, coach, skillRegistry }) {
  const skillProfile = getConversationSkill(skillRegistry, session);
  const conversationHistory = buildConversationHistory(session);
  let nextQuestion;
  if (typeof coach?.nextQuestion === 'function') {
      nextQuestion = await coach.nextQuestion({
        topic: session.topic,
        previousQuestion: session.currentQuestion,
        conversationHistory,
        conversationTurnCount: countConversationTurns(session),
        sources: session.sources || [],
      sourceDigest: session.sourceDigest || null,
      skillProfile
    });
  } else if (session.sourceMode === 'source' && typeof coach?.sourceQuestion === 'function') {
    nextQuestion = await coach.sourceQuestion({ topic: session.topic, sources: session.sources || [], sourceDigest: session.sourceDigest || null, conversationHistory, conversationTurnCount: countConversationTurns(session), skillProfile });
  } else if (typeof coach?.initialQuestion === 'function') {
    nextQuestion = await coach.initialQuestion({ topic: session.topic, skillProfile });
  }
  const normalizedQuestion = requireNonEmptyString(nextQuestion, 'nextQuestion');
  session.currentQuestion = normalizedQuestion;
  const answered = approveVoiceAnswer(turn, {
    answerText: 'Let us move to a new question.',
    answerSpeechText: `Let us move to a new question. ${normalizedQuestion}`,
    knowledgeLayers: ['llm'],
    citations: [],
    externalCitations: [],
    confidence: 'high',
    followUp: normalizedQuestion
  });
  session.voiceState = 'speaking_answer';
  return buildAnsweredResponse(answered, {
    nextState: 'speaking_answer',
    countsAsAnswer: false,
    newQuestion: true,
    requiresExternalConsent: false,
    legacyAnswer: null
  });
}

async function buildGeneralAnswerResult({ turn, session, coach, researchContext }) {
  const raw = typeof coach?.generalAnswer === 'function'
    ? await coach.generalAnswer(turn.transcript)
    : {
      mode: 'general',
      answer: `Here is a starting point for “${turn.transcript}”.`,
      sourceGroundedClaims: [],
      additionalContext: [],
      unsupportedOrUnresolved: [],
      confidence: 'medium'
    };
  const approved = approveVoiceAnswer(turn, {
    answerText: requireNonEmptyString(raw.answer, 'answerText'),
    answerSpeechText: requireNonEmptyString(raw.answerSpeechText || raw.answer, 'answerSpeechText'),
    knowledgeLayers: researchContext.approved && researchContext.results.length ? ['llm', 'external'] : ['llm'],
    citations: [],
    sourceClaims: [],
    externalClaims: researchContext.approved && researchContext.results.length
      ? researchContext.results.map((item, index) => ({
        claim: normalizeOptionalString(item.snippet) || `External research result ${index + 1}`,
        externalCitationId: normalizeOptionalString(item.id) || normalizeOptionalString(item.url) || normalizeOptionalString(item.title)
      }))
      : [],
    externalCitations: researchContext.approved ? researchContext.results : [],
    unsupportedOrUnresolved: Array.isArray(raw.unsupportedOrUnresolved) ? raw.unsupportedOrUnresolved : [],
    confidence: normalizeGeneralConfidence(raw.confidence),
    followUp: buildFollowUp(raw),
    sourceSupportStatus: 'not_applicable',
    externalKnowledgeStatus: inferExternalKnowledgeStatus(researchContext)
  }, {
    availableExternalCitations: researchContext.results
  });
  const response = buildAnsweredResponse(approved, {
    nextState: 'speaking_answer',
    requiresExternalConsent: researchContext.requiresExternalConsent,
    legacyAnswer: {
      mode: 'general',
      answer: approved.answerText,
      sourceGroundedClaims: [],
      additionalContext: (Array.isArray(raw.additionalContext) ? raw.additionalContext : []).map(item => ({
        claim: String(item?.claim || item || ''),
        label: String(item?.label || 'Additional context')
      })).filter(item => item.claim),
      unsupportedOrUnresolved: Array.isArray(raw.unsupportedOrUnresolved) ? raw.unsupportedOrUnresolved.map(String) : [],
      confidence: approved.confidence
    }
  });
  session.voiceState = response.nextState;
  return response;
}

async function buildCoachingResult({ turn, session, coach, skillProfile }) {
  if (typeof coach?.evaluateAnswer !== 'function') {
    throw new HttpError(503, 'Coaching evaluation is not configured.', 'VOICE_COACH_UNAVAILABLE');
  }
  const feedback = await coach.evaluateAnswer({
    topic: session.topic,
    question: session.currentQuestion,
    answer: turn.transcript,
    turnIndex: Array.isArray(session.turns) ? session.turns.length : 0,
    feedbackStyle: session.feedbackStyle,
    sources: session.sources || [],
    skillProfile
  });
  const academicResponse = normalizeOptionalString(feedback.academicResponse);
  const followUp = normalizeOptionalString(feedback.nextQuestion);
  const answerText = [
    academicResponse,
    ...feedback.strengths.slice(0, 2),
    feedback.improvement,
    followUp ? `Next question: ${followUp}` : ''
  ].filter(Boolean).join(' ');
  const answerSpeechText = buildCoachingSpeechText({ academicResponse, feedback, followUp, fallback: answerText });
  const approved = approveVoiceAnswer(turn, {
    answerText,
    answerSpeechText,
    knowledgeLayers: ['llm'],
    citations: [],
    externalCitations: [],
    confidence: 'medium',
    followUp,
    sourceSupportStatus: 'not_applicable',
    externalKnowledgeStatus: 'not_requested'
  });
  const response = buildAnsweredResponse(approved, {
    nextState: 'speaking_answer',
    requiresExternalConsent: false,
    legacyAnswer: null,
    feedback
  });
  session.voiceState = response.nextState;
  return response;
}

async function buildFallbackSourceAnswer({ turn, session, store, coach, retrievedChunks, skillProfile }) {
  if (typeof coach?.groundedAnswer === 'function') {
    const sources = typeof store?.searchSources === 'function'
      ? store.searchSources(session.id, turn.transcript, 5)
      : (session.sources || []);
    return await coach.groundedAnswer({ question: turn.transcript, sources, skillProfile });
  }
  const bestChunk = retrievedChunks[0];
  const answerText = bestChunk?.text || 'I could not find enough support in your supplied materials to answer that confidently.';
  return {
    answerText,
    answerSpeechText: answerText,
    sourceClaims: bestChunk ? [{
      claim: bestChunk.text,
      chunkId: bestChunk.id,
      citationExcerpt: bestChunk.text
    }] : [],
    llmBackground: [],
    discussionPoints: [],
    suggestions: [],
    externalClaims: [],
    citations: bestChunk ? [{
      sourceId: bestChunk.sourceId,
      chunkId: bestChunk.id,
      excerpt: bestChunk.text,
      page: bestChunk.page ?? null,
      section: bestChunk.section ?? null,
      start: bestChunk.start,
      end: bestChunk.end
    }] : [],
    externalCitations: [],
    sourceSupportStatus: bestChunk ? 'supported' : 'not_in_sources',
    externalKnowledgeStatus: 'not_requested',
    confidence: bestChunk ? 'medium' : 'low',
    uncertainty: bestChunk ? [] : ['The supplied materials did not contain a sufficiently relevant passage.'],
    conflicts: [],
    followUp: bestChunk ? 'Would you like me to point to the exact passage?' : 'Would you like to ask about a passage the source mentions more directly?'
  };
}

function normalizeBlendedResult(raw, { retrievedChunks, researchContext, generalKnowledgeAllowed = true }) {
  if (raw?.mode === 'source') {
    return convertGroundedAnswerToApprovedShape(raw, retrievedChunks);
  }

  const citations = Array.isArray(raw?.citations) ? raw.citations.map(citation => {
    const chunk = retrievedChunks.find(item => item.id === citation?.chunkId);
    if (!chunk) return citation;
    const excerpt = normalizeOptionalString(citation.excerpt) || normalizeOptionalString(chunk.text);
    const bounds = excerpt && chunk.text.includes(excerpt)
      ? {
        start: chunk.start + chunk.text.indexOf(excerpt),
        end: chunk.start + chunk.text.indexOf(excerpt) + excerpt.length
      }
      : { start: chunk.start, end: chunk.end };
    return {
      sourceId: chunk.sourceId,
      chunkId: chunk.id,
      page: chunk.page ?? null,
      section: chunk.section ?? null,
      excerpt,
      start: bounds.start,
      end: bounds.end
    };
  }) : [];

  return {
    answerText: requireNonEmptyString(raw?.answerText || raw?.answer, 'answerText'),
    answerSpeechText: requireNonEmptyString(raw?.answerSpeechText || raw?.answerText || raw?.answer, 'answerSpeechText'),
    knowledgeLayers: inferKnowledgeLayers(raw, researchContext, { generalKnowledgeAllowed }),
    citations,
    externalCitations: Array.isArray(raw?.externalCitations)
      ? raw.externalCitations
      : (researchContext.approved ? researchContext.results : []),
    discussionPoints: normalizeStringList(raw?.discussionPoints, 3),
    suggestions: normalizeStringList(raw?.suggestions, 3),
    unsupportedOrUnresolved: normalizeStringList(raw?.unsupportedOrUnresolved || raw?.uncertainty, 3),
    conflicts: normalizeConflictList(raw?.conflicts, 3),
    confidence: normalizeGeneralConfidence(raw?.confidence || inferConfidence(raw)),
    academicAssessment: raw?.academicAssessment ? normalizeAcademicAssessment(raw.academicAssessment) : null,
    followUp: buildFollowUp(raw),
    sourceSupportStatus: inferSourceSupportStatus(raw, citations),
    externalKnowledgeStatus: inferExternalKnowledgeStatus(researchContext, raw)
  };
}

function convertGroundedAnswerToApprovedShape(raw, retrievedChunks) {
  const citations = (Array.isArray(raw?.sourceGroundedClaims) ? raw.sourceGroundedClaims : []).map(claim => {
    const locator = claim?.locator || null;
    const chunk = retrievedChunks.find(item => item.sourceId === claim.sourceId && item.text.includes(claim.evidence));
    const page = claim?.page ?? chunk?.page ?? null;
    const section = claim?.section ?? chunk?.section ?? null;
    const start = locator?.start ?? chunk?.start ?? 0;
    const end = locator?.end ?? chunk?.end ?? start + String(claim?.evidence || '').length;
    return {
      sourceId: claim.sourceId,
      chunkId: chunk?.id || null,
      page,
      section,
      excerpt: claim.evidence,
      start,
      end
    };
  });
  return {
    answerText: requireNonEmptyString(raw.answer, 'answerText'),
    answerSpeechText: requireNonEmptyString(raw.answer, 'answerSpeechText'),
    knowledgeLayers: ['source'],
    citations,
    externalCitations: [],
    unsupportedOrUnresolved: normalizeStringList(raw?.unsupportedOrUnresolved, 3),
    conflicts: normalizeConflictList(raw?.conflicts, 3),
    discussionPoints: normalizeStringList(raw?.discussionPoints, 3),
    suggestions: normalizeStringList(raw?.suggestions, 3),
    confidence: normalizeGeneralConfidence(raw.confidence),
    followUp: buildFollowUp(raw),
    sourceSupportStatus: 'supported',
    externalKnowledgeStatus: 'not_requested'
  };
}

function inferKnowledgeLayers(raw, researchContext, { generalKnowledgeAllowed = true } = {}) {
  const layers = [];
  if ((Array.isArray(raw?.sourceClaims) && raw.sourceClaims.length) || (Array.isArray(raw?.citations) && raw.citations.length)) layers.push('source');
  if (generalKnowledgeAllowed && Array.isArray(raw?.llmBackground) && raw.llmBackground.length) layers.push('llm');
  if ((Array.isArray(raw?.externalClaims) && raw.externalClaims.length) || (Array.isArray(raw?.externalCitations) && raw.externalCitations.length) || researchContext.approved) layers.push('external');
  if (!layers.length && generalKnowledgeAllowed) layers.push('llm');
  return layers;
}

function inferConfidence(raw) {
  if (Array.isArray(raw?.uncertainty) && raw.uncertainty.length) return 'low';
  if (Array.isArray(raw?.conflicts) && raw.conflicts.length) return 'medium';
  if (Array.isArray(raw?.citations) && raw.citations.length) return 'high';
  return 'medium';
}

function buildFollowUp(raw) {
  return normalizeOptionalString(raw?.followUp)
    || (Array.isArray(raw?.unsupportedOrUnresolved) && raw.unsupportedOrUnresolved.length
      ? 'Would you like to ask a narrower follow-up question?'
      : 'Would you like a follow-up example?');
}

function buildCoachingSpeechText({ academicResponse, feedback, followUp, fallback }) {
  const approved = normalizeOptionalString(feedback?.answerSpeechText);
  if (approved) return limitVoiceText(approved);
  const parts = [
    normalizeOptionalString(academicResponse),
    normalizeOptionalString(feedback?.improvement),
    normalizeOptionalString(followUp)
  ].filter(Boolean);
  return limitVoiceText(parts.length ? parts.join(' ') : requireNonEmptyString(fallback, 'answerSpeechText'));
}

function limitVoiceText(value, max = 600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const boundary = text.slice(0, max).lastIndexOf('.');
  return `${text.slice(0, boundary > 80 ? boundary + 1 : max).trim()}…`;
}

function normalizeStringList(value, limit = 3) {
  return (Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean).slice(0, limit);
}

function normalizeConflictList(value, limit = 3) {
  return (Array.isArray(value) ? value : []).map(item => {
    if (item && typeof item === 'object') {
      return {
        description: String(item.description || item.topic || '').trim(),
        sourceIds: Array.isArray(item.sourceIds) ? item.sourceIds.map(String).filter(Boolean).slice(0, 5) : []
      };
    }
    return {
      description: String(item || '').trim(),
      sourceIds: []
    };
  }).filter(item => item.description).slice(0, limit);
}

function normalizeAcademicAssessment(value) {
  const label = ['direct', 'partial', 'off_topic'].includes(value?.label) ? value.label : 'partial';
  return {
    label,
    rationale: String(value?.rationale || 'The response was assessed against the active question and source topic.').trim()
  };
}

function inferSourceSupportStatus(raw, citations) {
  const explicit = String(raw?.sourceSupportStatus || '').trim().toLowerCase();
  if (['supported', 'digest_only', 'not_in_sources', 'not_applicable', 'pending'].includes(explicit)) return explicit;
  if (Array.isArray(citations) && citations.length) return 'supported';
  const unsupported = normalizeStringList(raw?.unsupportedOrUnresolved || raw?.uncertainty, 3).join(' ').toLowerCase();
  const answerText = String(raw?.answerText || raw?.answer || '').toLowerCase();
  if (unsupported.includes('prepared digest') || answerText.includes('prepared source digest')) return 'digest_only';
  if (unsupported.includes('could not find enough support') || answerText.includes('could not find enough support')) return 'not_in_sources';
  return 'not_applicable';
}

function inferExternalKnowledgeStatus(researchContext, raw = null) {
  const explicit = String(raw?.externalKnowledgeStatus || '').trim().toLowerCase();
  if (['included', 'consent_required', 'not_requested', 'unavailable'].includes(explicit)) return explicit;
  if (Array.isArray(raw?.externalCitations) && raw.externalCitations.length) return 'included';
  if (researchContext?.approved && Array.isArray(researchContext?.results) && researchContext.results.length) return 'included';
  if (researchContext?.requiresExternalConsent) return 'consent_required';
  return 'not_requested';
}

function normalizeSourceSupportStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['supported', 'digest_only', 'not_in_sources', 'not_applicable', 'pending'].includes(normalized)
    ? normalized
    : 'not_applicable';
}

function normalizeExternalKnowledgeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['included', 'consent_required', 'not_requested', 'unavailable'].includes(normalized)
    ? normalized
    : 'not_requested';
}

function buildSourceSpeechText(answer) {
  const base = requireNonEmptyString(answer.answerSpeechText || answer.answerText, 'answerSpeechText');
  const followUp = normalizeOptionalString(answer.followUp);
  if (!followUp) return base;
  if (base.toLowerCase().includes(followUp.toLowerCase())) return base;
  if (base.includes('?')) return base;
  return `${base} ${followUp}`;
}

function buildAnsweredResponse(turn, extras = {}) {
  return {
    turn,
    answerText: turn.answerText,
    answerSpeechText: turn.answerSpeechText,
    knowledgeLayers: turn.knowledgeLayers,
    citations: turn.citations,
    externalCitations: turn.externalCitations,
    discussionPoints: turn.discussionPoints,
    suggestions: turn.suggestions,
    unsupportedOrUnresolved: turn.unsupportedOrUnresolved,
    conflicts: turn.conflicts,
    ...(turn.academicAssessment ? { academicAssessment: turn.academicAssessment } : {}),
    confidence: turn.confidence,
    followUp: turn.followUp,
    sourceSupportStatus: turn.sourceSupportStatus,
    externalKnowledgeStatus: turn.externalKnowledgeStatus,
    countsAsAnswer: extras.countsAsAnswer !== false,
    ...(extras.newQuestion ? { newQuestion: true } : {}),
    nextState: extras.nextState || 'speaking_answer',
    requiresExternalConsent: Boolean(extras.requiresExternalConsent),
    ...(extras.sourceDigestStatus ? { sourceDigestStatus: extras.sourceDigestStatus } : {}),
    ...(extras.ingestionWarnings ? { ingestionWarnings: extras.ingestionWarnings } : {}),
    ...(extras.feedback ? { feedback: extras.feedback } : {}),
    ...(extras.legacyAnswer ? { legacyAnswer: extras.legacyAnswer } : {})
  };
}

function getConversationSkill(skillRegistry, session) {
  return skillRegistry?.get('academic-conversation') || skillRegistry?.get(session?.conversationSkillId || session?.activeSkillId);
}

function buildLegacySourceAnswer(turn, retrievedChunks) {
  return {
    mode: 'source',
    answer: turn.answerText,
    sourceGroundedClaims: turn.citations.map(citation => {
      const chunk = retrievedChunks.find(item => item.sourceId === citation.sourceId && item.start <= citation.start && item.end >= citation.end);
      return {
        claim: citation.excerpt,
        sourceId: citation.sourceId,
        sourceName: chunk?.sourceName || null,
        page: citation.page ?? null,
        section: citation.section ?? null,
        evidence: citation.excerpt,
        locator: { type: 'character', start: citation.start, end: citation.end },
        relevanceScore: chunk?.relevanceScore ?? null
      };
    }),
    additionalContext: turn.knowledgeLayers.includes('llm') ? [{ claim: 'This answer also uses general background context.', label: 'Additional context' }] : [],
    unsupportedOrUnresolved: turn.unsupportedOrUnresolved || [],
    conflicts: turn.conflicts || [],
    confidence: turn.confidence
  };
}

function buildControlResult(turn) {
  const state = controlTranscriptState(turn.transcript);
  const answered = approveVoiceAnswer(turn, {
    answerText: `Voice control acknowledged: ${turn.transcript}.`,
    answerSpeechText: `Voice control acknowledged: ${turn.transcript}.`,
    knowledgeLayers: ['llm'],
    citations: [],
    externalCitations: [],
    confidence: 'high',
    followUp: null
  });
  return buildAnsweredResponse(answered, {
    nextState: state,
    countsAsAnswer: false,
    requiresExternalConsent: false,
    legacyAnswer: null
  });
}

function controlTranscriptState(transcript) {
  switch (String(transcript || '').trim().toLowerCase()) {
    case 'pause': return 'paused';
    case 'stop': return 'completed';
    default: return 'listening';
  }
}

function persistVoiceTurnResult({ session, store, idempotencyKey, result }) {
  if (store?.recordVoiceTurnResult && idempotencyKey) {
    return store.recordVoiceTurnResult(session, idempotencyKey, result);
  }
  if (!Array.isArray(session.voiceTurns)) session.voiceTurns = [];
  if (!session.voiceTurns.some(turn => turn.id === result.turn.id)) session.voiceTurns.push(result.turn);
  if (idempotencyKey) {
    if (!(session.voiceIdempotency instanceof Map)) session.voiceIdempotency = new Map();
    session.voiceIdempotency.set(idempotencyKey, result);
  }
  return result;
}

function normalizeExternalResearch(externalResearch) {
  const requested = Boolean(externalResearch?.requested || externalResearch?.query || (Array.isArray(externalResearch?.results) && externalResearch.results.length));
  const approved = Boolean(externalResearch?.approved || externalResearch?.consentGranted);
  return {
    requested,
    approved,
    requiresExternalConsent: requested && !approved,
    results: approved && Array.isArray(externalResearch?.results) ? externalResearch.results : []
  };
}

export function buildConversationHistory(session, { limit = 2 } = {}) {
  const activeMode = session?.sourceMode === 'source' ? 'source' : 'practice';
  const typedTurns = Array.isArray(session?.turns) ? session.turns.map(turn => ({
    mode: turn.mode || (turn.sourceMode === 'source' ? 'source' : activeMode),
    role: 'coach',
    question: turn.question,
    answer: turn.answer
  })) : [];
  const voiceTurns = Array.isArray(session?.voiceTurns) ? session.voiceTurns.map(turn => ({
    mode: turn.mode || activeMode,
    role: turn.intent,
    transcript: turn.transcript,
    answerText: turn.answerText
  })) : [];
  return [...typedTurns, ...voiceTurns]
    .filter(turn => turn.mode === activeMode)
    .slice(-Math.max(1, Number(limit) || 2));
}

function countConversationTurns(session) {
  const activeMode = session?.sourceMode === 'source' ? 'source' : 'practice';
  const typedCount = Array.isArray(session?.turns)
    ? session.turns.filter(turn => (turn.mode || (turn.sourceMode === 'source' ? 'source' : activeMode)) === activeMode).length
    : 0;
  const voiceCount = Array.isArray(session?.voiceTurns)
    ? session.voiceTurns.filter(turn => (turn.mode || activeMode) === activeMode && !['control', 'new_question'].includes(turn.intent) && turn.status !== 'pending').length
    : 0;
  return typedCount + voiceCount;
}

function looksLikeCoachingTurn({ session, transcript }) {
  if (!session?.currentQuestion || !Array.isArray(session?.turns)) return false;
  const trimmed = String(transcript || '').trim();
  if (!trimmed) return false;
  if (/[?]$/.test(trimmed)) return false;
  return session.turns.length < session.questionLimit && words(trimmed).length >= 5;
}

function looksLikeSourceQuestion(transcript) {
  const value = String(transcript || '').toLowerCase();
  return /\b(source|paper|article|study|section|argument|chapter|notes|material|document|passage)\b/.test(value);
}

function normalizeGeneralConfidence(confidence) {
  const normalized = normalizeOptionalString(confidence);
  return CONFIDENCE_LEVELS.has(normalized) ? normalized : 'medium';
}

function words(text) {
  return String(text || '').match(/[a-z0-9]+/gi) || [];
}

function normalizeKnowledgeLayers(layers) {
  if (!Array.isArray(layers)) {
    throw new TypeError('knowledgeLayers must be an array.');
  }

  const normalized = [];
  for (const layer of layers) {
    const value = requireNonEmptyString(layer, 'knowledgeLayer');
    if (!KNOWLEDGE_LAYERS.has(value)) {
      throw new TypeError(`Unsupported knowledge layer "${value}".`);
    }
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

function normalizeCitations(citations) {
  if (!Array.isArray(citations)) {
    throw new TypeError('citations must be an array.');
  }

  return citations.map((citation, index) => normalizeCitation(citation, index));
}

function normalizeCitation(citation, index) {
  if (!citation || typeof citation !== 'object') {
    throw new TypeError(`citations[${index}] must be an object.`);
  }

  const start = normalizeOffset(citation.start, `citations[${index}].start`);
  const end = normalizeOffset(citation.end, `citations[${index}].end`);
  if (end < start) {
    throw new TypeError(`citations[${index}] end must be greater than or equal to start.`);
  }

  const excerpt = normalizeOptionalString(citation.excerpt);
  validateCitationEvidence({
    evidenceText: normalizeOptionalString(citation.chunkText) || normalizeOptionalString(citation.sourceText),
    excerpt,
    index
  });

  return {
    sourceId: requireNonEmptyString(citation.sourceId, `citations[${index}].sourceId`),
    chunkId: normalizeOptionalString(citation.chunkId),
    page: citation.page ?? null,
    section: normalizeOptionalString(citation.section),
    excerpt,
    start,
    end
  };
}

function normalizeExternalCitations(citations) {
  if (!Array.isArray(citations)) {
    throw new TypeError('externalCitations must be an array.');
  }

  return citations.map((citation, index) => {
    if (!citation || typeof citation !== 'object') {
      throw new TypeError(`externalCitations[${index}] must be an object.`);
    }

    return {
      title: requireNonEmptyString(citation.title, `externalCitations[${index}].title`),
      url: requireNonEmptyString(citation.url, `externalCitations[${index}].url`),
      publisher: normalizeOptionalString(citation.publisher),
      provider: normalizeOptionalString(citation.provider),
      retrievedAt: normalizeOptionalString(citation.retrievedAt),
      excerpt: normalizeOptionalString(citation.excerpt) || normalizeOptionalString(citation.snippet),
      query: normalizeOptionalString(citation.query)
    };
  });
}

function normalizeAnswerConfidence(confidence) {
  const normalized = normalizeOptionalString(confidence);
  if (!CONFIDENCE_LEVELS.has(normalized)) {
    throw new TypeError('confidence must be one of low, medium, or high.');
  }
  return normalized;
}

function normalizeConfidenceScore(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError('transcriptConfidence must be a finite number.');
  }

  return Math.min(Math.max(numeric, 0), 1);
}

function normalizeOffset(value, field) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new TypeError(`${field} must be a non-negative integer.`);
  }
  return numeric;
}

function validateCitationEvidence({ evidenceText, excerpt, index }) {
  if (!evidenceText) return;
  if (!excerpt || !evidenceText.includes(excerpt)) {
    throw new TypeError(`citations[${index}] must include an exact supporting substring when source text or chunk evidence is supplied.`);
  }
}

function requireNonEmptyString(value, field) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new TypeError(`${field} is required.`);
  }
  return normalized;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
}
