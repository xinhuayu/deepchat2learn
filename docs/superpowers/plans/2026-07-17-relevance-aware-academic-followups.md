# Relevance-Aware Academic Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make follow-up questions use the learner's latest contribution, three prior exchanges, the conversation agenda, and relevant digested source material without increasing full-transcript prompt size.

**Architecture:** Raise the shared live-context limit from two to three exchanges. Normalize each retained exchange into a compact object containing question, answer, AI response, and prior follow-up; use the same bounded representation for model prompts and source retrieval. Keep source digest and retrieved chunks conditional on source mode, while the academic-conversation skill defines the response and follow-up contract.

**Tech Stack:** Node.js ES modules, Node built-in test runner, Markdown skill files, existing OpenAI Responses prompt/schema layer.

## Global Constraints

- Keep live turns lightweight; do not run the full academic-research or epi-research review workflow during conversation.
- Keep source and practice session context separate.
- Send at most three recent exchanges, not the full transcript.
- Source claims must remain distinguishable from general LLM knowledge.
- Preserve the existing audio, transcript, idempotency, and session-state behavior.

---

### Task 1: Add failing regression tests for three-exchange follow-up context

**Files:**
- Modify: `tests/modelCoach.test.mjs`
- Modify: `tests/voiceSession.test.mjs`

**Interfaces:**
- The model prompt receives `conversationHistory` as normalized compact exchange objects.
- The source retrieval helper uses the same history bound when building its query.

- [ ] **Step 1: Write the failing model-context test**

Add a test beside the existing bounded-history test:

```js
test('academic follow-up prompts retain three complete prior exchanges and the latest response signal', async () => {
  let request;
  const coach = createModelCoach({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ output_text: JSON.stringify({
        answerText: 'The result suggests an association.', answerSpeechText: 'The result suggests an association. What limitation should we examine next?',
        sourceClaims: [], llmBackground: [], discussionPoints: [], suggestions: [], externalClaims: [], citations: [], externalCitations: [],
        confidence: 'medium', uncertainty: [], conflicts: [], followUp: 'What limitation should we examine next?'
      }) }) };
    }
  });

  await coach.composeBlendedAnswer({
    userQuestion: 'I think the association may reflect confounding.',
    currentQuestion: 'What does the main result mean?',
    sourceDigest: { mainArgument: 'The paper reports an observational association.', keyPoints: [{ text: 'The design cannot fully remove confounding.', evidence: 'confounding', chunkIds: ['paper:1'] }] },
    retrievedChunks: [{ id: 'paper:1', text: 'The observational design may be affected by confounding.', sourceId: 'paper' }],
    conversationHistory: Array.from({ length: 6 }, (_, index) => ({
      question: `Q${index}`, answer: `A${index}`, assistantResponse: `R${index}`, followUp: `F${index}`
    })),
    agenda: { currentStage: 'interpretation', nextStage: 'limitations', recentQuestions: ['What does the main result mean?'] },
    turnRole: 'answer_to_ai', generalKnowledgeAllowed: true
  });

  const input = JSON.parse(request.input);
  assert.equal(input.conversationHistory.length, 3);
  assert.deepEqual(input.conversationHistory[0], { question: 'Q3', answer: 'A3', assistantResponse: 'R3', followUp: 'F3' });
  assert.match(request.instructions, /latest.*answer|latest.*response/i);
  assert.match(request.instructions, /specific source idea|source-supported/i);
  assert.match(request.instructions, /next eligible stage/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test tests/modelCoach.test.mjs --test-name-pattern="three complete prior exchanges"
```

Expected: FAIL because the implementation currently retains only two exchanges and does not preserve the additional exchange fields.

- [ ] **Step 3: Write the failing source-retrieval test**

Add a source voice-turn test with four prior source turns and a short current transcript such as `Why?`. Capture the retrieval query and assert it contains the current question, `Why?`, and the question/answer text from exactly the last three prior turns while excluding the fourth-oldest turn.

- [ ] **Step 4: Run the source test to verify it fails**

Run:

```powershell
node --test tests/voiceSession.test.mjs --test-name-pattern="three prior source exchanges"
```

Expected: FAIL because `buildSourceRetrievalQuery` currently uses a two-exchange bound.

### Task 2: Implement normalized three-exchange context

**Files:**
- Modify: `src/modelCoach.mjs:7-125`
- Modify: `src/voiceSession.mjs:338-345`
- Modify: `src/conversationOrchestrator.mjs:257-270`

**Interfaces:**
- `compactConversationHistory(history)` returns at most three compact exchanges.
- `buildConversationHistory(session, { limit = 3 })` returns the same compact fields already used by voice turns.
- `buildSourceRetrievalQuery(session, transcript)` includes the current question/transcript and the last three source exchanges.

- [ ] **Step 1: Change the shared history limit and preserve fields**

Set `MAX_CONVERSATION_HISTORY` to `3`. In `compactConversationHistory`, map each retained object to:

```js
{
  question: String(item?.question || item?.currentQuestion || '').trim(),
  answer: String(item?.answer || item?.transcript || item?.answerText || '').trim(),
  assistantResponse: String(item?.assistantResponse || item?.feedback?.academicResponse || item?.feedback?.answerSpeechText || '').trim(),
  followUp: String(item?.followUp || item?.nextQuestion || item?.feedback?.nextQuestion || '').trim()
}
```

Remove empty fields before returning each item and omit empty exchanges.

- [ ] **Step 2: Align practice and source callers**

Replace `session.turns.slice(-2)` in `handlePracticeAnswer` with the existing shared compact-history helper or an equivalent three-item mapping that includes the latest answer and feedback response. Update `buildSourceRetrievalQuery` to request `limit: 3` and include `assistantResponse` and `followUp` in the query text.

- [ ] **Step 3: Strengthen prompt instructions**

In `withConversationSkillGuidance` and the blended-answer instructions, explicitly require:

```text
Use the latest learner question or answer as the primary follow-up signal. Use up to three prior exchanges to avoid repetition and maintain continuity. Tie the next question to one concrete claim, uncertainty, or idea from the latest response, relevant digest/evidence, and the next eligible agenda stage. Ask one concise question and move on when the learner has already addressed the current point.
```

- [ ] **Step 4: Run the targeted tests**

Run:

```powershell
node --test tests/modelCoach.test.mjs tests/voiceSession.test.mjs
```

Expected: PASS, including the new three-exchange tests.

### Task 3: Update the academic-conversation skill

**Files:**
- Modify: `skills/academic-conversation/SKILL.md`

**Interfaces:**
- The skill remains the main live dialogue skill for both practice and source mode.
- Source digestion skills remain conditional preparation tools, not live-turn skills.

- [ ] **Step 1: Add the explicit context contract**

Update the per-round protocol to require the latest learner contribution, up to three prior exchanges, the current agenda stage, and relevant source digest/evidence when in source mode.

- [ ] **Step 2: Add follow-up construction rules**

Require each follow-up to identify one specific signal from the learner's latest response, connect it to a source idea when available, advance to the next eligible agenda stage, and avoid any question already represented in recent history.

- [ ] **Step 3: Keep the skill concise and mode-specific**

Do not add full epidemiologic review instructions. Preserve the existing two-to-four-sentence spoken response limit, source/practice separation, and no-scorecard rule for source discussion.

- [ ] **Step 4: Run the skill-content checks**

Run:

```powershell
rg -n "three|latest|digest|retrieved|next eligible|avoid repetition|source mode" skills/academic-conversation/SKILL.md
```

Expected: the required context and follow-up terms are present, with no full-review workflow added.

### Task 4: Run full verification and inspect the diff

**Files:**
- Verify: `src/modelCoach.mjs`
- Verify: `src/voiceSession.mjs`
- Verify: `src/conversationOrchestrator.mjs`
- Verify: `skills/academic-conversation/SKILL.md`
- Verify: `tests/modelCoach.test.mjs`
- Verify: `tests/voiceSession.test.mjs`

- [ ] **Step 1: Run the complete package verification**

Run:

```powershell
npm.cmd run verify
```

Expected: type checks pass, all required tests pass, and only the already-expected optional Python/PDF tests may remain skipped.

- [ ] **Step 2: Inspect changed files for consistency**

Run:

```powershell
git diff --check
rg -n "MAX_CONVERSATION_HISTORY|slice\(-2\)|limit: 2|three prior|three.*exchange" src skills tests
```

Expected: the live context limit is consistently three, with no unintended two-exchange production path remaining.

- [ ] **Step 3: Confirm source/practice separation**

Run the existing source and practice context tests and confirm source digest fields are present only in source-mode model requests, while practice requests use the academic-conversation skill without source retrieval.
