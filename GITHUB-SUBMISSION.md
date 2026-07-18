# GitHub submission checklist

This folder is the sanitized source package for `deepchat2learn`.

## Included

- Application source, browser UI, bundled academic skills, tests, and documentation.
- `.env.example` with blank secrets and a blank, portable Python executable setting.
- Current interruption-safe voice turn-taking behavior and regression tests.

## Intentionally excluded

- `.env` and API keys
- SQLite databases, uploaded source documents, transcripts, recordings, logs, temporary files, and `node_modules`
- Generated PDF exports and other local-only artifacts

## Before committing

1. Review the files once more for project-specific material.
2. Create a private local `.env` from `.env.example` only when testing provider-backed features.
3. Run `npm run verify` from the repository root.
4. Commit the package to a new or existing GitHub repository.

The application can run without an API key using its deterministic local coach. A provider key is required for comprehensive remote model responses and Realtime/WebRTC voice. Python is optional; configure the host's own Python executable and PDF packages only when richer extraction is needed for complex research PDFs.
