# GitHub submission checklist

This folder is the GitHub-ready source package for `deepchat2learn` `v0.1.0`, the controlled-demonstration feature-freeze baseline. A private local `.env` may be used for testing, but it is ignored and must never be committed. Review the [release baseline](docs/RELEASE-BASELINE-v0.1.0.md) before expanding scope.

> **Critical known issue:** Desktop voice conversation is working in this frozen package, but continuous voice conversation through mobile browsers is still not working reliably. Mobile voice is not release-ready and remains future work. Do not change the frozen application behavior as part of submission; use desktop voice or typed interaction until a separate mobile-voice milestone is opened.

## Included

- Application source, browser UI, bundled academic skills, tests, and current project documentation.
- `.env.example` with blank secrets and a blank, portable Python executable setting.
- Continuous interruption-safe voice turn-taking, explicit session-ending phrases, concise spoken learning guidance, highlighted voice-processing status, and regression tests.
- `README.md`, `PROJECT-SUMMARY.md`, `RUN-THIS.md`, `CHANGELOG.md`, and this checklist for release and future-test handoff.
- The versioned Markdown system summary, technical inventory, audit record, and editable diagrams.

## Intentionally excluded

- `.env` contents and API keys
- SQLite databases, uploaded source documents, transcripts, recordings, logs, temporary files, and `node_modules`
- Ad hoc generated PDF exports and other local-only artifacts
- Inherited Git history; initialize or attach this clean folder to the intended GitHub repository.

## Before committing

1. Review the files once more for project-specific material and confirm any local `.env` remains ignored and unstaged.
2. Create a private local `.env` from `.env.example` only when testing provider-backed features.
3. Run `npm run verify` from the repository root, then use `RUN-THIS.md` for optional manual microphone and source checks.
4. Initialize Git here (or attach this folder to the intended repository), then commit the package.

The application can run without an API key using its deterministic local AI-for-learning fallback. A provider key is required for comprehensive remote model responses and Realtime/WebRTC voice. Python is optional; configure the host's own Python executable and PDF packages only when richer extraction is needed for complex research PDFs.

## Feature-freeze change control

`v0.1.0` freezes the verified MVP behaviour for submission and controlled demonstrations. Until a deliberate next milestone is opened, accept only regression fixes, security/privacy fixes, documentation corrections, and runtime-compatibility fixes that preserve the documented flow. Record every exception in `CHANGELOG.md` and update the release baseline, system summary, and technical inventory when a change materially affects learner behaviour, provider boundaries, records, limits, or privacy.
