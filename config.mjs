import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_LIMIT_DEFAULTS = Object.freeze({
  maxFiles: 10,
  maxFileBytes: 20_000_000,
  maxCombinedBytes: 50_000_000,
  maxPages: 300,
  maxWords: 150_000,
  maxPastedCharacters: 200_000
});

export const RESEARCH_DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'none',
  timeoutMs: 4_000,
  consentTtlMs: 60_000
});

export const RETENTION_DEFAULTS = Object.freeze({
  defaultMode: 'session',
  sessionTtlMs: 1000 * 60 * 60,
  shortExpiryMs: 1000 * 60 * 15,
  audioStorage: 'never'
});

export const SESSION_BUDGET_DEFAULTS = Object.freeze({
  turnBudget: 50,
  modelTokenBudget: 120_000
});

export const SESSION_LIMITS = Object.freeze({
  practiceMaxQuestions: 50,
  sourceMaxQuestions: 200
});

export const VOICE_DEFAULTS = Object.freeze({
  autoSubmitDelayMs: 5_000,
  transitionDelayMs: 750,
  realtimeSilenceMs: 5_000,
  realtimeWatchdogMs: 0,
  maxRecognitionRetries: 8,
  transcriptMaxCharacters: 12_000,
  textTimeoutMs: 30_000,
  sourceDigestTimeoutMs: 180_000,
  realtimeTimeoutMs: 60_000
});

export const REQUEST_DEFAULTS = Object.freeze({
  maxBodyBytes: 28_000_000
});

export const AUDIO_MODEL_DEFAULT = 'gpt-realtime-mini';

export function maxQuestionsForSourceMode(sourceMode = 'none') {
  return sourceMode === 'source' ? SESSION_LIMITS.sourceMaxQuestions : SESSION_LIMITS.practiceMaxQuestions;
}

export function getAudioModel(env = process.env) {
  return String(env.OPENAI_AUDIO_MODEL || env.OPENAI_REALTIME_MODEL || AUDIO_MODEL_DEFAULT).trim() || AUDIO_MODEL_DEFAULT;
}

export function loadDotEnv(filePath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

export function shouldLoadDotEnv(env = process.env) {
  return String(env.DEEPCHAT2LEARN_SKIP_DOTENV || '').trim() !== '1';
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseRetentionMode(value, fallback = RETENTION_DEFAULTS.defaultMode) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['session', 'until_deleted', 'short_expiry'].includes(normalized) ? normalized : fallback;
}

export function getSourceLimits(env = process.env) {
  return {
    maxFiles: parsePositiveInteger(env.MAX_SOURCE_FILES, SOURCE_LIMIT_DEFAULTS.maxFiles),
    maxFileBytes: parsePositiveInteger(env.MAX_SOURCE_FILE_BYTES, SOURCE_LIMIT_DEFAULTS.maxFileBytes),
    maxCombinedBytes: parsePositiveInteger(env.MAX_SOURCE_COMBINED_BYTES, SOURCE_LIMIT_DEFAULTS.maxCombinedBytes),
    maxPages: parsePositiveInteger(env.MAX_SOURCE_PAGES, SOURCE_LIMIT_DEFAULTS.maxPages),
    maxWords: parsePositiveInteger(env.MAX_SOURCE_WORDS, SOURCE_LIMIT_DEFAULTS.maxWords),
    maxPastedCharacters: parsePositiveInteger(env.MAX_PASTED_SOURCE_CHARACTERS, SOURCE_LIMIT_DEFAULTS.maxPastedCharacters)
  };
}

export function getResearchConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.EXTERNAL_RESEARCH_ENABLED, RESEARCH_DEFAULTS.enabled),
    provider: String(env.EXTERNAL_RESEARCH_PROVIDER || RESEARCH_DEFAULTS.provider).trim() || RESEARCH_DEFAULTS.provider,
    timeoutMs: parsePositiveInteger(env.EXTERNAL_RESEARCH_TIMEOUT_MS, RESEARCH_DEFAULTS.timeoutMs),
    consentTtlMs: parsePositiveInteger(env.EXTERNAL_RESEARCH_CONSENT_TTL_MS, RESEARCH_DEFAULTS.consentTtlMs)
  };
}

export function getRetentionConfig(env = process.env) {
  return {
    defaultMode: parseRetentionMode(env.SESSION_RETENTION_MODE, RETENTION_DEFAULTS.defaultMode),
    sessionTtlMs: parsePositiveInteger(env.SESSION_TTL_MS, RETENTION_DEFAULTS.sessionTtlMs),
    shortExpiryMs: parsePositiveInteger(env.SESSION_SHORT_EXPIRY_MS, RETENTION_DEFAULTS.shortExpiryMs),
    audioStorage: RETENTION_DEFAULTS.audioStorage
  };
}

export function getSessionBudgetConfig(env = process.env) {
  return {
    turnBudget: parsePositiveInteger(env.SESSION_TURN_BUDGET, SESSION_BUDGET_DEFAULTS.turnBudget),
    modelTokenBudget: parsePositiveInteger(env.SESSION_MODEL_TOKEN_BUDGET, SESSION_BUDGET_DEFAULTS.modelTokenBudget)
  };
}

export function getVoiceConfig(env = process.env) {
  return {
    autoSubmitDelayMs: parsePositiveInteger(env.VOICE_AUTO_SUBMIT_DELAY_MS, VOICE_DEFAULTS.autoSubmitDelayMs),
    transitionDelayMs: parsePositiveInteger(env.VOICE_TRANSITION_DELAY_MS, VOICE_DEFAULTS.transitionDelayMs),
    realtimeSilenceMs: parsePositiveInteger(env.VOICE_REALTIME_SILENCE_MS, VOICE_DEFAULTS.realtimeSilenceMs),
    realtimeWatchdogMs: parseNonNegativeInteger(env.VOICE_REALTIME_WATCHDOG_MS, VOICE_DEFAULTS.realtimeWatchdogMs),
    maxRecognitionRetries: parsePositiveInteger(env.VOICE_MAX_RECOGNITION_RETRIES, VOICE_DEFAULTS.maxRecognitionRetries),
    transcriptMaxCharacters: parsePositiveInteger(env.VOICE_MAX_TRANSCRIPT_CHARACTERS, VOICE_DEFAULTS.transcriptMaxCharacters),
    textTimeoutMs: parsePositiveInteger(env.OPENAI_TEXT_TIMEOUT_MS, VOICE_DEFAULTS.textTimeoutMs),
    sourceDigestTimeoutMs: parsePositiveInteger(env.OPENAI_SOURCE_DIGEST_TIMEOUT_MS, VOICE_DEFAULTS.sourceDigestTimeoutMs),
    realtimeTimeoutMs: parsePositiveInteger(env.OPENAI_REALTIME_TIMEOUT_MS, VOICE_DEFAULTS.realtimeTimeoutMs)
  };
}

export function getRequestConfig(env = process.env) {
  return {
    maxBodyBytes: parsePositiveInteger(env.MAX_REQUEST_BODY_BYTES, REQUEST_DEFAULTS.maxBodyBytes)
  };
}

if (shouldLoadDotEnv()) loadDotEnv();
