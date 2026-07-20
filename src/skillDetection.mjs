const METHODS_TERMS = [
  /\bepidemiolog(?:y|ical)\b/i,
  /\bcohort\b/i,
  /\bcase[- ]control\b/i,
  /\bbias\b/i,
  /\bconfound(?:ing|er)?\b/i,
  /\bcausal inference\b/i,
  /\bodds ratio\b/i,
  /\bincidence\b/i,
  /\bmortality\b/i,
  /\bregression\b/i,
  /\bprevalence\b/i,
  /\bhazard ratio\b/i
];

const REVIEW_TERMS = [
  /\bcritique\b/i,
  /\bcritical review\b/i,
  /\bapprais(?:e|al)\b/i,
  /\bevaluat(?:e|ion)\b/i,
  /\basse(?:ss|ssment)\b/i,
  /\breview\b/i,
  /\bmethod(?:s|ological)?\b/i
];

function searchableText({ topic = '', sourceNames = [], sourceText = '', question = '' } = {}) {
  return [topic, question, ...(Array.isArray(sourceNames) ? sourceNames : []), sourceText]
    .map(value => String(value || ''))
    .join('\n')
    .slice(0, 80_000);
}

export function detectSkillId(input = {}) {
  const text = searchableText(input);
  const hasMethodsSignal = METHODS_TERMS.some(pattern => pattern.test(text));
  const hasReviewSignal = REVIEW_TERMS.some(pattern => pattern.test(text));
  if (hasMethodsSignal && hasReviewSignal) {
    return { skillId: 'epi-research', reason: 'Automatic: epidemiology methods review.' };
  }
  return { skillId: 'none', reason: 'Automatic: general source discussion.' };
}

export function resolveSkillSelection({ requestedSkillId = 'auto', sourceMode = 'none', topic = '', sources = [], question = '', registry } = {}) {
  const candidate = String(requestedSkillId || 'auto').trim() || 'auto';
  const requested = ['auto', 'none', 'academic-research', 'epi-research'].includes(candidate) || registry?.get(candidate)
    ? candidate
    : 'auto';
  const conversationSkillId = registry?.get('academic-conversation') ? 'academic-conversation' : 'none';
  if (sourceMode !== 'source') {
    return {
      requestedSkillId: requested,
      activeSkillId: 'none',
      conversationSkillId,
      reason: 'Practice sessions do not activate source-review skills.'
    };
  }
  if (requested === 'none') {
    return { requestedSkillId: requested, activeSkillId: 'none', conversationSkillId, reason: 'Explicit: general source discussion.' };
  }
  if (requested === 'academic-research') {
    if (registry?.get('academic-research')) return { requestedSkillId: requested, activeSkillId: requested, conversationSkillId, reason: 'Explicit: academic research digest.' };
    return {
      requestedSkillId: requested,
      activeSkillId: 'none',
      conversationSkillId,
      reason: 'Explicit academic research skill unavailable; using general source discussion.',
      warning: 'The academic research skill is unavailable, so this session is using general source discussion.'
    };
  }
  if (requested === 'epi-research') {
    if (registry?.get('epi-research')) return { requestedSkillId: requested, activeSkillId: requested, conversationSkillId, reason: 'Explicit: epidemiology methods review.' };
    return {
      requestedSkillId: requested,
      activeSkillId: 'none',
      conversationSkillId,
      reason: 'Explicit skill unavailable; using general source discussion.',
      warning: 'The epidemiology review skill is unavailable, so this session is using general source discussion.'
    };
  }
  if (requested !== 'auto') {
    const profile = registry?.get(requested);
    if (profile) {
      return {
        requestedSkillId: requested,
        activeSkillId: requested,
        conversationSkillId,
        reason: `Explicit: ${profile.name || requested} digest.`
      };
    }
  }
  const detected = detectSkillId({
    topic,
    question,
    sourceNames: (Array.isArray(sources) ? sources : []).map(source => source?.name),
    sourceText: (Array.isArray(sources) ? sources : []).map(source => source?.text).join('\n')
  });
  if (detected.skillId === 'epi-research' && registry?.get('epi-research')) {
    return { requestedSkillId: requested, activeSkillId: detected.skillId, conversationSkillId, reason: detected.reason };
  }
  if (registry?.get('academic-research')) {
    return { requestedSkillId: requested, activeSkillId: 'academic-research', conversationSkillId, reason: 'Automatic: academic research digest for source discussion.' };
  }
  return { requestedSkillId: requested, activeSkillId: 'none', conversationSkillId, reason: detected.reason };
}
