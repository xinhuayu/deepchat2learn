const LIFECYCLE_EVENT_NAMES = new Set([
  'session.created',
  'voice.started',
  'voice.interrupted',
  'voice.submitted',
  'response.completed',
  'response.failed',
  'source.extraction.completed',
  'source.digest.completed'
]);

const MAX_FIELD_LENGTH = 160;

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, MAX_FIELD_LENGTH) : null;
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function normalizeDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? Math.min(Math.round(duration), 86_400_000) : null;
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => normalizeText(item)).filter(Boolean).slice(0, 10);
}

function normalizeTimestamp(value) {
  const candidate = value ? new Date(value) : new Date();
  return Number.isNaN(candidate.getTime()) ? new Date().toISOString() : candidate.toISOString();
}

function normalizeEvent(input) {
  const source = typeof input === 'string' ? { event: input } : input;
  if (!source || typeof source !== 'object') return null;
  const event = normalizeText(source.event);
  if (!LIFECYCLE_EVENT_NAMES.has(event)) return null;

  const normalized = {
    event,
    timestamp: normalizeTimestamp(source.timestamp)
  };
  const sessionId = normalizeText(source.sessionId);
  const mode = normalizeText(source.mode);
  const status = normalizeText(source.status);
  const errorCode = normalizeText(source.errorCode);
  const modelStatus = normalizeText(source.modelStatus);
  const fallbackReason = normalizeText(source.fallbackReason);
  const agendaStage = normalizeText(source.agendaStage);
  const idempotencyHash = normalizeText(source.idempotencyHash);
  const sourceCount = normalizeCount(source.sourceCount);
  const transcriptLength = normalizeCount(source.transcriptLength);
  const retrievedChunkCount = normalizeCount(source.retrievedChunkCount);
  const requestDurationMs = normalizeDuration(source.requestDurationMs);
  const retrievedChunkIds = normalizeIdList(source.retrievedChunkIds);
  if (sessionId) normalized.sessionId = sessionId;
  if (mode) normalized.mode = mode;
  if (status) normalized.status = status;
  if (sourceCount !== null) normalized.sourceCount = sourceCount;
  if (transcriptLength !== null) normalized.transcriptLength = transcriptLength;
  if (errorCode) normalized.errorCode = errorCode;
  if (modelStatus) normalized.modelStatus = modelStatus;
  if (fallbackReason) normalized.fallbackReason = fallbackReason;
  if (agendaStage) normalized.agendaStage = agendaStage;
  if (idempotencyHash) normalized.idempotencyHash = idempotencyHash;
  if (retrievedChunkCount !== null) normalized.retrievedChunkCount = retrievedChunkCount;
  if (requestDurationMs !== null) normalized.requestDurationMs = requestDurationMs;
  if (retrievedChunkIds.length) normalized.retrievedChunkIds = retrievedChunkIds;
  return normalized;
}

export function createLifecycleRecorder({ maxEvents = 100 } = {}) {
  const configuredLimit = Number(maxEvents);
  const retentionLimit = Number.isFinite(configuredLimit) ? Math.max(0, Math.floor(configuredLimit)) : 100;
  const events = [];

  return {
    record(input) {
      try {
        const event = normalizeEvent(input);
        if (!event || retentionLimit === 0) return event;
        events.push(event);
        while (events.length > retentionLimit) events.shift();
        return { ...event };
      } catch {
        return null;
      }
    },
    snapshot() {
      return events.map(event => ({ ...event }));
    }
  };
}

export const lifecycleEventNames = Object.freeze([...LIFECYCLE_EVENT_NAMES]);
