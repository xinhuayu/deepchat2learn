<p align="center"><img src="../public/brand-logo.png" alt="deepchat2learn logo" width="220"></p>

# deepchat2learn — technical inventory and milestone record

**Milestone date:** 19-20 July 2026  
**Status:** `v0.1.0` feature-freeze baseline / controlled demonstration  
**Role of this document:** canonical technical handoff for the GitHub-ready package.

This inventory records what is implemented, the operating contracts that protect the conversation, the verification evidence for the current baseline, and the engineering work still required before public deployment. The companion [system summary](SYSTEM-SUMMARY.md) explains the learning purpose, pedagogy, and product direction; the [release baseline](RELEASE-BASELINE-v0.1.0.md) records the independent audit and change-control gate; this document records the technical state behind both.

## Critical known issue: mobile-browser voice conversation

| Field | Milestone record |
|---|---|
| Severity | **Critical for mobile voice support**; it does not invalidate the verified desktop/controlled-demonstration baseline. |
| Observed status | Desktop voice conversation works, but continuous voice conversation through mobile browsers is still not working reliably. Typed interaction and desktop voice remain available workarounds. |
| Frozen decision | No application code, runtime behavior, or manually edited `public/index.html` titles are changed in this freeze. `v0.1.0` makes no mobile-voice readiness claim. |
| Required future investigation | Reproduce across target devices and browsers, then isolate microphone permission, autoplay, WebRTC/Realtime transport, browser speech fallback, and slow-network/reconnect behavior. Validate the fix with real-device tests before changing the frozen contract. |

## 1. Baseline and runtime

| Item | Current state |
|---|---|
| Package | `deepchat2learn` version `0.1.0`, private Node ESM application. |
| Release posture | `v0.1.0` is frozen for controlled demonstrations and GitHub submission; it is not a public-production 1.0 release. |
| Runtime | Node.js `>=22.5.0`. The service starts with `node src/server.mjs`. |
| Verification command | `npm run verify`, which runs JavaScript syntax checks followed by the deterministic test suite. |
| Browser application | `public/index.html`, `public/app.js`, `public/styles.css`, and `public/audioRecording.js`. |
| Server application | Node HTTP server in `src/server.mjs`; no browser credential access. |
| Storage | In-memory session storage by default; optional SQLite when `SQLITE_PATH` is configured. |
| Provider configuration | Private ignored `.env` on the server only. `.env.example` is retained as a sanitized setup template with no credentials or machine-specific paths. |
| Clean-distribution policy | The GitHub baseline excludes actual `.env` files, API keys, `node_modules`, caches, logs, runtime recordings, source uploads, databases, stale test output, bug reports, and prior chat-history artifacts. |

## 2. Component inventory

| Component | Main responsibility | Key technical boundary |
|---|---|---|
| `public/app.js` | Browser state, session creation, typed interaction, voice UI, transcripts, review display, source actions, and retry behaviour. | Treats the backend as the authority for turn outcomes; prevents stale client responses from taking over an active session. |
| `public/audioRecording.js` | Opt-in local `MediaRecorder` control and learner download. | Recording remains browser-local and is not placed in application requests or persisted session records. |
| `src/server.mjs` | HTTP server, static files, health report, security headers, request limits, session/API routing, source endpoints, and Realtime setup endpoints. | Reads provider settings only server-side and applies session capability checks before handling protected operations. |
| `src/config.mjs` | Parses and validates limits, timeouts, budgets, and environment overrides. | Defaults are explicit; an invalid override does not silently create an unbounded limit. |
| `src/conversationOrchestrator.mjs` | Session start, answer submission, idempotency, model-budget accounting, question progression, and response persistence. | A duplicate request replays the stored result instead of consuming a second round or model budget. |
| `src/topicScope.mjs` | Normalizes the targeted practice topic digest/gist generated after discovery and creates a bounded deterministic local scope for fallback. | The scope is a compact session constraint, not a substitute for source evidence or an unbounded transcript. |
| `src/voiceSession.mjs` | Voice-turn intent classification, guided learning responses, source-answer envelopes, interruption/retry handling, and summary-relevant records. | Closing, move-on, and direct-question language are handled before ordinary answer evaluation. |
| `src/modelCoach.mjs` | Prompt assembly, staged academic framing, strict structured text-model responses, source digestion, source-aware answers, and schema normalization. | Source and practice contexts are bounded differently; malformed output is not accepted as a normal result. |
| `src/modelGateway.mjs` | Provider call routing, task-specific deadlines, transient-error handling, and typed provider diagnostics. | Gateway timeout triggers a safe local AI-for-learning result rather than an unhandled conversational failure. |
| `src/fakeCoach.mjs` | Deterministic local AI-for-learning fallback for no-key development and provider recovery. | Keeps the product usable and tests deterministic without pretending that a fallback is provider-backed synthesis. |
| `src/sourceIngestion.mjs` | File validation and extraction for PDF, DOCX, TXT, Markdown, and pasted text. | Enforces source byte/page/word limits before expensive processing. Python-enhanced PDF extraction is optional. |
| `src/sourceKnowledge.mjs` | Source chunks, digest state, retrieval, evidence preparation, citations, and support classification. | Complete source material remains server-local after preparation; live source prompts receive bounded prepared context. |
| `src/evidence.mjs` | Citation/excerpt normalization and local source-support validation. | Accepts harmless extraction formatting changes but preserves original source excerpts for validation and display. |
| `src/realtime.mjs` | OpenAI Realtime/WebRTC request construction and server-side configuration. | Realtime carries audio transport; it does not bypass the authoritative text, source, budget, or turn-state path. |
| `src/store.mjs` and `src/sqliteStore.mjs` | Session lifecycle, isolated data, review records, summaries, retention, and optional durable persistence. | Sessions do not share histories, sources, budgets, transcripts, or pending turn state. |
| `src/rateLimit.mjs` | Request-rate guardrails and maintenance. | Limits protect the service without changing the learning agenda or source evidence contract. |
| `src/skillRegistry.mjs` and `src/skillDetection.mjs` | Selection and routing of named academic conversation/research skills. | Live conversation remains on `academic-conversation`; heavier source preparation can use research-oriented skills. |

## 3. Functional and state contracts

### Session and records

- A new session selects practice or source mode, stores a topic and opening question, and starts with an isolated history, budget, review record, and source set.
- A practice session starts without a topic digest. Its first three completed rounds establish the learner’s definition and aim, scope and boundaries, then a central claim, hypothesis, mechanism, setting, or example. The third round sends the first three exchanges with the explicit `within the topic of ...` constraint to the topic-digest task, which returns a definition, scope, gist, key concepts, boundaries, and an anchor question; the learner then receives a scope-confirmation question. If remote refinement is unavailable or invalid, the local AI-for-learning fallback creates a deterministic equivalent.
- A successful new session clears the browser’s visible review. Persisted entries retain timestamps and render newest first after reload.
- Session operations use capability/session checks, idempotency keys, question-round limits, token-budget accounting, expiry/retention behaviour, and stale-response protection.
- An explicit end request completes the session, provides a brief closure, and opens the summary. It does not add an artificial final question or consume an answer round.

### Conversation routing

```text
final learner contribution
  → classify: end | move on | direct question | ordinary response
  → prepare mode-specific bounded context (practice discovery or refined scope + five exchanges, or source digest + three exchanges)
  → request and validate structured response, or use safe fallback
  → persist the completed turn and update agenda/budget/review
  → deliver concise response plus one focused next question
```

- **End:** phrases such as “end the session,” “finish the conversation,” “wrap up,” and “I am done” take precedence over normal learning guidance.
- **Move on:** selects a relevant next question without treating the request as an answer.
- **Direct question:** receives an explanation before the conversation returns to its agenda.
- **Ordinary practice response:** receives concise learning feedback and a response-linked question.
- **Ordinary source response:** is discussed through the source-aware answer path rather than being converted into a practice scorecard.

### Academic conversation framing contract

- Live dialogue establishes the frame in this order whenever the material supports it: definition and orientation; scope and research aim; claim, hypothesis, or central question; setting, population, unit, and time horizon; design, comparison, and measures; findings and evidence; interpretation and uncertainty; then limitations, implications, or related extensions.
- Practice uses the first three completed rounds for definition/aim, scope/boundaries, and claim/hypothesis/mechanism plus setting or example before creating the deferred topic digest. Source conversation uses the prepared digest and exact evidence to ask the same frame questions without resending the raw document.
- A missing or inapplicable element is marked as not reported, unclear, or not applicable. Later open questions must connect to the active topic, frame, digest, or source evidence; unrelated pivots are briefly reframed rather than accepted as the next agenda.

### Practice topic-scope contract

- The first three practice rounds are a discovery phase. The `topic_digest` task runs once after the third completed round, receives exactly those three exchanges and the explicit `within the topic of ...` constraint, and uses a bounded 1,200-token structured response allowance.
- The accepted scope fields are `definition`, `scope`, `gist`, `keyConcepts`, `boundaries`, and `anchorQuestion`. They are compacted again before being placed in later prompts.
- The opening and first discovery questions receive only the stated topic and bounded history. After refinement and confirmation, next-question, evaluation, and general-answer requests receive the active scope. Vague questions are answered within that scope or receive a short clarification instead of causing an unrelated topic pivot.
- The scope is persisted in the in-memory session and the SQLite `topic_digest_json` column. Source sessions leave this field empty because the prepared source digest/gist is their authoritative topic constraint.

### Voice contract

- Browser recognition accumulates only final speech segments; interim hypotheses do not enter the answer box or server request.
- A spoken answer is submitted after **five seconds** of silence. The same five-second silence setting is retained for Realtime turn detection.
- AI speech highlights the real voice-processing status and pauses microphone capture to reduce echo. **Interrupt answer** stops playback and returns control to the learner.
- Final transcripts are normalized before submission; a temporary failed turn remains retryable and can be edited or submitted as typed text.
- The browser voice path, optional Realtime path, and typed fallback share the same server-side intent, source, budget, and persistence rules.

### Source contract

```text
source upload
  → validate and extract
  → chunk and retain original material locally
  → create evidence-linked digest/gist or extractive fallback
  → use digest/gist + compact evidence + bounded history in live conversation
  → validate local citation/support before presenting source-grounded claims
```

- Complete source text is used during ingestion/digestion. It is not resent in ordinary live source turns after a digest is ready.
- Source prompts include the topic, prepared digest/gist, compact exact-evidence options, and at most the latest **three** exchanges.
- Practice prompts include the topic and at most the latest **five** compact exchanges.
- Raw source text and complete chunks remain local for retrieval, validation, and fallback. Explicit forced consolidation is a maintenance path, not the ordinary conversational path.
- Source answers distinguish source-supported material, digest-level understanding, general academic context, unsupported material, and fallback-derived responses.

## 4. Configuration inventory

### Conversation, voice, and provider defaults

| Control | Default | Engineering purpose |
|---|---:|---|
| Interactive text deadline | 45 seconds | Allows realistic remote response time while preventing an indefinitely pending conversation turn. |
| Practice topic-digest allowance | 1,200 tokens | Leaves room for a concise post-third-round definition, scope, gist, boundaries, concepts, and anchor question. |
| Source-digestion deadline | 180 seconds | Gives large academic-document digestion a separate, longer execution window. |
| Source-digest output allowance | 12,000 tokens | Reduces `max_output_tokens` incomplete-digest failures for substantial papers. |
| Source-conversation output allowance | 3,300 tokens | Allows an evidence-aware explanation without applying the much larger digestion allowance to every live turn. |
| Realtime setup deadline | 60 seconds | Bounds WebRTC/Realtime initialization and provider negotiation. |
| Browser voice auto-submit silence | 5,000 ms | Preserves the requested five-second answer-finalization behaviour. |
| Realtime silence | 5,000 ms | Keeps voice turn detection aligned with browser voice. |
| Transcript and answer limit | 13,200 characters each | Provides headroom for natural spoken explanations while keeping requests bounded. |
| Question limit | 2,200 characters | Permits detailed academic questions without unbounded prompt growth. |
| Session model budget | 132,000 tokens | Sets a session-level consumption ceiling across remote model turns. |
| JSON request-body limit | 28 MB | Allows source-related payloads while preventing oversized API requests. |

### Source limits

| Control | Default |
|---|---:|
| Files per session | 10 |
| Individual file size | 20 MB |
| Combined source size | 50 MB |
| Pages | 300 |
| Extracted words | 150,000 |

These defaults are configured through environment variables and can be adjusted for a hosted deployment. Changes must be reviewed together: a higher file limit without an appropriate context, token, timeout, storage, and rate-limit plan can make source processing less reliable rather than more capable.

## 5. Provider reliability and bug-remediation record

| Observed issue | Technical cause addressed | Current mitigation |
|---|---|---|
| `MODEL_OUTPUT_INVALID` or `MODEL_REQUEST_FAILED` interrupted an interactive turn. | Remote requests can be slow or return malformed structured output. | Strict schema normalization, 45-second interactive deadline, typed provider diagnostics, and gateway fallback to the local AI-for-learning path. |
| Source digestion returned `responseStatus=incomplete` with `incompleteReason=max_output_tokens`. | Large document digestion had insufficient structured-output capacity. | Separate 180-second digest deadline and configurable 12,000-token output allowance. |
| An exact source citation could fail because PDF extraction changed formatting. | Literal matching is too strict for whitespace, quotes, dashes, and soft hyphens. | Normalized comparison accepts harmless formatting changes while original excerpts remain the evidence record. |
| Long conversations lost the subject or drifted. | Topic/history context was too weak or insufficiently bounded, especially when a learner’s contribution was vague. | Practice first gathers three discovery exchanges, then creates and persists a targeted digest/gist with an explicit within-topic constraint and carries it with five compact exchanges through later practice requests. Source turns retain three exchanges plus the prepared digest/gist. |
| Raw source material was unnecessarily repeated to the provider after digestion. | Ordinary refresh/conversation path did not consistently reuse the prepared source model. | Normal digest reuse and live source conversation send the gist and evidence context instead of complete source material. |
| Voice processing looked unclear. | The status treatment emphasized the AI response caption instead of the active system state. | The true processing-status message is highlighted; the caption remains readable but visually distinct. |
| Review content persisted confusingly between sessions. | Browser review lifecycle and durable ordering were incomplete. | New session reset, timestamp retention, and newest-first rendering. |

## 6. Provider-backed validation evidence

An external provider test was run only after explicit authorization to use a published research paper. The test paper was eight pages and approximately 6,655 words.

| Operation | Result |
|---|---|
| Direct remote source digestion | Completed successfully in about 35 seconds and produced a ready source model. |
| Ordinary digest refresh | Reused the prepared gist in about 6 ms without resending raw source text. |
| Voice-source service path | A model-backed voice-answer request with a finalized transcript completed successfully. |
| Follow-on source discussion | Three additional source turns completed in roughly 14–22 seconds each. |
| Session model consumption | Approximately 42,000 of the configured 132,000-token budget. |
| Voice finalization setting | Five-second silence policy remained enabled. |

This validates the server-side voice-answer service path and remote source flow. It does not replace physical browser/device testing for microphones, permissions, autoplay, WebRTC network behaviour, or accessibility technology.

## 7. Verification and package-integrity record

The most recent full command was:

```text
npm.cmd run verify
```

Results: **455 tests total; 452 passed; 0 failed; 3 skipped**. The skipped tests are optional environment-specific coverage rather than functional failures. The verification command also performs syntax checks for the browser scripts and all required server modules.

On 19 July 2026, an independent release audit also exercised a fresh no-key browser session through the landing page, automatic voice-processing state, typed answer, next question, and session summary. It reported no browser-console warnings or errors. Provider smoke checks exercised a model-backed practice session plus source creation, direct digestion, prepared-gist reuse, grounded source response, finalized voice-answer path, and completion without text-model fallback. The audit did not claim physical microphone, permission, autoplay, or live-WebRTC device validation; those remain release limitations.

Coverage includes:

- session creation, isolation, expiry, capability checks, idempotency, budgets, and summaries;
- practice and source question/answer behaviour, close and move-on routing, and agenda progression;
- source ingestion limits, digest state, direct-gist reuse, evidence citations, and fallback states;
- model prompt boundaries, topic-scope generation and propagation, malformed responses, deadlines, and gateway fallback;
- browser voice transitions, five-second silence submission, interruption, retry, typed fallback, Realtime routing, recording lifecycle, and processing-state visibility;
- durable review ordering, local-recording privacy, source/history separation, and configuration parsing.

The GitHub baseline was also scanned for secrets and stale artifacts. No distributed API keys, private `.env` files, recordings, source papers, SQLite files, logs, dependencies, or inherited chat artifacts are part of the clean package.

## 8. Current technical limitations and next engineering work

| Priority | Work item | Why it remains open |
|---|---|---|
| High | Device/browser end-to-end voice QA | Deterministic harnesses cannot fully reproduce permission prompts, mobile autoplay, microphone hardware, WebRTC candidate behaviour, echo, or slow network conditions. |
| High | Production identity, privacy, and retention | Public or sensitive-data deployment needs authentication, multi-user authorization, quotas, retention/deletion controls, and a deployment-specific privacy review. |
| High | Safe observability and provider recovery | Correlation IDs, bounded retry/backoff, deployer-visible latency/error metrics, and recovery controls are needed without logging raw learner or source content. |
| Medium | Source transparency UI | Learners should see citation/page support, digest coverage, and source-versus-general-context labels directly in the interface. |
| Medium | OCR and visual-source support | Scanned PDFs, complex figures, and tables need optional OCR/vision pipelines with explicit uncertainty and validation boundaries. |
| Medium | Streaming response design | Earlier text/audio feedback could reduce perceived waiting time, but must not compromise interruption safety, structured validation, or source support checking. |
| Medium | Multi-source comparison | Cross-source consolidation, contradiction tracking, and comparison need explicit user control so every original document is not repeatedly disclosed or added to each live prompt. |
| Medium | Learning-outcome evaluation | The project needs evaluation of explanation quality, comprehension, retention, and transfer, not only technical uptime and latency. |

## 9. Technical handoff and update policy

When the package changes materially, update this inventory with the changed component, contract, configuration value, validation evidence, and any new operational limitation. Keep the [system summary](SYSTEM-SUMMARY.md) focused on learning purpose and product direction; use this document for implementation and audit detail.

Before a release or public demonstration:

```text
review configuration and provider readiness
  → run npm run verify
  → perform browser/device smoke tests for voice and source discussion
  → record safe timing and fallback outcomes
  → update this inventory and the system summary
```

The technical priority remains aligned with the learning priority: protect turn-taking, session isolation, bounded context, source grounding, clear recovery, and privacy before adding complexity.
