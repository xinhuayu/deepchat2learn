# Changelog

All notable package milestones are recorded here. This project follows a controlled feature-freeze approach rather than treating a GitHub submission as a public-production release.

## [Unreleased maintenance] - 2026-07-20

- Adds a practice-session topic-scope digest before the opening question. The digest keeps a concise definition, scope, key concepts, boundaries, and anchor question available throughout the session.
- Persists the normalized scope in both in-memory and SQLite sessions and supplies it to initial questions, follow-up generation, answer evaluation, and general spoken-question handling.
- Uses a deterministic local scope when the remote scope request is unavailable or invalid, preserving the learning flow while keeping vague answers inside the declared topic.
- Adds regression coverage for scope creation, persistence, gateway routing, prompt inclusion, and voice forwarding. The current suite reports 449 passing tests and 3 optional skips.
- Records the critical unresolved mobile-browser voice-conversation issue. Desktop voice remains the frozen reference path; mobile voice is future work, and this documentation milestone introduces no application-code change.

## [0.1.0] - 2026-07-19

### Feature-freeze baseline

- Freezes the verified practice and source-conversation MVP for controlled demonstrations and GitHub submission.
- Preserves the bounded AI-for-learning flow: topic-aware questions, concise learning guidance, ending-language routing, newest-first review records, source grounding, local fallback, and optional browser or Realtime voice paths.
- Preserves the operational safeguards: five-second voice finalization, 45-second interactive model deadline, 180-second source-digest deadline, 12,000-token digest allowance, bounded recent history, source-gist reuse, and session/token guardrails.

### Audit and documentation

- Records independent automated, browser-flow, remote-provider, configuration, and package-hygiene evidence in [docs/RELEASE-BASELINE-v0.1.0.md](docs/RELEASE-BASELINE-v0.1.0.md).
- Corrects the landing-page tagline from “A vibrate place to think clearly” to “A vibrant place to think clearly,” with a regression check.
- Aligns the README, project summary, test guide, GitHub checklist, system summary, and technical inventory with the release posture.

### Release posture

- This is not a public-production 1.0 release. Production identity, observability, privacy/retention controls, and cross-device physical voice QA remain intentionally outside the freeze; continuous mobile-browser voice conversation is a critical unresolved issue.
- Until the next planned milestone, only regression, security/privacy, documentation, and runtime-compatibility fixes should be accepted. See the [release baseline](docs/RELEASE-BASELINE-v0.1.0.md) for the maintenance gate.
