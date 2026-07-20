import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countCompletedTurns, deriveSourceMetrics, ensureSourceContract, InMemoryStore, HttpError } from './store.mjs';
import { createCoach, digestSource, sourceAnswer } from './fakeCoach.mjs';
import { createRealtimeCall, createRealtimeSession } from './realtime.mjs';
import { ingestSource } from './sourceIngestion.mjs';
import { createModelCoach, createResilientCoach } from './modelCoach.mjs';
import { buildConsolidatedDigest, buildSourceConversationDigest, chunkSource } from './sourceKnowledge.mjs';
import { validateVoiceState } from './voiceSession.mjs';
import { createResearchAdapter } from './researchAdapter.mjs';
import { loadSkillRegistry } from './skillRegistry.mjs';
import { createConversationOrchestrator, refreshSkillSelection, serializeSource } from './conversationOrchestrator.mjs';
import { createModelGateway } from './modelGateway.mjs';
import './config.mjs';
import { getInteractionLimits, getRequestConfig, getResearchConfig, getRetentionConfig, getSessionBudgetConfig, getSourceLimits, getVoiceConfig } from './config.mjs';
import { RateLimiter } from './rateLimit.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, '..', 'public');
const configuredSkillRegistry = loadSkillRegistry({ rootDir: path.join(root, '..') });
const configuredRetention = getRetentionConfig();
const configuredBudgets = getSessionBudgetConfig();
const configuredInteractionLimits = getInteractionLimits();
const configuredVoice = getVoiceConfig();
const configuredRequest = getRequestConfig();

function modelFallbackDiagnostic(error) {
  const details = error?.details || {};
  const fields = ['providerStatus', 'providerCode', 'providerType', 'responseStatus', 'incompleteReason']
    .filter(field => details[field] !== undefined && details[field] !== null && String(details[field]).trim())
    .map(field => `${field}=${String(details[field]).slice(0, 120)}`);
  return fields.length ? ` ${fields.join(' ')}` : '';
}

let configuredStore = new InMemoryStore({
  sessionTtlMs: configuredRetention.sessionTtlMs,
  shortExpiryMs: configuredRetention.shortExpiryMs,
  defaultRetentionMode: configuredRetention.defaultMode,
  turnBudget: configuredBudgets.turnBudget,
  modelTokenBudget: configuredBudgets.modelTokenBudget
});
if (process.env.SQLITE_PATH) {
  try {
    const { SqliteStore } = await import('./sqliteStore.mjs');
    configuredStore = new SqliteStore({
      path: process.env.SQLITE_PATH,
      sessionTtlMs: configuredRetention.sessionTtlMs,
      shortExpiryMs: configuredRetention.shortExpiryMs,
      defaultRetentionMode: configuredRetention.defaultMode,
      turnBudget: configuredBudgets.turnBudget,
      modelTokenBudget: configuredBudgets.modelTokenBudget
    });
  } catch (error) {
    throw new Error('SQLITE_PATH is configured, but this Node runtime does not provide usable node:sqlite support. Use Node 22.5+ or unset SQLITE_PATH for memory storage.', { cause: error });
  }
}
const configuredCoach = process.env.OPENAI_API_KEY
  ? createResilientCoach(
    createModelCoach({
      apiKey: process.env.OPENAI_API_KEY,
      timeoutMs: configuredVoice.textTimeoutMs,
      sourceDigestTimeoutMs: configuredVoice.sourceDigestTimeoutMs,
      sourceDigestMaxOutputTokens: configuredVoice.sourceDigestMaxOutputTokens,
      sourceConversationMaxOutputTokens: configuredVoice.sourceConversationMaxOutputTokens
    }),
    createCoach(),
    {
      onFallback: ({ method, error }) => {
        console.warn(`[deepchat2learn] text model fallback for ${method}: ${error?.code || 'MODEL_ERROR'} ${error?.message || 'request failed'}${modelFallbackDiagnostic(error)}`);
      }
    }
  )
  : createCoach();
const configuredRateLimiter = new RateLimiter({ limit: Number(process.env.RATE_LIMIT_PER_MINUTE) || 120 });
const configuredResearch = getResearchConfig();
const configuredResearchAdapter = createResearchAdapter({
  enabled: configuredResearch.enabled,
  provider: configuredResearch.provider,
  timeoutMs: configuredResearch.timeoutMs,
  consentTtlMs: configuredResearch.consentTtlMs
});
const configuredModelGateway = process.env.OPENAI_API_KEY
  ? createModelGateway({
    textCoach: configuredCoach,
    realtimeFactory: {
      async createRealtimeCall({ session, sdp, signal }) {
        return createRealtimeCall({
          apiKey: process.env.OPENAI_API_KEY,
          sdp,
          topic: session.topic,
          questionLimit: session.questionLimit,
          signal
        });
      }
    },
    config: {
      timeoutMs: configuredVoice.textTimeoutMs,
      timeoutByTask: { source_digest: configuredVoice.sourceDigestTimeoutMs },
      fallbackTextCoach: createCoach(),
      // Interactive turns already have a local academic fallback. Retrying a
      // slow upstream request would only make the live conversation feel frozen.
      maxTransientRetries: 0
    }
  })
  : null;
const configuredOrchestrator = createConversationOrchestrator({
  store: configuredStore,
  coach: configuredCoach,
  skillRegistry: configuredSkillRegistry,
  researchAdapter: configuredResearchAdapter,
  config: {
    maxAnswerCharacters: configuredInteractionLimits.maxAnswerCharacters,
    maxQuestionCharacters: configuredInteractionLimits.maxQuestionCharacters,
    maxVoiceTranscriptCharacters: configuredVoice.transcriptMaxCharacters
  }
});
const maxAnswerCharacters = configuredInteractionLimits.maxAnswerCharacters;
const maxQuestionCharacters = configuredInteractionLimits.maxQuestionCharacters;
const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'microphone=(self)',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
};

function json(res, status, body) {
  res.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sourceMetrics(source) {
  const metrics = deriveSourceMetrics(source);
  return {
    byteCount: metrics.bytes,
    wordCount: metrics.words,
    pageCount: metrics.pages
  };
}

function sessionSourceTotals(session) {
  return session.sources.reduce((totals, source) => {
    const metrics = sourceMetrics(source);
    totals.bytes += metrics.byteCount;
    totals.words += metrics.wordCount;
    if (metrics.pageCount !== null) totals.pages += metrics.pageCount;
    return totals;
  }, { bytes: 0, words: 0, pages: 0 });
}

function throwSourceLimit({ limitName, measuredValue, configuredLimit, message }) {
  const error = new HttpError(413, message, 'SOURCE_LIMIT');
  error.details = { status: 'failed', limitName, measuredValue, configuredLimit };
  throw error;
}

async function body(req, maxBytes = configuredRequest.maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Request is too large.', 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Request body must be valid JSON.', 'INVALID_JSON'); }
}

function token(req) {
  return req.headers['x-session-token'];
}

function recordLifecycle(recorder, event) {
  try { recorder?.record?.(event); } catch { /* optional diagnostics must never affect API behavior */ }
}

async function digestForSource(coach, source, skillProfile = null) {
  if (typeof coach.digestSource !== 'function') return { mode: 'extractive', ...digestSource(source) };
  try { return await coach.digestSource(source, skillProfile); }
  catch { return { mode: 'extractive', ...digestSource(source) }; }
}

function createDirectTextCoach(modelGateway, fallbackCoach) {
  if (!modelGateway || typeof modelGateway.runTextTask !== 'function') return fallbackCoach;
  const directCoach = Object.create(fallbackCoach || null);
  return Object.assign(directCoach, {
    async topicDigest(input, { signal = null } = {}) {
      return modelGateway.runTextTask({ task: 'topic_digest', input, signal });
    },

    async initialQuestion(input, { signal = null } = {}) {
      return modelGateway.runTextTask({ task: 'question', input: { ...input, mode: 'initial' }, signal });
    },
    async nextQuestion(input, { signal = null } = {}) {
      return modelGateway.runTextTask({ task: 'question', input: { ...input, mode: 'next' }, signal });
    },
    async sourceQuestion(input, { signal = null } = {}) {
      return modelGateway.runTextTask({ task: 'question', input: { ...input, mode: 'source' }, signal });
    },
    async evaluateAnswer(input, { signal = null } = {}) {
      return modelGateway.runTextTask({ task: 'practice_evaluation', input, signal });
    },
    async digestSource(source, skillProfile = null, { signal = null } = {}) {
      return modelGateway.runTextTask({ task: 'source_digest', input: { ...source, skillProfile }, signal });
    },
    async buildConsolidatedDigest(input, { signal = null } = {}) {
      return modelGateway.runTextTask({ task: 'source_digest', input, signal });
    },
    async generalAnswer(question, { signal = null, context = null } = {}) {
      return modelGateway.runTextTask({ task: 'general_answer', input: { question, ...(context || {}) }, signal });
    },
    async groundedAnswer(input, { signal = null } = {}) {
      return modelGateway.runTextTask({ task: 'source_answer', input, signal });
    },
    async composeBlendedAnswer(input, { signal = null } = {}) {
      return modelGateway.runTextTask({ task: 'source_answer', input, signal });
    }
  });
}

async function rebuildSessionDigest(session, coach, skillRegistry = configuredSkillRegistry, { consumeBudget = true } = {}) {
  session.digestStatus = 'processing';
  session.digestError = null;
  for (const source of session.sources) {
    if (source.status !== 'failed') source.status = 'digesting';
    ensureSourceContract(source, session.digestStatus);
  }
  const chunks = session.sources.flatMap(source => source.chunks || []);
  try {
    if (consumeBudget) consumeModelBudget(session, session.topic, session.sources.map(source => source.text), chunks.map(chunk => chunk.text));
    session.sourceDigest = await buildConsolidatedDigest({
      sources: session.sources,
      chunks,
      coach,
      skillProfile: skillRegistry.get(session.activeSkillId)
    });
    session.digestWarnings = session.sourceDigest.warnings || [];
    session.digestStatus = 'ready';
    session.digestError = null;
    for (const source of session.sources) {
      source.status = 'ready';
      ensureSourceContract(source, session.digestStatus);
    }
  } catch (error) {
    session.digestStatus = 'failed';
    session.digestWarnings = collectSourceWarnings(session.sources, ['Digest generation failed.']);
    session.digestError = {
      code: error.code || 'DIGEST_BUILD_FAILED',
      message: error.message || 'Digest generation failed.'
    };
    for (const source of session.sources) {
      if (source.status !== 'ready') source.status = 'failed';
      ensureSourceContract(source, session.digestStatus);
    }
  }
}

function collectSourceWarnings(sources, extra = []) {
  return [...new Set([...(sources || []).flatMap(source => source.warnings || []), ...extra].filter(Boolean))];
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

function assertSessionCanChangeMaterials(session) {
  if (session.status === 'completed') throw new HttpError(409, 'This session is already complete.', 'SESSION_COMPLETED');
  if (session.status === 'ready_to_complete') throw new HttpError(409, 'This session has reached its question limit. Complete it before making changes.', 'SESSION_COMPLETE');
}

function ensureVoiceState(session) {
  if (!session.voiceState || !validateVoiceState(session.voiceState, session.voiceState)) {
    session.voiceState = 'idle';
  }
  return session.voiceState;
}

function setVoiceState(session, nextState) {
  const previous = ensureVoiceState(session);
  if (!validateVoiceState(previous, nextState)) {
    throw new HttpError(409, `Voice state cannot move from ${previous} to ${nextState}.`, 'VOICE_STATE_INVALID');
  }
  session.voiceState = nextState;
  session.voiceStateUpdatedAt = new Date().toISOString();
}

function assignVoiceState(session, nextState) {
  session.voiceState = nextState;
  session.voiceStateUpdatedAt = new Date().toISOString();
}

function latestVoiceTurn(session) {
  return Array.isArray(session.voiceTurns) && session.voiceTurns.length ? session.voiceTurns.at(-1) : null;
}

function voiceEventsBody(session) {
  const turn = latestVoiceTurn(session);
  return {
    state: ensureVoiceState(session),
    turnCount: countCompletedTurns(session),
    lastTranscript: turn?.transcript || null,
    lastTurn: turn ? {
      id: turn.id,
      status: turn.status,
      transcript: turn.transcript,
      answerSpeechText: turn.answerSpeechText
    } : null,
    updatedAt: session.voiceStateUpdatedAt || null
  };
}

async function handleApi(req, res, url, runtime = {}) {
  const store = runtime.store || configuredStore;
  const coach = runtime.coach || configuredCoach;
  const modelGateway = runtime.modelGateway || configuredModelGateway;
  const directTextCoach = createDirectTextCoach(modelGateway, coach);
  const rateLimiter = runtime.rateLimiter || configuredRateLimiter;
  const researchAdapter = runtime.researchAdapter || configuredResearchAdapter;
  const skillRegistry = runtime.skillRegistry || configuredSkillRegistry;
  const lifecycleRecorder = runtime.lifecycleRecorder || null;
  const orchestrator = runtime.orchestrator || createConversationOrchestrator({
    store,
    coach,
    skillRegistry,
    researchAdapter,
    config: {
      maxAnswerCharacters,
      maxQuestionCharacters,
      maxVoiceTranscriptCharacters: configuredVoice.transcriptMaxCharacters,
      lifecycleRecorder
    }
  });
  rateLimiter.prune?.();
  store.cleanupExpired?.();
  rateLimiter.check(token(req) || req.socket?.remoteAddress || 'anonymous');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;
  const payload = ['POST', 'PUT', 'PATCH'].includes(method) ? await body(req, configuredRequest.maxBodyBytes) : {};

  if (method === 'POST' && url.pathname === '/api/sessions') {
    const created = await orchestrator.startSession(payload);
    recordLifecycle(lifecycleRecorder, {
      event: 'session.created',
      sessionId: created.session?.id,
      mode: created.session?.sourceMode === 'source' ? 'source' : 'practice',
      status: created.session?.status,
      sourceCount: Array.isArray(created.session?.sources) ? created.session.sources.length : 0
    });
    return json(res, 201, created);
  }

  if (method === 'POST' && url.pathname === '/api/realtime/session') {
    const session = store.requireAuthorized(payload.sessionId, token(req));
    const realtime = await createRealtimeSession({ apiKey: process.env.OPENAI_API_KEY, topic: session.topic, questionLimit: session.questionLimit });
    return json(res, 200, realtime);
  }

  if (method === 'POST' && url.pathname === '/api/realtime/call') {
    const session = store.requireAuthorized(payload.sessionId, token(req));
    const call = modelGateway && typeof modelGateway.createRealtimeCall === 'function'
      ? await modelGateway.createRealtimeCall({ session, sdp: payload.sdp, signal: null })
      : await createRealtimeCall({ apiKey: process.env.OPENAI_API_KEY, sdp: payload.sdp, topic: session.topic, questionLimit: session.questionLimit });
    return json(res, 200, call);
  }

  if (parts[1] === 'voice' && parts[2] === 'sessions') {
    const sessionId = parts[3];
    if (!sessionId) throw new HttpError(404, 'Route not found.', 'NOT_FOUND');
    const session = store.requireAuthorized(sessionId, token(req));
    ensureVoiceState(session);

    if (method === 'POST' && parts.length === 5 && parts[4] === 'start') {
      assignVoiceState(session, 'permission_pending');
      store.save(session);
      recordLifecycle(lifecycleRecorder, {
        event: 'voice.started',
        sessionId: session.id,
        mode: session.sourceMode === 'source' ? 'source' : 'practice',
        status: session.voiceState,
        sourceCount: session.sources.length
      });
      return json(res, 200, voiceEventsBody(session));
    }

    if (method === 'POST' && parts.length === 5 && parts[4] === 'turns') {
      const result = await orchestrator.handleTurn({
        session,
        route: 'voice_turn',
        payload: {
          transcript: payload.transcript,
          transcriptConfidence: payload.transcriptConfidence,
          transcriptReviewed: payload.transcriptReviewed,
          idempotencyKey: payload.idempotencyKey || req.headers['idempotency-key'] || null
        }
      });
      return json(res, 200, result);
    }

    if (method === 'POST' && parts.length === 7 && parts[4] === 'turns' && parts[6] === 'interrupt') {
      const turn = (session.voiceTurns || []).find(item => item.id === parts[5]);
      if (!turn) throw new HttpError(404, 'Voice turn not found.', 'VOICE_TURN_NOT_FOUND');
      assignVoiceState(session, 'listening');
      store.save(session);
      recordLifecycle(lifecycleRecorder, {
        event: 'voice.interrupted',
        sessionId: session.id,
        mode: session.sourceMode === 'source' ? 'source' : 'practice',
        status: session.voiceState,
        sourceCount: session.sources.length
      });
      return json(res, 200, { state: session.voiceState, turn: { id: turn.id, status: turn.status } });
    }

    if (method === 'POST' && parts.length === 5 && parts[4] === 'pause') {
      assignVoiceState(session, 'paused');
      store.save(session);
      return json(res, 200, voiceEventsBody(session));
    }

    if (method === 'POST' && parts.length === 5 && parts[4] === 'resume') {
      assignVoiceState(session, 'listening');
      store.save(session);
      return json(res, 200, voiceEventsBody(session));
    }

    if (method === 'POST' && parts.length === 5 && parts[4] === 'stop') {
      assignVoiceState(session, 'completed');
      store.save(session);
      return json(res, 200, voiceEventsBody(session));
    }

    if (method === 'GET' && parts.length === 5 && parts[4] === 'events') {
      return json(res, 200, voiceEventsBody(session));
    }

    throw new HttpError(404, 'Route not found.', 'NOT_FOUND');
  }

  const sessionId = parts[2];
  if (!sessionId) throw new HttpError(404, 'Route not found.', 'NOT_FOUND');
  const session = store.requireAuthorized(sessionId, token(req));

  if (method === 'GET' && parts.length === 3) return json(res, 200, { session: store.publicSession(session) });

  if (method === 'POST' && parts.length === 4 && parts[3] === 'sources') {
    assertSessionCanChangeMaterials(session);
    const limits = getSourceLimits();
    const nextSourceCount = session.sources.length + 1;
    if (nextSourceCount > limits.maxFiles) {
      throwSourceLimit({
        limitName: 'maxFiles',
        measuredValue: nextSourceCount,
        configuredLimit: limits.maxFiles,
        message: `Source upload exceeds the configured maxFiles limit (${nextSourceCount}/${limits.maxFiles}).`
      });
    }
    const normalized = ingestSource({ ...payload, name: payload.name || `Source ${session.sources.length + 1}` }, {
      limits,
      lifecycleRecorder,
      sessionId: session.id,
      mode: 'source',
      sourceCount: nextSourceCount
    });
    if (normalized.text.length < 10) throw new HttpError(400, 'Add at least a few sentences of source material.', 'SOURCE_TEXT_REQUIRED');
    if (session.sources.some(source => source.hash && source.hash === normalized.hash)) throw new HttpError(409, 'That source is already attached to this session.', 'SOURCE_DUPLICATE');
    const totals = sessionSourceTotals(session);
    const combinedBytes = totals.bytes + normalized.byteCount;
    const combinedWords = totals.words + normalized.words;
    const combinedPages = totals.pages + (normalized.pages || 0);
    if (combinedBytes > limits.maxCombinedBytes) {
      throwSourceLimit({
        limitName: 'maxCombinedBytes',
        measuredValue: combinedBytes,
        configuredLimit: limits.maxCombinedBytes,
        message: `Source upload exceeds the configured maxCombinedBytes limit (${combinedBytes}/${limits.maxCombinedBytes}).`
      });
    }
    if (combinedWords > limits.maxWords) {
      throwSourceLimit({
        limitName: 'maxWords',
        measuredValue: combinedWords,
        configuredLimit: limits.maxWords,
        message: `Source upload exceeds the configured maxWords limit (${combinedWords}/${limits.maxWords}).`
      });
    }
    if (normalized.pages !== null && combinedPages > limits.maxPages) {
      throwSourceLimit({
        limitName: 'maxPages',
        measuredValue: combinedPages,
        configuredLimit: limits.maxPages,
        message: `Source upload exceeds the configured maxPages limit (${combinedPages}/${limits.maxPages}).`
      });
    }
    const source = {
      id: cryptoRandomId(),
      name: normalized.name,
      text: normalized.text,
      mimeType: normalized.mimeType,
      hash: normalized.hash,
      warnings: normalized.warnings,
      byteCount: normalized.byteCount,
      wordCount: normalized.words,
      pageCount: normalized.pages,
      metadata: normalized.metadata,
      figures: normalized.figures || [],
      tables: normalized.tables || normalized.metadata?.tables || [],
      captions: normalized.captions || normalized.metadata?.captions || [],
      status: 'extracting',
      pageMap: normalized.pageMap || null,
      createdAt: new Date().toISOString()
    };
    source.chunks = chunkSource({ sourceId: source.id, text: source.text, pages: source.pageMap, targetWords: 700, overlapWords: 100 });
    source.status = 'digesting';
    source.metrics = {
      ...normalized.metrics,
      chunkCount: source.chunks.length
    };
    session.sources.push(source);
    refreshSkillSelection(session, skillRegistry);
    consumeModelBudget(session, session.topic, source.text, source.chunks.map(chunk => chunk.text));
    const digest = await digestForSource(directTextCoach, source, skillRegistry.get(session.activeSkillId));
    recordLifecycle(lifecycleRecorder, {
      event: 'source.digest.completed',
      sessionId: session.id,
      mode: 'source',
      status: 'queued',
      sourceCount: session.sources.length
    });
    source.digest = digest;
    session.sourceDigest = buildSourceConversationDigest({ sources: session.sources });
    session.digestStatus = 'ready';
    source.status = 'ready';
    ensureSourceContract(source, session.digestStatus);
    session.digestError = null;
    session.digestWarnings = collectSourceWarnings(session.sources);
    store.save(session);
    return json(res, 201, {
      source: serializeSource(source, session.digestStatus),
      digest,
      skillId: session.skillId,
      activeSkillId: session.activeSkillId,
      skillSelectionReason: session.skillSelectionReason
    });
  }

  if (method === 'GET' && parts.length === 4 && parts[3] === 'sources') {
    return json(res, 200, orchestrator.getSourceStatus({ session, view: 'sources' }));
  }

  if (method === 'GET' && parts.length === 5 && parts[3] === 'sources' && parts[4] === 'digest') {
    return json(res, 200, orchestrator.getSourceStatus({ session, view: 'digest' }));
  }

  if (method === 'POST' && parts.length === 5 && parts[3] === 'sources' && parts[4] === 'digest') {
    if (!session.sources.length) throw new HttpError(409, 'Add a source before building a digest.', 'SOURCE_REQUIRED');
    const forceModelConsolidation = payload.forceModelConsolidation === true;
    if (forceModelConsolidation) {
      session.digestStatus = 'processing';
      session.digestError = null;
      store.save(session);
      await rebuildSessionDigest(session, directTextCoach, skillRegistry);
    } else {
      // Every source is digested at upload time. Reuse that prepared gist for
      // ordinary source conversations so the original document is not sent to
      // the remote model a second time.
      session.sourceDigest = buildSourceConversationDigest({ sources: session.sources, sourceDigest: null });
      session.digestStatus = 'ready';
      session.digestError = null;
      session.digestWarnings = collectSourceWarnings(session.sources);
      for (const source of session.sources) {
        if (source.status !== 'failed') source.status = 'ready';
        ensureSourceContract(source, session.digestStatus);
      }
      store.save(session);
    }
    recordLifecycle(lifecycleRecorder, {
      event: 'source.digest.completed',
      sessionId: session.id,
      mode: 'source',
      status: session.digestStatus,
      sourceCount: session.sources.length,
      errorCode: session.digestError?.code
    });
    store.save(session);
    return json(res, 200, {
      status: session.digestStatus,
      warnings: session.digestWarnings,
      digest: session.sourceDigest,
      error: session.digestError,
      sourceCount: session.sources.length
    });
  }

  if (method === 'GET' && parts.length === 6 && parts[3] === 'sources' && parts[5] === 'chunks') {
    const source = session.sources.find(item => item.id === parts[4]);
    if (!source) throw new HttpError(404, 'Source not found.', 'SOURCE_NOT_FOUND');
    return json(res, 200, {
      status: ensureSourceContract(source, session.digestStatus).status,
      sourceId: source.id,
      chunks: source.chunks || []
    });
  }

  if (method === 'POST' && parts.length === 4 && parts[3] === 'research-consent') {
    if (researchAdapter?.enabled === false || typeof researchAdapter?.approveConsent !== 'function') {
      throw new HttpError(409, 'External research is not enabled for this session.', 'RESEARCH_DISABLED');
    }
    session.researchConsent = researchAdapter.approveConsent({});
    store.save(session);
    return json(res, 200, {
      approved: true,
      expiresAt: session.researchConsent.expiresAt
    });
  }

  if (method === 'POST' && parts.length === 4 && parts[3] === 'source-prompts') {
    assertSessionCanChangeMaterials(session);
    if (!session.sources.length) throw new HttpError(409, 'Add a source before generating a source-based question.', 'SOURCE_REQUIRED');
    refreshSkillSelection(session, skillRegistry, payload.question || '');
    const sourceDigest = buildSourceConversationDigest({ sources: session.sources, sourceDigest: session.sourceDigest });
    consumeModelBudget(session, session.topic, sourceDigest);
    const question = await directTextCoach.sourceQuestion({ topic: session.topic, sourceDigest, skillProfile: skillRegistry.get('academic-conversation') });
    session.currentQuestion = question;
    store.save(session);
    return json(res, 200, { question, skillId: session.skillId, activeSkillId: session.activeSkillId, skillSelectionReason: session.skillSelectionReason });
  }

  if (method === 'DELETE' && parts.length === 5 && parts[3] === 'sources') {
    assertSessionCanChangeMaterials(session);
    const sourceIndex = session.sources.findIndex(source => source.id === parts[4]);
    if (sourceIndex < 0) throw new HttpError(404, 'Source not found.', 'SOURCE_NOT_FOUND');
    session.sources.splice(sourceIndex, 1);
    refreshSkillSelection(session, skillRegistry);
    session.sourceDigest = null;
    session.digestStatus = session.sources.length ? 'queued' : null;
    session.digestWarnings = collectSourceWarnings(session.sources);
    session.digestError = null;
    for (const source of session.sources) {
      if (source.status !== 'failed') source.status = 'digesting';
      ensureSourceContract(source, session.digestStatus);
    }
    store.save(session);
    return json(res, 200, { deleted: true, sourceId: parts[4] });
  }

  if (method === 'POST' && parts.length === 4 && parts[3] === 'turns') {
    return json(res, 200, await orchestrator.handleTurn({
      session,
      route: 'practice_answer',
      payload: {
        answer: payload.answer,
        idempotencyKey: req.headers['idempotency-key'] || null
      }
    }));
  }

  if (method === 'POST' && parts.length === 4 && parts[3] === 'questions') {
    if (payload.mode === 'source' || payload.mode === 'general') {
      return json(res, 200, await orchestrator.handleTurn({
        session,
        route: 'typed_question',
        payload
      }));
    }
    if (typeof payload.question !== 'string' || payload.question.trim().length < 2) throw new HttpError(400, 'Enter a question.', 'QUESTION_REQUIRED');
    if (payload.question.length > maxQuestionCharacters) throw new HttpError(413, 'That question is too long. Please shorten it.', 'QUESTION_TOO_LONG');
    return json(res, 200, await directTextCoach.generalAnswer(payload.question.trim()));
  }

  if (method === 'POST' && parts.length === 4 && parts[3] === 'complete') {
    return json(res, 200, orchestrator.buildSummary({ session }));
  }

  if (method === 'DELETE' && parts.length === 3) {
    (store.deleteSession || store.delete).call(store, sessionId);
    return json(res, 200, { deleted: true });
  }

  throw new HttpError(404, 'Route not found.', 'NOT_FOUND');
}

function cryptoRandomId() {
  return crypto.randomUUID();
}

function extractSessionId(pathname) {
  const voiceMatch = pathname.match(/^\/api\/voice\/sessions\/([^/]+)/);
  if (voiceMatch) return voiceMatch[1];
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)/);
  return sessionMatch ? sessionMatch[1] : null;
}

function mime(file) {
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.js')) return 'text/javascript';
  return 'text/html';
}

async function serveStatic(res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (name.includes('..') || name.includes('\\')) throw new HttpError(404, 'Not found.', 'NOT_FOUND');
  try {
    const content = await fs.readFile(path.join(publicDir, name));
    res.writeHead(200, { ...securityHeaders, 'content-type': `${mime(name)}; charset=utf-8` });
    res.end(content);
  } catch { throw new HttpError(404, 'Not found.', 'NOT_FOUND'); }
}

export function createServer({
  store: serverStore = configuredStore,
  coach: serverCoach = configuredCoach,
  modelGateway: serverModelGateway = configuredModelGateway,
  rateLimiter: serverRateLimiter = configuredRateLimiter,
  researchAdapter: serverResearchAdapter = configuredResearchAdapter,
  skillRegistry: serverSkillRegistry = configuredSkillRegistry,
  lifecycleRecorder = null,
  orchestrator: serverOrchestrator = createConversationOrchestrator({
    store: serverStore,
    coach: createDirectTextCoach(serverModelGateway, serverCoach),
    skillRegistry: serverSkillRegistry,
    researchAdapter: serverResearchAdapter,
    config: {
      maxAnswerCharacters,
      maxQuestionCharacters,
      maxVoiceTranscriptCharacters: configuredVoice.transcriptMaxCharacters,
      lifecycleRecorder
    }
  }),
  logger = null
} = {}) {
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url, 'http://localhost');
    let statusCode = 200;
    let errorCode = null;
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const sourceLimits = getSourceLimits();
        return json(res, 200, {
          status: 'ok',
          service: 'deepchat2learn',
          capabilities: {
            textCoach: process.env.OPENAI_API_KEY ? 'model' : 'local-demo',
            realtimeVoice: Boolean(process.env.OPENAI_API_KEY),
            storage: process.env.SQLITE_PATH ? 'sqlite' : 'memory'
          },
          connection: {
            textModel: process.env.OPENAI_API_KEY ? 'configured' : 'local-demo',
            realtimeVoice: process.env.OPENAI_API_KEY ? 'configured' : 'not_configured'
          },
          voice: configuredVoice,
          sourceLimits,
          privacy: {
            defaultRetentionMode: configuredRetention.defaultMode,
            audioStorage: configuredRetention.audioStorage
          },
          budgets: {
            turnBudget: configuredBudgets.turnBudget,
            modelTokenBudget: configuredBudgets.modelTokenBudget
          }
        });
      }
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, {
        store: serverStore,
        coach: serverCoach,
        modelGateway: serverModelGateway,
        rateLimiter: serverRateLimiter,
         researchAdapter: serverResearchAdapter,
         skillRegistry: serverSkillRegistry,
         lifecycleRecorder,
         orchestrator: serverOrchestrator
      });
      else await serveStatic(res, url.pathname);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      statusCode = status;
      errorCode = error.code || 'INTERNAL_ERROR';
      json(res, status, {
        ...(error.details?.status ? { status: error.details.status } : {}),
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: status === 500 ? 'Something went wrong. Try again.' : error.message,
          ...(error.details || {})
        }
      });
    } finally {
      if (logger?.info) {
        logger.info({
          event: 'request',
          method: req.method,
          path: url.pathname,
          statusCode: res.statusCode || statusCode,
          durationMs: Date.now() - startedAt,
          sessionId: extractSessionId(url.pathname),
          errorCode
        });
      }
    }
  });
  server.on('close', () => serverStore.close?.());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`deepchat2learn running at http://localhost:${port}`));
}
