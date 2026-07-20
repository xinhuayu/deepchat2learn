import { getVoiceConfig } from './config.mjs';
import { HttpError } from './store.mjs';

const DEFAULT_TEXT_TIMEOUT_MS = getVoiceConfig().textTimeoutMs;
const DEFAULT_MAX_TRANSIENT_RETRIES = 1;

const TRANSIENT_ERROR_CODES = new Set([
  'MODEL_REQUEST_FAILED'
]);

const VALIDATION_ERROR_CODES = new Set([
  'MODEL_REQUEST_INVALID',
  'MODEL_OUTPUT_INVALID',
  'MODEL_OUTPUT_INCOMPLETE',
  'MODEL_REFUSAL'
]);

const NON_RETRYABLE_ERROR_CODES = new Set([
  'MODEL_NOT_CONFIGURED',
  'REALTIME_NOT_CONFIGURED',
  'REQUEST_TOO_LARGE',
  'INVALID_JSON',
  'SOURCE_LIMIT',
  'SESSION_COMPLETED',
  'SESSION_COMPLETE',
  'SESSION_TURN_BUDGET_EXCEEDED',
  'SESSION_MODEL_BUDGET_EXCEEDED',
  'QUESTION_REQUIRED',
  'QUESTION_TOO_LONG',
  'ANSWER_REQUIRED',
  'ANSWER_TOO_LONG',
  'TRANSCRIPT_REQUIRED',
  'TOPIC_REQUIRED',
  'GOAL_INVALID',
  'DIFFICULTY_INVALID',
  'FEEDBACK_STYLE_INVALID',
  'SOURCE_MODE_INVALID',
  'RETENTION_MODE_INVALID',
  'SKILL_INVALID',
  'SKILL_MODE_INVALID',
  'QUESTION_LIMIT_INVALID'
]);

export function createModelGateway({
  textCoach = null,
  realtimeFactory = null,
  config = {}
} = {}) {
  const timeoutMs = normalizePositiveInteger(config.timeoutMs, DEFAULT_TEXT_TIMEOUT_MS);
  const timeoutByTask = config.timeoutByTask && typeof config.timeoutByTask === 'object' ? config.timeoutByTask : {};
  const maxTransientRetries = normalizeRetryCount(config.maxTransientRetries, DEFAULT_MAX_TRANSIENT_RETRIES);
  const fallbackTextCoach = config.fallbackTextCoach || null;
  const summaryHandler = typeof config.summaryHandler === 'function' ? config.summaryHandler : null;

  return {
    async runTextTask({ task, input = {}, signal = null } = {}) {
      const safeTask = requireTask(task);
      const operation = resolveTextOperation({ task: safeTask, input, textCoach, summaryHandler });
      const taskTimeoutMs = normalizePositiveInteger(timeoutByTask[safeTask], timeoutMs);
      const attemptsAllowed = maxTransientRetries + 1;
      let attempt = 0;
      let lastTransient = null;

      while (attempt < attemptsAllowed) {
        attempt += 1;
        try {
          return await executeTextOperation({
            operation,
            task: safeTask,
            input,
            signal,
            timeoutMs: taskTimeoutMs,
            attempt
          });
        } catch (error) {
          const classified = classifyTextError(error, {
            task: safeTask,
            input,
            attempt,
            timeoutMs: taskTimeoutMs
          });
          if (!classified.retryable) throw classified;
          lastTransient = classified;
          if (attempt >= attemptsAllowed) break;
        }
      }

      if (fallbackTextCoach) {
        const fallbackOperation = resolveTextOperation({ task: safeTask, input, textCoach: fallbackTextCoach, summaryHandler });
        try {
          return await executeTextOperation({
            operation: fallbackOperation,
            task: safeTask,
            input,
            signal,
            timeoutMs: taskTimeoutMs,
            attempt: attemptsAllowed + 1,
            fallbackUsed: true
          });
        } catch (error) {
          throw classifyTextError(error, {
            task: safeTask,
            input,
            attempt: attemptsAllowed + 1,
            timeoutMs: taskTimeoutMs,
            fallbackUsed: true
          });
        }
      }

      throw lastTransient || buildGatewayError({
        status: 502,
        code: 'MODEL_GATEWAY_TRANSIENT',
        message: 'The model task could not be completed right now. Try again.',
        task: safeTask,
        input,
        retryable: true,
        attemptCount: attemptsAllowed,
        timeoutMs: taskTimeoutMs
      });
    },

    async createRealtimeCall({ session, sdp, signal = null } = {}) {
      if (!realtimeFactory || typeof realtimeFactory.createRealtimeCall !== 'function') {
        throw buildGatewayError({
          status: 503,
          code: 'MODEL_GATEWAY_VALIDATION',
          message: 'Realtime calling is not configured for this model gateway.',
          task: 'realtime_call',
          input: { sessionId: session?.id || null, sdp },
          retryable: false
        });
      }
      return realtimeFactory.createRealtimeCall({ session, sdp, signal });
    }
  };
}

function requireTask(task) {
  const normalized = String(task || '').trim();
  if (!normalized) {
    throw buildGatewayError({
      status: 400,
      code: 'MODEL_GATEWAY_VALIDATION',
      message: 'A model gateway task is required.',
      task: 'unknown',
      input: null,
      retryable: false
    });
  }
  return normalized;
}

function resolveTextOperation({ task, input, textCoach, summaryHandler }) {
  switch (task) {
    case 'question':
      return resolveQuestionOperation(textCoach, input);
    case 'topic_digest':
      return createCoachOperation(textCoach, 'topicDigest', input, task);
    case 'practice_evaluation':
      return createCoachOperation(textCoach, 'evaluateAnswer', input, task);
    case 'source_digest':
      if (Array.isArray(input?.sources)) {
        return createCoachOperation(textCoach, 'buildConsolidatedDigest', input, task);
      }
      return createCoachOperation(textCoach, 'digestSource', input, task);
    case 'source_answer':
      if (typeof textCoach?.composeBlendedAnswer === 'function') {
        return createCoachOperation(textCoach, 'composeBlendedAnswer', input, task);
      }
      return createCoachOperation(textCoach, 'groundedAnswer', input, task);
    case 'general_answer':
      return {
        run({ signal = null } = {}) {
          if (typeof textCoach?.generalAnswer !== 'function') {
            throw missingHandlerError(task, 'generalAnswer');
          }
          const normalized = normalizeGeneralAnswerInput(input);
          return textCoach.generalAnswer(normalized.question, { signal, context: normalized.context });
        }
      };
    case 'summary':
      if (summaryHandler) {
        return {
          run({ signal = null } = {}) {
            return summaryHandler(input);
          }
        };
      }
      if (typeof textCoach?.summary === 'function') {
        return createCoachOperation(textCoach, 'summary', input, task);
      }
      throw missingHandlerError(task, 'summaryHandler');
    default:
      throw buildGatewayError({
        status: 400,
        code: 'MODEL_GATEWAY_TASK_UNSUPPORTED',
        message: `Unsupported model task "${task}".`,
        task,
        input,
        retryable: false
      });
  }
}

function resolveQuestionOperation(textCoach, input) {
  const mode = String(input?.mode || '').trim().toLowerCase();
  if (!mode) {
    throw buildGatewayError({
      status: 400,
      code: 'MODEL_GATEWAY_VALIDATION',
      message: 'question.mode is required and must be one of initial, next, or source.',
      task: 'question',
      input,
      retryable: false
    });
  }
  if (mode === 'initial') {
    return createCoachOperation(textCoach, 'initialQuestion', omitMode(input), 'question');
  }
  if (mode === 'next') {
    return createCoachOperation(textCoach, 'nextQuestion', omitMode(input), 'question');
  }
  if (mode === 'source') {
    return createCoachOperation(textCoach, 'sourceQuestion', omitMode(input), 'question');
  }
  throw buildGatewayError({
    status: 400,
    code: 'MODEL_GATEWAY_VALIDATION',
    message: `question.mode "${mode}" is not supported. Use initial, next, or source.`,
    task: 'question',
    input,
    retryable: false
  });
}

function createCoachOperation(textCoach, methodName, input, task) {
  return {
    run({ signal = null } = {}) {
      if (typeof textCoach?.[methodName] !== 'function') {
        throw missingHandlerError(task, methodName);
      }
      return textCoach[methodName](input, { signal });
    }
  };
}

async function executeTextOperation({
  operation,
  task,
  input,
  signal,
  timeoutMs,
  attempt,
  fallbackUsed = false
}) {
  return await withTimeout(
    effectiveSignal => operation.run({ signal: effectiveSignal }),
    {
      task,
      input,
      signal,
      timeoutMs,
      attempt,
      fallbackUsed
    }
  );
}

async function withTimeout(run, { task, input, signal, timeoutMs, attempt, fallbackUsed }) {
  if (signal?.aborted) {
    throw buildGatewayError({
      status: 504,
      code: 'MODEL_GATEWAY_TIMEOUT',
      message: 'The model task was cancelled before it completed.',
      task,
      input,
      retryable: false,
      attemptCount: attempt,
      timeoutMs,
      fallbackUsed
    });
  }

  return await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const callerAbortHandler = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', callerAbortHandler, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
      reject(buildGatewayError({
        status: 504,
        code: 'MODEL_GATEWAY_TIMEOUT',
        message: 'The model task took too long to respond. Try again.',
        task,
        input,
        retryable: true,
        attemptCount: attempt,
        timeoutMs,
        fallbackUsed
      }));
    }, timeoutMs);

    let settled = false;
    if (signal) {
      const rejectOnCallerAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(buildGatewayError({
          status: 504,
          code: 'MODEL_GATEWAY_TIMEOUT',
          message: 'The model task was cancelled before it completed.',
          task,
          input,
          retryable: false,
          attemptCount: attempt,
          timeoutMs,
          fallbackUsed
        }));
      };
      signal.addEventListener('abort', rejectOnCallerAbort, { once: true });
    }

    Promise.resolve()
      .then(() => run(controller.signal))
      .then(result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', callerAbortHandler);
        resolve(result);
      })
      .catch(error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', callerAbortHandler);
        reject(error);
      });
  });
}

function classifyTextError(error, { task, input, attempt, timeoutMs, fallbackUsed = false }) {
  if (error?.code === 'MODEL_GATEWAY_TIMEOUT') return error;

  if (isTimeoutError(error)) {
    return buildGatewayError({
      status: 504,
      code: 'MODEL_GATEWAY_TIMEOUT',
      message: error?.message || 'The model task took too long to respond. Try again.',
      task,
      input,
      retryable: true,
      attemptCount: attempt,
      timeoutMs,
      fallbackUsed,
      cause: error
    });
  }

  if (isValidationError(error)) {
    return buildGatewayError({
      status: error?.status || 400,
      code: 'MODEL_GATEWAY_VALIDATION',
      message: error?.message || 'The model task input or output was invalid.',
      task,
      input,
      retryable: false,
      attemptCount: attempt,
      timeoutMs,
      fallbackUsed,
      cause: error
    });
  }

  if (isNonRetryableError(error)) {
    return error;
  }

  if (isTransientError(error)) {
    return buildGatewayError({
      status: error?.status || 502,
      code: 'MODEL_GATEWAY_TRANSIENT',
      message: error?.message || 'The model task could not be completed right now. Try again.',
      task,
      input,
      retryable: true,
      attemptCount: attempt,
      timeoutMs,
      fallbackUsed,
      cause: error
    });
  }

  return buildGatewayError({
    status: error?.status || 502,
    code: 'MODEL_GATEWAY_TRANSIENT',
    message: error?.message || 'The model task could not be completed right now. Try again.',
    task,
    input,
    retryable: true,
    attemptCount: attempt,
    timeoutMs,
    fallbackUsed,
    cause: error
  });
}

function isTimeoutError(error) {
  return error?.name === 'AbortError'
    || error?.code === 'MODEL_TIMEOUT'
    || error?.status === 504;
}

function isValidationError(error) {
  if (error?.code === 'MODEL_GATEWAY_VALIDATION' || error?.code === 'MODEL_GATEWAY_TASK_UNSUPPORTED') return true;
  if (VALIDATION_ERROR_CODES.has(error?.code)) return true;
  if (error instanceof TypeError) return true;
  return [400, 422].includes(error?.status);
}

function isNonRetryableError(error) {
  if (NON_RETRYABLE_ERROR_CODES.has(error?.code)) return true;
  return [401, 403, 404, 409, 413, 429].includes(error?.status);
}

function isTransientError(error) {
  if (TRANSIENT_ERROR_CODES.has(error?.code)) return true;
  if (typeof error?.status === 'number' && error.status >= 500 && error.status < 600) {
    return !VALIDATION_ERROR_CODES.has(error?.code);
  }
  return false;
}

function normalizeGeneralQuestion(input) {
  if (typeof input === 'string') return input;
  const question = String(input?.question || '').trim();
  if (!question) {
    throw buildGatewayError({
      status: 400,
      code: 'MODEL_GATEWAY_VALIDATION',
      message: 'general_answer.question is required.',
      task: 'general_answer',
      input,
      retryable: false
    });
  }
  return question;
}

function normalizeGeneralAnswerInput(input) {
  if (typeof input === 'string') return { question: normalizeGeneralQuestion(input), context: null };
  const question = normalizeGeneralQuestion(input);
  const context = input && typeof input === 'object'
    ? {
      topic: input.topic || null,
      currentQuestion: input.currentQuestion || null,
      topicDigest: input.topicDigest || null,
      conversationHistory: Array.isArray(input.conversationHistory) ? input.conversationHistory : []
    }
    : null;
  return { question, context };
}

function missingHandlerError(task, handlerName) {
  return buildGatewayError({
    status: 503,
    code: 'MODEL_GATEWAY_VALIDATION',
    message: `The model gateway is missing the ${handlerName} handler for task "${task}".`,
    task,
    input: null,
    retryable: false
  });
}

function buildGatewayError({
  status,
  code,
  message,
  task,
  input,
  retryable,
  attemptCount = null,
  timeoutMs = null,
  fallbackUsed = false,
  cause = null
}) {
  const error = new HttpError(status, message, code);
  error.retryable = Boolean(retryable);
  error.details = {
    task,
    retryable: Boolean(retryable),
    ...(attemptCount === null ? {} : { attemptCount }),
    ...(timeoutMs === null ? {} : { timeoutMs }),
    ...(fallbackUsed ? { fallbackUsed: true } : {}),
    ...(cause?.code ? { causeCode: cause.code } : {}),
    ...(input === null || input === undefined ? {} : { input: snapshotInput(input) })
  };
  if (cause) error.cause = cause;
  return error;
}

function snapshotInput(input) {
  if (typeof input === 'string') {
    return { question: input.slice(0, 1_000) };
  }
  if (!input || typeof input !== 'object') return input;
  const snapshot = {};
  for (const key of ['mode', 'question', 'answer', 'transcript', 'topic', 'userQuestion', 'currentQuestion', 'previousQuestion', 'sdp']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      snapshot[key] = input[key].slice(0, 2_000);
    }
  }
  if (input.id) snapshot.id = String(input.id);
  if (input.name) snapshot.name = String(input.name);
  if (input.sourceId) snapshot.sourceId = String(input.sourceId);
  if (Array.isArray(input.sources)) snapshot.sourceCount = input.sources.length;
  if (Array.isArray(input.chunks)) snapshot.chunkCount = input.chunks.length;
  if (typeof input.text === 'string') snapshot.textCharacters = input.text.length;
  return snapshot;
}

function omitMode(input) {
  const copy = { ...(input || {}) };
  delete copy.mode;
  return copy;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRetryCount(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
