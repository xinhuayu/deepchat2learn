export const CONVERSATION_STAGES = [
  'orientation',
  'design',
  'population',
  'measures',
  'findings',
  'interpretation',
  'limitations, implications, or application'
];

function normalizeQuestion(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function createConversationAgenda({ completedTurns = 0, currentQuestion = '', recentQuestions = [] } = {}) {
  const normalizedTurns = Math.max(0, Number.isFinite(Number(completedTurns)) ? Math.floor(Number(completedTurns)) : 0);
  const stageIndex = Math.min(normalizedTurns, CONVERSATION_STAGES.length - 1);
  const nextStageIndex = Math.min(stageIndex + 1, CONVERSATION_STAGES.length - 1);
  const questions = [];
  for (const value of [...(Array.isArray(recentQuestions) ? recentQuestions : []), currentQuestion]) {
    const question = normalizeQuestion(value);
    if (question && !questions.includes(question)) questions.push(question);
  }
  return {
    currentStage: CONVERSATION_STAGES[stageIndex],
    nextStage: CONVERSATION_STAGES[nextStageIndex],
    recentQuestions: questions.slice(-4)
  };
}
