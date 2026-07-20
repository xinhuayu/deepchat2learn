<p align="center"><img src="public/brand-logo.png" alt="deepchat2learn logo" width="220"></p>

# deepchat2learn project summary

> **Release status:** `v0.1.0` feature-freeze baseline for controlled demonstrations and GitHub submission; not a public-production 1.0 release. The release gate and independent audit record are in [docs/RELEASE-BASELINE-v0.1.0.md](docs/RELEASE-BASELINE-v0.1.0.md).

`deepchat2learn` is a browser-based coaching application for practicing explanations and discussing supplied source materials. It runs locally with a deterministic coach and can optionally use a server-side text model, OpenAI Realtime voice, live transcription, and SQLite persistence.

## Current user flow

1. Start a practice or source-grounded session and receive a focused opening question.
2. Reply by typing or speaking. Browser and Realtime voice both wait five seconds after the final user speech before submitting an answer.
3. The server evaluates the answer, retrieves supplied-source evidence when relevant, and returns one concise next action plus a focused follow-up question.
4. Continue the conversation, ask for a new question, or say an explicit ending phrase such as "end the session," "finish the conversation," "wrap up," or "I am done."
5. An ending phrase receives a short closing message, adds no extra question or answer turn, and transitions directly to the session summary.

The conversation page visibly highlights the active voice-processing state. AI speech pauses microphone capture to reduce echo, and the explicit interrupt control lets the learner speak sooner. The former "Read the question aloud" button has been removed because session questions begin automatically in the continuous voice flow.

## Reliability and model behavior

- Text coaching has a 45-second default request deadline and a deterministic local fallback, so a slow remote response does not turn into a failed conversation turn.
- Source digestion has its own 180-second default deadline and a 12,000-token configurable structured-response allowance (`OPENAI_SOURCE_DIGEST_MAX_OUTPUT_TOKENS`), reducing `max_output_tokens` incomplete-digest failures for larger papers.
- Voice and answer limits include deliberate headroom: transcripts and answers default to 13,200 characters, questions to 2,200 characters, request bodies to 28 MB, and session model budget to 132,000 tokens.
- The five-second voice silence settings remain unchanged: `VOICE_AUTO_SUBMIT_DELAY_MS=5000` and `VOICE_REALTIME_SILENCE_MS=5000`.
- Practice prompts retain the topic and up to five compact recent exchanges. After a source is digested, source prompts use only the topic, prepared digest/gist, compact exact-evidence options, and the three latest exchanges; raw documents remain local for evidence validation and fallbacks. Spoken coaching is constrained to one brief, concrete action before the next question.

## Source materials and records

The package accepts PDF, DOCX, TXT, Markdown, and pasted material. It preserves page-aware extraction where available, produces an evidence-validated digest, and labels general model context separately from source-specific claims. Source-grounded answers validate cited source excerpts before showing them.

Session summaries retain recurring strengths, gaps, and source-use information. The visible review is reset for a new session and rendered newest-first; durable records retain timestamps for the same order after refresh. Optional SQLite persistence is disabled unless `SQLITE_PATH` is configured. Audio recording is separately opt-in, remains in browser memory until the user downloads it, and is never uploaded to the server or stored in session records.

## Configuration and verification

Copy `.env.example` to a private `.env` only for provider-backed testing. The example contains no credentials or machine-specific Python path. Leave the API key blank to use the local demo coach. Python is optional; Node-only source extraction remains supported.

Run the complete syntax and regression suite from this folder:

```text
npm run verify
```

The GitHub-ready content contains no real credentials, recordings, databases, logs, source uploads, prior chat artifacts, or inherited Git history. A developer may keep a private ignored `.env` locally for provider testing; it must not be committed.

An authorized provider validation with an 8-page, 6,655-word published PDF completed direct remote digestion in about 35 seconds. Digest reuse then took about 6 ms without resending raw source text, and a voice-source turn plus three further source turns completed successfully in about 14–22 seconds each. The session used about 42,000 of its 132,000-token budget.

For setup and manual checks, see [RUN-THIS.md](RUN-THIS.md). For repository submission, see [GITHUB-SUBMISSION.md](GITHUB-SUBMISSION.md). For the component-level system view and diagrams, see [docs/SYSTEM-SUMMARY.md](docs/SYSTEM-SUMMARY.md).

The `v0.1.0` release record captures the independent verification pass, the bounded feature-freeze scope, and the remaining deployment work in [docs/RELEASE-BASELINE-v0.1.0.md](docs/RELEASE-BASELINE-v0.1.0.md).

## Remaining deployment work

This is a local MVP. Production deployments still need deployment-specific authentication, observability, retention controls, and privacy review before handling sensitive or high-volume workloads.
