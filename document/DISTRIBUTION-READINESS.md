# Distribution readiness

## Package status

The package is suitable for local testing and controlled demonstration after the checks below. It is not a production multi-user service yet. The clean distribution copy contains only `.env.example`; create a private local `.env` from it only when provider-backed testing is needed.

For the current milestone state, completed-feature checklist, verified test evidence, limitations, and next priorities, see the canonical [SYSTEM-SUMMARY.md](SYSTEM-SUMMARY.md), under the milestone record section. `MILESTONE-SUMMARY-2026-07-19.md` is retained only as a compatibility pointer.

## Clean-up completed

- `.env.example` is the safe distributable configuration template. A private local `.env` may be created for provider-backed testing, but it must not be packaged or shared.
- Removed empty live-test log artifacts.
- Added `.gitignore` rules for `.env`, SQLite files, logs, data, and dependencies.
- Preserved `.env.example` as the safe configuration template.
- Preserved the clean `public/brand-logo.png` asset and bundled skills.
- Added the full architecture and usage summary in `document/SYSTEM-SUMMARY.md`.
- Added conversation controls for closing a session, moving to a new topic, and asking direct explanatory questions without misclassifying them as answer submissions.
- Placed the primary voice control and live voice-status message directly below the AI question for mobile visibility; secondary controls remain below the primary voice block.

## Verification checklist

- `npm run typecheck` — syntax checks all JavaScript modules.
- `npm test` — deterministic application, source, model, voice, browser-harness, and storage tests.
- `npm run verify` — runs both checks together.
- No API key should appear in the package. Create a private `.env` locally from `.env.example` only when testing provider-backed features.
- Node.js 22.5 or newer is required by the package configuration.
- Python is optional and the distributed `.env.example` intentionally contains no machine-specific Python path. If configured, set `DEEPCHAT2LEARN_PYTHON_BIN` to the host's own `python.exe` and install optional PDF packages such as `pdfplumber` and/or `PyMuPDF` (`fitz`).

## Local test procedure

```text
copy .env.example .env
edit .env and set OPENAI_API_KEY locally
npm run verify
npm start
open http://localhost:3000
```

For a no-key demonstration, omit `.env`. Typed interaction, browser speech input/output, local fallback coaching, source extraction, and deterministic tests remain available. A real API key is needed for provider-backed, real-time, and more comprehensive model responses.

### Provider and PDF requirements

The current package is tested against the OpenAI API contract. Keys from other providers—such as Claude, Gemini, Grok, DeepSeek, or Kimi—require an adapter or an OpenAI-compatible endpoint; entering a key alone does not make an unrelated API protocol work. Real-time GPT Live-style audio also requires the provider/model to support the configured Realtime/WebRTC transport, not merely text completion.

Complex PDFs are the main reason to install Python. Text-based PDFs, DOCX/Word, TXT, Markdown, and pasted notes remain usable on a normal Node-only web host. For layout-heavy, table-rich, figure-heavy, or scanned research papers, configure the host's Python executable and install PDF-processing packages such as `pdfplumber` and/or `PyMuPDF`; add OCR or vision tooling separately when scanned pages or visual figure interpretation are required. If Python is not installed, keep the variable blank and use the built-in Node extraction fallback.

During a live session, finalized voice text remains visible while the model is processing. The question card places the voice control and current processing status immediately below the AI question so mobile users can see the active state. Closing phrases prepare the session summary and preserve transcript/audio export options; move-on phrases advance the academic agenda without using an answer round.

## Distribution cautions

- Never distribute `.env`, SQLite files, raw source documents, transcripts, or downloaded recordings.
- Use HTTPS in hosted environments for microphone and WebRTC access.
- Add authentication and user isolation before exposing SQLite or long-lived sessions to multiple users.
- Review provider data-retention and source-privacy requirements before uploading research papers or student work.
- Treat the current package as an MVP demonstration, not a security-reviewed production deployment.
