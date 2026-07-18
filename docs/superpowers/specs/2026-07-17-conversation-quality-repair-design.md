# Conversation Quality Repair Design

## Goal

Restore model-backed speaking feedback and make practice and source conversations advance through distinct, source-aware learning ideas instead of repeating generic prompts.

## Scope

1. Repair the OpenAI strict output schema used by `evaluateAnswer` so practice feedback does not fall back to the local demo coach.
2. Give question generation a durable, session-specific progress signal rather than deriving progress from the two-turn live context window.
3. Preserve a bounded recent history for response speed while sending the model the current stage, recently asked questions, and the next eligible stage.
4. Improve research-paper source digests so their compact live representation covers distinct paper dimensions: research question, design, population, measures, findings, interpretation, and limitations when the source supports them.
5. Keep normal conversation responses concise, source-grounded, and distinct from a full research review.

## Design

### Strict evaluation output

`feedbackSchema` will declare `answerSpeechText` as required, matching the strict JSON-schema contract already used for the model response. A regression test will inspect the outgoing schema and a redacted live request will confirm the provider accepts `evaluateAnswer`.

### Conversation agenda

Add a small pure helper that derives an agenda from the completed turn count and recent session questions. It returns the current stage, next stage, and a bounded list of recently asked questions. The seven-stage order is orientation, design, population, measures, findings, interpretation, and limitations/implications.

Practice evaluation, source answers, and explicit new-question requests will pass this agenda to model prompts. After a direct answer, the requested follow-up must target the next eligible stage rather than reuse a recent question. A partial answer can request one clarification, then advance. The local fallback coach will use `conversationTurnCount`, not the truncated conversation-history length, to select its stage.

### Source conversation map

The consolidated-digest prompt will request distinct, evidence-linked coverage across the paper dimensions that exist in the supplied material. It will remain limited to eight key points and exact source evidence. The compact live digest will retain all eight key points, not only the first four, so later question stages can anchor to methods, findings, and limitations rather than only the introduction.

### Safeguards

The compact two-turn exchange window remains unchanged for latency and privacy. The agenda contains only stage labels and short prior question text. Source-mode answers continue to cite retrieved chunks and label general knowledge separately. The academic-conversation skill remains the live dialogue protocol; research-review skills remain digest-only.

## Tests and verification

- Regression test: strict feedback schema requires every declared field.
- Regression test: fallback questions advance beyond the second stage when total completed turns increase.
- Regression test: model prompts receive an agenda and all compact digest points.
- Existing source and voice behavior tests remain green.
- Run `npm.cmd run verify` and safe redacted provider checks for `evaluateAnswer`, source digest, and source dialogue.

## Non-goals

- No change to voice transport, microphone turn-taking, source file limits, or external research consent.
- No full epidemiologic critique on every discussion turn.
