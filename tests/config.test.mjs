import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getAudioModel, getRequestConfig, getRetentionConfig, getSessionBudgetConfig, getSourceLimits, getVoiceConfig, loadDotEnv, maxQuestionsForSourceMode, shouldLoadDotEnv } from '../src/config.mjs';

test('configuration template keeps the optional PDF extractor path portable and secret-free', async () => {
  const template = await fs.readFile(path.join(process.cwd(), '.env.example'), 'utf8');
  assert.match(template, /^DEEPCHAT2LEARN_PYTHON_BIN=\s*$/m);
  assert.doesNotMatch(template, /C:\\Users\\[^\r\n]+\\python\.exe/i);
  assert.match(template, /^OPENAI_API_KEY=$/m);
  assert.match(template, /^SQLITE_PATH=$/m);
  assert.doesNotMatch(template, /sk-(?:proj-)?/i);
  assert.doesNotMatch(template, /^OPENAI_API_KEY=\S+/m);
});

test('session question caps distinguish practice and source conversation modes', () => {
  assert.equal(maxQuestionsForSourceMode('none'), 50);
  assert.equal(maxQuestionsForSourceMode('source'), 200);
});

test('dotenv loader parses comments and quoted values without overwriting env', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-env-'));
  const file = path.join(directory, '.env');
  const original = process.env.DEEPCHAT2LEARN_TEST_EXISTING;
  process.env.DEEPCHAT2LEARN_TEST_EXISTING = 'keep-me';
  await fs.writeFile(file, '# comment\nDEEPCHAT2LEARN_TEST_NEW="new value"\nDEEPCHAT2LEARN_TEST_EXISTING=replace-me\n');
  try {
    loadDotEnv(file);
    assert.equal(process.env.DEEPCHAT2LEARN_TEST_NEW, 'new value');
    assert.equal(process.env.DEEPCHAT2LEARN_TEST_EXISTING, 'keep-me');
  } finally {
    delete process.env.DEEPCHAT2LEARN_TEST_NEW;
    if (original === undefined) delete process.env.DEEPCHAT2LEARN_TEST_EXISTING;
    else process.env.DEEPCHAT2LEARN_TEST_EXISTING = original;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('test runner can opt out of automatic dotenv loading without changing production defaults', () => {
  assert.equal(shouldLoadDotEnv({}), true);
  assert.equal(shouldLoadDotEnv({ DEEPCHAT2LEARN_SKIP_DOTENV: '1' }), false);
});

test('source limits use the approved relaxed defaults', () => {
  assert.deepEqual(getSourceLimits({}), {
    maxFiles: 10,
    maxFileBytes: 20_000_000,
    maxCombinedBytes: 50_000_000,
    maxPages: 300,
    maxWords: 150_000,
    maxPastedCharacters: 200_000
  });
});

test('source limits read the exact environment variable overrides', () => {
  assert.deepEqual(getSourceLimits({
    MAX_SOURCE_FILES: '11',
    MAX_SOURCE_FILE_BYTES: '1200',
    MAX_SOURCE_COMBINED_BYTES: '4500',
    MAX_SOURCE_PAGES: '12',
    MAX_SOURCE_WORDS: '1300',
    MAX_PASTED_SOURCE_CHARACTERS: '1400'
  }), {
    maxFiles: 11,
    maxFileBytes: 1200,
    maxCombinedBytes: 4500,
    maxPages: 12,
    maxWords: 1300,
    maxPastedCharacters: 1400
  });
});

test('retention config uses the privacy defaults', () => {
  assert.deepEqual(getRetentionConfig({}), {
    defaultMode: 'session',
    sessionTtlMs: 3_600_000,
    shortExpiryMs: 900_000,
    audioStorage: 'never'
  });
});

test('retention config reads the exact environment variable overrides', () => {
  assert.deepEqual(getRetentionConfig({
    SESSION_RETENTION_MODE: 'until_deleted',
    SESSION_TTL_MS: '7200000',
    SESSION_SHORT_EXPIRY_MS: '120000'
  }), {
    defaultMode: 'until_deleted',
    sessionTtlMs: 7_200_000,
    shortExpiryMs: 120_000,
    audioStorage: 'never'
  });
});

test('session budgets use the privacy defaults', () => {
  assert.deepEqual(getSessionBudgetConfig({}), {
    turnBudget: 50,
    modelTokenBudget: 120_000
  });
});

test('session budgets read the exact environment variable overrides', () => {
  assert.deepEqual(getSessionBudgetConfig({
    SESSION_TURN_BUDGET: '7',
    SESSION_MODEL_TOKEN_BUDGET: '4500'
  }), {
    turnBudget: 7,
    modelTokenBudget: 4500
  });
});

test('voice config uses patient academic conversation defaults', () => {
  assert.deepEqual(getVoiceConfig({}), {
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
});

test('voice config reads timing and retry overrides', () => {
  assert.deepEqual(getVoiceConfig({
    VOICE_AUTO_SUBMIT_DELAY_MS: '6000',
    VOICE_TRANSITION_DELAY_MS: '900',
    VOICE_REALTIME_SILENCE_MS: '7000',
    VOICE_REALTIME_WATCHDOG_MS: '0',
    VOICE_MAX_RECOGNITION_RETRIES: '12',
    VOICE_MAX_TRANSCRIPT_CHARACTERS: '16000',
    OPENAI_TEXT_TIMEOUT_MS: '90000',
    OPENAI_REALTIME_TIMEOUT_MS: '75000'
  }), {
    autoSubmitDelayMs: 6_000,
    transitionDelayMs: 900,
    realtimeSilenceMs: 7_000,
    realtimeWatchdogMs: 0,
    maxRecognitionRetries: 12,
    transcriptMaxCharacters: 16_000,
    textTimeoutMs: 90_000,
    sourceDigestTimeoutMs: 180_000,
    realtimeTimeoutMs: 75_000
  });
});

test('request body config allows base64 source uploads within the source file limit', () => {
  assert.deepEqual(getRequestConfig({}), { maxBodyBytes: 28_000_000 });
  assert.deepEqual(getRequestConfig({ MAX_REQUEST_BODY_BYTES: '32000000' }), { maxBodyBytes: 32_000_000 });
});

test('audio and text model configuration remain independent', () => {
  assert.equal(getAudioModel({ OPENAI_AUDIO_MODEL: 'gpt-realtime-mini', OPENAI_REALTIME_MODEL: 'gpt-realtime', OPENAI_TEXT_MODEL: 'gpt-5-mini' }), 'gpt-realtime-mini');
  assert.equal(getAudioModel({ OPENAI_AUDIO_MODEL: '', OPENAI_REALTIME_MODEL: 'gpt-realtime', OPENAI_TEXT_MODEL: 'gpt-5-mini' }), 'gpt-realtime');
  assert.equal(getAudioModel({ OPENAI_TEXT_MODEL: 'gpt-5-mini' }), 'gpt-realtime-mini');
});
