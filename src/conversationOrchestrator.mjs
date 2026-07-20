import { buildSessionSummary, countCompletedTurns, deriveSourceDigestStatus, ensureSourceContract, HttpError, sourceReadyForGroundedAnswers } from './store.mjs';
import { answerVoiceTurn as defaultAnswerTurn, buildConversationHistory, isSessionEndRequest, refinePracticeTopicDigestAfterTurn, SESSION_CLOSING_MESSAGE } from './voiceSession.mjs';
import { resolveSkillSelection as defaultResolveSkillSelection } from './skillDetection.mjs';
import { getDigestStatus as defaultReadDigestStatus } from './sourceKnowledge.mjs';
import { getInteractionLimits, maxQuestionsForSourceMode } from './config.mjs';

const DEFAULT_INTERACTION_LIMITS = getInteractionLimits();
const DEFAULT_MAX_ANSWER_CHARACTERS = DEFAULT_INTERACTION_LIMITS.maxAnswerCharacters;
const DEFAULT_MAX_QUESTION_CHARACTERS = DEFAULT_INTERACTION_LIMITS.maxQuestionCharacters;

export function createConversationOrchestrator({
  coach,
  store,
  skillRegistry,
  researchAdapter,
  config = {}
} = {}) {
  const answerTurn = config.answerTurn || (args => defaultAnswerTurn({ ...args, lifecycleRecorder: config.lifecycleRecorder || null }));
  const resolveSkillSelection = config.resolveSkillSelection || defaultResolveSkillSelection;
  const readDigestStatus = config.readDigestStatus || defaultReadDigestStatus;
  const maxAnswerCharacters = config.maxAnswerCharacters || DEFAULT_MAX_ANSWER_CHARACTERS;
  const maxQuestionCharacters = config.maxQuestionCharacters || DEFAULT_MAX_QUESTION_CHARACTERS;
  const maxVoiceTranscriptCharacters = config.maxVoiceTranscriptCharacters || maxQuestionCharacters;

  return {
    async startSession(payload = {}) {
      if (typeof payload.topic !== 'string' || payload.topic.trim().length < 2) {
        throw new HttpError(400, 'Enter a topic to begin coaching.', 'TOPIC_REQUIRED');
      }

      validateSessionInput(payload, skillRegistry);
      const requestedSkillId = payload.skillId || (payload.sourceMode === 'source' ? 'auto' : 'none');
      const selection = resolveSkillSelection({
        requestedSkillId,
        sourceMode: payload.sourceMode || 'none',
        topic: payload.topic.trim(),
        registry: skillRegistry
      });
      const created = store.createSession({
        ...payload,
        topic: payload.topic.trim(),
        skillId: selection.requestedSkillId,
        activeSkillId: selection.activeSkillId,
        conversationSkillId: selection.conversationSkillId,
        skillSelectionReason: selection.warning ? `${selection.reason} ${selection.warning}` : selection.reason
      });
      const session = store.get(created.session.id);

      try {
        session.topicDigest = null;
        session.currentQuestion = await coach.initialQuestion({
          ...session,
          topicDigest: null,
          conversationTurnCount: 0,
          skillProfile: skillRegistry.get('academic-conversation')
        });
      } catch (error) {
        (store.deleteSession || store.delete).call(store, session.id);
        throw error;
      }

      store.save(session);
      return {
        ...created,
        session: store.publicSession(session),
        question: session.currentQuestion
      };
    },

    async handleTurn({ session, route, payload = {} } = {}) {
      if (!session || typeof session !== 'object') {
        throw new TypeError('session is required.');
      }

      switch (route) {
        case 'practice_answer':
          return handlePracticeAnswer({
            session,
            payload,
            store,
            coach,
            skillRegistry,
            maxAnswerCharacters
          });
        case 'typed_question':
          return handleTypedQuestion({
            session,
            payload,
            store,
            coach,
            skillRegistry,
            researchAdapter,
            answerTurn,
            resolveSkillSelection,
            maxQuestionCharacters
          });
        case 'voice_turn':
          return handleVoiceTurn({
            session,
            payload,
            store,
            coach,
            skillRegistry,
            researchAdapter,
            answerTurn,
            resolveSkillSelection,
            maxQuestionCharacters,
            maxVoiceTranscriptCharacters
          });
        default:
          throw new HttpError(404, 'Route not found.', 'NOT_FOUND');
      }
    },

    getSourceStatus({ session, view = 'sources' } = {}) {
      if (!session || typeof session !== 'object') {
        throw new TypeError('session is required.');
      }

      if (view === 'digest') {
        const digestStatus = readDigestStatus(session.id, store);
        return {
          ...digestStatus,
          sourceCount: session.sources.length
        };
      }

      return {
        sources: session.sources.map(source => serializeSource(source, session.digestStatus)),
        digestStatus: session.digestStatus || 'queued',
        digestWarnings: session.digestWarnings || [],
        digestError: session.digestError || null,
        skillId: session.skillId,
        activeSkillId: session.activeSkillId,
        skillSelectionReason: session.skillSelectionReason
      };
    },

    buildSummary({ session } = {}) {
      if (!session || typeof session !== 'object') {
        throw new TypeError('session is required.');
      }

      session.status = 'completed';
      store.save(session);
      return {
        summary: store.sessionSummary?.(session) || buildSessionSummary(session)
      };
    }
  };
}

export function validateSessionInput(payload, skillRegistry) {
  const goals = new Set(['clarity', 'structure', 'specificity']);
  const difficulties = new Set(['beginner', 'intermediate', 'advanced']);
  const feedbackStyles = new Set(['supportive', 'direct', 'socratic']);
  if (payload.goal !== undefined && !goals.has(payload.goal)) throw new HttpError(400, 'Choose a supported coaching goal.', 'GOAL_INVALID');
  if (payload.difficulty !== undefined && !difficulties.has(payload.difficulty)) throw new HttpError(400, 'Choose a supported difficulty.', 'DIFFICULTY_INVALID');
  if (payload.feedbackStyle !== undefined && !feedbackStyles.has(payload.feedbackStyle)) throw new HttpError(400, 'Choose a supported feedback style.', 'FEEDBACK_STYLE_INVALID');
  if (payload.sourceMode !== undefined && !['none', 'source'].includes(payload.sourceMode)) throw new HttpError(400, 'Choose a supported source mode.', 'SOURCE_MODE_INVALID');
  if (payload.retentionMode !== undefined && !['session', 'until_deleted', 'short_expiry'].includes(payload.retentionMode)) throw new HttpError(400, 'Choose a supported retention mode.', 'RETENTION_MODE_INVALID');
  if (payload.skillId !== undefined) {
    const knownSkill = ['epi-research', 'academic-research'].includes(payload.skillId) || skillRegistry?.get(payload.skillId);
    if (!['auto', 'none'].includes(payload.skillId) && !knownSkill) throw new HttpError(400, 'Choose a supported source-review skill.', 'SKILL_INVALID');
    if (payload.sourceMode === 'none' && payload.skillId !== 'none' && payload.skillId !== 'auto') throw new HttpError(400, 'Source-review skills are available only for materials sessions.', 'SKILL_MODE_INVALID');
  }
  const maxQuestions = maxQuestionsForSourceMode(payload.sourceMode);
  if (payload.questionLimit !== undefined && (!Number.isInteger(Number(payload.questionLimit)) || Number(payload.questionLimit) < 1 || Number(payload.questionLimit) > maxQuestions)) {
    throw new HttpError(400, `Choose between 1 and ${maxQuestions} questions for this session.`, 'QUESTION_LIMIT_INVALID');
  }
}

export function refreshSkillSelection(session, skillRegistry, question = '', resolveSkillSelection = defaultResolveSkillSelection) {
  const selection = resolveSkillSelection({
    requestedSkillId: session.skillId,
    sourceMode: session.sourceMode,
    topic: session.topic,
    sources: session.sources,
    question,
    registry: skillRegistry
  });
  session.activeSkillId = selection.activeSkillId;
  session.conversationSkillId = selection.conversationSkillId;
  session.skillSelectionReason = selection.warning ? `${selection.reason} ${selection.warning}` : selection.reason;
  return selection;
}

function currentSessionTurnCount(session) {
  return countCompletedTurns(session);
}

function estimateModelTokens(...values) {
  const text = values.flat(Infinity).filter(value => value !== undefined && value !== null).map(value => {
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }).join(' ');
  return Math.max(1, Math.ceil(text.length / 4));
}

function budgetLimitError(code, message, session, extra = {}) {
  const error = new HttpError(429, message, code);
  error.details = {
    spokenMessage: message,
    retentionMode: session.retentionMode,
    turnBudget: session.turnBudget,
    modelTokenBudget: session.modelTokenBudget,
    modelTokensUsed: session.modelTokensUsed || 0,
    ...extra
  };
  return error;
}

function ensureTurnBudget(session) {
  if (currentSessionTurnCount(session) < session.turnBudget) return;
  throw budgetLimitError(
    'SESSION_TURN_BUDGET_EXCEEDED',
    'This session has reached its turn limit. Start a new session or delete this one to continue.',
    session,
    { turnCount: currentSessionTurnCount(session) }
  );
}

function consumeModelBudget(session, ...values) {
  const estimatedTokens = estimateModelTokens(...values);
  const nextTotal = (session.modelTokensUsed || 0) + estimatedTokens;
  if (nextTotal > session.modelTokenBudget) {
    throw budgetLimitError(
      'SESSION_MODEL_BUDGET_EXCEEDED',
      'This session has reached its model budget. Start a new session or delete this one to continue.',
      session,
      { estimatedTokens, projectedModelTokensUsed: nextTotal }
    );
  }
  session.modelTokensUsed = nextTotal;
  return estimatedTokens;
}

function assertSessionCanAnswer(session, store) {
  if (session.status === 'completed') throw new HttpError(409, 'This session is already complete.', 'SESSION_COMPLETED');
  if (session.status === 'ready_to_complete') throw new HttpError(409, 'This session has reached its question limit.', 'SESSION_COMPLETE');
  if (currentSessionTurnCount(session) >= session.questionLimit) {
    session.status = 'ready_to_complete';
    store.save(session);
    throw new HttpError(409, 'This session has reached its question limit.', 'SESSION_COMPLETE');
  }
}

async function handlePracticeAnswer({ session, payload, store, coach, skillRegistry, maxAnswerCharacters }) {
  const idempotencyKey = payload.idempotencyKey || null;
  if (idempotencyKey && session.idempotency.has(idempotencyKey)) {
    return session.idempotency.get(idempotencyKey);
  }
  if (session.status === 'completed') throw new HttpError(409, 'This session is already complete.', 'SESSION_COMPLETED');
  if (typeof payload.answer !== 'string' || payload.answer.trim().length < 2) throw new HttpError(400, 'Add an answer before submitting.', 'ANSWER_REQUIRED');
  if (payload.answer.length > maxAnswerCharacters) throw new HttpError(413, 'That answer is too long for this session. Please shorten it.', 'ANSWER_TOO_LONG');
  if (isSessionEndRequest(payload.answer)) {
    session.status = 'ready_to_complete';
    const result = {
      turn: null,
      feedback: null,
      nextQuestion: null,
      done: true,
      sessionEnded: true,
      closingMessage: SESSION_CLOSING_MESSAGE
    };
    if (idempotencyKey) session.idempotency.set(idempotencyKey, result);
    store.save(session);
    return result;
  }
  assertSessionCanAnswer(session, store);
  ensureTurnBudget(session);
  const conversationTurnCount = currentSessionTurnCount(session);
  consumeModelBudget(session, session.topic, session.currentQuestion, payload.answer, session.sources.map(source => source.name));
  const feedback = await coach.evaluateAnswer({
    topic: session.topic,
    question: session.currentQuestion,
    answer: payload.answer.trim(),
    turnIndex: session.turns.length,
    conversationTurnCount,
    feedbackStyle: session.feedbackStyle,
    sources: session.sources,
    topicDigest: session.topicDigest || null,
    conversationHistory: buildConversationHistory(session, { limit: 5 }),
    skillProfile: skillRegistry.get('academic-conversation') || skillRegistry.get(session.conversationSkillId || session.activeSkillId)
  });
  const turn = {
    index: session.turns.length,
    question: session.currentQuestion,
    answer: payload.answer.trim(),
    feedback,
    createdAt: new Date().toISOString()
  };
  session.turns.push(turn);
  const done = session.turns.length >= session.questionLimit;
  if (done) session.status = 'ready_to_complete';
  const refinement = await refinePracticeTopicDigestAfterTurn({
    session,
    coach,
    skillRegistry,
    previousQuestion: turn.question,
    allowNextQuestion: !done
  });
  if (refinement.created && refinement.nextQuestion) feedback.nextQuestion = refinement.nextQuestion;
  if (!done) session.currentQuestion = refinement.nextQuestion || feedback.nextQuestion;
  const result = { turn, feedback, nextQuestion: done ? null : session.currentQuestion, done };
  if (idempotencyKey) session.idempotency.set(idempotencyKey, result);
  store.save(session);
  return result;
}

export async function handleVoiceTurn({
  session,
  payload,
  store,
  coach,
  skillRegistry,
  researchAdapter,
  answerTurn,
  resolveSkillSelection = defaultResolveSkillSelection,
  maxQuestionCharacters,
  maxVoiceTranscriptCharacters
}) {
  const normalizedIdempotencyKey = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey.trim() : '';
  if (normalizedIdempotencyKey && store?.getVoiceTurnReplay) {
    const replay = store.getVoiceTurnReplay(session, normalizedIdempotencyKey);
    if (replay) return { ...replay, done: Boolean(replay.sessionEnded) || currentSessionTurnCount(session) >= session.questionLimit };
  }
  if (typeof payload.transcript !== 'string' || payload.transcript.trim().length < 1) {
    throw new HttpError(400, 'Add a transcript before submitting.', 'TRANSCRIPT_REQUIRED');
  }
  const maxTranscriptCharacters = maxVoiceTranscriptCharacters || maxQuestionCharacters;
  if (payload.transcript.length > maxTranscriptCharacters) {
    throw new HttpError(413, 'That transcript is too long. Please shorten it.', 'QUESTION_TOO_LONG');
  }
  const endingRequest = isSessionEndRequest(payload.transcript);
  if (!endingRequest) {
    assertSessionCanAnswer(session, store);
    ensureTurnBudget(session);
    refreshSkillSelection(session, skillRegistry, payload.transcript, resolveSkillSelection);
    consumeModelBudget(session, session.topic, session.currentQuestion, payload.transcript, session.sourceDigest, session.sources.map(source => source.name));
  }
  session.voiceState = payload.transcriptReviewed ? 'retrieving' : 'finalizing_transcript';
  session.voiceStateUpdatedAt = new Date().toISOString();
  const externalResearch = endingRequest
    ? consentDisabledState()
    : await lookupExternalResearch({ session, query: payload.transcript, researchAdapter });
  let result = await answerTurn({
    session,
    transcript: payload.transcript,
    transcriptConfidence: payload.transcriptConfidence,
    transcriptReviewed: payload.transcriptReviewed,
    idempotencyKey: normalizedIdempotencyKey || null,
    externalResearch,
    store,
    coach,
    skillRegistry,
    inputMode: 'voice',
    intentHint: null
  });
  if (result?.turn && !Array.isArray(session.voiceTurns)) session.voiceTurns = [];
  if (result?.turn && !session.voiceTurns.some(turn => turn.id === result.turn.id)) session.voiceTurns.push(result.turn);
  const done = Boolean(result.sessionEnded) || currentSessionTurnCount(session) >= session.questionLimit;
  await refinePracticeTopicDigestAfterTurn({
    session,
    coach,
    skillRegistry,
    previousQuestion: result?.turn?.question || session.currentQuestion,
    result,
    allowNextQuestion: !done
  });
  if (done) {
    session.status = 'ready_to_complete';
  } else if (result.feedback?.nextQuestion) {
    session.currentQuestion = result.feedback.nextQuestion;
  } else if (result.followUp && !['control', 'end_session'].includes(result.turn?.intent)) {
    session.currentQuestion = result.followUp;
  }
  session.voiceState = result.nextState || 'speaking_answer';
  session.voiceStateUpdatedAt = new Date().toISOString();
  store.save(session);
  return { ...result, done };
}

export async function handleTypedQuestion({
  session,
  payload,
  store,
  coach,
  skillRegistry,
  researchAdapter,
  answerTurn,
  resolveSkillSelection = defaultResolveSkillSelection,
  maxQuestionCharacters
}) {
  if (typeof payload.question !== 'string' || payload.question.trim().length < 2) throw new HttpError(400, 'Enter a question.', 'QUESTION_REQUIRED');
  if (payload.question.length > maxQuestionCharacters) throw new HttpError(413, 'That question is too long. Please shorten it.', 'QUESTION_TOO_LONG');
  const idempotencyKey = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey.trim() : '';
  if (idempotencyKey && store?.getVoiceTurnReplay) {
    const replay = store.getVoiceTurnReplay(session, idempotencyKey);
    if (replay) {
      return {
        ...replay,
        done: Boolean(replay.sessionEnded) || currentSessionTurnCount(session) >= session.questionLimit,
        session: store.publicSession(session)
      };
    }
  }
  const endingRequest = isSessionEndRequest(payload.question);
  if (!endingRequest) {
    assertSessionCanAnswer(session, store);
    ensureTurnBudget(session);
    refreshSkillSelection(session, skillRegistry, payload.question, resolveSkillSelection);
    consumeModelBudget(session, session.topic, payload.question, session.sourceDigest, session.sources.map(source => source.name));
  }
  const mode = payload.mode === 'source' ? 'source_question' : 'general_question';
  const externalResearch = endingRequest
    ? consentDisabledState()
    : await lookupExternalResearch({ session, query: payload.question, researchAdapter });
  const result = await answerTurn({
    session,
    transcript: payload.question.trim(),
    transcriptConfidence: 1,
    transcriptReviewed: true,
    idempotencyKey: idempotencyKey || null,
    externalResearch,
    store,
    coach,
    skillRegistry,
    inputMode: 'typed',
    intentHint: mode
  });
  const done = Boolean(result.sessionEnded) || currentSessionTurnCount(session) >= session.questionLimit;
  if (done) session.status = 'ready_to_complete';
  store.save(session);
  const legacy = translateLegacyQuestionAnswer(result);
  const pendingSourceMessage = payload.mode === 'source' ? sourceProcessingMessage(session) : '';
  return {
    ...legacy,
    ...result,
    mode: legacy.mode,
    answer: legacy.answer,
    sourceGroundedClaims: legacy.sourceGroundedClaims,
    additionalContext: legacy.additionalContext,
    unsupportedOrUnresolved: legacy.unsupportedOrUnresolved,
    sourceDigestStatus: result.sourceDigestStatus || pendingSourceMessage,
    done,
    nextState: result.nextState || 'speaking_answer',
    session: store.publicSession(session)
  };
}

export function translateLegacyQuestionAnswer(result) {
  if (result?.legacyAnswer) return result.legacyAnswer;
  if (result?.knowledgeLayers?.includes('source')) {
    return {
      mode: 'source',
      answer: result.answerText,
      sourceGroundedClaims: result.citations.map(citation => ({
        claim: citation.excerpt,
        sourceId: citation.sourceId,
        sourceName: null,
        page: citation.page ?? null,
        section: citation.section ?? null,
        evidence: citation.excerpt,
        locator: { type: 'character', start: citation.start, end: citation.end },
        relevanceScore: null
      })),
      additionalContext: result.knowledgeLayers.includes('llm') ? [{ claim: 'This answer also uses general background context.', label: 'Additional context' }] : [],
      unsupportedOrUnresolved: [],
      conflicts: [],
      confidence: result.confidence
    };
  }
  return {
    mode: 'general',
    answer: result.answerText,
    sourceGroundedClaims: [],
    additionalContext: [],
    unsupportedOrUnresolved: [],
    confidence: result.confidence
  };
}

export function sourceProcessingMessage(session) {
  if (!session?.sources?.length) return '';
  if (session.digestStatus === 'failed') return 'One or more materials failed to finish processing, so grounded answers may be incomplete.';
  if (session.digestStatus === 'queued' || session.digestStatus === 'processing' || session.sources.some(source => !sourceReadyForGroundedAnswers(source, session.digestStatus))) {
    return 'Your materials are still processing, so grounded answers are not ready yet. You can keep chatting while the digest finishes.';
  }
  return '';
}

export function serializeSource(source, sessionDigestStatus = null) {
  const normalized = ensureSourceContract(source, sessionDigestStatus);
  return {
    id: normalized.id,
    name: normalized.name,
    status: normalized.status,
    characters: normalized.text.length,
    bytes: normalized.byteCount,
    words: normalized.wordCount,
    pages: normalized.pageCount,
    mimeType: normalized.mimeType,
    warnings: normalized.warnings,
    metrics: normalized.metrics,
    metadata: normalized.metadata || { pageCount: normalized.pageCount ?? null, sectionCount: 0 },
    figures: normalized.figures || normalized.metadata?.figures || [],
    tables: normalized.tables || normalized.metadata?.tables || [],
    captions: normalized.captions || normalized.metadata?.captions || [],
    digestStatus: deriveSourceDigestStatus(normalized, sessionDigestStatus),
    digest: normalized.digest || null,
    chunkCount: (normalized.chunks || []).length,
    createdAt: normalized.createdAt
  };
}

function consentDisabledState() {
  return {
    status: 'disabled',
    requested: false,
    approved: false,
    requiresExternalConsent: false,
    results: []
  };
}

export async function lookupExternalResearch({ session, query, researchAdapter }) {
  if (!researchAdapter?.lookup) return consentDisabledState();
  const result = await researchAdapter.lookup({
    query,
    consent: session.researchConsent
  });
  session.researchConsent = result?.nextConsent || null;
  return {
    status: result?.status || 'disabled',
    requested: Boolean(result?.requested),
    approved: Boolean(result?.approved),
    requiresExternalConsent: Boolean(result?.requiresExternalConsent),
    results: Array.isArray(result?.results) ? result.results : []
  };
}
