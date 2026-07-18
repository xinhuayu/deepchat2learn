import { locateEvidence } from './evidence.mjs';
import { createConversationAgenda } from './conversationAgenda.mjs';

function clamp(value) {
  return Math.max(1, Math.min(5, value));
}

function words(text) {
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function academicTerms(text) {
  const stopWords = new Set(['a', 'about', 'after', 'again', 'does', 'from', 'have', 'into', 'is', 'my', 'one', 'that', 'the', 'their', 'this', 'what', 'when', 'which', 'with', 'would', 'your']);
  return new Set(words(text).filter(word => !stopWords.has(word)));
}

function answerAnchor(answer) {
  const sentence = String(answer || '').split(/(?<=[.!?])\s+/).find(Boolean) || String(answer || '');
  return sentence.replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ').replace(/[.?!]+$/, '') || 'your answer';
}

function buildAcademicResponse({ topic, answer, assessmentLabel }) {
  const lower = `${topic} ${answer}`.toLowerCase();
  if (/photosynthesis/.test(lower)) return 'Academically, photosynthesis converts light energy into chemical energy, so your response connects to the central biological mechanism.';
  if (/cohort study|cohort/.test(lower)) return 'Academically, a cohort study defines groups by exposure and observes later outcomes, so the time order in your response is important.';
  if (/temporality/.test(lower)) return 'In epidemiology, temporality means the exposure must precede the outcome; it is necessary for causal interpretation but does not prove causality by itself.';
  if (assessmentLabel === 'off_topic') return `Academic connection: your response mentions ${answerAnchor(answer)}, but it does not yet address the stated question about ${topic}.`;
  if (assessmentLabel === 'partial') return `Academic connection: your response addresses ${answerAnchor(answer)}; add the mechanism, evidence, or limitation that links it to ${topic}.`;
  return `Academic connection: your response addresses ${answerAnchor(answer)} and relates it to ${topic}.`;
}

function questionForStage(stage, topic, { source = false, sourceCount = 0 } = {}) {
  if (stage === 'orientation') return source ? (sourceCount > 1 ? 'What are these materials mainly about?' : 'What is this paper mainly about?') : `What is the main research question or idea about ${topic}?`;
  if (stage === 'design') return source ? 'What study design or approach does the material use?' : 'What approach or example should we examine next?';
  if (stage === 'population') return source ? 'Who is the target population or sample in this material?' : `What population, participants, or case group matters most for ${topic}?`;
  if (stage === 'measures') return source ? 'What key concept, variable, or measure should we clarify?' : `What key concept, variable, or measure matters most for ${topic}?`;
  if (stage === 'findings') return source ? 'What evidence or result matters most?' : `What result or evidence best supports the main idea about ${topic}?`;
  if (stage === 'interpretation') return source ? 'How should we interpret that result?' : `How should we interpret that evidence about ${topic}?`;
  return source ? 'What limitation or implication should we discuss next?' : `What limitation or implication of ${topic} should we examine next?`;
}

export function createCoach() {
  return {
    initialQuestion({ topic, sourceMode = 'none', sources = [], sourceDigest = null }) {
      if (sourceMode === 'source' || sources.length || sourceDigest) return 'What is this paper or material mainly about?';
      return `What is the main research question or idea you want to explore about "${topic}"?`;
    },

    nextQuestion({ topic, sources = [], conversationHistory = [], conversationTurnCount = null }) {
      const completedTurns = Number.isInteger(conversationTurnCount)
        ? conversationTurnCount
        : Math.max(0, (Array.isArray(conversationHistory) ? conversationHistory.length : 0) - 1);
      return questionForStage(createConversationAgenda({ completedTurns }).currentStage, topic, { source: sources.length > 0, sourceCount: sources.length });
    },

    evaluateAnswer({ topic, question, answer, turnIndex, feedbackStyle = 'supportive' }) {
      const count = words(answer).length;
      const hasExample = /\b(for example|such as|because|when|experience|instance)\b/i.test(answer);
      const clearStart = /\b(the main|my|this|it is|i would|first)\b/i.test(answer);
      const strengths = [
        clearStart ? 'You gave the answer a direct starting point.' : 'You engaged with the question instead of avoiding it.',
        hasExample ? 'You added a concrete detail that makes the idea easier to remember.' : 'You kept the response focused on the topic.'
      ];
      const baseImprovement = count < 18
        ? 'Add one concrete detail or example so the listener can see how the idea works.'
        : 'Make the structure easier to follow by stating the main point, evidence, and takeaway in that order.';
      const improvement = feedbackStyle === 'direct'
        ? `Most important change: ${baseImprovement}`
        : feedbackStyle === 'socratic'
          ? `What could you add or reorder so the listener can see the idea more clearly?`
          : baseImprovement;
      const exampleAnswer = count < 18
        ? `${answer.replace(/[.?!]+$/, '')}. For example, you could briefly show how this appears in a real situation.`
        : `A stronger version would begin with the main point, support it with one example, and end with why it matters.`;
      const base = count < 8 ? 2 : count < 18 ? 3 : 4;
      const relevantTerms = new Set([...academicTerms(topic), ...academicTerms(question)]);
      const answerTerms = academicTerms(answer);
      const overlap = [...relevantTerms].filter(term => answerTerms.has(term)).length;
      const academicAssessment = overlap >= 2 ? {
        label: 'direct',
        rationale: `Your answer directly addresses the question through ${answerAnchor(answer)}.`
      } : overlap === 1 ? {
        label: 'partial',
        rationale: 'Your answer connects to the topic, but it needs a clearer link to the question.'
      } : {
        label: 'off_topic',
        rationale: 'Your answer does not yet address the question or topic closely enough.'
      };
      const anchor = answerAnchor(answer);
      const nextAgenda = createConversationAgenda({ completedTurns: Number(turnIndex || 0) + 1, currentQuestion: question });
      const nextQuestion = count < 8
        ? `What example or detail could you add about ${anchor}?`
        : academicAssessment.label === 'direct' && count >= 18
          ? questionForStage(nextAgenda.currentStage, topic)
        : academicAssessment.label === 'direct'
          ? `What evidence or example would strengthen your point about ${anchor}?`
          : academicAssessment.label === 'partial'
            ? `How does ${anchor} answer the question about ${topic}?`
            : `How does ${anchor} relate to the question about ${topic}?`;
      return {
        strengths,
        improvement,
        exampleAnswer,
        scores: {
          clarity: clamp(base + (clearStart ? 1 : 0)),
          relevance: clamp(base + 1),
          structure: clamp(base + (hasExample ? 1 : 0)),
          completeness: clamp(base),
          specificity: clamp(base + (hasExample ? 1 : 0))
        },
        evidence: [answer.slice(0, 180)],
        academicAssessment,
        academicResponse: buildAcademicResponse({ topic, answer, assessmentLabel: academicAssessment.label }),
        nextQuestion,
        question
      };
    },

    digestSource(source) {
      return { mode: 'extractive', ...digestSource(source) };
    },

    buildConsolidatedDigest({ sources = [], chunks = [] }) {
      const points = (Array.isArray(sources) ? sources : []).map(source => {
        const chunk = (Array.isArray(chunks) ? chunks : []).find(item => item.sourceId === source.id);
        if (!chunk) return null;
        const text = String(chunk.text || '').split(/(?<=[.!?])\s+/).find(Boolean) || String(chunk.text || '').trim();
        return text ? { text, sourceIds: [source.id], chunkIds: [chunk.id] } : null;
      }).filter(Boolean).slice(0, 5);
      return {
        mainArgument: points[0]?.text || '',
        keyPoints: points,
        importantTerms: [],
        evidence: points.map(point => ({ claim: point.text, chunkIds: point.chunkIds })),
        conflicts: [],
        openQuestions: []
      };
    },

    sourceQuestion({ sources, conversationHistory = null, conversationTurnCount = null, skillProfile = null }) {
      if (Number.isInteger(conversationTurnCount) || Array.isArray(conversationHistory)) {
        const completedTurns = Number.isInteger(conversationTurnCount) ? conversationTurnCount : Math.max(0, conversationHistory.length - 1);
        return questionForStage(createConversationAgenda({ completedTurns }).currentStage, '', { source: true, sourceCount: sources.length });
      }
      if (skillProfile?.id === 'epi-research') {
        if (sources.length > 1) return 'How do these studies differ in design, target population, and main estimand, and which assumptions matter most for comparing them?';
        return 'What are this study\'s target population, design, main estimand, and most important validity assumption?';
      }
      if (skillProfile?.id === 'academic-conversation') {
        if (sources.length > 1) return 'How do these materials agree or differ, and what evidence would help us explain the difference?';
        return `What is the central idea in “${sources[0]?.name || 'this material'}”, and which evidence would you like me to explain first?`;
      }
      if (sources.length > 1) return 'How do these materials agree or differ, and what evidence supports your comparison?';
      const source = sources[0];
      return `What is the main idea in “${source.name}”, and what evidence supports it?`;
    },

    generalAnswer(question) {
      return {
        mode: 'general',
        answer: `Here is a starting point for thinking about “${question}”: define the central idea, connect it to an example, and identify what would change your conclusion.`,
        sourceGroundedClaims: [],
        additionalContext: [{ claim: 'This response comes from general coaching context, not supplied materials.', label: 'Additional context' }],
        unsupportedOrUnresolved: [],
        confidence: 'medium'
      };
    },

    groundedAnswer({ sources, question }) {
      return sourceAnswer(sources, question);
    }
  };
}

export function searchSource(source, question) {
  const queryTerms = new Set(words(question.toLowerCase()).filter(word => word.length > 2));
  const sentences = source.text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let cursor = 0;
  const ranked = sentences.map((text, index) => {
    const start = source.text.indexOf(text, cursor);
    cursor = start < 0 ? cursor : start + text.length;
    const tokens = new Set(words(text.toLowerCase()));
    const score = [...queryTerms].filter(term => tokens.has(term)).length;
    return { text, index, score, locator: locateEvidence(source.text, text) };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.score ? ranked[0] : null;
}

export function sourceAnswer(sources, question) {
  const ranked = sources.map(source => ({ source, hit: searchSource(source, question) }))
    .filter(item => item.hit)
    .sort((a, b) => b.hit.score - a.hit.score);
  const match = ranked[0];
  if (!match) {
    return {
      mode: 'source',
      answer: 'I could not find enough support in your supplied materials to answer that confidently.',
      sourceGroundedClaims: [],
      additionalContext: [],
      unsupportedOrUnresolved: ['The supplied materials did not contain a sufficiently relevant passage.'],
      conflicts: [],
      confidence: 'low'
    };
  }
  const conflicts = ranked.filter(item => item !== match && item.hit.score >= match.hit.score && item.hit.text !== match.hit.text);
  return {
    mode: 'source',
    answer: match.hit.text,
    sourceGroundedClaims: [{
      claim: match.hit.text,
      sourceId: match.source.id,
      sourceName: match.source.name,
      page: null,
      section: null,
      evidence: match.hit.text,
      locator: match.hit.locator,
      relevanceScore: match.hit.score
    }],
    additionalContext: [],
    unsupportedOrUnresolved: [],
    conflicts: conflicts.length ? [{ description: 'Multiple supplied materials contain different passages relevant to this question.', sourceIds: [match.source.id, ...conflicts.map(item => item.source.id)] }] : [],
    confidence: conflicts.length ? 'low' : match.hit.score > 1 ? 'high' : 'medium'
  };
}

export function digestSource(source) {
  const sentences = source.text.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 5);
  let cursor = 0;
  return {
    digestText: sentences.join(' '),
    keyPoints: sentences.map((text, index) => {
      const locator = locateEvidence(source.text, text, cursor);
      if (locator) cursor = locator.end;
      return { text, sourceName: source.name, section: null, page: null, index, locator };
    }),
    openQuestions: []
  };
}
