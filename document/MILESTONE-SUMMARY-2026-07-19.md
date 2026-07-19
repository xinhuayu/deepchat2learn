# deepchat2learn milestone summary

## Current handoff anchor

**Date:** 2026-07-19  
**Project:** deepchat2learn  
**Stage:** functional MVP / controlled demonstration  
**Primary goal:** smooth, academically meaningful voice conversation supported by supplied source materials

**Milestone marker:** ACTIVE BASELINE - resume future work from this document and the clean `deepchat2learn-github-package` archive.

This document is the current project handoff anchor. It consolidates the prior system summaries, development retrospective, implementation history, and current verification evidence. It is intended to reduce the need to reread the full development conversation.

## 1. Executive status

deepchat2learn is a browser-based academic learning system with two modes:

- **Practice speaking:** the AI asks progressive academic questions, listens to spoken or typed answers, evaluates relevance and meaning, gives concise constructive guidance, and asks a response-linked follow-up.
- **Source discussion:** the user supplies papers, documents, notes, or pasted text. The system extracts and digests the material, retrieves relevant evidence, answers questions in original language, adds clearly separated general knowledge when needed, evaluates the learner's response for relevance, and advances the academic discussion.

The system's most important design decision is the separation between a fast live conversation path and a deeper source-processing path:

```text
browser voice/text
  -> session orchestrator
  -> compact academic-conversation policy
  -> bounded recent context
  -> fast model or safe local fallback
  -> clean response, next question, and session state

source files
  -> extraction and artifacts
  -> chunks and retrieval
  -> source digest and evidence checks
  -> bounded context for the live conversation
```

### Verification snapshot

- `npm run verify`: passed.
- Syntax checks: passed for all required JavaScript modules.
- Tests: 457 total; 454 passed; 0 failed; 3 skipped.

## Post-milestone mobile voice hardening

The package now includes a focused iPhone/Safari Realtime transport fix set:

- waits for ICE gathering before sending the browser's local SDP offer;
- prepares a mobile-safe remote audio element with `playsInline`, autoplay, and explicit playback;
- falls back to browser voice input when Realtime negotiation fails;
- records safe Realtime call diagnostics in the hosted health response.

The mobile-specific regression tests are included in the voice browser harness and the full verification run above.
- Skipped tests: optional Python-dependent PDF extraction cases when the deterministic test environment does not provide the optional extractor.
- Clean package: no `.env`, SQLite data, temporary files, recordings, or raw source papers.
- Live demonstration: [deepchat2learn.onrender.com](https://deepchat2learn.onrender.com/).

### Status legend

- **Verified:** implemented and covered by deterministic tests in the current package.
- **Implemented / environment-dependent:** implemented and test-harness-covered, but dependent on a browser, provider, Python installation, HTTPS, or deployment configuration.
- **MVP limitation:** intentionally incomplete for a local or controlled demonstration.
- **Planned:** recommended future work, not part of the verified current release.

## 2. Architecture and logic flow

### Main control flow

```text
user action
  -> browser state
  -> HTTP/WebRTC transport
  -> session authorization and limits
  -> conversation orchestrator
  -> intent classification
  -> bounded context builder
  -> provider gateway or local fallback
  -> response normalization and evidence checks
  -> persisted session turn
  -> spoken/text response and next question
```

### Core state model

The browser and server coordinate explicit states rather than relying on incidental event order:

`idle -> ai-speaking -> user-listening -> user-speaking -> finalizing -> processing -> ready`

Error, interruption, stopping, and completion are explicit recovery paths. Each active voice turn has a turn identity so a late response cannot overwrite a newer turn.

### Context model

Source-mode requests use four bounded layers:

1. Paper-level digest.
2. Retrieved source chunks, table facts, captions, or evidence metadata.
3. Current question or answer plus at most three recent exchanges.
4. Clearly labeled general LLM knowledge when the source is incomplete.

Short follow-up retrieval uses only the two most immediate exchanges. Practice and source histories remain separate by session and mode.

### Skill model

- `academic-conversation`: main live dialogue policy in both modes.
- `academic-research`: broad source digestion and research interpretation.
- `epi-research`: doctoral-level epidemiology and causal-inference critique.

The specialized research skills are used for digestion or explicit review tasks. They are not run in full on every live voice turn; this preserves response speed and keeps the conversation coherent.

## Ten lessons distilled from the project

1. Build one complete user journey before adding advanced capability.
2. Put an explicit session orchestrator and state machine at the center.
3. Treat voice as a turn-taking protocol, not as a single recording event.
4. Keep live conversation fast and source digestion deep but separate.
5. Use skills as small operating policies, with specialized skills reserved for the work that needs them.
6. Define function contracts, context budgets, timeouts, fallbacks, and acceptance tests explicitly.
7. Keep every session and mode isolated; never let stale context leak into a new turn.
8. Keep humans responsible for academic meaning, privacy, safety, and release decisions.
9. Choose models by task, latency, and risk rather than by model name alone.
10. Turn real user failures into regression tests, documentation updates, and release evidence.

## 3. Feature and function checklist

### A. Core server and session functions

| Function or feature | Status | Evidence or boundary |
|---|---|---|
| Node server, static assets, and startup path | Verified | Typechecked and covered by API/static tests. |
| Health endpoint and readiness reporting | Verified | Health tests cover provider and Realtime readiness states. |
| Browser security headers | Verified | API/static security-header test passes. |
| Session creation with capability token | Verified | Store and API tests cover session-scoped authorization. |
| Practice mode default limit of 50 rounds | Verified | Session-limit tests pass. |
| Source mode default limit of 200 rounds | Verified | Source session-limit tests pass. |
| Custom smaller round limits | Verified | Session creation and route tests pass. |
| Per-session model-token budget | Verified | Budget guard tests pass. |
| Rate limiting and maintenance pruning | Verified | Rate-limit and API maintenance tests pass. |
| Session retention modes | Verified | Session, short-expiry, and until-deleted paths are tested. |
| Session expiration and deletion cascade | Verified | In-memory and SQLite cascade tests pass. |
| Session-scoped history and mode isolation | Verified | Client, store, orchestration, and source-history tests pass. |
| Duplicate request idempotency | Verified | Typed and voice replay tests pass. |
| Stale response protection after stop/interruption | Verified | Superseded-turn tests pass. |

### B. Conversation and agenda functions

| Function or feature | Status | Evidence or boundary |
|---|---|---|
| Initial question generation | Verified | Walking-skeleton and failed-initial-question tests pass. |
| Typed question and answer flow | Verified | API and client tests cover question, answer, feedback, follow-up, and summary. |
| Academic relevance evaluation | Verified | Feedback fields and practice evaluation tests pass. |
| Concise academic explanation or correction | Verified | Practice response contract and voice evaluation tests pass. |
| Response-linked follow-up question | Verified | Coach and voice tests pass. |
| Progressive conversation agenda | Verified | Agenda tests cover stages, progression, and recent questions. |
| Direct questions such as “what,” “why,” “explain,” and “how” | Verified | Direct explanatory-question tests pass. |
| Move-on requests without consuming an answer round | Verified | Source and practice move-on tests pass. |
| Closing phrases and session completion | Verified | Close-phrase and completion tests pass. |
| Non-circular question progression | Verified in deterministic paths | Agenda and source-question tests pass; quality still depends on provider output. |
| Local fallback coach | Verified | No-key and model-failure paths are tested. |
| Structured response normalization | Verified | Model schema and normalization tests pass. |
| Provider error classification and fallback | Verified | Gateway, model, and API failure tests pass. |

### C. Browser voice and audio functions

| Function or feature | Status | Evidence or boundary |
|---|---|---|
| Microphone permission handling | Implemented / environment-dependent | Browser harness covers allowed and denied permission paths. |
| Browser speech recognition fallback | Implemented / environment-dependent | Harness covers unsupported recognition and typed fallback. |
| Browser speech synthesis playback | Implemented / environment-dependent | Voice harness covers spoken response sequencing. |
| Automatic listening after an AI question | Verified in harness | Startup and transition tests pass. |
| Five-second silence auto-submit | Verified | Voice auto-submit and silence-window tests pass. |
| Multi-segment answer accumulation | Verified | Recognition-cycle tests pass. |
| Interim transcript exclusion | Verified | Interim hypotheses never enter final answer or model request. |
| Final transcript replacement by recognition index | Verified | Updated-final-hypothesis tests pass. |
| Filler and stutter cleanup | Verified | Transcript cleanup tests pass. |
| AI microphone suppression during playback | Verified in harness | Echo-prevention and mic-off tests pass. |
| Explicit user interruption / barge-in | Verified in harness | Interrupt and source-barge-in tests pass. |
| Stale AI answer cancellation | Verified | Stopping and interruption tests pass. |
| Visible voice statuses and captions | Verified | Client and voice-harness accessibility tests pass. |
| Retryable transcript after model failure | Verified | Failed voice-turn retry tests pass. |
| Realtime WebRTC setup and event routing | Implemented / environment-dependent | Deterministic Realtime harness and transport tests pass; live behavior depends on provider, browser, HTTPS, and deployment. |
| Realtime reconnection | Verified in harness | Reconnect tests pass. |
| Server-side VAD and silence configuration | Implemented / environment-dependent | Configuration and Realtime harness coverage pass; provider behavior remains external. |
| Opt-in local conversation recording | Verified in harness | Recording lifecycle, byte limits, ownership, download, and privacy tests pass. |
| Complete-conversation recording when remote audio is available | Implemented / environment-dependent | Harness covers mixed and microphone-only fallback. |

### D. Source ingestion, knowledge, and evidence

| Function or feature | Status | Evidence or boundary |
|---|---|---|
| Pasted text and notes | Verified | Source normalization and API tests pass. |
| TXT and Markdown ingestion | Verified | Source-ingestion tests pass. |
| DOCX body and section extraction | Verified | DOCX extraction tests pass. |
| Text-based PDF extraction | Verified | PDF payload and page-aware extraction tests pass. |
| Optional Python PDF extraction | Implemented / environment-dependent | Code path exists; optional Python tests are skipped when Python packages are unavailable. |
| PDF page metadata and warnings | Verified | Extraction metadata and warning tests pass. |
| Tables, captions, and embedded-figure metadata | Verified | Source artifact and persistence tests pass where extractable. |
| OCR for scanned PDFs | Planned | Not included in the current default package. |
| Visual interpretation of figures | Planned | Figure bytes/metadata can be retained; vision interpretation is not yet a default pipeline. |
| File-count, byte, page, word, and request-body limits | Verified | Limit and rejection tests pass. |
| Duplicate source detection by content hash | Verified | Duplicate-upload tests pass. |
| Deterministic chunking with page/section metadata | Verified | Chunk and metadata tests pass. |
| Source retrieval and ranking | Verified | In-memory and SQLite retrieval tests pass. |
| Digest status and progress states | Verified | Queued, processing, ready, failed, and fallback status tests pass. |
| Per-source digest | Verified | Digest route and model-coach tests pass. |
| Cross-source consolidated digest | Verified | Consolidated digest and complementary-source tests pass. |
| Extractive fallback after digest-model failure | Verified | Digest fallback tests pass. |
| Evidence-linked paraphrased digest points | Verified | Exact evidence and synthesized-claim validation tests pass. |
| Citation and source-support status | Verified | Fabricated citation rejection and source-answer tests pass. |
| Conflict and incomplete-extraction warnings | Verified | Fixture tests pass. |
| Source deletion | Verified | Deletion and SQLite cleanup tests pass. |
| Source-grounded answers plus general LLM knowledge | Verified in contract and fallback paths | Source-answer tests cover separate support status; live provider quality remains environment-dependent. |
| Consent-gated external research adapter | Implemented / environment-dependent | Consent and adapter tests pass; external provider setup is not enabled by default. |

### E. Skills and learning behavior

| Function or feature | Status | Evidence or boundary |
|---|---|---|
| Skill registry and supported IDs | Verified | Skill registry tests pass. |
| Automatic skill detection | Verified | Detection tests pass. |
| Explicit skill selection | Verified | Session setup and registry tests pass. |
| Academic conversation skill | Verified in prompt integration | Used for live practice and source turns. |
| Academic research skill | Packaged and integrated | Used for source digestion; formal review quality still requires human judgment. |
| Epi-research skill | Packaged and integrated | Methods-first epidemiology and causal-inference guidance is available for source review. |
| Source mode does not switch to practice coaching | Verified | Source conversation evaluation tests pass. |
| Concise live responses and one focused follow-up | Verified in response contract | Provider output quality still requires monitoring. |
| Gradual simple-to-complex questioning | Verified in agenda/fallback paths | Live model adherence remains an operational quality metric. |
| Learner-empathetic constructive guidance | Implemented in skill/prompt policy | Requires continued human quality review. |

### F. Browser interface and session review

| Function or feature | Status | Evidence or boundary |
|---|---|---|
| Landing page topic and mode setup | Verified | Client tests cover setup and controls. |
| Source processing status highlight | Verified | Source setup UI test passes. |
| Compact coaching notes and history | Verified | Layout and client tests pass. |
| Most-recent-first conversation history | Verified | Practice and source history tests pass. |
| Draft clearing between turns | Verified | Turn-clearing tests pass. |
| Final transcript visible during processing | Verified | Client tests cover processing state and draft visibility. |
| Review-before-sending option | Verified | Client behavior is tested. |
| Typed fallback when voice is unavailable | Verified | Browser harness and client tests pass. |
| Transcript copy and local download | Verified | Browser fallback and review-export tests pass. |
| Final session summary | Verified | Summary, recurring patterns, material coverage, and focus tests pass. |
| Source digest panel and refresh behavior | Verified | Materials panel and digest refresh tests pass. |
| Accessible announcements and progress semantics | Verified | Accessibility-oriented client tests pass. |
| Brand logo and blue visual identity | Implemented | Static image/type and UI asset tests pass. |
| Public live-demo README link | Implemented | README points to the hosted Render deployment. |

### G. Persistence, configuration, and distribution

| Function or feature | Status | Evidence or boundary |
|---|---|---|
| In-memory session store | Verified | Store tests pass. |
| Optional SQLite persistence | Verified | SQLite API/store tests pass. |
| SQLite FTS source retrieval | Verified | SQLite retrieval tests pass. |
| SQLite schema migration for voice/source metadata | Verified | Migration and reload tests pass. |
| Expiry pruning and cascade cleanup | Verified | SQLite expiry and deletion tests pass. |
| Safe `.env.example` with masked paths | Verified | Distribution configuration contains no personal path or key. |
| Server-side API key handling | Verified by configuration and security tests | Actual provider secret safety still depends on deployment configuration. |
| Node-only fallback deployment | Implemented / environment-dependent | Text-based source flow works without Python; hosting must satisfy Node and HTTPS requirements. |
| Python-enhanced PDF deployment | Implemented / environment-dependent | Host must provide Python and compatible packages. |
| README, run guide, distribution cautions, and system summaries | Implemented | Documentation is present and refreshed. |
| Clean ZIP distribution | Verified at packaging checks | Current archive excludes secrets and temporary test artifacts. |
| Public multi-user authentication and isolation | MVP limitation | Not yet implemented. |

## Five milestone risks to monitor

1. **Voice transport:** browser permissions, echo cancellation, device differences, provider latency, and WebRTC behavior can still differ from deterministic harness results.
2. **Source comprehension:** extraction and retrieval errors can produce shallow or repetitive answers even when the conversation mechanics are correct.
3. **Context leakage:** stale drafts, interrupted turns, or mixed mode history can silently reduce answer quality if session boundaries regress.
4. **Provider dependency:** timeouts, model changes, quotas, cold starts, and incompatible API keys can affect hosted behavior.
5. **Production safety:** authentication, multi-user isolation, privacy controls, and operational monitoring are not yet production-complete.

## 4. What is genuinely finished

The following areas are complete enough to call **finished for the current MVP scope**, because implementation exists and deterministic tests cover the relevant behavior:

- Typed and browser-voice conversation loops.
- Explicit turn state, interruption, stale-response protection, and transcript cleanup.
- Practice/source mode separation and session-specific history.
- Academic conversation skill routing in both modes.
- Progressive agenda, direct questions, move-on, and close controls.
- Source ingestion for text, DOCX, ordinary PDFs, and pasted material.
- Chunking, retrieval, digest status, digest fallback, source deletion, and evidence validation.
- Optional SQLite persistence, FTS retrieval, expiry, and deletion cascades.
- Local recording lifecycle and privacy boundaries.
- Configuration templates, limits, rate limiting, health, test suite, README, and clean distribution process.

“Finished” here means complete for the tested MVP contract. It does not mean provider-backed voice, public multi-user hosting, OCR, or production security has been fully validated.

## 5. What is implemented but not fully verified in production

These paths are implemented and have deterministic harness coverage, but require real environment testing:

1. OpenAI text-model requests and source digestion over the network.
2. OpenAI Realtime/WebRTC voice transport on the hosted deployment.
3. Browser microphone permissions, audio routing, echo cancellation, and device variability.
4. Python-enhanced PDF extraction on a host with `pdfplumber` or `PyMuPDF`.
5. Public Render behavior under real latency, cold starts, provider errors, and concurrent users.
6. Quality of model-generated answers, source synthesis, and non-repetitive follow-up questions across a broad paper set.

## 6. Known limitations and risks

- The hosted demo is not a production multi-tenant service. Authentication, per-user authorization, distributed session storage, and durable operational observability remain future work.
- Realtime transport can still be affected by browser permissions, HTTPS, device drivers, provider limits, network latency, and hosting proxies.
- Text-based PDF extraction is supported; scanned-PDF OCR and visual figure interpretation are not default capabilities.
- A passing deterministic test suite cannot prove that every provider response is academically accurate or pedagogically effective.
- Source-grounded answers can be only as complete as the extraction, digest, retrieval, and evidence checks. The learner should be shown uncertainty rather than receiving invented detail.
- Public users should not submit confidential research papers, identifiable student work, or sensitive personal information until deployment-specific privacy and retention controls are reviewed.

## 7. Short-term recommendations

### Priority 0: validate the hosted core loop

Run a repeatable browser smoke test against the live deployment covering microphone permission, AI playback, interruption, five-second silence submission, long answers, transcript uniqueness, a provider error, and recovery. Record latency and visible status for each step.

### Priority 1: add production observability without sensitive content

Add request correlation IDs, provider task name, model name, duration, retry count, failure stage, session mode, and a content hash. Never log raw transcripts, prompts, source text, API keys, or audio.

### Priority 2: measure learning and conversation quality

Create a small evaluation set of research papers and learner questions. Score directness, evidence use, paraphrase quality, answer relevance, question progression, repetition, latency, and fallback clarity.

### Priority 3: improve deployment documentation

Document the Render environment variables, health-check expectations, cold-start behavior, provider configuration, Python availability, data retention, and how to reproduce a local no-key demonstration.

### Priority 4: keep the single source of truth current

Update this document whenever a function, state, configuration, skill, test, or deployment boundary changes. Retire conflicting older status claims rather than adding another parallel summary.

## 8. Long-term recommendations

1. Add authentication, per-user quotas, encrypted persistence, deletion workflows, and a distributed session store.
2. Add OCR and optional vision-assisted interpretation for scanned PDFs, tables, and statistical figures with explicit uncertainty.
3. Add provider adapters and a capability matrix for text, audio, transcription, embeddings, and structured output.
4. Add streaming text or sentence-level playback to reduce perceived latency.
5. Add prompt, skill, schema, and retrieval-version tracking with evaluation comparisons.
6. Add instructor rubrics, paper-specific objectives, concept maps, misconception summaries, and spaced follow-up sessions.
7. Add privacy-preserving telemetry and operational dashboards for latency, model failures, source-processing failures, and voice state errors.
8. Run multi-user load, chaos, and cross-browser testing before positioning the tool as a public service.

## 9. Resumption instructions for the next project phase

Resume from this document rather than the full chat history. The next recommended task is the hosted browser smoke test and observability pass, not another broad feature expansion.

Use this sequence:

```text
read this milestone summary
  -> verify the live deployment configuration
  -> run the P0 voice/source smoke test
  -> record evidence and latency
  -> fix one highest-impact failure
  -> add a regression test
  -> update this summary and the package
```

The project should remain conversation-first: preserve turn-taking, session boundaries, source grounding, and understandable recovery before adding new agents or deeper analysis features.
