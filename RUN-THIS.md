# deepchat2learn test guide

This is a clean testable build of deepchat2learn. It requires Node.js 22.5 or newer and does not require Python.

## Start

```text
npm start
```

Open http://localhost:3000.

Starting a session automatically begins continuous browser voice conversation and asks for microphone access. Browser voice recognition keeps accumulating finalized speech segments until five seconds of silence, rather than submitting the first short segment. Typed questions and answers remain available if permission is denied. To enable model-backed answers and optional OpenAI Realtime voice, copy `.env.example` to `.env`, put the API key after `OPENAI_API_KEY=`, and restart the server. The real key must stay in that local `.env`; it is not included in this package. `OPENAI_TEXT_MODEL` controls text understanding; `OPENAI_AUDIO_MODEL` controls the low-latency audio conversation model; `OPENAI_TRANSCRIBE_MODEL` controls live transcription. Ordinary text turns use a 30-second default deadline, balancing fuller remote-model response time with a responsive demo; the local academic fallback can continue the session if the deadline is reached. `OPENAI_SOURCE_DIGEST_TIMEOUT_MS` gives research-paper digestion a longer deadline than ordinary turns. The template is prefilled with the current Windows Python path for richer research-PDF extraction. Change that path on another computer, or leave it blank to use the Node-only fallback.

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
3. On a mobile device, confirm the primary voice button and live processing/status message appear immediately below the AI question without scrolling.
4. Speak for at least 10 seconds with one or two natural pauses shorter than five seconds.
5. Pause for five seconds and confirm the transcript submits automatically.
6. Confirm the spoken response includes a concise answer and focused follow-up, then listening resumes.
7. Speak while the AI is still answering. Confirm the AI speech stops, your transcript becomes the active answer, and the five-second silence window starts after your latest speech. The “Stop voice conversation” and “Speak answer” controls should darken while active.
8. In a practice round, answer the question with a complete research claim or example. Confirm the academic conversation moves to a different related question. Say “new question” or “another issue” and confirm a fresh question appears without increasing the completed-answer count.
9. Deny microphone permission once and confirm the typed controls remain usable.
10. For Realtime testing, confirm microphone input is muted during AI audio, AI speech is not transcribed as user speech, the explicit Interrupt answer control opens the microphone, and disconnect/reconnect does not restart the academic session.
11. On a mobile device, test both a browser with SpeechRecognition and one without it. When Realtime is configured, both should use the same live WebRTC path; when it is not configured, the app should use browser speech where available and provide typed fallback without blocking the session. If mobile audio autoplay is blocked, tap the page once after the connection message and confirm AI audio begins.

## Source-material check

- The default source limit is 10 files, 20 MB per file, and 50 MB combined. Deployment settings can change these values, and the browser follows the server-advertised file limit.
- Research PDFs retain page-aware text, captions, and embedded-figure metadata. When `DEEPCHAT2LEARN_PYTHON_BIN` points to Python with `pdfplumber`, the package also extracts typical research-paper tables and captions. This optional path is useful for papers like the supplied cognitive-trajectories PDF; Node-only hosting still works as a fallback.
- `academic-research` or `epi-research` may guide digestion and explicit review. Routine spoken rounds use the compact `academic-conversation` skill.
- Source-specific claims must have supplied-material citations. LLM background is displayed separately.

## Privacy

Raw microphone audio is never stored. Do not add `.env`, SQLite databases, logs, caches, temporary files, generated audio files, or `node_modules` to a test package. If you package a recording-enabled build, keep the downloaded audio file out of the bundle; it belongs to the user's device, not the app.
