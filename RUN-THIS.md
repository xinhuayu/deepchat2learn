# deepchat2learn test guide

This guide accompanies the `v0.1.0` feature-freeze baseline. Read the [release baseline](docs/RELEASE-BASELINE-v0.1.0.md) before changing frozen behaviour or preparing a submission.

This is a clean testable build of deepchat2learn. It requires Node.js 22.5 or newer and does not require Python.

> **Critical known issue — mobile voice:** The desktop voice conversation path is the verified reference for `v0.1.0`. Continuous voice conversation through mobile browsers is still not working reliably, so mobile microphone checks below are diagnostic follow-up work rather than a release-readiness claim. Use desktop voice or typed interaction for the current baseline.

## Start

```text
npm start
```

Open http://localhost:3000.

Starting a session automatically begins continuous browser voice conversation and asks for microphone access.

Practice mode starts with a digest-free framing phase. The first three completed rounds establish the learner’s definition and aim, scope and boundaries, then a central claim, hypothesis, mechanism, setting, or example. After the third round, the remote text path receives those three exchanges with the explicit `within the topic of ...` constraint, creates a targeted digest and gist, and presents a short scope-confirmation prompt. The next response can confirm or correct the focus; later requests use the refined scope with up to five compact exchanges.

Source conversation progresses through definition, scope, research aim, claim or hypothesis, setting, design, measures, evidence, interpretation, and related extensions using the prepared digest. Source-answer requests send compact evidence options and the latest three exchanges; generated source questions use the prepared digest and recent history. The original document and complete raw chunks remain server-local after preparation.

Browser voice recognition keeps accumulating finalized speech segments until five seconds of silence, rather than submitting the first short segment. Typed questions and answers remain available if permission is denied. To enable model-backed answers and optional OpenAI Realtime voice, copy `.env.example` to `.env`, put the API key after `OPENAI_API_KEY=`, and restart the server. The real key must stay in that local `.env`; it is not included in this package. `OPENAI_TEXT_MODEL` controls text understanding; `OPENAI_AUDIO_MODEL` controls the low-latency audio conversation model; `OPENAI_TRANSCRIBE_MODEL` controls live transcription.

Ordinary text turns use a 45-second default deadline, balancing fuller remote-model response time with a responsive demo; the local academic fallback continues the session if the gateway deadline is reached. `OPENAI_SOURCE_DIGEST_TIMEOUT_MS` gives research-paper digestion a longer deadline, while `OPENAI_SOURCE_DIGEST_MAX_OUTPUT_TOKENS=12000` supplies separate structured-output headroom for larger papers. The direct provider digest request is bounded to 88,000 characters per source; explicit consolidation can batch bounded chunks. The template leaves the optional Python executable path blank; set it only on the current host when richer research-PDF extraction is needed, or leave it blank to use the Node-only fallback.

Practice sessions support up to 50 questions and source sessions up to 200; smaller limits can be selected during setup. The application’s default session model-budget guard is 132,000 estimated input-size tokens, separate from the provider’s actual usage or billing meter.

If you also turn on recording, keep it explicit and local: it must be started by the user, it stays in browser memory until download, and it requires a browser with `MediaRecorder` plus microphone permission. When the browser can expose both audio streams, the recording is complete-conversation audio; when browser speech fallback is used, the file is microphone-only and labeled that way. The recording stops at 60 minutes or 128 MiB and does not upload to the server.

Academic framing check: the first rounds should establish definition and aim, scope and boundaries, then a claim, hypothesis, mechanism, setting, or example. After the third practice round, verify the targeted digest/gist and scope-confirmation prompt; the next response may confirm or correct the focus, and later requests should carry no more than five compact exchanges. Source conversations should continue through design, measures, evidence, interpretation, and uncertainty before moving into related open questions.

## Verify

```text
npm run verify
node --test tests/voiceBrowserHarness.test.mjs
```

The automated voice harness verifies continuous startup, five-second browser auto-submission, five-second Realtime silence detection, two reconnect attempts, strict browser and Realtime turn-taking, direct session-ending requests, concise spoken learning guidance, retryable failed transcripts, source-grounded answers, and typed fallback. The optional Python PDF test may be skipped when `pdfplumber` is not installed; Node-only PDF extraction remains tested.

Add recording scenarios to the manual check list when you verify this build:

1. Enable recording explicitly, confirm the UI explains that audio stays on the device, and start a session.
2. Allow microphone access and confirm the recording state appears.
3. Confirm a supported browser captures complete-conversation audio when the AI stream is available.
4. Confirm browser speech fallback is labeled microphone-only.
5. Stop recording and confirm the download action is explicit, the resulting file is user-controlled, and no audio shows up in transcripts or server logs.
6. Confirm unsupported `MediaRecorder` leaves typed and voice controls usable while recording remains off.
7. Confirm the recording limit warning appears near 55 minutes and the recording finalizes at 60 minutes.

## Manual microphone check

For practice mode, verify the discovery sequence explicitly: the opening question asks for the learner’s working definition, the next rounds narrow scope and request a useful specific or example, and after the third completed round the app asks for confirmation of the generated digest/gist. After confirmation, later requests should carry the digest and no more than five recent exchanges. Source mode keeps its separate prepared-source-digest contract.

1. Start a session and allow microphone access when prompted.
2. Confirm the opening AI question is spoken before listening begins.
3. On desktop, confirm the primary voice button and visibly highlighted live processing/status message appear immediately below the AI question without scrolling. On mobile, record whether the same state appears and whether the voice connection proceeds; the known mobile-browser issue may reproduce here. The separate latest-spoken-line caption must not receive the processing highlight.
4. Speak for at least 10 seconds with one or two natural pauses shorter than five seconds.
5. Pause for five seconds and confirm the transcript submits automatically.
6. Confirm the spoken response includes one brief, concrete learning step and a focused follow-up, then listening resumes.
7. Speak while the AI is still answering. Confirm the AI speech stops, your transcript becomes the active answer, and the five-second silence window starts after your latest speech. The “Stop voice conversation” and “Speak answer” controls should darken while active.
8. In a practice round, answer the question with a complete research claim or example. Confirm the academic conversation moves to a different related question. Say “new question” or “another issue” and confirm a fresh question appears without increasing the completed-answer count.
9. Say "end the session," "finish the conversation," "wrap up," or "I am done." Confirm the app gives a brief closure, asks no next question, and moves to the summary page.
10. Deny microphone permission once and confirm the typed controls remain usable.
11. For Realtime testing, confirm microphone input is muted during AI audio, AI speech is not transcribed as user speech, the explicit **Interrupt AI answer** control opens the microphone, and disconnect/reconnect does not restart the academic session.
12. For future mobile diagnosis, test both a mobile browser with SpeechRecognition and one without it. Record whether Realtime/WebRTC, browser speech, permissions, autoplay, and typed fallback behave as expected; do not treat a successful desktop run as evidence that this critical mobile issue is resolved. If mobile audio autoplay is blocked, tap the page once after the connection message and record whether AI audio begins.
13. Start a fresh session after completing or leaving another. Confirm its review panel is empty until the new conversation produces entries, then confirm the newest item is at the top after each exchange.

## Source-material check

- The default source limit is 10 files, 20 MB per file, 50 MB combined, 300 pages, and 150,000 extracted words. Deployment settings can change these values, and the browser follows the server-advertised file limit.
- The direct provider digest request uses up to 88,000 characters per source; the complete extracted source and chunks remain local, and explicit consolidation can batch bounded chunks.
- Research PDFs retain page-aware text, captions, and embedded-figure metadata. When `DEEPCHAT2LEARN_PYTHON_BIN` points to Python with `pdfplumber`, the package also extracts typical research-paper tables and captions. This optional path is useful for complex research PDFs; Node-only hosting still works as a fallback.
- `academic-research` or `epi-research` may guide digestion and explicit review. Routine spoken rounds use the compact `academic-conversation` skill.
- Source-specific claims must have supplied-material citations. LLM background is displayed separately.

## Privacy

Raw microphone audio is never stored. Do not add `.env`, SQLite databases, logs, caches, temporary files, generated audio files, or `node_modules` to a test package. If you package a recording-enabled build, keep the downloaded audio file out of the bundle; it belongs to the user's device, not the app.
