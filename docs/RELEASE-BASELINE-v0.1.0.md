<p align="center"><img src="../public/brand-logo.png" alt="deepchat2learn logo" width="220"></p>

# deepchat2learn v0.1.0 feature-freeze release baseline

**Decision date:** 19 July 2026  
**Release class:** controlled demonstration and GitHub submission  
**Versioning decision:** retain `0.1.0`; this is a definitive MVP baseline, not a public-production 1.0 release.

## Release decision

`v0.1.0` freezes the current learning experience because the core practice, source-grounded, record, fallback, and voice-coordination paths have been independently exercised and their limits are documented. The freeze is intended to make the package stable enough to submit, review, reproduce, and test without quietly changing the learner contract.

The release does **not** claim readiness for sensitive, high-volume, or public multi-user deployment. Authentication, user-level authorization, deployment monitoring, production retention policy, and physical-device voice QA remain future work.

### Follow-up regression maintenance — 20 July 2026

The feature-freeze contract remains unchanged, but the practice continuity path received a regression fix after the initial baseline audit. Practice sessions now create a concise structured topic-scope digest before the opening question, persist it in the session, and carry it through initial-question generation, follow-up questions, answer evaluation, and general spoken-question handling. A deterministic local scope is used when the remote scope request is unavailable or invalid. This directly addresses multi-round drift caused by vague learner contributions without changing the five-second voice-finalization boundary, source-conversation context contract, or user-facing session controls.

### Critical known issue — mobile-browser voice conversation

Desktop voice conversation and the automated/server voice paths work for the frozen baseline, but continuous voice conversation through mobile browsers is still not working reliably. This is a critical unresolved issue and a release blocker for mobile voice support. It does not justify changing the verified desktop/controlled-demonstration behavior in `v0.1.0`; no application code or manually edited `public/index.html` titles are changed in this freeze. Future work must reproduce the failure across the target device/browser matrix and validate microphone permissions, autoplay, WebRTC/Realtime transport, browser speech fallback, and network recovery before mobile voice can be considered ready.

## Frozen learner contract

- Practice and source sessions start with a focused question and preserve session isolation, budgets, retention choice, and review records.
- Every live prompt carries the topic. Practice also carries its persisted scope digest and up to five compact recent exchanges; source conversation uses the prepared digest/gist, bounded evidence context, and three recent exchanges rather than repeatedly sending the original material.
- A normal completed answer receives concise, response-linked learning feedback and one focused next question. Direct questions and move-on requests are routed separately.
- Phrases such as “end the session,” “finish the conversation,” “wrap up,” and “I am done” receive a short closure and proceed directly to the summary without another question.
- Voice processing states are visibly highlighted; AI speech pauses microphone capture, interruption is available, typed interaction remains usable, and five seconds of final silence remains the submission boundary. The desktop/controlled-browser path is the verified reference; mobile-browser voice remains the critical unresolved issue above.
- The local deterministic AI-for-learning fallback remains available when the provider is absent, slow, malformed, or otherwise unable to complete a text turn.
- Source claims use prepared local evidence and validation; raw source material is kept server-local after digestion for ordinary live source turns.

## Independent audit evidence

| Audit area | Evidence recorded for this baseline |
|---|---|
| Syntax and regression suite | The follow-up `npm run verify` completed with **452 tests total: 449 passed, 0 failed, 3 optional environment-specific skips**. |
| Static package hygiene | No distributed credential pattern, local-machine path, database, recording, log, cache, uploaded source, `node_modules`, or inherited Git history was found in the submission content. `.env.example` remained as the only portable configuration template. |
| Configuration contracts | Environment-template parity and local Markdown-link checks passed. Documented timing, token, character, source, and request-size limits matched the configuration surface. |
| Local browser flow | In an isolated no-key session, the landing page created a practice session, showed the active voice-processing state, accepted a typed answer, produced concise feedback and a next question, retained the turn in review history, and ended at the session summary. Browser-console warnings and errors were absent. |
| Provider practice smoke | A non-sensitive model-backed practice session created successfully, completed an answer turn, and produced a summary without text-model fallback (about 15.8 seconds end to end). |
| Provider source smoke | A non-sensitive source session completed model-backed direct digestion, prepared-gist reuse, a grounded source question, a finalized voice-answer path, and session completion without text-model fallback (about 45.5 seconds end to end). |

The browser check validated application state and fallback-friendly flow; it did not assert successful real microphone capture, permission grants, audio playback, mobile autoplay, or live WebRTC transport. Desktop voice is the current verified reference, while continuous mobile-browser voice remains the known critical gap requiring target-device testing.

## Correction made during this audit

The landing-page tagline contained a visible copy error: “A vibrate place to think clearly.” The cause was a matching typo in both `public/index.html` and its client regression test. The test was first changed to expect “A vibrant place to think clearly,” verified to fail, then the markup was corrected and the focused test passed. No other behaviour changed.

## Submission gate

The package is ready to stage for GitHub when the staged copy satisfies all of the following:

1. It contains application source, tests, skills, documentation, editable diagrams, and the versioned Markdown system summary. No PDF export is included in this frozen package.
2. It excludes actual `.env` files, credentials, local databases, recordings, source uploads, logs, test output, caches, `node_modules`, and inherited history.
3. `npm run verify` passes from the staged copy without relying on a private `.env`.
4. The README, project summary, system summary, technical inventory, changelog, and submission checklist agree on the version, feature-freeze posture, limits, and remaining risks.

## Change-control policy

Until the next deliberate milestone opens, accept only changes that preserve this learner contract:

- regression fixes;
- security, privacy, or data-integrity fixes;
- documentation corrections; or
- Node/runtime compatibility fixes.

New capabilities, prompt-policy changes, altered model/provider boundaries, changed user-record semantics, or revised time/token limits require a new documented milestone, updated automated tests, and refreshes to this release record, the system summary, and the technical inventory.
