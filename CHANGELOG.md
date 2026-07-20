# Changelog

All notable package milestones are recorded here. This project follows a controlled feature-freeze approach rather than treating a GitHub submission as a public-production release.

## [0.1.0] - 2026-07-19

### Feature-freeze baseline

- Freezes the verified practice and source-conversation MVP for controlled demonstrations and GitHub submission.
- Preserves the bounded learning flow: topic-aware questions, concise coaching, ending-language routing, newest-first review records, source grounding, local fallback, and optional browser or Realtime voice paths.
- Preserves the operational safeguards: five-second voice finalization, 45-second interactive model deadline, 180-second source-digest deadline, 12,000-token digest allowance, bounded recent history, source-gist reuse, and session/token guardrails.

### Audit and documentation

- Records independent automated, browser-flow, remote-provider, configuration, and package-hygiene evidence in [docs/RELEASE-BASELINE-v0.1.0.md](docs/RELEASE-BASELINE-v0.1.0.md).
- Corrects the landing-page tagline from “A vibrate place to think clearly” to “A vibrant place to think clearly,” with a regression check.
- Aligns the README, project summary, test guide, GitHub checklist, system summary, and technical inventory with the release posture.

### Release posture

- This is not a public-production 1.0 release. Production identity, observability, privacy/retention controls, and cross-device physical voice QA remain intentionally outside the freeze.
- Until the next planned milestone, only regression, security/privacy, documentation, and runtime-compatibility fixes should be accepted. See the [release baseline](docs/RELEASE-BASELINE-v0.1.0.md) for the maintenance gate.
