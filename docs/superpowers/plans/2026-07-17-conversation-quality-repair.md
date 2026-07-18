# Conversation Quality Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore provider-backed speaking evaluation and advance practice and source conversations through distinct, source-aware learning stages.

**Architecture:** A pure agenda module derives stage and recent-question context from each session without increasing the two-turn transcript window. Model prompts and fallback question generation consume that agenda. The source digest remains evidence-linked but requests broader paper coverage and preserves all eight compact key points for live discussion.

**Tech Stack:** Node.js ESM, OpenAI Responses structured output, Node test runner, browser voice harness.

## Global Constraints

- Preserve source citations and separate source evidence from general knowledge.
- Keep live conversational responses concise; do not run full review workflows per turn.
- Keep the conversation-history transcript window at two exchanges.
- Never log API keys, source text, or model output during provider checks.

---

### Task 1: Repair strict provider feedback schema

**Files:**
- Modify: `src/modelCoach.mjs: feedbackSchema`
- Modify: `tests/modelCoach.test.mjs`

**Interfaces:**
- Produces: provider-compatible `feedbackSchema` for `createModelCoach().evaluateAnswer()`.

- [ ] **Step 1: Write the failing regression test**

Add a `createModelCoach` fake-fetch test that captures the `coaching_feedback` request and asserts:

```js
const schema = request.text.format.schema;
assert.equal(schema.required.includes('answerSpeechText'), true);
assert.deepEqual(
  Object.keys(schema.properties).sort(),
  [...schema.required].sort()
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/modelCoach.test.mjs`

Expected: the schema assertion fails because `answerSpeechText` is missing from `required`.

- [ ] **Step 3: Make the minimal schema repair**

Add `answerSpeechText` to `feedbackSchema.required` in `src/modelCoach.mjs`. Do not change the feedback response shape.

- [ ] **Step 4: Verify the regression test passes**

Run: `npm.cmd test -- tests/modelCoach.test.mjs`

Expected: zero failures.

### Task 2: Add a bounded conversation agenda

**Files:**
- Create: `src/conversationAgenda.mjs`
- Modify: `src/fakeCoach.mjs`
- Modify: `src/modelCoach.mjs`
- Modify: `src/voiceSession.mjs`
- Modify: `src/conversationOrchestrator.mjs`
- Modify: `package.json`
- Test: `tests/conversationAgenda.test.mjs`

**Interfaces:**
- Produces: `createConversationAgenda({ completedTurns, currentQuestion, recentQuestions })` returning `{ currentStage, nextStage, recentQuestions }`.
- Consumes: a session turn count plus at most four short prior question strings.

- [ ] **Step 1: Write failing agenda tests**

Create tests that expect:

```js
assert.deepEqual(
  createConversationAgenda({ completedTurns: 4, currentQuestion: 'What did the study find?', recentQuestions: ['What is the research question?'] }),
  {
    currentStage: 'findings',
    nextStage: 'interpretation',
    recentQuestions: ['What is the research question?', 'What did the study find?']
  }
);
```

and a fallback-coach test where `conversationTurnCount: 5` produces a findings or interpretation question rather than a design question.

- [ ] **Step 2: Run the agenda tests to verify they fail**

Run: `npm.cmd test -- tests/conversationAgenda.test.mjs`

Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement the pure agenda module**

Create `src/conversationAgenda.mjs` with the ordered stages:

```js
export const CONVERSATION_STAGES = ['orientation', 'design', 'population', 'measures', 'findings', 'interpretation', 'limitations and implications'];
export function createConversationAgenda({ completedTurns = 0, currentQuestion = '', recentQuestions = [] } = {}) {
  return { currentStage, nextStage, recentQuestions };
}
```

Map completed turns 0 through 6 to the listed stages and clamp later turns to the final stage.

- [ ] **Step 4: Thread agenda through conversation calls**

Pass `conversationTurnCount`, `conversationHistory`, and `agenda` to:

```js
coach.evaluateAnswer({ ..., conversationTurnCount, conversationHistory, agenda })
coach.composeBlendedAnswer({ ..., conversationTurnCount, agenda })
coach.nextQuestion({ ..., agenda })
coach.sourceQuestion({ ..., agenda })
```

Use `countConversationTurns(session)` in voice paths and `session.turns.length` in typed-practice paths. Keep the transcript history limit at two.

- [ ] **Step 5: Use agenda in model and fallback prompts**

Update model inputs and instructions to include `agenda`, require a non-repeating next question, and move direct answers to `agenda.nextStage`. Update `fakeCoach.nextQuestion` and `fakeCoach.sourceQuestion` to select stages from `conversationTurnCount`; update fallback evaluation to select a later related stage after a direct answer.

- [ ] **Step 6: Add the module to syntax verification and run targeted tests**

Add `node --check src/conversationAgenda.mjs` to `package.json` `typecheck`, then run:

`npm.cmd test -- tests/conversationAgenda.test.mjs tests/modelCoach.test.mjs tests/voiceSession.test.mjs`

Expected: zero failures.

### Task 3: Improve source-digest coverage for live discussion

**Files:**
- Modify: `src/modelCoach.mjs: compactConversationDigest, buildConsolidatedDigest`
- Test: `tests/modelCoach.test.mjs`

**Interfaces:**
- Consumes: the existing evidence-linked consolidated digest.
- Produces: compact digest context containing up to eight key points and a prompt that requests non-duplicative paper coverage.

- [ ] **Step 1: Write failing compact-digest tests**

Capture a `source_question` or `composeBlendedAnswer` model request supplied with eight key points. Assert the serialized input retains the eighth point and that the digest instruction includes research-question, design, population, measures, findings, interpretation, and limitations coverage.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/modelCoach.test.mjs`

Expected: the request contains only four key points and lacks the coverage instruction.

- [ ] **Step 3: Implement bounded richer context**

Change `compactConversationDigest` to preserve `digest.keyPoints.slice(0, 8)`. Add to the consolidated-digest instruction: when a paper supports them, choose distinct evidence-linked points across research question, design, population, measures, findings, interpretation, and limitations; do not repeat introductory claims.

- [ ] **Step 4: Verify targeted model tests pass**

Run: `npm.cmd test -- tests/modelCoach.test.mjs`

Expected: zero failures.

### Task 4: Run end-to-end verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-conversation-quality-repair-design.md` only if the implementation materially differs from the approved design.

- [ ] **Step 1: Run local verification**

Run: `npm.cmd run verify`

Expected: typecheck passes and the complete test suite reports zero failures.

- [ ] **Step 2: Run safe live provider checks**

Using the locally configured key, call `evaluateAnswer`, `buildConsolidatedDigest`, and `composeBlendedAnswer` with synthetic short text. Print only `{ ok, code, upstreamStatus, providerCode }` or response-shape booleans.

Expected: all three calls return successful structured responses; no key, source text, or model response is printed.
