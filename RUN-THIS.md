# deepchat2learn test guide

This is a clean testable build of deepchat2learn. It requires Node.js 22.5 or newer and does not require Python.

**Active milestone:** This package is the 2026-07-19 functional MVP baseline. The canonical verified feature checklist and next-phase priorities are in `document/SYSTEM-SUMMARY.md`, under the milestone record section.

## Start

```text
npm start
```

Open http://localhost:3000.

Starting a session automatically begins continuous browser voice conversation and asks for microphone access. On iPhone, tap Start voice conversation and allow both microphone and browser speech recognition if Safari prompts for them. The app primes browser recognition directly from that user gesture; it also recovers from mobile speech playback errors or missing completion events instead of remaining stuck at AI speaking. Browser voice recognition keeps accumulating finalized speech segments until five seconds of silence, rather than submitting the first short segment. Interim hypotheses never appear in the answer box or reach the AI. If the browser revises a result, the newest finalized wording replaces the earlier hypothesis instead of being appended. Typed questions and answers remain available if permission is denied. To enable model-backed answers and optional OpenAI Realtime voice, copy `.env.example` to `.env`, put the API key after `OPENAI_API_KEY=`, and restart the server. The real key must stay in that local `.env`; it is not included in this package. `OPENAI_TEXT_MODEL` controls text understanding; `OPENAI_AUDIO_MODEL` controls the low-latency audio conversation model; `OPENAI_TRANSCRIBE_MODEL` controls live transcription; `OPENAI_SOURCE_DIGEST_TIMEOUT_MS` gives research-paper digestion a longer deadline than ordinary turns. The Python setting in `.env.example` is intentionally blank for distribution: set `DEEPCHAT2LEARN_PYTHON_BIN` to the host's own `python.exe` only when richer PDF extraction is needed, or leave it blank for the Node-only fallback.

### Provider and source-processing prerequisites

Without an API key, the package still supports deterministic testing, typed interaction, browser speech input/output, local fallback coaching, and source extraction. A purchased API key from Claude, Gemini, Grok, DeepSeek, Kimi, or another provider is usable only if the provider is connected through an adapter or OpenAI-compatible API configuration; the current package is tested against OpenAI's API contract. Real-time GPT Live-style voice additionally requires a provider/model that supports the configured Realtime/WebRTC transport.

Python is optional. Text-based PDFs, DOCX/Word documents, TXT, Markdown, and pasted notes can be processed without Python. For complex research PDFs—especially layout-heavy papers with tables, figures, or scanned pages—install Python and PDF-processing packages such as `pdfplumber` and/or `PyMuPDF` (`fitz`) and set the local executable path in `.env`. If Python is unavailable, the app reports the optional extractor limitation and continues with the built-in Node fallback.

If you also turn on recording, keep it explicit and local: it must be started by the user, it stays in browser memory until download, and it requires a browser with `MediaRecorder` plus microphone permission. When the browser can expose both audio streams, the recording is complete-conversation audio; when browser speech fallback is used, the file is microphone-only and labeled that way. The recording stops at 60 minutes or 128 MiB and does not upload to the server.

## Verify

```text
npm run verify
node --test tests/voiceBrowserHarness.test.mjs
```

The automated voice harness verifies continuous startup, five-second browser auto-submission, five-second Realtime silence detection, two reconnect attempts, strict browser and Realtime turn-taking, retryable failed transcripts, source-grounded answers, and typed fallback. The optional Python PDF test may be skipped when `pdfplumber` is not installed; Node-only PDF extraction remains tested.

Add recording scenarios to the manual check list when you verify this build:

1. Enable recording explicitly, confirm the UI explains that audio stays on the device, and start a session.
2. Allow microphone access and confirm the recording state appears.
3. Confirm a supported browser captures complete-conversation audio when the AI stream is available.
4. Confirm browser speech fallback is labeled microphone-only.
5. Stop recording and confirm the download action is explicit, the resulting file is user-controlled, and no audio shows up in transcripts or server logs.
6. Confirm unsupported `MediaRecorder` leaves typed and voice controls usable while recording remains off.
7. Confirm the recording limit warning appears near 55 minutes and the recording finalizes at 60 minutes.

## Manual microphone check

1. Start a session and allow microphone access when prompted.
2. Confirm the opening AI question is spoken before listening begins.
3. Speak for at least 10 seconds with one or two natural pauses shorter than five seconds.
4. Pause for five seconds and confirm the transcript submits automatically.
5. Confirm the spoken response includes a concise answer and focused follow-up, then listening resumes.
6. While the AI is still answering, press **Interrupt answer** before you speak. Confirm the AI speech stops, your transcript becomes the active answer, and the five-second silence window starts after your latest speech. The “Stop voice conversation” and “Speak answer” controls should darken while active.
7. In a practice round, answer the question with a complete research claim or example. Confirm the academic conversation moves to a different related question. Say “new question” or “another issue” and confirm a fresh question appears without increasing the completed-answer count.
8. Deny microphone permission once and confirm the typed controls remain usable.
9. For Realtime testing, confirm microphone input is muted during AI audio, AI speech is not transcribed as user speech, the explicit **Interrupt answer** control opens the microphone, and disconnect/reconnect does not restart the academic session.

## Source-material check

- The default source limit is 10 files, 20 MB per file, and 50 MB combined. Deployment settings can change these values, and the browser follows the server-advertised file limit.
- Research PDFs retain page-aware text, captions, and embedded-figure metadata. When `DEEPCHAT2LEARN_PYTHON_BIN` points to the host's Python with `pdfplumber` and/or `PyMuPDF`, the package can use stronger extraction for typical research-paper tables and captions. This optional path is useful for papers like the supplied cognitive-trajectories PDF; Node-only hosting still works for text-based inputs and as a fallback.
- `academic-research` or `epi-research` may guide digestion and explicit review. Routine spoken rounds use the compact `academic-conversation` skill.
- Source-specific claims must have supplied-material citations. LLM background is displayed separately.

## Privacy

Raw microphone audio is never stored. Do not add `.env`, SQLite databases, logs, caches, temporary files, generated audio files, or `node_modules` to a test package. If you package a recording-enabled build, keep the downloaded audio file out of the bundle; it belongs to the user's device, not the app.
