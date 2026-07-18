# deepchat2learn - Academic Learning MVP

deepchat2learn is a browser-based academic learning environment for deep voice conversations, practicing explanations, and exploring supplied source material. The dependency-free local setup includes a deterministic academic conversation coach and can optionally use a server-side text model, live AI voice, and SQLite persistence.

For the architecture, conversation flows, feature map, current limitations, and distribution checklist, see [document/SYSTEM-SUMMARY.md](document/SYSTEM-SUMMARY.md) and [document/DISTRIBUTION-READINESS.md](document/DISTRIBUTION-READINESS.md).

Bundled skill profiles can shape how supplied materials are digested and discussed. The first profile is `epi-research`, a doctoral-level epidemiologic methods critique guide stored under `skills/epi-research/`. Skill guidance controls the review method and response structure; paper-specific claims and citations must still come from the uploaded material.

## Run locally

Requires Node.js 22.5 or newer. This release uses Node's built-in `node:sqlite` module when `SQLITE_PATH` is configured.

```text
npm start
```

Open [http://localhost:3000](http://localhost:3000).

The test suite uses Node's built-in test runner in deterministic serial mode. It deliberately ignores a local `.env` so fallback and no-key paths remain testable without making remote API calls. This avoids intermittent Windows worker contention in the SQLite/PDF-heavy cases:

```text
npm test
```

For the syntax and regression check, run `npm run verify`. It checks every JavaScript module and runs the complete test suite. You can run only the syntax check with `npm run typecheck`.

Practice sessions start with a 50-round question-and-answer limit. Sessions that use supplied materials start with a 200-round limit. Smaller limits remain available in the setup controls. Starting a session now enters continuous browser voice conversation automatically: the AI speaks, the microphone listens, the finalized transcript waits five seconds, and the answer is submitted. If microphone access is denied or voice is unavailable, the same session remains usable through typed controls. Enable “Review before sending” when you want to approve or edit the transcript first.

Optional conversation recording is separate from the voice flow. It is opt-in, browser-local, and kept in memory until you explicitly download it. When the browser can expose both the microphone and the AI audio stream, the recording can contain the complete conversation; browser speech fallback records microphone-only audio and labels it that way. Recording stops at 60 minutes or 128 MiB, whichever comes first, and the file is only created when you choose to download it.

## Configure the OpenAI key

The key belongs in a separate `.env` parameter file at the project root—the same folder as `package.json`. Do not place it in `public/`, `src/`, browser storage, or frontend JavaScript.

1. Copy `.env.example` to a new file named `.env`.
2. Open `.env` and set the key on the `OPENAI_API_KEY` line:

```text
OPENAI_API_KEY=your-key-goes-here
```

3. Save the file and start the server with `npm start`.
4. Open [http://localhost:3000](http://localhost:3000).

The server loads `.env` automatically and reads `OPENAI_API_KEY` only on the server. `.env` is ignored by Git; never commit it or share it in screenshots, logs, or chat. If the key is blank or the `.env` file is absent, the typed path, browser voice input, and spoken browser playback still work through the local demo and browser capabilities. Without a provider key, responses are limited to the bundled local academic coach and built-in extraction; provider-backed answers are not available.

To use model-backed text coaching, source digestion, and OpenAI Realtime voice, provide a valid key and keep the remaining settings from `.env.example` unless you have a reason to change them. A key from another provider—such as Claude, Gemini, Grok, DeepSeek, or Kimi—can be used only after adding an adapter or configuring an OpenAI-compatible endpoint for that provider. A provider key by itself is not automatically interchangeable with the current OpenAI SDK/API calls. For GPT Live-style real-time audio, the selected provider must also support the configured Realtime/WebRTC path; a text-only API key enables text generation but not live voice transport.

### Python and PDF extraction

```text
DEEPCHAT2LEARN_PYTHON_BIN=full-path-to-your-python.exe
```

The Python path is deliberately blank in the distributable `.env.example`; never copy a developer's personal path into a shared package. Set it to the full path of the Python executable on the machine running the server, or leave it blank. Python is optional for ordinary text-based PDFs, DOCX/Word files, TXT, Markdown, and pasted notes because the Node fallback handles those inputs. Python plus PDF packages such as `pdfplumber` and/or `PyMuPDF` (`fitz`) is recommended for complex, layout-heavy, table-rich, figure-heavy, or scanned research PDFs. Additional OCR or figure-vision tooling may be required for scanned pages and visual interpretation. If Python is unavailable, the application should report that optional enhancement as unavailable and continue with its built-in Node extraction rather than rejecting the source.

```text
OPENAI_API_KEY=your-server-side-key
OPENAI_TEXT_MODEL=gpt-5-mini
OPENAI_TEXT_TIMEOUT_MS=120000
OPENAI_SOURCE_DIGEST_TIMEOUT_MS=300000
# Separate low-latency audio model; change this independently from text reasoning.
OPENAI_AUDIO_MODEL=gpt-realtime-mini
# Optional backward-compatible alias if OPENAI_AUDIO_MODEL is blank.
OPENAI_REALTIME_MODEL=
OPENAI_REALTIME_TIMEOUT_MS=120000
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
VOICE_AUTO_SUBMIT_DELAY_MS=5000
VOICE_TRANSITION_DELAY_MS=750
VOICE_REALTIME_SILENCE_MS=5000
VOICE_REALTIME_WATCHDOG_MS=0
VOICE_MAX_RECOGNITION_RETRIES=8
VOICE_MAX_TRANSCRIPT_CHARACTERS=12000
RATE_LIMIT_PER_MINUTE=120
MAX_ANSWER_CHARACTERS=12000
MAX_QUESTION_CHARACTERS=2000
MAX_REQUEST_BODY_BYTES=28000000
SESSION_RETENTION_MODE=session
SESSION_TTL_MS=3600000
SESSION_SHORT_EXPIRY_MS=900000
SESSION_TURN_BUDGET=50
SESSION_MODEL_TOKEN_BUDGET=120000
MAX_SOURCE_FILES=10
MAX_SOURCE_FILE_BYTES=20000000
MAX_SOURCE_COMBINED_BYTES=50000000
npm start
```

The text model powers questions, feedback, and general-context answers. The live voice button uses a separate Realtime audio model and transcription model, so speech latency and cost can be tuned independently from text reasoning. The backend still owns source-grounded answers and the typed turn contract. Realtime turn detection waits for five seconds of silence by default so normal academic pauses do not end an answer prematurely. Browser voice recognition is continuous and accumulates multiple finalized speech segments before the five-second pause submits the answer. Interim hypotheses stay out of the answer box and server request; when the browser revises a result at the same recognition index, the latest finalized wording replaces the earlier hypothesis instead of being appended. Ordinary voice turns allow up to 120 seconds for model processing and source digestion allows up to 300 seconds by default; temporary failures preserve the transcript so it can be retried, and stopping a session discards any late response from an earlier turn.

Set `SQLITE_PATH=./data/deepchat2learn.sqlite` to persist sessions and supplied materials across restarts. Leave it unset for the lightweight in-memory demo. SQLite persistence requires Node 22.5 or newer because it uses Node's built-in `node:sqlite` support.

## Current slice

- Topic-based coaching setup with progressive settings.
- Typed answer loop: question -> answer -> feedback -> follow-up -> summary.
- Coaching feedback now includes an academic relevance judgment, a concise knowledge-based explanation or correction, and a follow-up tied to the user's latest claim or gap. Voice coaching speaks the same sequence so the discussion develops from the learner's response.
- Session-scoped capability tokens and in-memory retention.
- Optional PDF, DOCX, TXT, Markdown, or pasted material for source-grounded questions. The default per-file limit is 20 MB, and the browser reads the active deployment limit from the server. PDF ingestion works on ordinary Node web hosts without Python and retains page-aware text, table rows, table/figure captions, embedded-figure metadata, and safely extractable figure bytes when available. Set `DEEPCHAT2LEARN_PYTHON_BIN` to the host's own Python executable with packages such as `pdfplumber` and/or `PyMuPDF` installed for stronger research-paper extraction. Without Python, text-based PDFs and Word/text materials remain supported through the Node fallback. Scanned-PDF OCR and visual figure interpretation are not included by default.
- Optional local audio recording of the active conversation. It requires a browser that supports `MediaRecorder` and an allowed microphone permission; if either is unavailable, the regular typed and voice controls still work but recording stays off. The recording never uploads to the server, never enters transcripts, and never becomes part of the session record.
- Per-source digest preview; with `OPENAI_API_KEY`, digests are model-generated with evidence-validated key points and a safe extractive fallback.
- Bundled `academic-research` and `academic-conversation` skills, plus the optional `epi-research` methods-review skill. Research skills digest supplied documents; academic conversation guides the live typed and voice dialogue.
- Source conversation rounds use a compact academic dialogue protocol; full research digestion and epidemiology critique guidance are reserved for source processing or explicit review requests so voice turns remain responsive.
- Source answers combine exact document evidence with clearly labeled general LLM context, discussion points, suggestions, uncertainty, and follow-up questions. External research remains consent-gated.
- Per-source digests persist and reappear after adding multiple materials or refreshing the session.
- Material-generated coaching questions persist as the active turn, including across refresh and SQLite-backed sessions.
- A session started with supplied material opens with a grounded coaching question; material-free sessions keep the general topic question.
- With multiple supplied materials, the local fallback coach asks a comparison question across them.
- Optional SQLite persistence with FTS5 source retrieval across restarts.
- Model-backed source answers validate exact evidence substrings before showing citations.
- Potentially conflicting source passages are surfaced instead of silently hidden.
- Feedback includes a “Why this feedback?” evidence disclosure, and session reviews retain those excerpts.
- Final summaries show recurring strengths, recurring gaps, and whether supplied materials informed the session.
- Duplicate source content is rejected using SHA-256 content hashes.
- API requests are rate-limited per session token or client address.
- Browser speech synthesis captions/playback and optional browser speech recognition.
- Voice conversation follows a focused continuous loop: start the session, speak the question, listen for the answer, wait five seconds after the final transcript, retrieve and digest source material when applicable, speak a concise answer with discussion help and a focused follow-up, then listen again.
- Voice status announces listening, answer finalization, source retrieval/digestion, evaluation, and speaking phases. Temporary failures preserve the captured transcript for retry, while typed answers remain available as a fallback. During AI speech, microphone input is paused to prevent echo capture; the explicit Interrupt answer control cancels AI output before listening continues.
- Realtime voice closes and reconnects transport independently from the academic session. Server-side VAD finalizes user speech after configured silence, while echo cancellation, noise suppression, and automatic gain control are requested from the browser.
- Both practice and source conversations use only the compact academic-conversation guide for each dialogue turn. Full academic-research and epi-research guidance is reserved for source digestion or explicit review requests. Live model prompts send up to three bounded prior exchanges, a compact digest, and a small set of retrieved source passages; short retrieval follow-ups use only the two most immediate exchanges. A complete answer advances to a different related question; say “new question,” “ask something new,” or “another issue” to move on immediately. Source-review skills remain focused on digesting and reviewing supplied materials.
- Voice timing and transcript size are configurable through `VOICE_AUTO_SUBMIT_DELAY_MS`, `VOICE_TRANSITION_DELAY_MS`, `VOICE_REALTIME_SILENCE_MS`, `VOICE_REALTIME_WATCHDOG_MS`, `VOICE_MAX_RECOGNITION_RETRIES`, and `VOICE_MAX_TRANSCRIPT_CHARACTERS`. The realtime watchdog defaults to `0` (disabled), so active speech is not cut off by elapsed time; silence/VAD remains the turn boundary. Model requests use `OPENAI_TEXT_TIMEOUT_MS`; source digestion uses the longer `OPENAI_SOURCE_DIGEST_TIMEOUT_MS` deadline and a bounded digest context. JSON request bodies default to 28 MB so a base64-encoded source can fit within the 20 MB per-file limit; adjust `MAX_REQUEST_BODY_BYTES` with the source limits if needed.
- The recording UI is explicitly user-driven: the user must start recording, stop it, and choose whether to download the resulting file.
- Practice sessions support up to 50 rounds; source-grounded sessions support up to 200 rounds.
- Optional OpenAI Realtime WebRTC connection when a server API key is configured.
- Explicit session deletion.
- Expired sessions are pruned, including associated source and turn data.
- Retention choices for session-only, until-deleted, or short-expiry storage of transcripts, materials, digests, and citations.
- Per-session turn and model-budget guards return a clear limit message instead of silently overrunning usage.
- `GET /api/health` provides an unauthenticated liveness check for local or hosted deployments.

## Privacy note

The default setup stores session data in memory and does not save audio. During an explicitly enabled recording, audio exists only in the active local recording buffer; the app does not retain it in SQLite, browser storage, logs, transcripts, or API responses. The app never uploads audio to the server. Any downloaded file is controlled by the user's device and file-system permissions after the explicit download action.

Retention applies to transcripts, pasted material, extracted text, digests, citations, and external research records:

- `SESSION_RETENTION_MODE=session` keeps the current one-hour session-style expiry.
- `SESSION_RETENTION_MODE=until_deleted` keeps session data until the user deletes it.
- `SESSION_RETENTION_MODE=short_expiry` uses `SESSION_SHORT_EXPIRY_MS` for a shorter automatic expiry.

With `SQLITE_PATH` configured, retained session records, pasted material, extracted text, digests, and transcripts persist in the SQLite database until the configured expiry or deletion cascade removes them. Deleting a session removes the session row plus voice turns, source chunks, digests, citations, idempotency records, and stored external research results for that session.

Budget controls are configurable per deployment with `SESSION_TURN_BUDGET` and `SESSION_MODEL_TOKEN_BUDGET`. When a session hits either budget, the app returns a clear spoken and visual limit message so the user can start a fresh session instead of continuing with partial state.

External research remains opt-in. Enable it only with `EXTERNAL_RESEARCH_ENABLED=true`, and expect every external lookup to require explicit consent in the UI before results are attached to an answer.

This remains a local MVP: production authentication, OCR or vision-based figure interpretation, observability, and deployment-specific privacy controls are still required before handling sensitive or high-volume workloads.
