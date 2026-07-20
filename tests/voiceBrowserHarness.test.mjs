import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createAudioRecordingFixtures } from './helpers/audioRecordingFixtures.mjs';
export { createAudioRecordingFixtures };

const FIXTURE_DIR = new URL('./fixtures/voice-source/', import.meta.url);
const AUDIO_RECORDING_PATH = new URL('../public/audioRecording.js', import.meta.url);
const APP_PATH = new URL('../public/app.js', import.meta.url);

function flushMicrotasks() {
  return new Promise(resolve => setImmediate(resolve));
}

async function loadJson(name) {
  return JSON.parse(await fs.readFile(new URL(name, FIXTURE_DIR), 'utf8'));
}

function materializeSource(sourceFixture) {
  const warnings = Array.isArray(sourceFixture.warnings) ? sourceFixture.warnings.slice() : [];
  let cursor = 0;
  const pages = [];
  const text = (sourceFixture.segments || []).map((segment, index) => {
    const prefix = index === 0 ? '' : ' ';
    const start = cursor + prefix.length;
    const end = start + segment.text.length;
    pages.push({ page: segment.page, section: segment.section, start, end });
    cursor = end;
    return `${prefix}${segment.text}`;
  }).join('');
  return {
    id: sourceFixture.id,
    name: sourceFixture.name,
    text,
    pages,
    warnings
  };
}

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }

  toggle(name, force) {
    if (force === undefined) {
      if (this.values.has(name)) this.values.delete(name);
      else this.values.add(name);
      return this.values.has(name);
    }
    if (force) this.values.add(name);
    else this.values.delete(name);
    return force;
  }
}

class FakeElement {
  constructor(tagName = 'div', { id = '', classNames = [] } = {}) {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList(classNames);
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.children = [];
    this.parent = null;
    this.ownerDocument = null;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.files = [];
    this.textContent = '';
    this.innerHTML = '';
  }

  appendChild(child) {
    child.parent = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    if (child.id) this.ownerDocument?.register(child);
    return child;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'type') this.type = String(value);
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatchEvent(event) {
    const listeners = this.listeners.get(event.type) || [];
    const safeEvent = {
      preventDefault() {},
      stopPropagation() {},
      ...event,
      currentTarget: this,
      target: event.target || this
    };
    for (const listener of listeners) listener(safeEvent);
    return true;
  }

  click() {
    this.dispatchEvent({ type: 'click' });
  }

  focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  select() {
    this.selected = true;
  }

  querySelector(selector) {
    if (selector === 'button[type="submit"]') {
      return this.children.find(child => child.tagName === 'BUTTON' && child.type === 'submit') || null;
    }
    if (selector === 'input') {
      return this.children.find(child => child.tagName === 'INPUT') || null;
    }
    if (selector === 'option[value="source"]') {
      return this.options?.find(option => option.value === 'source') || null;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector === '.source-remove') {
      return this.children.filter(child => child.classList.contains('source-remove'));
    }
    return [];
  }

  closest(selector) {
    if (selector === '.mode-option') return this.modeOption || null;
    if (selector === '.source-remove' && this.classList.contains('source-remove')) return this;
    return this.parent?.closest?.(selector) || null;
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.byId = new Map();
    this.modeOptions = [];
    this.modeInputs = [];
    this.activeElement = null;
    this.body = new FakeElement('body', { id: 'body' });
    this.body.ownerDocument = this;
    this.activeElement = this.body;
  }

  register(element) {
    element.ownerDocument = this;
    if (element.id) this.byId.set(element.id, element);
    return element;
  }

  createElement(tagName) {
    return this.register(new FakeElement(tagName));
  }

  querySelector(selector) {
    if (selector === '#setupForm button[type="submit"]') return this.byId.get('setupForm')?.querySelector('button[type="submit"]') || null;
    if (selector.startsWith('#')) return this.byId.get(selector.slice(1)) || null;
    if (selector === '.mode-option.selected') return this.modeOptions.find(option => option.classList.contains('selected')) || null;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === '.mode-option') return this.modeOptions.slice();
    if (selector === 'input[name="mode"]') return this.modeInputs.slice();
    return [];
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatchEvent(event) {
    const listeners = this.listeners.get(event.type) || [];
    for (const listener of listeners) listener(event);
    return true;
  }

  execCommand() {
    return true;
  }
}

class FakeSpeechRecognition {
  constructor(harness) {
    this.harness = harness;
    harness.lastRecognition = this;
    this.started = false;
    this.startCount = 0;
    this.stopCount = 0;
    this.lang = 'en-US';
    this.interimResults = false;
  }

  start() {
    this.started = true;
    this.startCount += 1;
    this.onstart?.();
  }

  stop() {
    const active = this.started;
    this.started = false;
    this.stopCount += 1;
    if (active) this.onend?.();
  }

  emitResult(transcript, resultIndex = 0, isFinal = true) {
    this.onresult?.({
      resultIndex,
      results: [[{ transcript, isFinal }]]
    });
  }
}

class FakeSpeechSynthesis {
  constructor() {
    this.queue = [];
    this.active = null;
    this.cancelCount = 0;
  }

  speak(utterance) {
    this.queue.push(utterance.text);
    this.active = utterance;
  }

  cancel() {
    this.cancelCount += 1;
    this.active = null;
  }

  finish() {
    const utterance = this.active;
    this.active = null;
    utterance?.onend?.();
  }
}

class FakeSpeechSynthesisUtterance {
  constructor(text) {
    this.text = text;
    this.onend = null;
    this.onerror = null;
  }
}

class FakeDataChannel {
  constructor(harness) {
    this.harness = harness;
    this.readyState = 'open';
    this.sent = [];
  }

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }

  emitMessage(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

class FakeRTCPeerConnection {
  constructor(harness) {
    this.harness = harness;
    harness.lastPeer = this;
    harness.peers.push(this);
    this.connectionState = 'new';
  }

  addTrack(track) {
    this.track = track;
  }

  createDataChannel() {
    this.channel = new FakeDataChannel(this.harness);
    this.harness.lastDataChannel = this.channel;
    return this.channel;
  }

  async createOffer() {
    return { sdp: 'fake-offer-sdp' };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.connectionState = 'connected';
    if (!this.harness.noRemoteAudio && this.harness.remoteStream) {
      this.ontrack?.({
        streams: [this.harness.remoteStream],
        track: this.harness.remoteStream.getAudioTracks()[0]
      });
    }
    this.channel?.onopen?.();
    this.onconnectionstatechange?.();
  }

  close() {
    this.connectionState = 'closed';
  }
}

function createTimerController() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      timers.set(id, { fn, delay: Number(delay) || 0 });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async flushDue(maxDelay = 1000) {
      while ([...timers.values()].some(timer => timer.delay <= maxDelay)) {
        const current = [...timers.entries()].filter(([, timer]) => timer.delay <= maxDelay);
        for (const [id] of current) timers.delete(id);
        for (const [, timer] of current) timer.fn();
        await flushMicrotasks();
      }
    },
    pendingDelays() {
      return [...timers.values()].map(timer => timer.delay);
    }
  };
}

function buildSessionPublic(id, currentQuestion = '') {
  return {
    id,
    topic: 'Voice materials',
    goal: 'clarity',
    difficulty: 'beginner',
    feedbackStyle: 'supportive',
    questionLimit: 5,
    sourceMode: 'source',
    status: 'active',
    currentQuestion,
    turnCount: 0,
    sourceCount: 0,
    retentionMode: 'until_deleted',
    audioStorage: 'never',
    turnBudget: 200,
    modelTokenBudget: 132000,
    modelTokensUsed: 0,
    createdAt: new Date('2026-07-14T00:00:00.000Z').toISOString(),
    expiresAt: null
  };
}

function createFixtureServer(fixtures, { digestStatus = 'ready', denyMicrophone = false, currentQuestion = '', failVoiceTurns = 0, pendingVoiceTurn = null, realtimeConfigured = false } = {}) {
  const sessionId = 'session-voice-1';
  const token = 'token-voice-1';
  const paper = materializeSource(fixtures.paper.source);
  const complementarySources = fixtures.complementary.sources.map(materializeSource);
  const conflictSources = fixtures.conflict.sources.map(materializeSource);
  const incompleteSource = materializeSource(fixtures.incomplete.source);
  const sources = [
    {
      id: paper.id,
      name: paper.name,
      characters: paper.text.length,
      text: paper.text,
      digestStatus,
      warnings: [],
      digest: {
        mode: 'extractive',
        digestText: paper.text,
        keyPoints: [{ text: paper.text, evidence: paper.text }],
        openQuestions: []
      }
    },
    ...complementarySources.map(source => ({
      id: source.id,
      name: source.name,
      characters: source.text.length,
      text: source.text,
      digestStatus: 'ready',
      warnings: [],
      digest: {
        mode: 'extractive',
        digestText: source.text,
        keyPoints: [{ text: source.text, evidence: source.text }],
        openQuestions: []
      }
    })),
    ...conflictSources.map(source => ({
      id: source.id,
      name: source.name,
      characters: source.text.length,
      text: source.text,
      digestStatus: 'ready',
      warnings: [],
      digest: {
        mode: 'extractive',
        digestText: source.text,
        keyPoints: [{ text: source.text, evidence: source.text }],
        openQuestions: []
      }
    })),
    {
      id: incompleteSource.id,
      name: incompleteSource.name,
      characters: incompleteSource.text.length,
      text: incompleteSource.text,
      digestStatus,
      warnings: digestStatus === 'processing' ? [] : incompleteSource.warnings,
      digest: {
        mode: 'extractive',
        digestText: incompleteSource.text,
        keyPoints: [{ text: incompleteSource.text, evidence: incompleteSource.text }],
        openQuestions: []
      }
    }
  ];
  const voiceResponses = new Map([
    ['What is the paper\'s main argument?', {
      turn: { id: 'turn-1', status: 'answered' },
      answerText: fixtures.paper.source.segments[0].text,
      answerSpeechText: fixtures.paper.source.segments[0].text,
      knowledgeLayers: ['source'],
      citations: [{
        sourceId: paper.id,
        sourceName: paper.name,
        page: 1,
        section: 'Argument',
        excerpt: fixtures.paper.source.segments[0].text
      }],
      externalCitations: [],
      confidence: 'high',
      followUp: 'Would you like the supporting evidence next?',
      nextState: 'speaking_answer'
    }],
    ['What evidence supports it?', {
      turn: { id: 'turn-2', status: 'answered' },
      answerText: fixtures.paper.source.segments[1].text,
      answerSpeechText: fixtures.paper.source.segments[1].text,
      knowledgeLayers: ['source'],
      citations: [{
        sourceId: paper.id,
        sourceName: paper.name,
        page: 2,
        section: 'Results',
        excerpt: fixtures.paper.source.segments[1].text
      }],
      externalCitations: [],
      confidence: 'high',
      followUp: 'Would you like me to connect it with the other notes?',
      nextState: 'speaking_answer'
    }],
    ['How do the materials complement each other?', {
      turn: { id: 'turn-3', status: 'answered' },
      answerText: 'Your materials say spacing revisits ideas after forgetting, and retrieval practice strengthens memory by pulling the answer back from memory.',
      answerSpeechText: 'Your materials say spacing revisits ideas after forgetting, and retrieval practice strengthens memory by pulling the answer back from memory.',
      knowledgeLayers: ['source', 'llm'],
      citations: [{
        sourceId: complementarySources[0].id,
        sourceName: complementarySources[0].name,
        page: 1,
        section: 'Overview',
        excerpt: fixtures.complementary.sources[0].segments[0].text
      }, {
        sourceId: complementarySources[1].id,
        sourceName: complementarySources[1].name,
        page: 1,
        section: 'Overview',
        excerpt: fixtures.complementary.sources[1].segments[0].text
      }],
      externalCitations: [],
      confidence: 'medium',
      followUp: 'Do you want the disagreement between the studies too?',
      nextState: 'speaking_answer'
    }],
    ['Do any sources conflict?', {
      turn: { id: 'turn-4', status: 'answered' },
      answerText: 'Yes. Your materials disagree about whether spaced practice improves long-term retention for these students.',
      answerSpeechText: 'Yes. Your materials disagree about whether spaced practice improves long-term retention for these students.',
      knowledgeLayers: ['source'],
      citations: [{
        sourceId: conflictSources[0].id,
        sourceName: conflictSources[0].name,
        page: 4,
        section: 'Results',
        excerpt: fixtures.conflict.sources[0].segments[0].text
      }, {
        sourceId: conflictSources[1].id,
        sourceName: conflictSources[1].name,
        page: 6,
        section: 'Results',
        excerpt: fixtures.conflict.sources[1].segments[0].text
      }],
      externalCitations: [],
      confidence: 'medium',
      conflicts: [{
        description: 'One study reports improvement, and another reports no improvement.'
      }],
      ingestionWarnings: incompleteSource.warnings,
      sourceDigestStatus: digestStatus === 'processing'
        ? 'Source digest is still processing. You can keep typing while I get it ready.'
        : 'Source digest ready for grounded answers.',
      followUp: 'Would you like background context on why studies might disagree?',
      nextState: 'speaking_answer'
    }],
    [fixtures.general.question, {
      turn: { id: 'turn-5', status: 'answered' },
      answerText: fixtures.general.answerText,
      answerSpeechText: fixtures.general.answerSpeechText,
      knowledgeLayers: fixtures.general.knowledgeLayers,
      citations: fixtures.general.citations,
      externalCitations: fixtures.general.externalCitations,
      confidence: fixtures.general.confidence,
      unsupportedOrUnresolved: fixtures.general.unsupportedOrUnresolved,
      followUp: fixtures.general.followUp,
      nextState: 'speaking_answer'
    }]
  ]);

  return {
    sessionId,
    token,
    denyMicrophone,
    deleted: false,
    expireNextVoiceTurn: false,
    voiceTurnRequests: [],
    interrupts: [],
    fetchLifecycle: [],
    typedQuestions: [],
    failVoiceTurnsRemaining: failVoiceTurns,
    pendingVoiceTurn,
    async handle(url, options = {}) {
      const parsed = new URL(url, 'http://localhost');
      const pathname = parsed.pathname;
      const method = String(options.method || 'GET').toUpperCase();
      const body = options.body ? JSON.parse(options.body) : null;
      if (pathname === '/api/health') {
        return { ok: true, body: { capabilities: { textCoach: 'local', realtimeVoice: realtimeConfigured, storage: 'sqlite' }, connection: { realtimeVoice: realtimeConfigured ? 'configured' : 'not_configured' }, sourceLimits: { maxFiles: 10, maxFileBytes: 20_000_000 }, privacy: { defaultRetentionMode: 'until_deleted', audioStorage: 'never' } } };
      }
      if (pathname === '/api/sessions' && method === 'POST') {
        const session = buildSessionPublic(sessionId, 'What is the central claim?');
        session.sourceCount = sources.length;
        return { ok: true, body: { session, token, question: session.currentQuestion } };
      }
      if (pathname === `/api/sessions/${sessionId}` && method === 'GET') {
        if (this.deleted) return { ok: false, body: { error: { code: 'SESSION_NOT_FOUND', message: 'Session missing.' } } };
        const session = buildSessionPublic(sessionId, currentQuestion);
        session.sourceCount = sources.length;
        return { ok: true, body: { session } };
      }
      if (pathname === `/api/sessions/${sessionId}/sources/digest` && method === 'POST') {
        return { ok: true, body: { digestStatus } };
      }
      if (pathname === `/api/sessions/${sessionId}/sources` && method === 'GET') {
        if (this.deleted) return { ok: false, body: { error: { code: 'SESSION_NOT_FOUND', message: 'Session missing.' } } };
        return { ok: true, body: { sources, digestStatus } };
      }
      if (pathname === `/api/voice/sessions/${sessionId}/start` && method === 'POST') return { ok: true, body: { started: true } };
      if (pathname === `/api/voice/sessions/${sessionId}/pause` && method === 'POST') return { ok: true, body: { paused: true } };
      if (pathname === `/api/voice/sessions/${sessionId}/resume` && method === 'POST') return { ok: true, body: { resumed: true } };
      if (pathname === `/api/voice/sessions/${sessionId}/stop` && method === 'POST') return { ok: true, body: { stopped: true } };
      if (pathname.startsWith(`/api/voice/sessions/${sessionId}/turns/`) && pathname.endsWith('/interrupt') && method === 'POST') {
        this.interrupts.push(pathname.split('/').at(-2));
        return { ok: true, body: { interrupted: true } };
      }
      if (pathname === `/api/voice/sessions/${sessionId}/turns` && method === 'POST') {
        if (this.expireNextVoiceTurn) {
          this.expireNextVoiceTurn = false;
          return { ok: false, body: { error: { code: 'SESSION_EXPIRED', message: 'Your session expired.' } } };
        }
        if (this.pendingVoiceTurn) return this.pendingVoiceTurn;
        if (this.failVoiceTurnsRemaining > 0) {
          this.failVoiceTurnsRemaining -= 1;
          return { ok: false, body: { error: { code: 'VOICE_TEMPORARY_FAILURE', message: 'The academic voice service is temporarily unavailable.' } } };
        }
        this.fetchLifecycle.push('retrieving');
        this.voiceTurnRequests.push(body);
        const result = voiceResponses.get(body.transcript) || {
          turn: { id: `turn-${this.voiceTurnRequests.length}`, status: 'answered' },
          answerText: fixtures.general.answerText,
          answerSpeechText: fixtures.general.answerSpeechText,
          knowledgeLayers: ['llm'],
          citations: [],
          externalCitations: [],
          confidence: 'low',
          unsupportedOrUnresolved: ['I did not find that detail in your supplied materials.'],
          followUp: fixtures.general.followUp,
          nextState: 'speaking_answer'
        };
        return { ok: true, body: result };
      }
      if (pathname === `/api/sessions/${sessionId}/questions` && method === 'POST') {
        this.typedQuestions.push(body);
        return { ok: true, body: {
          answerText: fixtures.general.answerText,
          answerSpeechText: fixtures.general.answerSpeechText,
          knowledgeLayers: ['llm'],
          citations: [],
          externalCitations: [],
          confidence: 'medium',
          unsupportedOrUnresolved: fixtures.general.unsupportedOrUnresolved,
          followUp: fixtures.general.followUp
        } };
      }
      if (pathname === `/api/sessions/${sessionId}/complete` && method === 'POST') {
        return { ok: true, body: { summary: {
          completedTurns: this.voiceTurnRequests.length,
          overallScores: { clarity: 4, structure: 4, specificity: 3 },
          recurringStrengths: ['Clear focus'],
          recurringGaps: ['Add one concrete example'],
          sourceCount: sources.length,
          sourceNames: sources.map(source => source.name),
          nextPractice: 'Practice one shorter answer.'
        } } };
      }
      if (pathname === `/api/sessions/${sessionId}` && method === 'DELETE') {
        this.deleted = true;
        return { ok: true, body: { deleted: true } };
      }
      if (pathname === '/api/realtime/call' && method === 'POST') {
        return { ok: true, body: { sdp: 'fake-answer-sdp' } };
      }
      throw new Error(`Unhandled request ${method} ${pathname}`);
    }
  };
}

function createHarnessDom() {
  const document = new FakeDocument();
  const add = (tag, id, options = {}) => {
    const element = document.register(new FakeElement(tag, { id, classNames: options.classNames || [] }));
    if (options.type) {
      element.type = options.type;
      element.setAttribute('type', options.type);
    }
    document.body.appendChild(element);
    return element;
  };

  add('div', 'setupView');
  add('div', 'sessionView', { classNames: ['hidden'] });
  add('div', 'summaryView', { classNames: ['hidden'] });
  add('div', 'globalError', { classNames: ['hidden'] });
  add('div', 'serviceStatus');
  add('section', 'voicePermissionSetup', { classNames: ['voice-permission-setup', 'hidden'] });
  add('div', 'voiceAccessTitle');
  add('button', 'prepareVoiceButton', { type: 'button' });
  add('div', 'browser-audio-note');
  add('div', 'voiceLiveRegion');
  add('div', 'voiceStateLabel');
  add('div', 'voiceState');
  add('div', 'voiceStateGuidance');
  add('div', 'voiceCaptionText');
  add('div', 'microphoneStatus');
  add('div', 'recordingStatus');
  add('div', 'recordingTimer');
  add('div', 'recordingMode');
  add('div', 'sourceDigestStatus');
  add('div', 'sourceDigest');
  add('div', 'sourceBadge');
  add('div', 'additionalSourceStatus');
  add('div', 'sourceStatus');
  add('div', 'summaryStatus');
  add('div', 'transcriptStatus');
  add('div', 'summaryContent');
  add('div', 'questionText');
  add('div', 'progressLabel');
  add('div', 'progressBar');
  add('div', 'feedbackTitle');
  add('div', 'scoreList');
  add('div', 'strengths');
  add('div', 'improvement');
  add('div', 'exampleAnswer');
  add('div', 'evidenceText');
  add('div', 'sourceList');
  add('div', 'feedbackEmpty');
  add('div', 'feedbackContent', { classNames: ['hidden'] });
  add('aside', 'feedbackCard');
  add('div', 'transcriptPanel', { classNames: ['hidden'] });
  add('div', 'transcriptList');
  add('div', 'materialAnswer', { classNames: ['hidden'] });
  add('div', 'materialsPanel');
  add('div', 'sourceSetup', { classNames: ['hidden'] });
  add('div', 'sessionTopic');
  const topic = add('input', 'topic');
  topic.value = 'Academic discussion';
  const goal = add('select', 'goal');
  goal.value = 'structure';
  const difficulty = add('select', 'difficulty');
  difficulty.value = 'intermediate';
  const feedbackStyle = add('select', 'feedbackStyle');
  feedbackStyle.value = 'socratic';
  const questionLimit = add('select', 'questionLimit');
  questionLimit.value = '200';
  questionLimit.options = [{ value: '50', disabled: false }, { value: '200', disabled: false }];
  const skillProfile = add('select', 'skillProfile');
  skillProfile.value = 'auto';
  const retentionMode = add('select', 'retentionMode');
  retentionMode.value = 'session';
  add('div', 'questionLimitHelp');
  add('div', 'skillProfileStatus');
  add('input', 'answerText');
  add('input', 'sourceFile');
  add('input', 'sourceName');
  add('textarea', 'sourceText');
  add('input', 'additionalSourceFile');
  add('input', 'additionalSourceName');
  add('textarea', 'additionalSourceText');
  add('input', 'materialQuestion');
  const reviewToggle = add('input', 'reviewTranscriptToggle');
  reviewToggle.checked = false;
  const materialMode = add('select', 'materialMode');
  materialMode.options = [
    { value: 'general', disabled: false },
    { value: 'source', disabled: false }
  ];
  materialMode.value = 'source';
  materialMode.querySelector = selector => selector === 'option[value="source"]'
    ? materialMode.options.find(option => option.value === 'source')
    : null;

  const setupForm = add('form', 'setupForm');
  const setupSubmit = document.register(new FakeElement('button'));
  setupSubmit.type = 'submit';
  setupForm.appendChild(setupSubmit);
  setupForm.querySelector = selector => selector === 'button[type="submit"]' ? setupSubmit : null;
  setupForm.reset = () => {
    for (const child of setupForm.children) {
      if ('value' in child) child.value = '';
      if ('checked' in child) child.checked = false;
      if ('files' in child) child.files = [];
    }
  };

  add('form', 'materialQuestionForm');
  const ids = [
    'addSourceButton',
    'submitAnswer',
    'replayFeedback',
    'sourceQuestionButton',
    'askQuestion',
    'copyTranscript',
    'downloadTranscript',
    'downloadRecordingSummaryButton',
    'listenButton',
    'voiceConversationButton',
    'recordConversationButton',
    'stopRecordingButton',
    'discardRecordingButton',
    'downloadRecordingButton',
    'voiceInterruptButton',
    'voicePauseButton',
    'voiceStopButton',
    'voiceRetryButton',
    'liveVoiceButton',
    'endSession',
    'newSession',
    'deleteData'
  ];
  for (const id of ids) add('button', id, { type: 'button' });
  document.querySelector('#recordConversationButton')?.setAttribute('aria-pressed', 'false');
  document.querySelector('#stopRecordingButton').disabled = true;
  document.querySelector('#discardRecordingButton').disabled = true;
  document.querySelector('#downloadRecordingButton').disabled = true;
  document.querySelector('#downloadRecordingSummaryButton').disabled = true;

  const practiceInput = add('input', 'modePractice');
  practiceInput.name = 'mode';
  practiceInput.value = 'practice';
  const materialsInput = add('input', 'modeMaterials');
  materialsInput.name = 'mode';
  materialsInput.value = 'materials';
  materialsInput.checked = true;
  const practiceOption = add('label', 'modePracticeOption', { classNames: ['mode-option'] });
  practiceOption.querySelector = selector => selector === 'input' ? practiceInput : null;
  practiceInput.modeOption = practiceOption;
  practiceOption.appendChild(practiceInput);
  const materialsOption = add('label', 'modeMaterialsOption', { classNames: ['mode-option', 'selected'] });
  materialsOption.querySelector = selector => selector === 'input' ? materialsInput : null;
  materialsInput.modeOption = materialsOption;
  materialsOption.appendChild(materialsInput);
  document.modeOptions = [practiceOption, materialsOption];
  document.modeInputs = [practiceInput, materialsInput];
  return document;
}

async function createHarness(options = {}) {
  const fixtures = {
    paper: await loadJson('paper.json'),
    complementary: await loadJson('complementary-sources.json'),
    conflict: await loadJson('conflict.json'),
    incomplete: await loadJson('incomplete-extraction.json'),
    general: await loadJson('general-background-question.json')
  };
  const document = createHarnessDom();
  const timers = createTimerController();
  const recordingFixture = createAudioRecordingFixtures();
  const speechSynthesis = new FakeSpeechSynthesis();
  const server = createFixtureServer(fixtures, options);
  const sessionStorageWrites = [];
  const sessionStorageData = new Map([[
    'deepchat2learn-session',
    JSON.stringify({
      id: server.sessionId,
      token: server.token,
      mode: 'materials',
      transcript: [],
      materialHistory: [],
      draft: '',
      additionalSourceName: '',
      additionalSourceText: ''
    })
  ]]);
  const sessionStorage = {
    getItem(key) {
      return sessionStorageData.has(key) ? sessionStorageData.get(key) : null;
    },
    setItem(key, value) {
      sessionStorageWrites.push({ key, value: String(value) });
      if (recordingFixture.containsRecordingData(value) || String(value).includes('blob:fixture')) {
        throw new Error('Recording data reached sessionStorage');
      }
      sessionStorageData.set(key, String(value));
    },
    removeItem(key) {
      sessionStorageData.delete(key);
    }
  };

  const harness = {
    document,
    server,
    speechSynthesis,
    events: [],
    peers: [],
    mediaTracks: [],
    mediaConstraints: [],
    fetchBodies: [],
    recordingFixture,
    sessionStorageWrites,
    remoteStream: recordingFixture.remoteStream,
    noRemoteAudio: Boolean(options.noRemoteAudio),
    timers,
    sessionStorage,
    confirmResponse: true
  };

  const navigator = {
    userAgent: options.mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    platform: options.mobile ? 'iPhone' : 'Win32',
    maxTouchPoints: options.mobile ? 5 : 0,
    permissions: {
      async query() {
        return {
          state: options.microphonePermission || 'prompt',
          addEventListener() {}
        };
      }
    },
    mediaDevices: {
      async getUserMedia(constraints) {
        const callNumber = harness.mediaConstraints.length + 1;
        if (server.denyMicrophone || options.denyGetUserMediaCall === callNumber) {
          const error = new Error('Denied');
          error.name = 'NotAllowedError';
          throw error;
        }
        const track = new recordingFixture.MediaStreamTrackCtor('audio', `microphone-${harness.mediaTracks.length + 1}`);
        const stopTrack = track.stop.bind(track);
        track.stopped = false;
        track.stop = function stop() {
          this.stopped = true;
          stopTrack();
        };
        harness.mediaTracks.push(track);
        harness.mediaConstraints.push(constraints);
        return new recordingFixture.MediaStreamCtor([track]);
      }
    },
    clipboard: {
      async writeText() {}
    }
  };

  const fetchImpl = async (url, options = {}) => {
    harness.fetchBodies.push(options.body);
    if (recordingFixture.containsRecordingData(options.body) || String(options.body || '').includes('blob:fixture')) {
      throw new Error('Recording data reached fetch');
    }
    const response = await server.handle(url, options);
    return {
      ok: response.ok,
      async json() {
        return response.body;
      }
    };
  };

  const context = {
    console,
    document,
    navigator,
    sessionStorage,
    fetch: fetchImpl,
    btoa: value => Buffer.from(value, 'latin1').toString('base64'),
    window: null,
    Blob: recordingFixture.BlobCtor,
    MediaRecorder: recordingFixture.MediaRecorderCtor,
    AudioContext: recordingFixture.AudioContextCtor,
    webkitAudioContext: recordingFixture.AudioContextCtor,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    SpeechSynthesisUtterance: FakeSpeechSynthesisUtterance,
    SpeechRecognition: options.noSpeechRecognition ? undefined : class extends FakeSpeechRecognition {
      constructor() {
        super(harness);
      }
    },
    webkitSpeechRecognition: options.noSpeechRecognition ? undefined : class extends FakeSpeechRecognition {
      constructor() {
        super(harness);
      }
    },
    RTCPeerConnection: class extends FakeRTCPeerConnection {
      constructor() {
        super(harness);
      }
    }
  };
  context.window = context;
  context.window.document = document;
  context.window.navigator = navigator;
  context.window.sessionStorage = sessionStorage;
  context.window.fetch = fetchImpl;
  context.window.speechSynthesis = speechSynthesis;
  context.window.Blob = recordingFixture.BlobCtor;
  context.window.MediaRecorder = recordingFixture.MediaRecorderCtor;
  context.window.AudioContext = recordingFixture.AudioContextCtor;
  context.window.webkitAudioContext = recordingFixture.AudioContextCtor;
  context.window.listeners = new Map();
  context.window.addEventListener = (type, handler) => {
    if (!context.window.listeners.has(type)) context.window.listeners.set(type, []);
    context.window.listeners.get(type).push(handler);
  };
  context.window.removeEventListener = (type, handler) => {
    const listeners = context.window.listeners.get(type) || [];
    context.window.listeners.set(type, listeners.filter(item => item !== handler));
  };
  context.window.confirm = () => harness.confirmResponse;
  context.window.setTimeout = (fn, delay) => timers.setTimeout(fn, delay);
  context.window.clearTimeout = id => timers.clearTimeout(id);
  context.window.URL = recordingFixture.URLRef;
  context.setTimeout = context.window.setTimeout;
  context.clearTimeout = context.window.clearTimeout;
  context.URL = context.window.URL;

  document.addEventListener('deepchat2learn:voice', event => {
    harness.events.push(event.detail.type);
  });

  const recordingSource = await fs.readFile(AUDIO_RECORDING_PATH, 'utf8');
  vm.runInNewContext(recordingSource, context, { filename: path.resolve(AUDIO_RECORDING_PATH.pathname) });
  const source = await fs.readFile(APP_PATH, 'utf8');
  vm.runInNewContext(source, context, { filename: path.resolve(APP_PATH.pathname) });
  await flushMicrotasks();

  harness.context = context;
  harness.voiceCoordinator = context.window.voiceCoordinator;
  harness.recognition = () => harness.lastRecognition;
  harness.dataChannel = () => harness.lastDataChannel;
  harness.finishSpeech = async () => {
    speechSynthesis.finish();
    await flushMicrotasks();
    await timers.flushDue();
  };
  harness.flush = async (maxDelay = 1000) => {
    await flushMicrotasks();
    await timers.flushDue(maxDelay);
    await flushMicrotasks();
  };
  return harness;
}

test('local recording is disabled by default and voice can start without recording', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  assert.equal(harness.document.querySelector('#recordConversationButton').getAttribute('aria-pressed'), 'false');
  assert.equal(harness.recordingFixture.recorderInstances.length, 0);

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.equal(harness.voiceCoordinator.active, true);
  assert.equal(harness.recordingFixture.recorderInstances.length, 0);
  assert.match(harness.document.querySelector('#recordingStatus').textContent, /recording.+(?:off|unavailable|start a voice conversation)/i);
});

test('opted-in browser voice starts a separate microphone-only local recording', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  const recorder = harness.recordingFixture.lastRecorder;
  assert.ok(recorder, 'local recording should create a MediaRecorder');
  assert.equal(recorder.state, 'recording');
  assert.equal(recorder.stream.getAudioTracks().length, 1);
  assert.equal(harness.mediaConstraints.length, 2, 'browser speech uses a separate recording microphone stream after the voice permission check');
  assert.equal(harness.document.querySelector('#recordConversationButton').getAttribute('aria-pressed'), 'true');
  assert.match(harness.document.querySelector('#recordingMode').textContent, /microphone only/i);
  assert.match(harness.document.querySelector('#recordingMode').textContent, /spoken browser playback is not captured/i);
});

test('opted-in realtime voice records complete conversation when remote audio is attached', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#liveVoiceButton').click();
  await harness.flush();

  const recorder = harness.recordingFixture.lastRecorder;
  assert.ok(recorder, 'realtime recording should create a MediaRecorder');
  assert.equal(harness.mediaConstraints.length, 1, 'realtime voice should reuse the permission stream instead of requesting the microphone twice');
  assert.equal(recorder.state, 'recording');
  assert.equal(harness.recordingFixture.audioContexts.length, 1);
  assert.equal(harness.recordingFixture.audioContexts[0].sources.length, 2);
  assert.match(harness.document.querySelector('#recordingMode').textContent, /complete conversation/i);
});

test('realtime recording falls back to microphone-only when remote audio is unavailable without stopping voice', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?', noRemoteAudio: true });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#liveVoiceButton').click();
  await harness.flush();

  assert.equal(harness.voiceCoordinator.active, true);
  assert.equal(harness.recordingFixture.lastRecorder?.state, 'recording');
  assert.equal(harness.recordingFixture.audioContexts.length, 1);
  assert.equal(harness.recordingFixture.audioContexts[0].sources.length, 1);
  assert.match(harness.document.querySelector('#recordingMode').textContent, /microphone only/i);
  assert.match(harness.document.querySelector('#recordingStatus').textContent, /AI audio unavailable|microphone-only/i);
});

test('realtime recording upgrades to complete conversation when remote audio arrives late', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?', noRemoteAudio: true });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#liveVoiceButton').click();
  await harness.flush();

  const recorder = harness.recordingFixture.lastRecorder;
  assert.equal(recorder.state, 'recording');
  assert.equal(harness.recordingFixture.audioContexts.length, 1);
  assert.match(harness.document.querySelector('#recordingMode').textContent, /microphone only/i);

  harness.peers[0].ontrack?.({
    streams: [harness.remoteStream],
    track: harness.remoteStream.getAudioTracks()[0]
  });
  await harness.flush();

  assert.equal(harness.recordingFixture.recorderInstances.length, 1);
  assert.equal(recorder.startCount, 1);
  assert.equal(harness.recordingFixture.audioContexts[0].sources.length, 2);
  assert.match(harness.document.querySelector('#recordingMode').textContent, /complete conversation/i);
});

test('realtime recording relabels as microphone-only after remote audio disconnects', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#liveVoiceButton').click();
  await harness.flush();
  assert.match(harness.document.querySelector('#recordingMode').textContent, /complete conversation/i);

  harness.peers[0].connectionState = 'disconnected';
  harness.peers[0].onconnectionstatechange?.();

  assert.match(harness.document.querySelector('#recordingMode').textContent, /microphone only/i);
});

test('realtime reconnect preserves the borrowed recording microphone stream', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#liveVoiceButton').click();
  await harness.flush();

  const borrowedTrack = harness.mediaTracks.at(-1);
  const recorder = harness.recordingFixture.lastRecorder;
  assert.equal(recorder.state, 'recording');
  assert.equal(borrowedTrack.readyState, 'live');
  assert.match(harness.document.querySelector('#recordingMode').textContent, /complete conversation/i);

  harness.dataChannel().close();
  await harness.flush(600);

  assert.equal(harness.peers.length, 2);
  assert.equal(borrowedTrack.readyState, 'live');
  assert.equal(borrowedTrack.stopped, false);
  assert.equal(harness.mediaTracks.at(-1), borrowedTrack);
  assert.equal(harness.peers.at(-1).track, borrowedTrack);
  assert.equal(recorder.state, 'recording');
  assert.match(harness.document.querySelector('#recordingMode').textContent, /complete conversation|microphone only/i);
});

test('browser voice stays active when only the recording microphone request is denied', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?', denyGetUserMediaCall: 2 });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.equal(harness.voiceCoordinator.active, true);
  assert.equal(harness.recordingFixture.recorderInstances.length, 0);
  assert.match(harness.document.querySelector('#recordingStatus').textContent, /denied|unavailable/i);
  assert.equal(harness.server.voiceTurnRequests.length, 0);
  assert.equal(harness.fetchBodies.some(body => harness.recordingFixture.containsRecordingData(body) || String(body || '').includes('blob:fixture')), false);
});

test('recording pauses with voice pause and keeps recording through interruption', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  const recorder = harness.recordingFixture.lastRecorder;

  harness.document.querySelector('#voicePauseButton').click();
  await harness.flush();
  assert.equal(recorder.pauseCount, 1);
  assert.equal(recorder.state, 'paused');

  harness.document.querySelector('#voicePauseButton').click();
  await harness.flush();
  assert.equal(recorder.resumeCount, 1);
  assert.equal(recorder.state, 'recording');

  harness.document.querySelector('#voiceInterruptButton').click();
  await harness.flush();
  assert.equal(recorder.state, 'recording');
  assert.equal(recorder.stopCount, 0);
});

test('ending a session stops recording and preserves the ready blob for summary download', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  harness.recordingFixture.lastRecorder.emitChunk(harness.recordingFixture.makeRecordingChunk());

  harness.document.querySelector('#endSession').click();
  await harness.flush();

  assert.match(harness.document.querySelector('#recordingStatus').textContent, /ready to download/i);
  assert.equal(harness.document.querySelector('#downloadRecordingSummaryButton').disabled, false);

  harness.document.querySelector('#downloadRecordingSummaryButton').click();
  await harness.flush();

  assert.equal(harness.recordingFixture.createdObjectUrls.length, 1);
  assert.equal(harness.recordingFixture.createdObjectUrls[0].blob.__containsRecordingData, true);
});

test('canceled beforeunload preserves a ready recording and pagehide discards it', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  harness.recordingFixture.lastRecorder.emitChunk(harness.recordingFixture.makeRecordingChunk());
  harness.document.querySelector('#stopRecordingButton').click();
  await harness.flush();
  assert.equal(harness.document.querySelector('#downloadRecordingButton').disabled, false);

  harness.document.querySelector('#answerText').value = 'Unsubmitted answer draft';
  const beforeUnloadEvent = {
    type: 'beforeunload',
    defaultPrevented: false,
    returnValue: undefined,
    preventDefault() {
      this.defaultPrevented = true;
    }
  };
  for (const handler of harness.context.window.listeners.get('beforeunload') || []) handler(beforeUnloadEvent);

  assert.equal(beforeUnloadEvent.defaultPrevented, true);
  assert.equal(beforeUnloadEvent.returnValue, '');
  assert.equal(harness.document.querySelector('#downloadRecordingButton').disabled, false);
  assert.match(harness.document.querySelector('#recordingStatus').textContent, /ready to download/i);

  for (const handler of harness.context.window.listeners.get('pagehide') || []) handler({ type: 'pagehide' });

  assert.equal(harness.document.querySelector('#downloadRecordingButton').disabled, true);
  assert.equal(harness.document.querySelector('#downloadRecordingSummaryButton').disabled, true);
  assert.doesNotMatch(harness.document.querySelector('#recordingStatus').textContent, /ready to download/i);
});

test('new session discards retained recording data after a normal stop', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  harness.recordingFixture.lastRecorder.emitChunk(harness.recordingFixture.makeRecordingChunk());
  harness.document.querySelector('#stopRecordingButton').click();
  await harness.flush();
  assert.equal(harness.document.querySelector('#downloadRecordingButton').disabled, false);

  harness.document.querySelector('#newSession').click();
  await harness.flush();

  assert.equal(harness.document.querySelector('#downloadRecordingButton').disabled, true);
  assert.equal(harness.document.querySelector('#downloadRecordingSummaryButton').disabled, true);
  assert.equal(harness.document.querySelector('#recordConversationButton').getAttribute('aria-pressed'), 'false');
  assert.doesNotMatch(harness.document.querySelector('#recordingStatus').textContent, /ready to download/i);
});

test('expired-session recovery discards a retained ready recording', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  harness.recordingFixture.lastRecorder.emitChunk(harness.recordingFixture.makeRecordingChunk());
  harness.document.querySelector('#stopRecordingButton').click();
  await harness.flush();
  assert.equal(harness.document.querySelector('#downloadRecordingButton').disabled, false);

  harness.server.expireNextVoiceTurn = true;
  await assert.rejects(
    harness.voiceCoordinator.submitTranscript({ transcript: 'What is the paper\'s main argument?', confidence: null, reviewed: false, itemKey: 'expired-recording-1' }),
    /session expired/i
  );
  await harness.flush();

  assert.equal(harness.document.querySelector('#downloadRecordingButton').disabled, true);
  assert.equal(harness.document.querySelector('#downloadRecordingSummaryButton').disabled, true);
  assert.equal(harness.document.querySelector('#recordConversationButton').getAttribute('aria-pressed'), 'false');
  assert.doesNotMatch(harness.document.querySelector('#recordingStatus').textContent, /ready to download/i);
});

test('recording data never appears in voice turn requests or persisted client session', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#recordConversationButton').click();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  harness.recordingFixture.lastRecorder.emitChunk(harness.recordingFixture.makeRecordingChunk());

  await harness.voiceCoordinator.submitTranscript({ transcript: 'What is the paper\'s main argument?', confidence: null, reviewed: false, itemKey: 'privacy-1' });
  await harness.flush();

  assert.deepEqual(Object.keys(harness.server.voiceTurnRequests.at(-1)).sort(), [
    'idempotencyKey',
    'transcript',
    'transcriptConfidence',
    'transcriptReviewed'
  ]);
  assert.equal(harness.fetchBodies.some(body => harness.recordingFixture.containsRecordingData(body) || String(body || '').includes('blob:fixture')), false);
  assert.equal(harness.sessionStorageWrites.some(entry => harness.recordingFixture.containsRecordingData(entry.value) || entry.value.includes('blob:fixture')), false);
});

test('idle voice toolbar actions are disabled until a voice state makes them meaningful', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  assert.equal(harness.document.querySelector('#voicePauseButton').disabled, true);
  assert.equal(harness.document.querySelector('#voiceStopButton').disabled, true);
  assert.equal(harness.document.querySelector('#voiceInterruptButton').disabled, true);
  assert.equal(harness.document.querySelector('#voiceRetryButton').disabled, true);

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.equal(harness.document.querySelector('#voicePauseButton').disabled, false);
  assert.equal(harness.document.querySelector('#voiceStopButton').disabled, false);
  assert.equal(harness.document.querySelector('#voiceInterruptButton').disabled, false);
  assert.equal(harness.document.querySelector('#voiceRetryButton').disabled, true);
});

test('shared browser voice state attributes cover idle, ai-speaking, listening, processing, and retryable error', async () => {
  let resolvePending;
  const pendingVoiceTurn = new Promise(resolve => { resolvePending = resolve; });
  const harness = await createHarness({ currentQuestion: 'What is the study design?', pendingVoiceTurn });

  assert.equal(harness.document.querySelector('#voiceState').getAttribute('data-voice-state'), 'idle');
  assert.equal(harness.document.querySelector('#submitAnswer').getAttribute('data-voice-state'), 'idle');

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  assert.equal(harness.document.querySelector('#voiceState').getAttribute('data-voice-state'), 'ai-speaking');
  assert.equal(harness.document.querySelector('#voiceState').classList.contains('voice-state-active'), true);
  assert.equal(harness.document.querySelector('#voiceState').classList.contains('voice-processing-message'), true);
  assert.equal(harness.document.querySelector('#voiceCaptionText').classList.contains('voice-processing-message'), false);
  assert.equal(harness.document.querySelector('#voiceInterruptButton').disabled, false);

  await harness.finishSpeech();
  await harness.flush();
  assert.equal(harness.document.querySelector('#voiceState').getAttribute('data-voice-state'), 'listening');
  assert.equal(harness.document.querySelector('#voiceConversationButton').classList.contains('voice-state-active'), true);
  assert.equal(harness.document.querySelector('#voiceInterruptButton').disabled, true);

  const pending = harness.voiceCoordinator.submitTranscript({ transcript: 'What is the paper\'s main argument?', itemKey: 'processing-1' });
  await flushMicrotasks();
  assert.equal(harness.document.querySelector('#voiceState').getAttribute('data-voice-state'), 'processing');
  assert.equal(harness.document.querySelector('#submitAnswer').getAttribute('data-voice-state'), 'processing');
  assert.equal(harness.document.querySelector('#submitAnswer').classList.contains('voice-state-processing'), true);
  assert.equal(harness.document.querySelector('#voiceState').classList.contains('voice-processing-message'), true);
  assert.equal(harness.document.querySelector('#voiceCaptionText').classList.contains('voice-processing-message'), false);

  resolvePending({ ok: true, body: {
    turn: { id: 'processing-turn', status: 'answered' },
    answerText: 'Retrieval practice supports retention.',
    answerSpeechText: 'Retrieval practice supports retention.',
    knowledgeLayers: ['source'],
    citations: [],
    externalCitations: [],
    confidence: 'high',
    followUp: 'Would you like the mechanism next?'
  } });
  await pending;
  await harness.flush();

  const retryHarness = await createHarness({ failVoiceTurns: 1, currentQuestion: 'What is the study design?' });
  retryHarness.document.querySelector('#voiceConversationButton').click();
  await retryHarness.flush();
  await assert.rejects(
    retryHarness.voiceCoordinator.submitTranscript({ transcript: 'What is the paper\'s main argument?', itemKey: 'retryable-1' }),
    /academic voice service is temporarily unavailable/i
  );
  assert.equal(retryHarness.document.querySelector('#voiceState').getAttribute('data-voice-state'), 'retryable-error');
  assert.equal(retryHarness.document.querySelector('#voiceState').classList.contains('voice-state-error'), true);
  assert.equal(retryHarness.document.querySelector('#voiceRetryButton').classList.contains('voice-state-error'), true);
  assert.equal(retryHarness.document.querySelector('#answerText').value, 'What is the paper\'s main argument?');
  assert.equal(retryHarness.document.querySelector('#voiceRetryButton').disabled, false);
});

test('browser voice state renders user-speaking during interruption before returning to listening', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the paper\'s main argument?' });
  const recognition = harness.recognition();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  assert.equal(harness.document.querySelector('#voiceState').getAttribute('data-voice-state'), 'ai-speaking');

  harness.document.querySelector('#voiceInterruptButton').click();
  await harness.flush();
  assert.equal(harness.document.querySelector('#voiceState').getAttribute('data-voice-state'), 'user-speaking');
  assert.equal(harness.document.querySelector('#voiceState').classList.contains('voice-state-active'), true);

  recognition.emitResult('I want to answer now with more detail.', 1, false);
  await harness.flush();
  assert.equal(harness.document.querySelector('#voiceState').getAttribute('data-voice-state'), 'user-speaking');
});

test('voice completion renders completed before exiting to the summary view', async () => {
  const harness = await createHarness({
    currentQuestion: 'What is the paper\'s main argument?',
    pendingVoiceTurn: Promise.resolve({
      ok: true,
      body: {
        turn: { id: 'completed-turn', status: 'answered' },
        answerText: 'Retrieval practice supports retention.',
        answerSpeechText: 'Retrieval practice supports retention.',
        knowledgeLayers: ['source'],
        citations: [],
        externalCitations: [],
        confidence: 'high',
        done: true,
        nextState: 'speaking_answer'
      }
    })
  });

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  await harness.voiceCoordinator.submitTranscript({ transcript: 'What is the paper\'s main argument?', itemKey: 'completed-1' });
  await harness.flush();
  assert.equal(harness.speechSynthesis.active !== null, true);

  harness.speechSynthesis.finish();
  await flushMicrotasks();
  assert.equal(harness.document.querySelector('#voiceState').getAttribute('data-voice-state'), 'completed');
  assert.equal(harness.document.querySelector('#summaryView').classList.contains('hidden'), true);

  await harness.flush(750);
  assert.equal(harness.document.querySelector('#summaryView').classList.contains('hidden'), false);
});

test('voice harness handles permission denial without a physical microphone', async () => {
  const harness = await createHarness({ denyMicrophone: true });

  await assert.rejects(
    harness.voiceCoordinator.start({ transport: 'browser-fallback' }),
    /Microphone access could not be started/
  );

  assert.match(harness.document.querySelector('#voiceState').textContent, /Microphone access was denied/i);
  assert.match(harness.document.querySelector('#voiceState').textContent, /type your answer instead/i);
  assert.match(harness.document.querySelector('#microphoneStatus').textContent, /Microphone unavailable/i);
  assert.equal(harness.document.activeElement?.id, 'answerText');
});

test('voice access preflight stays hidden on desktop', async () => {
  const harness = await createHarness({ microphonePermission: 'prompt' });
  const panel = harness.document.querySelector('#voicePermissionSetup');

  assert.equal(panel.classList.contains('hidden'), true);
  assert.equal(harness.mediaConstraints.length, 0);
});

test('mobile voice access preflight appears only when browser permissions need attention', async () => {
  const harness = await createHarness({ mobile: true, microphonePermission: 'prompt' });
  const panel = harness.document.querySelector('#voicePermissionSetup');
  const button = harness.document.querySelector('#prepareVoiceButton');

  assert.equal(panel.classList.contains('hidden'), false);
  assert.match(harness.document.querySelector('#browser-audio-note').textContent, /allow microphone and browser speech recognition/i);

  button.click();
  await harness.flush();

  assert.equal(panel.classList.contains('hidden'), true);
  assert.match(harness.document.querySelector('#browser-audio-note').textContent, /ready/i);
  assert.equal(harness.mediaConstraints.length, 1);
});

test('mobile browsers without SpeechRecognition do not show a browser permission prompt', async () => {
  const harness = await createHarness({ mobile: true, noSpeechRecognition: true, microphonePermission: 'prompt' });
  const panel = harness.document.querySelector('#voicePermissionSetup');

  assert.equal(panel.classList.contains('hidden'), true);
  assert.match(harness.document.querySelector('#browser-audio-note').textContent, /live AI voice|typing/i);
});

test('mobile browser without SpeechRecognition uses configured Realtime voice from the main voice button', async () => {
  const harness = await createHarness({ mobile: true, noSpeechRecognition: true, realtimeConfigured: true, microphonePermission: 'granted' });

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.equal(harness.voiceCoordinator.active, true);
  assert.equal(harness.voiceCoordinator.transport, 'realtime');
  assert.ok(harness.dataChannel(), 'configured Realtime transport should be selected automatically');
  assert.equal(harness.mediaConstraints.length, 1, 'the permission stream should be reused for the live transport');
});

test('mobile browser prefers configured Realtime voice even when SpeechRecognition exists', async () => {
  const harness = await createHarness({ mobile: true, realtimeConfigured: true, microphonePermission: 'granted' });

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.equal(harness.voiceCoordinator.active, true);
  assert.equal(harness.voiceCoordinator.transport, 'realtime');
  assert.ok(harness.dataChannel(), 'mobile voice should use the capability-backed Realtime transport');
  assert.equal(harness.mediaConstraints.length, 1, 'mobile Realtime voice should reuse the permission stream');
});

test('unsupported speech recognition leaves the typed fallback focused and ready', async () => {
  const harness = await createHarness({ noSpeechRecognition: true });

  assert.equal(harness.document.querySelector('#listenButton').disabled, true);
  assert.match(harness.document.querySelector('#listenButton').textContent, /unavailable/i);

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.match(harness.document.querySelector('#voiceState').textContent, /speech recognition is unavailable/i);
  assert.match(harness.document.querySelector('#voiceState').textContent, /type your answer instead/i);
  assert.equal(harness.document.activeElement?.id, 'answerText');
});

test('voice harness reports accessible microphone after permission check', async () => {
  const harness = await createHarness();

  assert.match(harness.document.querySelector('#microphoneStatus').textContent, /not checked/i);

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.match(harness.document.querySelector('#microphoneStatus').textContent, /Microphone accessible/i);
});

test('source voice startup speaks the current academic question before listening', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design and target estimand?' });
  const recognition = harness.recognition();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.equal(recognition.started, false, 'recognition must stay off while the opening question is spoken');
  assert.equal(harness.speechSynthesis.queue.at(-1), 'What is the study design and target estimand?');

  await harness.finishSpeech();
  await harness.flush();
  await harness.flush(750);
  assert.equal(recognition.started, true);
});

test('voice keeps microphone input ready for interruption through the AI-to-microphone transition', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the paper\'s main argument?' });
  const recognition = harness.recognition();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.equal(harness.speechSynthesis.active !== null, true);
  assert.equal(recognition.started, false);
  harness.speechSynthesis.finish();
  await harness.flush();
  await harness.flush(750);
  assert.equal(recognition.started, true);
});

test('failed voice turns remain retryable with the same transcript', async () => {
  const harness = await createHarness({ failVoiceTurns: 1 });
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  await assert.rejects(
    harness.voiceCoordinator.submitTranscript({ transcript: 'What is the paper\'s main argument?', itemKey: 'retry-1' }),
    /academic voice service is temporarily unavailable/i
  );

  assert.equal(harness.document.activeElement?.id, 'voiceRetryButton');
  assert.match(harness.document.querySelector('#voiceState').textContent, /saved for retry/i);

  harness.document.querySelector('#voiceRetryButton').click();
  await harness.flush();
  assert.equal(harness.server.voiceTurnRequests.length, 1);
  assert.equal(harness.server.voiceTurnRequests[0].transcript, 'What is the paper\'s main argument?');
  assert.equal(harness.document.activeElement?.id, 'voiceRetryButton');
});

test('spoken questions expose a visible caption without a redundant repeat control', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the paper\'s main argument?' });

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.match(harness.document.querySelector('#voiceStateLabel').textContent, /AI speaking/i);
  assert.match(harness.document.querySelector('#voiceCaptionText').textContent, /What is the paper's main argument\?/i);
  assert.equal(harness.document.querySelector('#repeatSpokenLine'), null);
});

test('stopping during a pending turn prevents a stale answer from being rendered or spoken', async () => {
  let resolvePending;
  const pendingVoiceTurn = new Promise(resolve => { resolvePending = resolve; });
  const harness = await createHarness({ pendingVoiceTurn });
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  const pending = harness.voiceCoordinator.submitTranscript({ transcript: 'What is the paper\'s main argument?', itemKey: 'stale-1' });
  harness.voiceCoordinator.stop();
  resolvePending({ ok: true, body: {
    turn: { id: 'stale-turn', status: 'answered' },
    answerText: 'This answer arrived too late.',
    answerSpeechText: 'This answer arrived too late.',
    knowledgeLayers: ['llm'],
    citations: [],
    externalCitations: [],
    confidence: 'medium',
    followUp: 'Should I continue?'
  } });
  await pending;
  await harness.flush();

  assert.doesNotMatch(harness.document.querySelector('#materialAnswer').innerHTML, /This answer arrived too late/);
  assert.equal(harness.speechSynthesis.queue.includes('This answer arrived too late.'), false);
});

test('browser recognition tolerates more than three transient resets', async () => {
  const harness = await createHarness();
  const recognition = harness.recognition();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    recognition.onerror?.({ error: 'no-speech' });
    await harness.timers.flushDue(250);
    await flushMicrotasks();
  }

  assert.equal(harness.voiceCoordinator.state, 'listening');
});

test('source voice turns announce retrieval and digestion while the answer is pending', async () => {
  let resolvePending;
  const pendingVoiceTurn = new Promise(resolve => { resolvePending = resolve; });
  const harness = await createHarness({ pendingVoiceTurn });
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  const pending = harness.voiceCoordinator.submitTranscript({ transcript: 'What is the paper\'s main argument?', itemKey: 'digest-1' });
  await flushMicrotasks();
  assert.match(harness.document.querySelector('#voiceState').textContent, /retriev|digest/i);
  assert.equal(harness.document.querySelector('#voiceState').classList.contains('voice-processing-message'), true);
  assert.equal(harness.document.querySelector('#voiceCaptionText').classList.contains('voice-processing-message'), false);

  resolvePending({ ok: true, body: {
    turn: { id: 'digest-turn', status: 'answered' },
    answerText: 'The paper argues that retrieval practice supports retention.',
    answerSpeechText: 'The paper argues that retrieval practice supports retention.',
    knowledgeLayers: ['source'],
    citations: [{ sourceId: 'paper-1', sourceName: 'paper.pdf', page: 1, excerpt: 'Retrieval practice supports retention.' }],
    externalCitations: [],
    confidence: 'high',
    followUp: 'Would you like the mechanism?'
  } });
  await pending;
});

test('an explicit voice ending request plays the closing message and then opens the summary', async () => {
  const closingMessage = 'Thanks for the conversation. Your session is complete; here is your summary.';
  const harness = await createHarness({
    currentQuestion: 'What is the paper\'s main argument?',
    pendingVoiceTurn: {
      ok: true,
      body: {
        turn: { id: 'ending-turn', intent: 'end_session', status: 'answered' },
        answerText: closingMessage,
        answerSpeechText: closingMessage,
        knowledgeLayers: ['llm'],
        citations: [],
        externalCitations: [],
        confidence: 'high',
        followUp: null,
        countsAsAnswer: false,
        sessionEnded: true,
        closingMessage,
        done: true,
        nextState: 'completed'
      }
    }
  });
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  await harness.finishSpeech();
  await harness.flush();

  const result = await harness.voiceCoordinator.submitTranscript({ transcript: 'I am done', itemKey: 'end-voice-1' });
  assert.equal(result.sessionEnded, true);
  assert.match(harness.document.querySelector('#voiceState').textContent, /session is complete/i);

  await harness.finishSpeech();
  await harness.timers.flushDue(1000);
  await harness.flush();
  assert.equal(harness.document.querySelector('#summaryView').classList.contains('hidden'), false);
  assert.equal(harness.document.querySelector('#summaryStatus').textContent, closingMessage);
});

test('voice conversation automatically starts answer listening after its initial question finishes', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the paper\'s main argument?' });
  const recognition = harness.recognition();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  assert.equal(recognition.started, false);

  await harness.finishSpeech();
  await harness.flush();
  assert.equal(recognition.started, true);
  assert.match(harness.document.querySelector('#listenButton').textContent, /Stop listening/i);
});

test('browser voice keeps recognition off during AI speech and manual interrupt opens listening', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the paper\'s main argument?' });
  const recognition = harness.recognition();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.notEqual(harness.speechSynthesis.active, null);
  assert.equal(recognition.started, false);
  assert.equal(harness.document.querySelector('#listenButton').getAttribute('aria-pressed'), 'false');
  const cancelCount = harness.speechSynthesis.cancelCount;
  harness.document.querySelector('#voiceInterruptButton').click();
  await harness.flush();

  assert.ok(harness.speechSynthesis.cancelCount > cancelCount);
  assert.equal(harness.voiceCoordinator.state, 'listening');
  assert.equal(recognition.started, true);
  assert.equal(harness.document.querySelector('#voiceConversationButton').getAttribute('aria-pressed'), 'true');
});

test('browser voice ignores recognition results while AI speaks to prevent echo capture', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the paper\'s main argument?' });
  const recognition = harness.recognition();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.notEqual(harness.speechSynthesis.active, null);
  assert.equal(recognition.started, false);
  assert.equal(harness.document.querySelector('#listenButton').getAttribute('aria-pressed'), 'false');
  const requestCount = harness.server.voiceTurnRequests.length;

  recognition.emitResult('The AI said this sentence.', 0);
  await harness.flush();

  assert.equal(harness.server.voiceTurnRequests.length, requestCount);
  assert.equal(harness.voiceCoordinator.state, 'speaking');

  await harness.finishSpeech();
  await harness.flush();
  await harness.flush();
  await harness.flush(750);
  assert.equal(recognition.started, true);
});

test('voice mode auto-submits after five seconds of silence while typed mode keeps manual submit', async () => {
  const harness = await createHarness();
  const recognition = harness.recognition();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  await harness.finishSpeech();
  await harness.flush();

  recognition.emitResult('What is the paper\'s main argument?', 0);
  await harness.flush();
  assert.equal(harness.server.voiceTurnRequests.length, 0);

  await harness.timers.flushDue(4999);
  await flushMicrotasks();
  assert.equal(harness.server.voiceTurnRequests.length, 0);

  await harness.timers.flushDue(5000);
  await flushMicrotasks();
  assert.equal(harness.server.voiceTurnRequests.length, 1);

  harness.voiceCoordinator.stop();
  assert.equal(harness.document.querySelector('#submitAnswer').disabled, false);
});

test('browser voice accumulates multi-segment answers before five-second submission', async () => {
  const harness = await createHarness();
  const recognition = harness.recognition();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  await harness.finishSpeech();
  await harness.flush();

  recognition.emitResult('The study uses a longitudinal cohort.', 0);
  recognition.emitResult('It examines cognitive trajectories and later health.', 1);
  await harness.flush();

  const expected = 'The study uses a longitudinal cohort. It examines cognitive trajectories and later health.';
  assert.equal(harness.document.querySelector('#answerText').value, expected);
  assert.equal(harness.server.voiceTurnRequests.length, 0);

  await harness.timers.flushDue(4_999);
  await flushMicrotasks();
  assert.equal(harness.server.voiceTurnRequests.length, 0);

  await harness.timers.flushDue(5_000);
  await flushMicrotasks();
  assert.equal(harness.server.voiceTurnRequests.length, 1);
  assert.equal(harness.server.voiceTurnRequests[0].transcript, expected);
});

test('browser voice resets the silence window without submitting interim recognition text', async () => {
  const harness = await createHarness();
  const recognition = harness.recognition();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  await harness.finishSpeech();
  await harness.flush();

  recognition.emitResult('The study uses a longitudinal cohort.', 0, true);
  await harness.flush();
  recognition.emitResult('It examines cognitive trajectories and later health.', 1, false);
  await harness.flush();

  await harness.timers.flushDue(5_000);
  await flushMicrotasks();

  assert.equal(harness.server.voiceTurnRequests.length, 1);
  assert.equal(harness.server.voiceTurnRequests[0].transcript, 'The study uses a longitudinal cohort.');
});

test('browser voice replaces an updated final hypothesis at the same recognition index', async () => {
  const harness = await createHarness();
  const recognition = harness.recognition();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  await harness.finishSpeech();
  await harness.flush();

  recognition.emitResult('What is', 0, true);
  await harness.flush();
  recognition.emitResult('What is the distribution', 0, false);
  await harness.flush();
  assert.equal(harness.document.querySelector('#answerText').value, 'What is');

  recognition.emitResult('What is the distribution?', 0, true);
  await harness.flush();
  assert.equal(harness.document.querySelector('#answerText').value, 'What is the distribution?');

  await harness.timers.flushDue(5_000);
  await flushMicrotasks();
  assert.equal(harness.server.voiceTurnRequests.length, 1);
  assert.equal(harness.server.voiceTurnRequests[0].transcript, 'What is the distribution?');
});

test('browser voice keeps interim recognition out of the answer box until the transcript is finalized', async () => {
  const harness = await createHarness();
  const recognition = harness.recognition();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  await harness.finishSpeech();
  await harness.flush();

  recognition.emitResult('The study examines cognitive change', 0, false);
  await harness.flush();

  assert.equal(harness.document.querySelector('#answerText').value, '');
  assert.equal(harness.document.querySelector('#materialQuestion').value, '');

  recognition.emitResult('The study examines cognitive change and later health.', 0, true);
  await harness.flush();
  assert.equal(harness.document.querySelector('#answerText').value, 'The study examines cognitive change and later health.');
  assert.equal(harness.server.voiceTurnRequests.length, 0);
});

test('browser voice requires explicit interruption before listening during AI speech', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the paper\'s main argument?' });
  const recognition = harness.recognition();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();

  assert.notEqual(harness.speechSynthesis.active, null);
  assert.equal(recognition.started, false);
  const cancelCount = harness.speechSynthesis.cancelCount;
  recognition.emitResult('I think the main argument is about cognitive decline.', 0, false);
  await harness.flush();

  assert.equal(harness.speechSynthesis.cancelCount, cancelCount);
  assert.equal(harness.voiceCoordinator.state, 'speaking');
  assert.equal(harness.document.querySelector('#answerText').value, '');

  harness.document.querySelector('#answerText').value = 'The prior spoken answer should not carry forward.';
  harness.document.querySelector('#materialQuestion').value = 'The prior spoken question should not carry forward.';
  harness.voiceCoordinator.captureSegments = ['The stale recognition segment should not carry forward.'];
  harness.document.querySelector('#voiceInterruptButton').click();
  await harness.flush();
  assert.ok(harness.speechSynthesis.cancelCount > cancelCount);
  assert.equal(harness.voiceCoordinator.state, 'listening');
  assert.equal(recognition.started, true);
  assert.equal(harness.document.querySelector('#answerText').value, '');
  assert.equal(harness.document.querySelector('#materialQuestion').value, '');
  assert.equal(harness.voiceCoordinator.captureSegments.length, 0);
  assert.equal(JSON.parse(harness.sessionStorageWrites.at(-1).value).draft, '');
});

test('standalone speak-answer input auto-submits after five seconds of silence', async () => {
  const harness = await createHarness();
  const recognition = harness.recognition();

  harness.document.querySelector('#listenButton').click();
  await harness.flush();
  recognition.emitResult('What is the paper\'s main argument?', 0);
  await harness.flush();

  assert.equal(harness.document.querySelector('#answerText').value, 'What is the paper\'s main argument?');
  assert.match(harness.document.querySelector('#voiceState').textContent, /submit it after 5 seconds/i);
  assert.equal(harness.server.voiceTurnRequests.length, 0);

  await harness.timers.flushDue(4999);
  await flushMicrotasks();
  assert.equal(harness.server.voiceTurnRequests.length, 0);

  await harness.timers.flushDue(5000);
  await flushMicrotasks();
  assert.equal(harness.server.voiceTurnRequests.length, 1);
});

test('voice mode submits later recognition cycles when the browser resets resultIndex', async () => {
  const harness = await createHarness();
  const recognition = harness.recognition();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  await harness.finishSpeech();
  await harness.flush();

  recognition.emitResult('What is the paper\'s main argument?', 0);
  recognition.stop();
  await harness.flush(5000);
  assert.equal(harness.server.voiceTurnRequests.length, 1);

  await harness.finishSpeech();
  await harness.flush();
  recognition.emitResult('What evidence supports that argument?', 0);
  recognition.stop();
  await harness.flush(5000);
  assert.equal(harness.server.voiceTurnRequests.length, 2);
});

test('voice mode keeps visual coaching notes visible and restores controls when stopped', async () => {
  const harness = await createHarness();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  assert.equal(harness.document.querySelector('#feedbackCard').classList.contains('voice-feedback-hidden'), false);

  harness.voiceCoordinator.stop();
  assert.equal(harness.document.querySelector('#feedbackCard').classList.contains('voice-feedback-hidden'), false);
});

test('browser voice listening does not force-stop after the old seven-second cutoff', async () => {
  const harness = await createHarness();

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  await harness.finishSpeech();
  await harness.flush();

  assert.equal(harness.recognition().started, true);
  assert.equal(harness.voiceCoordinator.silenceTimer, null);
});

test('voice harness supports five spoken turns, interruption, typed fallback, and deterministic event order', async () => {
  const harness = await createHarness({ digestStatus: 'processing' });
  const recognition = harness.recognition();
  const transcripts = [
    'What is the paper\'s main argument?',
    'What evidence supports it?',
    'How do the materials complement each other?',
    'Do any sources conflict?',
    'What is metacognition, and how does it relate to studying?'
  ];

  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  assert.ok(recognition.startCount >= 1);
  assert.match(harness.document.querySelector('#sourceDigestStatus').textContent, /processing/i);

  recognition.emitResult(transcripts[0], 0);
  recognition.stop();
  await harness.flush(5000);
  assert.deepEqual(
    [harness.events[harness.events.indexOf('transcript_finalized')], harness.server.fetchLifecycle[0], harness.events[harness.events.indexOf('answer_approved')], harness.events[harness.events.indexOf('speech_started')]],
    ['transcript_finalized', 'retrieving', 'answer_approved', 'speech_started']
  );
  assert.match(harness.document.querySelector('#materialAnswer').innerHTML, /From your materials/);

  await harness.voiceCoordinator.interrupt();
  await harness.flush();
  assert.equal(harness.speechSynthesis.cancelCount > 0, true);
  assert.deepEqual(harness.server.interrupts, ['turn-1']);

  await harness.voiceCoordinator.resume();
  await harness.flush();

  for (const [index, transcript] of transcripts.slice(1).entries()) {
    recognition.emitResult(transcript, index + 1);
    recognition.stop();
    await harness.flush(5000);
    const answerMarkup = harness.document.querySelector('#materialAnswer').innerHTML;
    if (transcript === 'How do the materials complement each other?') {
      assert.match(answerMarkup, /From your materials/);
      assert.match(answerMarkup, /LLM background/);
    }
    if (transcript === 'Do any sources conflict?') {
      assert.match(answerMarkup, /Materials may disagree/);
      assert.match(answerMarkup, /Table text may be incomplete\./);
    }
    if (transcript === 'What is metacognition, and how does it relate to studying?') {
      assert.match(answerMarkup, /LLM background/);
      assert.match(answerMarkup, /I did not find that definition in your supplied materials\./);
      assert.match(harness.document.querySelector('#sourceDigestStatus').textContent, /I did not find that definition/i);
    }
    await harness.finishSpeech();
  }

  assert.equal(harness.server.voiceTurnRequests.length, 5);

  harness.document.querySelector('#materialQuestion').value = transcripts[4];
  harness.document.querySelector('#materialQuestionForm').dispatchEvent({
    type: 'submit',
    preventDefault() {}
  });
  await harness.flush();

  assert.equal(harness.server.typedQuestions.length, 1);
  assert.match(harness.document.querySelector('#materialAnswer').innerHTML, /LLM background/);
  assert.equal(harness.server.deleted, false);
  harness.document.querySelector('#deleteData').click();
  await harness.flush();
  assert.equal(harness.server.deleted, true);
});

test('voice harness routes realtime transcripts and approved speech through deterministic WebRTC events', async () => {
  const harness = await createHarness();

  harness.document.querySelector('#liveVoiceButton').click();
  await harness.flush();

  const channel = harness.dataChannel();
  assert.ok(channel, 'realtime data channel should be created');

  channel.emitMessage({
    type: 'deepchat2learn.turn.finalized',
    transcript: 'What evidence supports it?',
    item_id: 'rtc-item-1'
  });
  await harness.flush();

  assert.equal(harness.server.voiceTurnRequests.at(-1).transcript, 'What evidence supports it?');
  assert.equal(channel.sent.at(-1).type, 'response.create');
  assert.match(channel.sent.at(-1).response.instructions, /Students who used retrieval practice remembered more after one week/i);
});

test('realtime reconnect replaces only the failed transport and preserves both retry attempts', async () => {
  const harness = await createHarness();

  harness.document.querySelector('#liveVoiceButton').click();
  await harness.flush();
  const firstChannel = harness.dataChannel();
  assert.equal(harness.peers.length, 1);

  firstChannel.close();
  await harness.flush(600);
  assert.equal(harness.peers.length, 2);
  assert.equal(harness.voiceCoordinator.reconnectAttempts, 1);

  harness.dataChannel().close();
  await harness.flush(600);
  assert.equal(harness.peers.length, 3);
  assert.equal(harness.voiceCoordinator.reconnectAttempts, 2);
});

test('realtime microphone is disabled during the AI question and enabled after it ends', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#liveVoiceButton').click();
  await harness.flush();

  const liveTrack = harness.mediaTracks.at(-1);
  assert.equal(liveTrack.enabled, false);
  const audioConstraints = harness.mediaConstraints.at(-1).audio;
  assert.equal(audioConstraints.echoCancellation, true);
  assert.equal(audioConstraints.noiseSuppression, true);
  assert.equal(audioConstraints.autoGainControl, true);

  assert.equal(liveTrack.enabled, false);
  await harness.finishSpeech();
  await harness.flush(750);
  assert.equal(liveTrack.enabled, true);
  assert.equal(harness.voiceCoordinator.state, 'listening');
});

test('realtime ignores echo-like speech events during AI speech and manual interrupt opens input', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#liveVoiceButton').click();
  for (let attempt = 0; attempt < 6; attempt += 1) await harness.flush();
  const channel = harness.dataChannel();
  assert.notEqual(harness.speechSynthesis.active, null);
  assert.equal(harness.voiceCoordinator.state, 'speaking');
  assert.equal(harness.mediaTracks.at(-1).enabled, false);

  channel.emitMessage({ type: 'input_audio_buffer.speech_started' });
  await harness.flush();

  assert.equal(harness.mediaTracks.at(-1).enabled, false);
  assert.equal(channel.sent.some(message => message.type === 'response.cancel'), false);
  assert.equal(channel.sent.some(message => message.type === 'output_audio_buffer.clear'), false);

  harness.document.querySelector('#voiceInterruptButton').click();
  await harness.flush();
  assert.equal(harness.mediaTracks.at(-1).enabled, true);
  assert.equal(channel.sent.some(message => message.type === 'response.cancel'), true);
  assert.equal(channel.sent.some(message => message.type === 'output_audio_buffer.clear'), true);

  channel.emitMessage({ type: 'output_audio_buffer.stopped' });
  await harness.flush();
  assert.equal(harness.mediaTracks.at(-1).enabled, true);
});

test('realtime microphone stays disabled throughout AI speech and re-enables after output', async () => {
  const harness = await createHarness({ currentQuestion: 'What is the study design?' });

  harness.document.querySelector('#liveVoiceButton').click();
  for (let attempt = 0; attempt < 6; attempt += 1) await harness.flush();
  const channel = harness.dataChannel();
  const liveTrack = harness.mediaTracks.at(-1);

  assert.equal(harness.voiceCoordinator.state, 'speaking');
  assert.equal(liveTrack.enabled, false);
  channel.emitMessage({ type: 'response.audio_transcript.done', transcript: 'AI caption only' });
  await harness.flush();
  assert.equal(harness.document.querySelector('#voiceState').textContent, 'AI is asking the question. Please wait until it finishes.');
  assert.equal(harness.document.querySelector('#voiceCaptionText').textContent, 'AI caption only');

  channel.emitMessage({ type: 'output_audio_buffer.stopped' });
  await harness.flush();
  assert.equal(liveTrack.enabled, true);
});

test('starting a session enters the shared continuous voice conversation instead of one-turn listening', async () => {
  const harness = await createHarness();
  harness.voiceCoordinator.stop();

  harness.document.querySelector('#setupForm').dispatchEvent({
    type: 'submit',
    preventDefault() {}
  });
  await harness.flush();

  assert.equal(harness.voiceCoordinator.active, true);
  assert.equal(harness.voiceCoordinator.standaloneListening, false);
  assert.equal(harness.speechSynthesis.queue.at(-1), 'What is the central claim?');

  await harness.finishSpeech();
  await harness.flush();
  await harness.flush(750);
  assert.equal(harness.recognition().started, true);
});

test('session review shows the most recent exchange first and clears before a new session starts', async () => {
  const harness = await createHarness();
  harness.document.querySelector('#voiceConversationButton').click();
  await harness.flush();
  await harness.finishSpeech();
  await harness.flush();

  await harness.voiceCoordinator.submitTranscript({ transcript: 'What is the paper\'s main argument?', itemKey: 'review-1' });
  await harness.flush();
  await harness.finishSpeech();
  await harness.flush();
  await harness.voiceCoordinator.submitTranscript({ transcript: 'What evidence supports it?', itemKey: 'review-2' });
  await harness.flush();

  const reviewBeforeRestart = harness.document.querySelector('#transcriptList').innerHTML;
  assert.ok(reviewBeforeRestart.indexOf('What evidence supports it?') < reviewBeforeRestart.indexOf('What is the paper&#039;s main argument?'), reviewBeforeRestart);

  harness.voiceCoordinator.stop();
  harness.document.querySelector('#setupForm').dispatchEvent({ type: 'submit', preventDefault() {} });
  await harness.flush();

  assert.equal(harness.document.querySelector('#transcriptPanel').classList.contains('hidden'), true);
  assert.equal(harness.document.querySelector('#transcriptList').innerHTML, '');
});

test('browser source validation accepts files below the server-advertised twenty-megabyte limit', async () => {
  const harness = await createHarness();
  const file = {
    name: 'research-paper.pdf',
    type: 'application/pdf',
    size: 3_000_000,
    async arrayBuffer() { return new Uint8Array([37, 80, 68, 70]).buffer; }
  };
  const sourceFile = harness.document.querySelector('#sourceFile');
  sourceFile.files = [file];
  sourceFile.dispatchEvent({ type: 'change', target: sourceFile });
  await harness.flush();

  assert.match(harness.document.querySelector('#sourceStatus').textContent, /ready/i);
  assert.doesNotMatch(harness.document.querySelector('#sourceStatus').textContent, /could not be read/i);
});
