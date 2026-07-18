# Relevance-Aware Academic Follow-ups Design

## Goal

Make academic conversation follow-up questions responsive to the learner's latest answer, up to three prior exchanges, the current agenda stage, and relevant digested source material.

## Behavior

- Live practice and source conversations continue to use `academic-conversation` as the main dialogue skill.
- The prompt receives at most three recent exchanges, including AI question, learner answer, AI response, and prior follow-up when available.
- Source mode also receives the normalized digest and retrieved source chunks selected using the current turn plus the recent three-exchange context.
- The model answers the latest learner question or response first, identifies one meaningful learning point, and asks one concise follow-up tied to the learner's answer and the next eligible agenda stage.
- Source-mode follow-ups prefer a specific source-supported idea and do not become practice scorecards.
- Practice-mode follow-ups use the learner's answer and agenda but do not receive source-specific context.
- The prompt must discourage repeated questions, circular subtopics, generic prompts, and unsupported source claims.

## Scope

Change the bounded history limit and context serialization in the model and voice paths, update the academic-conversation skill wording, and add regression tests. No change to audio transport, transcript capture, source extraction, or session limits is required.

## Acceptance criteria

1. A six-turn input sends only the last three exchanges to the model.
2. Each retained exchange preserves the AI question, learner answer, AI response, and prior follow-up when present.
3. Source retrieval queries include the current turn and the last three source exchanges.
4. Source prompt instructions explicitly require a response tied to the latest learner contribution, relevant digest/evidence, and the next agenda stage.
5. Practice and source contexts remain separate.
6. Existing tests and the full verification command pass.
