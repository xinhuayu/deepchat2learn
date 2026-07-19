# Source Conversation Quality Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make source-mode answers question-specific, source-grounded, non-repetitive, and resilient to provider failures, stale state, and replay errors.

**Architecture:** Add privacy-safe turn diagnostics, then repair the boundaries between idempotency, retrieval, digest selection, synthesis validation, fallback responses, and agenda progression. Keep `academic-conversation` as the live dialogue guide; source-review skills remain restricted to source digestion.

**Tech Stack:** Node.js ES modules, built-in `node:test`, in-memory/SQLite stores, deterministic fake coach, optional OpenAI text provider.

## Global Constraints

- Do not log API keys, raw source text, raw transcripts, or full provider responses.
- Preserve separate practice and source histories.
- Preserve source citations and exact-evidence validation.
- Preserve interruption cleanup and idempotent retry behavior.
- Keep provider-backed and deterministic local fallback paths testable.

---

### Task 1: Add a deterministic multi-question regression fixture and safe turn diagnostics

**Files:**
- Modify: `src/lifecycleEvents.mjs`
- Modify: `src/voiceSession.mjs`
- Test: `tests/voiceSession.test.mjs`, `tests/api.test.mjs`

- [ ] Add event metadata for intent, model status, fallback reason, retrieval chunk IDs, agenda stage, and bounded latency; hash sensitive values before recording.
- [ ] Add a test sequence covering orientation, design, population, methods, and limitations questions.
- [ ] Verify failure cases identify provider failure, fallback, and replay without exposing sensitive input.

### Task 2: Enforce idempotency content matching and fresh active-turn state

**Files:**
- Modify: `src/voiceSession.mjs`, `src/conversationOrchestrator.mjs`, `src/store.mjs`
- Modify: `public/app.js`
- Test: `tests/api.test.mjs`, `tests/voiceBrowserHarness.test.mjs`

- [ ] Store a normalized transcript/question fingerprint with each replay entry.
- [ ] Replay only when the new normalized content matches the stored fingerprint; otherwise return a typed conflict and require a new key.
- [ ] Add tests for identical retry, changed-content reuse, interruption, and next-turn isolation.

### Task 3: Make source retrieval question-focused and diverse

**Files:**
- Modify: `src/voiceSession.mjs`, `src/sourceKnowledge.mjs`
- Test: `tests/voiceSession.test.mjs`, `tests/sourceKnowledge.test.mjs`

- [ ] Use the current user question as the primary retrieval query; add prior context only for short follow-ups.
- [ ] Diversify selected chunks by source section/page and avoid repeating recently used chunks when alternatives exist.
- [ ] Preserve source IDs, page/section locators, and relevance scores.
- [ ] Add tests proving different questions select different eligible chunks and short follow-ups still retain immediate context.

### Task 4: Improve digest-stage selection and synthesis diversity

**Files:**
- Modify: `src/modelCoach.mjs`, `src/voiceSession.mjs`, `src/conversationAgenda.mjs`
- Test: `tests/modelCoach.test.mjs`, `tests/voiceSession.test.mjs`

- [ ] Pass stage-labeled digest points and recent source-use metadata to the live prompt.
- [ ] Add a bounded semantic-overlap check against recent assistant answers and the digest main argument.
- [ ] Require a different evidence point, section, or agenda stage when the first draft repeats prior content.
- [ ] Ensure a direct answer advances to a related new stage and does not repeat an already asked question.

### Task 5: Replace repetitive fallbacks with question-specific recovery

**Files:**
- Modify: `src/modelCoach.mjs`, `src/fakeCoach.mjs`
- Test: `tests/modelCoach.test.mjs`, `tests/fakeCoach.test.mjs`

- [ ] Keep fallback status and reason explicit.
- [ ] Build fallback answers from the best question-matched passage, section, digest point, and a question-specific limitation.
- [ ] Remove fixed repeated fallback follow-ups when a better agenda question or source open question is available.
- [ ] Test timeout, invalid model output, no-match retrieval, and successful provider responses separately.

### Task 6: Verify, synchronize, and package

**Files:**
- Modify: `README.md`, `RUN-THIS.md`, `document/SYSTEM-SUMMARY.md`, `document/DISTRIBUTION-READINESS.md`
- Sync: `outputs/deepchat2learn-github-package`

- [ ] Run focused regression tests after each task.
- [ ] Run `npm run verify` from the test package.
- [ ] Confirm no secret, database, source document, recording, temporary file, or generated PDF enters the distribution copy.
- [ ] Refresh `deepchat2learn-github-package.zip` and verify archive contents.
