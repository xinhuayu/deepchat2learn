import { HttpError } from './store.mjs';
import { getAudioModel, getVoiceConfig, maxQuestionsForSourceMode } from './config.mjs';

const realtimeUrl = 'https://api.openai.com/v1/realtime/client_secrets';
const callsUrl = 'https://api.openai.com/v1/realtime/calls';
const defaultVoiceConfig = getVoiceConfig();
const defaultTimeoutMs = defaultVoiceConfig.realtimeTimeoutMs;
const defaultSilenceMs = defaultVoiceConfig.realtimeSilenceMs;
const defaultQuestionLimit = maxQuestionsForSourceMode('none');

export function buildApprovedSpeechRequest(answerSpeechText, externalResearchSpeechText = '') {
  const text = String(answerSpeechText || '').trim();
  if (!text) throw new TypeError('answerSpeechText is required.');
  const external = String(externalResearchSpeechText || '').trim();
  return {
    type: 'response.create',
    response: {
      instructions: external
        ? `Speak exactly this approved answer, then clearly say the separate external-research segment. Do not add or change anything: ${text} ${external}`
        : `Speak exactly this approved answer. Do not add or change anything: ${text}`
    }
  };
}

export function normalizeRealtimeEvent(message) {
  if (!message || typeof message !== 'object') return null;
  if (['conversation.item.input_audio_transcription.completed', 'deepchat2learn.turn.finalized'].includes(message.type) && String(message.transcript || '').trim()) {
    return {
      type: 'transcript_finalized',
      transcript: String(message.transcript).trim(),
      itemId: message.item_id || null
    };
  }
  if (message.type === 'deepchat2learn.answer.approved' && String(message.answerSpeechText || '').trim()) {
    return {
      type: 'answer_approved',
      answerSpeechText: String(message.answerSpeechText).trim(),
      ...(String(message.externalResearchSpeechText || '').trim()
        ? { externalResearchSpeechText: String(message.externalResearchSpeechText).trim() }
        : {})
    };
  }
  if (message.type === 'output_audio_buffer.started') return { type: 'speech_started' };
  if (message.type === 'output_audio_buffer.stopped') return { type: 'speech_ended' };
  if (message.type === 'input_audio_buffer.speech_started') return { type: 'listening' };
  if (['error', 'deepchat2learn.turn.error'].includes(message.type)) {
    return {
      type: 'recoverable_error',
      message: message.error?.message || 'Live voice reported an error.'
    };
  }
  return null;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, timeoutCode, timeoutMessage, failureCode, failureMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new HttpError(504, timeoutMessage, timeoutCode);
    throw new HttpError(502, failureMessage, failureCode);
  } finally {
    clearTimeout(timer);
  }
}

function instructions(topic, questionLimit) {
  return [
    'You are the voice layer for a supportive speaking coach.',
    `The user is practicing: ${topic}.`,
    `The session has at most ${questionLimit} questions.`,
    'Ask one concise question at a time and wait for the user to finish.',
    'Do not automatically answer after user audio; wait for a client response.create event so the backend can evaluate the finalized transcript first.',
    'Wait for the browser turn-taking gate before treating input as user speech; never treat your own output echo as a user turn.',
    'Keep spoken responses short and show captions when possible.',
    'Do not invent source citations or answer source questions without an approved backend answer.',
    'The typed coaching path remains available if audio fails.'
  ].join(' ');
}

export async function createRealtimeSession({ apiKey, topic, questionLimit = defaultQuestionLimit, model = null, fetchImpl = fetch, timeoutMs = defaultTimeoutMs }) {
  if (!apiKey) throw new HttpError(503, 'Live AI voice is not configured yet. Continue by typing or use browser voice input.', 'REALTIME_NOT_CONFIGURED');
  const audioModel = model || getAudioModel();
  const response = await fetchWithTimeout(fetchImpl, realtimeUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: audioModel,
        instructions: instructions(topic, questionLimit),
        audio: { output: { voice: 'marin' } }
      }
    })
  }, timeoutMs, 'REALTIME_TIMEOUT', 'Live AI voice took too long to initialize. Continue by typing.', 'REALTIME_INIT_FAILED', 'Live AI voice could not be initialized. Continue by typing.');
  if (!response.ok) throw new HttpError(502, 'Live AI voice could not be initialized. Continue by typing.', 'REALTIME_INIT_FAILED');
  const payload = await response.json();
  return {
    ...payload,
    clientSecret: payload?.clientSecret || payload?.value || payload?.client_secret?.value || null,
    model: payload?.model || audioModel
  };
}

export async function createRealtimeCall({ apiKey, sdp, topic, questionLimit = defaultQuestionLimit, model = null, fetchImpl = fetch, timeoutMs = defaultTimeoutMs, silenceMs = defaultSilenceMs }) {
  if (!apiKey) throw new HttpError(503, 'Live AI voice is not configured yet. Continue by typing or use browser voice input.', 'REALTIME_NOT_CONFIGURED');
  if (typeof sdp !== 'string' || !sdp.trim()) throw new HttpError(400, 'A WebRTC offer is required.', 'SDP_REQUIRED');
  const audioModel = model || getAudioModel();
  const form = new FormData();
  form.append('sdp', new Blob([sdp], { type: 'application/sdp' }), 'offer.sdp');
  form.append('session', JSON.stringify({
    type: 'realtime',
    model: audioModel,
    instructions: instructions(topic, questionLimit),
    audio: {
      input: {
        transcription: { model: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe', language: 'en' },
        turn_detection: { type: 'server_vad', create_response: false, silence_duration_ms: silenceMs }
      },
      output: { voice: 'marin' }
    }
  }));
  const response = await fetchWithTimeout(fetchImpl, callsUrl, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form }, timeoutMs, 'REALTIME_TIMEOUT', 'Live AI voice took too long to connect. Continue by typing.', 'REALTIME_CALL_FAILED', 'Live AI voice could not connect. Continue by typing.');
  if (!response.ok) throw new HttpError(502, 'Live AI voice could not connect. Continue by typing.', 'REALTIME_CALL_FAILED');
  return { sdp: await response.text(), model: audioModel };
}
