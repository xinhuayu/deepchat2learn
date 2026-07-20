import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('voice policy does not impose a hard realtime speaking cutoff', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /realtimeWatchdogMs:\s*0/);
  assert.match(app, /voicePolicy\.realtimeWatchdogMs/);
  assert.doesNotMatch(app, /silenceTimeoutMs:\s*7000/);
});

test('typecheck script always checks the mandatory audio recorder cross-platform', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.typecheck, /node --check public\/audioRecording\.js/);
  assert.doesNotMatch(pkg.scripts.typecheck, /\bif exist\b/i);
});

test('materials sessions refresh the source panel even without an initial upload', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const branch = app.match(/if \(state\.mode === 'materials'.*?\n    \}\n    \$\('#sessionTopic'/s)?.[0];
  assert.ok(branch, 'materials start branch should be present');
  assert.doesNotMatch(branch, /&& sourcePayload/);
  assert.match(branch, /await refreshSources\(\);/);
});

test('materials panel renders digest key points and open questions', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function renderDigest\(digest\)/);
  assert.match(app, /digest\.mode === 'model'/);
  assert.match(app, /digest\.keyPoints/);
  assert.match(app, /digest\.openQuestions/);
});

test('materials refresh restores and renders a digest for each source', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function renderSourceDigests\(sources\)/);
  assert.match(app, /source\.digest/);
  assert.match(app, /renderSourceDigests\(result\.sources\)/);
});

test('adding a source keeps the aggregate digest view', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const branch = app.match(/async function addAdditionalSource\(\).*?\n\}/s)?.[0];
  assert.ok(branch, 'additional source flow should be present');
  assert.match(branch, /await refreshSources\(\)/);
  assert.doesNotMatch(branch, /renderDigest\(uploaded\.digest\)/);
});

test('invalid source selection clears a stale pending upload', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const branch = app.match(/async function loadSourceFile\(event\).*?\n\}/s)?.[0];
  assert.ok(branch, 'source file loading flow should be present');
  assert.match(branch, /state\.pendingSource = null/);
  assert.match(branch, /\$\('#sourceFile'\)\.value = ''/);
  assert.match(branch, /\$\('#sourceStatus'\)\.textContent = 'The file could not be read\. Paste the material instead\.'/);
});

test('switching text sources refreshes only an auto-filled source name', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const branch = app.match(/async function loadSourceFile\(event\).*?\n\}/s)?.[0];
  assert.ok(branch, 'source file loading flow should be present');
  assert.match(branch, /const sourceName = \$\('#sourceName'\)/);
  assert.match(branch, /sourceName\.value === sourceName\.dataset\.autoName/);
  assert.match(branch, /sourceName\.dataset\.autoName = file\.name/);
});

test('editing the source name disables automatic filename replacement', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\('#sourceName'\)\.addEventListener\('input', \(\) => \{[\s\S]*?dataset\.autoName = ''[\s\S]*?\}\)/);
});

test('materials sessions expose a source-based coaching question action', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="sourceQuestionButton"/);
  assert.match(app, /sourceQuestionButton/);
  assert.match(app, /source-prompts/);
});

test('materials setup exposes explicit and automatic review-skill selection', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="skillProfile"/);
  assert.match(html, /value="auto"/);
  assert.match(html, /value="academic-research"/);
  assert.match(html, /value="epi-research"/);
  assert.match(app, /skillId: state\.mode === 'materials'/);
  assert.match(app, /renderSkillProfileStatus/);
});

test('voice conversation applies fresh questions without counting move-on requests as answers', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(result\.countsAsAnswer !== false\) state\.session\.turnCount/);
  assert.match(app, /if \(result\.countsAsAnswer !== false\) \{\s*state\.materialHistory\.push/s);
  assert.match(app, /if \(result\.followUp && !result\.done\) \{\s*state\.session\.currentQuestion = result\.followUp/s);
});

test('active materials sessions accept an additional pasted source', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="additionalSourceName"/);
  assert.match(html, /id="additionalSourceText"/);
  assert.match(app, /const additionalText = \$\('#additionalSourceText'\)\.value\.trim\(\)/);
  assert.match(app, /const payload = file\s*\?\s*await readSourceFile\(file\)\s*:\s*\{[\s\S]*text: additionalText[\s\S]*\};/);
  assert.match(app, /\$\('#additionalSourceText'\)\.value = ''/);
});

test('source question action exposes a processing state', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function setSourceQuestionProcessing\(processing\)/);
  assert.match(app, /Generating source question/);
  assert.match(app, /setSourceQuestionProcessing\(true\)/);
  assert.match(app, /setSourceQuestionProcessing\(false\)/);
});

test('source question action gives a retry message after generation failure', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /I could not create a materials question\. Try again\./);
});

test('starting with supplied material uses a grounded first coaching question', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const branch = app.match(/if \(state\.mode === 'materials'.*?\n    \}\n    \$\('#sessionTopic'/s)?.[0];
  assert.ok(branch, 'materials start branch should be present');
  assert.match(branch, /sourcePayload/);
  assert.match(branch, /source-prompts/);
  assert.match(branch, /firstQuestion/);
});

test('dynamic coaching content exposes accessible announcements and progress semantics', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="questionText"[^>]*aria-live="polite"/);
  assert.match(html, /id="sourceList"[^>]*aria-live="polite"/);
  assert.match(html, /id="sourceDigest"[^>]*aria-live="polite"/);
  assert.match(html, /id="progressBar"[^>]*role="progressbar"/);
  assert.match(html, /id="additionalSourceFile"[^>]*aria-label="Add a source file"/);
  assert.match(html, /id="materialQuestion"[^>]*aria-label="Ask about your materials"/);
  assert.match(app, /setAttribute\('aria-valuenow'/);
});

test('materials questions support keyboard submission and announce answers', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /form id="materialQuestionForm" class="ask-row"/);
  assert.match(html, /id="materialAnswer"[^>]*aria-live="polite"/);
  assert.match(app, /\$\('#materialQuestionForm'\)\.addEventListener\('submit'/);
  assert.match(app, /event\.preventDefault\(\); askMaterialQuestion\(\)/);
});

test('materials Q&A exposes a processing state', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function setMaterialQuestionProcessing\(processing\)/);
  assert.match(app, /Thinking about your materials/);
  assert.match(app, /setMaterialQuestionProcessing\(true\)/);
  assert.match(app, /setMaterialQuestionProcessing\(false\)/);
});

test('session start exposes a processing state', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function setStartProcessing\(processing\)/);
  assert.match(app, /Preparing your session/);
  assert.match(app, /setStartProcessing\(true\)/);
  assert.match(app, /setStartProcessing\(false\)/);
});

test('failed session setup clears half-started client session state', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const branch = app.match(/async function startSession\(event\).*?\n\}/s)?.[0];
  assert.ok(branch, 'session start flow should be present');
  assert.match(app, /async function discardFailedSession\(\)/);
  assert.match(branch, /await discardFailedSession\(\)/);
  assert.match(branch, /catch \(error\) \{[\s\S]*state\.session = null/);
  assert.match(branch, /state\.token = null/);
  assert.match(branch, /clearClientSession\(\)/);
});

test('non-submit session controls declare their button types', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="endSession"[^>]*type="button"/);
  assert.match(html, /id="newSession"[^>]*type="button"/);
  assert.match(html, /id="deleteData"[^>]*type="button"/);
});

test('local recording UI loads before app and exposes accessible local-only controls', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="\/audioRecording\.js"><\/script>\s*<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /id="recordConversationButton"[^>]*type="button"[^>]*aria-pressed="false"/);
  assert.match(html, /id="recordingStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="recordingTimer"[^>]*aria-live="polite"/);
  assert.match(html, /id="recordingMode"/);
  assert.match(html, /id="stopRecordingButton"[^>]*type="button"[^>]*disabled/);
  assert.match(html, /id="discardRecordingButton"[^>]*type="button"[^>]*disabled/);
  assert.match(html, /id="downloadRecordingButton"[^>]*type="button"[^>]*disabled/);
  assert.match(html, /Audio stays on this device and is not uploaded\./);
});

test('local recording UI explains capture states and keeps a summary download control', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /id="downloadRecordingSummaryButton"[^>]*type="button"[^>]*disabled/);
  assert.match(html, /unavailable/i);
  assert.match(html, /microphone-only/i);
  assert.match(html, /complete-conversation/i);
  assert.match(html, /limit/i);
  assert.match(html, /discarded/i);
  assert.match(css, /\.recording-panel\s*\{/);
  assert.match(css, /\.recording-actions\s*\{/);
  assert.match(css, /\.recording-status-row\s*\{/);
  assert.match(css, /\.recording-mode\s*\{/);
  assert.match(css, /\.secondary\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--blue-dark\)/);
});

test('landing privacy copy distinguishes default voice privacy from optional local recording', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /not recorded by default/i);
  assert.match(html, /enable local recording/i);
  assert.match(html, /never uploaded/i);
  assert.doesNotMatch(html, /<p class="privacy-note">No audio is saved\./i);
  assert.doesNotMatch(html, /Audio is never stored\. This setting controls only transcripts/i);
});

test('materials Q&A gives a retry message after an answer failure', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /I could not answer that right now\. Try again\./);
});

test('source file controls advertise and accept DOCX documents', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /\.docx/);
  assert.match(html, /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
  assert.match(app, /pdf\|docx\|txt\|md/);
  assert.match(html, /Research PDFs work without Python and include page-aware text, table rows, captions, embedded-figure metadata, and safely extractable figure bytes/);
});

test('session exposes a reviewable transcript and records submitted turns', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="transcriptPanel"/);
  assert.match(html, /id="transcriptList"[^>]*aria-live="polite"/);
  assert.match(app, /function renderTranscript\(\)/);
  assert.match(app, /state\.transcript\.push\(/);
});

test('session layout keeps coaching notes at the bottom of the left panel and review beside submit', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /class="card question-card"[\s\S]*id="microphoneStatus"[\s\S]*id="feedbackCard"/);
  assert.doesNotMatch(html, /class="response-column"[\s\S]*id="feedbackCard"/);
  assert.match(html, /id="answerText"[\s\S]*id="voiceTranscriptReview"[\s\S]*id="submitAnswer"/);
  assert.match(html, /id="answerText"[^>]*rows="5"/);
  assert.match(html, /id="questionLimit"[\s\S]*value="50"(?: selected)?\s*>50/);
  assert.match(html, /id="questionLimit"[\s\S]*value="200">200/);
  assert.match(html, /id="questionText"[\s\S]*class="voice-primary-block"[\s\S]*id="voiceConversationButton"[\s\S]*class="voice-status-block"[\s\S]*id="voiceState"/);
  assert.match(html, /class="voice-primary-block"[\s\S]*id="voiceConversationButton"[\s\S]*class="question-actions"[\s\S]*id="listenButton"/);
  assert.doesNotMatch(html, /class="question-actions"[\s\S]*id="voiceConversationButton"/);
  assert.match(html, /class="voice-toolbar"[\s\S]*id="voicePauseButton"[\s\S]*id="voiceStopButton"/);
  assert.doesNotMatch(html, /id="voiceStatus"/);
  assert.match(html, /id="voiceState"[^>]*aria-live="polite"/);
});

test('session setup defaults its round limit to the active mode cap', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<option value="50" selected>50<\/option>/);
  assert.match(app, /if \(select\.value !== String\(maxQuestions\)\) select\.value = String\(maxQuestions\);/);
  assert.match(app, /function syncConversationDefaults\(\)/);
  assert.match(app, /sourceMode\s*\?\s*'structure'\s*:\s*'clarity'/);
  assert.match(app, /sourceMode\s*\?\s*'intermediate'\s*:\s*'beginner'/);
  assert.match(app, /sourceMode\s*\?\s*'socratic'\s*:\s*'supportive'/);
});

test('coaching notes and chat history remain visible in a compact layout', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /voice-feedback-hidden/);
  assert.match(app, /turn\.voice/);
  assert.match(html, /id="voiceTranscriptReviewText"/);
  assert.match(css, /\.question-card > \.feedback-card\s*\{[^}]*padding:\s*16px/);
  assert.match(css, /\.transcript-panel\s*\{[^}]*padding:\s*18px/);
  assert.match(css, /\.transcript-turn\s*\{[^}]*padding:\s*10px 12px/);
  assert.match(css, /\.secondary\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--blue-dark\)/);
  assert.match(app, /user_speech_started/);
  assert.match(app, /response\.cancel/);
});

test('session transcript can be copied for later review', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="copyTranscript"/);
  assert.match(html, /id="transcriptStatus"[^>]*role="status"/);
  assert.match(app, /function copyTranscript\(\)/);
  assert.match(app, /navigator\.clipboard\.writeText/);
});

test('session review copying has a browser fallback', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function copyTextWithFallback\(text\)/);
  assert.match(app, /document\.execCommand\?\.\('copy'\)/);
  assert.match(app, /copyTextWithFallback\(text\)/);
});

test('session review can be downloaded as a local text file', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="downloadTranscript"/);
  assert.match(app, /function downloadTranscript\(\)/);
  assert.match(app, /new Blob\(\[transcriptText\(\)\]/);
  assert.match(app, /URL\.createObjectURL/);
});

test('feedback exposes a why-this-feedback evidence disclosure', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="evidenceText"/);
  assert.match(html, /<summary>Why this feedback\?<\/summary>/);
  assert.match(app, /feedback\.evidence/);
  assert.match(app, /turn\.feedback\.evidence/);
});

test('feedback exposes academic relevance and response-linked explanation fields', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="academicAssessment"/);
  assert.match(html, /id="academicResponse"/);
  assert.match(app, /feedback\.academicAssessment/);
  assert.match(app, /feedback\.academicResponse/);
});

test('session warns before leaving with an unsent answer', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function hasUnsubmittedAnswer\(\)/);
  assert.match(app, /You have an unsent answer/);
  assert.match(app, /beforeunload/);
  assert.match(app, /confirmLeavingWithDraft\(\)/);
});

test('session warns before discarding an unsubmitted material draft', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function hasUnsubmittedMaterialsDraft\(\)/);
  assert.match(app, /source material waiting to be added/);
  assert.match(app, /hasUnsubmittedMaterialsDraft\(\)/);
  assert.match(app, /if \(!hasUnsubmittedAnswer\(\) && !hasUnsubmittedMaterialsDraft\(\)\) return/);
});

test('leaving with two draft types warns about both before discarding them', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const confirmation = app.match(/function confirmLeavingWithDraft\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(confirmation, 'draft confirmation should be present');
  assert.match(confirmation, /const warnings = \[\]/);
  assert.match(confirmation, /if \(hasUnsubmittedAnswer\(\)\)/);
  assert.match(confirmation, /if \(hasUnsubmittedMaterialsDraft\(\)\)/);
  assert.match(confirmation, /warnings\.join/);
});

test('session review export includes the final coaching summary', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /state\.summary = result\.summary/);
  assert.match(app, /Overall scores:/);
  assert.match(app, /Next practice:/);
});

test('session review export includes recurring patterns and material coverage', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /Recurring strengths:/);
  assert.match(app, /Recurring gaps:/);
  assert.match(app, /Materials used:/);
  assert.match(app, /Learned concepts:/);
  assert.match(app, /Unresolved questions:/);
  assert.match(app, /Next steps:/);
});

test('final summary shows recurring patterns, learning sections, and source coverage', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /learnedConcepts/);
  assert.match(app, /unresolvedQuestions/);
  assert.match(app, /nextSteps/);
  assert.match(app, /recurringStrengths/);
  assert.match(app, /recurringGaps/);
  assert.match(app, /sourceCount/);
  assert.match(app, /sourceNames/);
  assert.match(app, /sourceCoverage/);
  assert.match(app, /Learning/);
  assert.match(app, /Source coverage/);
});

test('source-mode summary avoids rendering practice scorecards', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const showScores = state\.session\?\.sourceMode !== 'source'/);
  assert.match(app, /showScores \? `<div class="score-grid">/);
});

test('completion moves focus to the session summary', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="summaryView"[^>]*tabindex="-1"/);
  assert.match(app, /show\('summaryView'\);\s*\$\('#summaryView'\)\.focus\(\);/);
});

test('answer submission exposes a processing state and restores controls', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function setAnswerProcessing\(submitting\)/);
  assert.match(app, /aria-busy/);
  assert.match(app, /Reviewing your answer/);
  assert.match(app, /setAnswerProcessing\(false\)/);
});

test('final answer completion does not re-persist the finished session', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const submission = app.match(/async function submitAnswer\([\s\S]*?\n\}/)?.[0];
  assert.ok(submission, 'answer submission flow should be present');
  assert.match(submission, /else \{ state\.session\.currentQuestion = result\.nextQuestion; renderQuestion\(result\.nextQuestion\); persistClientSession\(\); \}/);
});

test('materials announce the current source count after changes', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="additionalSourceStatus"[^>]*role="status"/);
  assert.match(app, /function renderSourceCount\(sources\)/);
  assert.match(app, /available for source-grounded questions/);
  assert.match(app, /renderSourceCount\(sources\)/);
});

test('materials disable source uploads at the configured source limit', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /additionalSourceFile.*disabled/);
  assert.match(app, /addSourceButton.*disabled/);
  assert.match(app, /Remove one to add another/);
});

test('voice turns advance progress and do not queue a follow-up after the final round', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(result\.countsAsAnswer !== false\) state\.session\.turnCount = Number\(state\.session\.turnCount \|\| 0\) \+ 1/);
  assert.match(app, /if \(result\.followUp && !result\.done\)/);
  assert.match(app, /voiceCoordinator\.shouldAutoResume = !result\.done/);
});

test('materials source capacity follows the server-configured limit', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function maxSourceFiles\(\)/);
  assert.doesNotMatch(app, /sources\.length >= 3/);
  assert.doesNotMatch(app, /sourceCount[^\n]*>= 3/);
});

test('adding a source exposes a processing state', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function setSourceProcessing\(processing\)/);
  assert.match(app, /Adding source/);
  assert.match(app, /setSourceProcessing\(true\)/);
  assert.match(app, /setSourceProcessing\(false\)/);
});

test('source upload gives a retry message after processing failure', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /I could not add that source\. Try again\./);
});

test('ending a session exposes a processing state', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function setEndSessionProcessing\(processing\)/);
  assert.match(app, /Ending session/);
  assert.match(app, /setEndSessionProcessing\(true\)/);
  assert.match(app, /setEndSessionProcessing\(false\)/);
});

test('deleting session data exposes a processing state', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function setDeleteDataProcessing\(processing\)/);
  assert.match(app, /Deleting session/);
  assert.match(app, /setDeleteDataProcessing\(true\)/);
  assert.match(app, /setDeleteDataProcessing\(false\)/);
});

test('refresh recovery preserves the current answer draft in session storage', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /draft: \$\('#answerText'\)\.value/);
  assert.match(app, /typeof saved\.draft === 'string'/);
  assert.match(app, /\$\('#answerText'\)\.addEventListener\('input', persistClientSession\)/);
});

test('refresh recovery preserves an additional pasted-source draft', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /additionalSourceName: \$\('#additionalSourceName'\)\.value/);
  assert.match(app, /additionalSourceText: \$\('#additionalSourceText'\)\.value/);
  assert.match(app, /typeof saved\.additionalSourceText === 'string'/);
  assert.match(app, /\$\('#additionalSourceText'\)\.addEventListener\('input', persistClientSession\)/);
});

test('session reset clears an additional source draft', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function clearAdditionalSourceDraft\(\)/);
  const recover = app.match(/function recoverExpiredSession[\s\S]*?\n\}/)?.[0];
  assert.ok(recover, 'expired-session recovery should be present');
  assert.match(recover, /clearAdditionalSourceDraft\(\)/);
  const reset = app.match(/\$\('#newSession'\)[\s\S]*?\n\$\('#deleteData'/)?.[0];
  assert.ok(reset, 'session reset handler should be present');
  assert.match(reset, /clearAdditionalSourceDraft\(\)/);
  const deletion = app.match(/\$\('#deleteData'\)\.addEventListener[\s\S]*?\n\}\);/)?.[0];
  assert.ok(deletion, 'session deletion handler should be present');
  assert.match(deletion, /clearAdditionalSourceDraft\(\)/);
});

test('failed session deletion preserves the additional source draft', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const deletion = app.match(/\$\('#deleteData'\)\.addEventListener[\s\S]*?\n\}\);/)?.[0];
  assert.ok(deletion, 'session deletion handler should be present');
  assert.match(deletion, /await api\(\`\/api\/sessions\/\$\{state\.session\.id\}\`, \{ method: 'DELETE' \}\)/);
  assert.match(deletion, /await api\([\s\S]*?\n\s*clearAdditionalSourceDraft\(\)/);
});

test('session lifecycle clears the setup source filename marker', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function clearSourceNameAutoMarker\(\)/);
  const recover = app.match(/function recoverExpiredSession[\s\S]*?\n\}/)?.[0];
  assert.ok(recover, 'expired-session recovery should be present');
  assert.match(recover, /clearSourceNameAutoMarker\(\)/);
  const reset = app.match(/\$\('#newSession'\)[\s\S]*?\n\$\('#deleteData'/)?.[0];
  assert.ok(reset, 'new-session reset handler should be present');
  assert.match(reset, /clearSourceNameAutoMarker\(\)/);
});

test('session reset restores the visual practice-mode selection', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function syncModeSelection\(\)/);
  const recover = app.match(/function recoverExpiredSession[\s\S]*?\n\}/)?.[0];
  assert.ok(recover, 'expired-session recovery should be present');
  assert.match(recover, /syncModeSelection\(\)/);
  const reset = app.match(/\$\('#newSession'\)[\s\S]*?\n\$\('#deleteData'/)?.[0];
  assert.ok(reset, 'new-session reset handler should be present');
  assert.match(reset, /syncModeSelection\(\)/);
});

test('answer textarea supports Ctrl or Cmd plus Enter submission', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\('#answerText'\)\.addEventListener\('keydown'/);
  assert.match(app, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(app, /event\.key === 'Enter'/);
  assert.match(app, /event\.preventDefault\(\); submitAnswer\(\)/);
});

test('voice recognition persists its transcript draft for refresh recovery', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /state\.recognition\.onresult = event => .*persistClientSession\(\);/);
});

test('latest feedback can be replayed aloud on demand', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="replayFeedback"/);
  assert.match(app, /function replayFeedback\(\)/);
  assert.match(app, /state\.lastFeedback = feedback/);
  assert.match(app, /replayFeedback/);
});

test('live voice control exposes its connected state accessibly', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="liveVoiceButton"[^>]*aria-pressed="false"/);
  assert.match(app, /function setLiveVoiceState\(connected\)/);
  assert.match(app, /setAttribute\('aria-pressed', String\(connected\)\)/);
  assert.match(app, /setLiveVoiceState\(true\)/);
  assert.match(app, /setLiveVoiceState\(false\)/);
});

test('browser voice input exposes its listening state accessibly', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="listenButton"[^>]*aria-pressed="false"/);
  assert.match(app, /function setListeningState\(listening\)/);
  assert.match(app, /setListeningState\(true\)/);
  assert.match(app, /setListeningState\(false\)/);
});

test('session lifecycle stops browser voice recognition', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function stopSpeechRecognition\(\)/);
  assert.match(app, /state\.recognition\.stop\(\)/);
  const completion = app.match(/async function completeSession\([^)]*\).*?\n\}/s)?.[0];
  assert.ok(completion, 'session completion flow should be present');
  assert.match(completion, /stopLiveVoice\(\)/);
  assert.match(completion, /stopSpeechRecognition\(\)/);
  assert.match(app, /stopSpeechRecognition\(\); clearClientSession\(\)/);
});

test('finalized voice transcripts persist the canonical draft before review', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\('#answerText'\)\.value = trimmed;\s+\$\('#materialQuestion'\)\.value = trimmed;\s+persistClientSession\(\);/);
});

test('session review survives a tab refresh after server validation', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /sessionStorage\.setItem\(SESSION_STORAGE_KEY/);
  assert.match(app, /async function restoreClientSession\(\)/);
  assert.match(app, /await api\(`\/api\/sessions\/\$\{saved\.id\}`/);
  assert.match(app, /restoreClientSession\(\);/);
  assert.match(app, /result\.session\.status === 'completed'/);
  assert.match(app, /clearClientSession\(\);/);
});

test('expired sessions return the user to setup with a clear recovery message', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function recoverExpiredSession\(message/);
  assert.match(app, /data\.error\?\.code/);
  assert.match(app, /SESSION_EXPIRED/);
  assert.match(app, /recoverExpiredSession\(/);
  assert.match(app, /Your session expired\. Start a new session to continue\./);
  assert.match(app, /show\('setupView'\)/);
});

test('invalid session authorization uses the same recovery path', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /SESSION_NOT_FOUND/);
  assert.match(app, /UNAUTHORIZED/);
  assert.match(app, /Your session is no longer available\. Start a new session to continue\./);
});

test('network failures use a plain-language recovery message', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /Unable to reach deepchat2learn\. Check your connection and try again\./);
  assert.match(app, /catch \{\s*throw new Error\(/);
});

test('idempotent answer retries do not duplicate transcript turns', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(!state\.transcript\.some\(turn => turn\.question === question && turn\.answer === answer\)\)/);
});

test('digest key points expose their supporting evidence', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /point\.evidence/);
  assert.match(app, /digest-evidence/);
});

test('source citations expose their text locator when available', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /claim\.locator\?\.type === 'character'/);
  assert.match(app, /citation-locator/);
  assert.match(app, /claim\.locator\.start/);
  assert.match(app, /claim\.locator\.end/);
});

test('materials Q&A is preserved in the session review export', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /materialHistory: \[\]/);
  assert.match(app, /materialHistory: state\.materialHistory/);
  assert.match(app, /state\.materialHistory\.push/);
  assert.match(app, /Materials Q&A:/);
});

test('session review export retains source evidence locators', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const exportSection = app.match(/const materialsText = state\.materialHistory[\s\S]*?return \[/)?.[0];
  assert.ok(exportSection, 'materials export section should be present');
  assert.match(exportSection, /claim\.locator\?\.type === 'character'/);
  assert.match(exportSection, /Text position:/);
});

test('materials Q&A appears in the live session review panel', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /state\.materialHistory\.map/);
  assert.match(app, /material-review/);
  assert.match(app, /state\.materialHistory\.length/);
});

test('digest evidence exposes its text locator when available', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /point\.locator\?\.type === 'character'/);
  assert.match(app, /digest-locator/);
});

test('setup explains which coaching services are configured', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="serviceStatus"/);
  assert.match(app, /async function loadServiceStatus\(\)/);
  assert.match(app, /if \(!response\.ok\) throw new Error\('Service status unavailable'\)/);
  assert.match(app, /Local demo coach is active/);
  assert.match(app, /AI text coaching is configured/);
  assert.match(app, /connection\?\.textModel/);
  assert.match(app, /realtimeVoice/);
});

test('product branding uses deepchat2learn', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<title>deepchat2learn/);
  assert.match(html, /aria-label="deepchat2learn home"/);
  assert.match(html, /> deepchat2learn<\/a>/);
});

test('brand image is used as a compact project icon', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /rel="icon"[^>]+href="\/brand-logo\.png"/);
  assert.match(html, /class="brand-logo"[^>]+src="\/brand-logo\.png"/);
  assert.match(html, /alt=""/);
  assert.match(css, /\.brand-logo\s*\{[^}]*width:\s*54px[^}]*height:\s*30px[^}]*object-fit:\s*contain/s);
});

test('landing page uses the deep-learning conversation copy', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /A vibrant place to think clearly/);
  assert.match(html, /Turn Hot Conversations into Deep Learning/);
  assert.match(html, /What would you like to discuss today\?[\s\S]*?\(required\)/i);
  assert.doesNotMatch(html, /Choose a topic, answer one question at a time/);
  assert.match(html, /Adjust conversation options/);
  assert.match(html, /Supply document or notes and ask questions about them/);
  assert.match(html, /Start conversation/);
  assert.match(html, /embedded(?:-figure| figures)/i);
  assert.match(app, /Start conversation <span aria-hidden="true">→<\/span>/);
});

test('voice-first mode exposes an explicit accessible control and state machine', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="voiceConversationButton"[^>]*type="button"/);
  assert.match(html, /id="voiceConversationButton"[^>]*aria-pressed="false"/);
  assert.match(app, /voiceConversation: 'off'/);
  assert.match(app, /function setVoiceConversationState\(mode\)/);
  assert.match(app, /Start voice conversation/);
  assert.match(app, /Stop voice conversation/);
});

test('voice-first mode starts recognition after speaking the current question and can stop cleanly', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function startVoiceConversation\(\)/);
  assert.match(app, /function stopVoiceConversation\(\)/);
  assert.match(app, /speak\(state\.session\.currentQuestion, \{ onend:/);
  assert.match(app, /state\.recognition\.start\(\)/);
  assert.match(app, /speechSynthesis\.cancel\(\)/);
});

test('speech playback supports completion and error callbacks', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function speak\(text, \{ onend, onerror \} = \{\}\)/);
  assert.match(app, /utterance\.onend = onend/);
  assert.match(app, /utterance\.onerror = onerror/);
});

test('voice recognition auto-submits a finalized non-empty transcript', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function handleVoiceTranscript\(transcript, itemKey\)/);
  assert.doesNotMatch(app, /submitAnswer\(\{ voice: true, answer: transcript \}\)/);
  assert.match(app, /voiceSubmissionKey/);
  assert.match(app, /if \(!transcript\.trim\(\)\) return/);
  assert.match(app, /autoSubmitDelayMs:\s*5000/);
  assert.match(app, /queueTranscript/);
  assert.match(app, /recognition\.onend[\s\S]*pendingTranscript/);
  assert.match(app, /voiceRecognitionSessionId/);
});

test('voice feedback speaks before the next question and recognition restarts only while voice mode is active', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /result\.feedback\.answerSpeechText \|\|/);
  assert.match(app, /One useful next step:/);
  assert.match(app, /onend: \(\) => startVoiceListening\(\)/);
  assert.match(app, /state\.voiceConversation === 'listening'/);
});

test('voice-first mode explicitly requests microphone permission before speaking', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function requestMicrophoneAccess\(\{ retainStream = false \} = \{\}\)/);
  assert.match(app, /navigator\.mediaDevices\.getUserMedia\(microphoneConstraints\)/);
  assert.match(app, /echoCancellation: true/);
  assert.match(app, /noiseSuppression: true/);
  assert.match(app, /autoGainControl: true/);
  assert.match(app, /Please allow microphone access/);
  assert.match(app, /stream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(app, /await requestMicrophoneAccess\(\)/);
});

test('voice recognition retries transient failures and reports the browser error', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function scheduleVoiceListeningRetry\(message\)/);
  assert.match(app, /event\.error/);
  assert.match(app, /no-speech/);
  assert.match(app, /not-allowed/);
  assert.match(app, /voiceRecognitionAttempts/);
});

test('voice coordinator exposes a shared transport contract for browser fallback and live voice', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const voiceCoordinator = \{/);
  assert.match(app, /start: async \(/);
  assert.match(app, /stop: \(/);
  assert.match(app, /pause: async \(/);
  assert.match(app, /resume: async \(/);
  assert.match(app, /interrupt: async \(/);
  assert.match(app, /submitTranscript: async \(\{ transcript, confidence, reviewed, itemKey \} = \{\}\)/);
  assert.match(app, /speakApprovedAnswer: \(\{ answerSpeechText \} = \{\}\)/);
});

test('spoken turns submit finalized transcripts through the voice session endpoint', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\/api\/voice\/sessions\/\$\{state\.session\.id\}\/turns/);
  assert.match(app, /transcriptConfidence: confidence/);
  assert.match(app, /transcriptReviewed: reviewed/);
  assert.match(app, /idempotencyKey:/);
});

test('voice coordinator emits shared events and only speaks backend-approved answer speech text', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function emitVoiceEvent\(type, detail = \{\}\)/);
  assert.match(app, /permission_pending/);
  assert.match(app, /transcript_finalized/);
  assert.match(app, /answer_approved/);
  assert.match(app, /speech_started/);
  assert.match(app, /speech_ended/);
  assert.match(app, /recoverable_error/);
  assert.match(app, /speakApprovedAnswer:\s*\(\{ answerSpeechText \} = \{\}\) => \{[\s\S]*?buildApprovedSpeechRequest\(answerSpeechText/);
  assert.match(app, /speakApprovedAnswer:\s*\(\{ answerSpeechText \} = \{\}\) => \{[\s\S]*?speakLayeredAnswer\(\{/);
  assert.doesNotMatch(app, /response\.audio_transcript\.done[\s\S]*?speak\(/);
});

test('voice runtime exposes a harness-observable event stream and a typed materials fallback path', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /document\.dispatchEvent\(new CustomEvent\('deepchat2learn:voice'/);
  assert.match(app, /window\.voiceCoordinator = voiceCoordinator/);
  assert.match(app, /\$\('#materialQuestionForm'\)\.addEventListener\('submit'/);
  assert.match(app, /askMaterialQuestion\(\)/);
});

test('voice transcript finalization keeps interim text out of the typed fields and mirrors only the finalized transcript', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /applyVoiceEventsState[\s\S]*?\$\('#answerText'\)\.value = event\.transcript/);
  assert.doesNotMatch(app, /applyVoiceEventsState[\s\S]*?\$\('#materialQuestion'\)\.value = event\.transcript/);
  assert.match(app, /emitAndApplyVoiceEvent\('transcript_finalized', \{ transcript: trimmed/);
  assert.match(app, /\$\('#answerText'\)\.value = trimmed/);
  assert.match(app, /\$\('#materialQuestion'\)\.value = trimmed/);
  assert.match(app, /persistClientSession\(\)/);
});

test('realtime namespaced data-channel events feed the same shared coordinator paths', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /deepchat2learn\.turn\.finalized/);
  assert.match(app, /deepchat2learn\.answer\.approved/);
  assert.match(app, /deepchat2learn\.turn\.error/);
  assert.match(app, /handleRealtimeTransportMessage\(message\)/);
  assert.match(app, /voiceCoordinator\.speakApprovedAnswer\(\{ answerSpeechText: raw\.answerSpeechText \}\)/);
  assert.match(app, /emitAndApplyVoiceEvent\('recoverable_error'/);
});

test('voice coordinator resumes follow-up listening without requiring typed input and supports barge-in cleanup', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /voiceCoordinator\.interrupt\(\)/);
  assert.match(app, /voiceCoordinator\.resume\(\)/);
  assert.match(app, /voiceCoordinator\.submitTranscript\(/);
  assert.match(app, /if \(voiceCoordinator\.transport === 'browser-fallback'\) return/);
  assert.match(app, /if \(voiceCoordinator\.active && voiceCoordinator\.shouldAutoResume\) voiceCoordinator\.scheduleResume\(\)/);
});

test('voice UI exposes microphone accessibility status', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="microphoneStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(app, /function setMicrophoneStatus\(status/);
  assert.match(app, /Microphone accessible/);
  assert.match(app, /Microphone access was denied/);
});

test('voice readiness messaging distinguishes browser audio from microphone permission', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(app, /function detectMobileBrowser\(\)/);
  assert.match(app, /function syncVoiceAccessSetup\(\)/);
  assert.match(app, /This browser does not provide browser speech recognition/);
  assert.match(app, /Live AI voice can work when configured/);
  assert.match(html, /id="voicePermissionSetup"[^>]*class="voice-permission-setup hidden"/);
  assert.match(html, /id="prepareVoiceButton"/);
  assert.match(app, /navigator\.permissions\.query\(\{ name: 'microphone' \}\)/);
  assert.match(app, /permission\.state === 'granted'/);
  assert.match(app, /permission\.state === 'denied'/);
  assert.match(app, /state\.localStream = reconnectStream \|\| reusableLocalStream \|\| await navigator\.mediaDevices\.getUserMedia\(microphoneConstraints\)/);
  assert.match(app, /setMicrophoneStatus\('available'\)/);
  assert.match(html, /browser-audio-note/);
});

test('mobile voice chooses configured Realtime when browser speech recognition is unavailable', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /state\.realtimeConfigured = connection\?\.realtimeVoice === 'configured'/);
  assert.match(app, /state\.realtimeConfigured && \(state\.isMobileBrowser \|\| !state\.recognition\)/);
  assert.match(app, /const transport = preferRealtime \? 'realtime' : 'browser-fallback'/);
  assert.match(app, /const microphoneReady = await requestMicrophoneAccess\(\);\s*const speechReady = microphoneReady && await primeBrowserSpeechRecognition\(\)/);
  assert.match(app, /playsInline = true/);
  assert.match(app, /tryPlayRemoteAudio\(\)/);
  assert.match(app, /event\.streams\?\.\[0\]/);
});

test('voice and typed materials UI expose source-aware state, review, and recovery controls', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="voiceState"/);
  assert.match(html, /id="voiceTranscriptReview"/);
  assert.match(html, /id="knowledgeLayers"/);
  assert.match(html, /id="sourceDigestStatus"/);
  assert.match(html, /id="voiceCitations"/);
  assert.match(html, /id="voiceInterruptButton"[^>]*type="button"/);
  assert.match(html, /id="voicePauseButton"[^>]*type="button"/);
  assert.match(html, /id="voiceStopButton"[^>]*type="button"/);
  assert.match(html, /id="voiceRetryButton"[^>]*type="button"/);
  assert.match(html, /id="reviewTranscriptToggle"/);
});

test('approved answers render through one shared provenance renderer for voice and typed materials questions', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function renderApprovedAnswer\(result\)/);
  assert.match(app, /renderApprovedAnswer\(result\)/);
  assert.match(app, /renderApprovedAnswer\(answer\)/);
  assert.doesNotMatch(app, /function renderMaterialAnswer\(answer, \{ speakAnswer = true \} = \{\}\)/);
});

test('approved answer rendering exposes knowledge layers, confidence, citations, warnings, and follow-up prompts', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /knowledgeLayers/);
  assert.match(app, /sourceSupportStatus/);
  assert.match(app, /externalKnowledgeStatus/);
  assert.match(app, /voiceCitations/);
  assert.match(app, /sourceDigestStatus/);
  assert.match(app, /requiresExternalConsent/);
  assert.match(app, /ingestionWarnings/);
  assert.match(app, /conflicts/);
  assert.match(app, /followUp/);
  assert.match(app, /discussionPoints/);
  assert.match(app, /Suggestions/);
});

test('source answer rendering uses the approved speech text and shows academic assessment as a lightweight relevance note', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /approved\.academicAssessment/);
  assert.match(app, /Relevant to your question/);
  assert.match(app, /answerSpeechText: approved\.answerSpeechText/);
  assert.doesNotMatch(app, /answerSpeechText: \[approved\.answerText/);
  assert.doesNotMatch(app, /Practice scores/i);
});

test('external research asks for explicit one-turn consent and retries through the consent endpoint', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /research-consent/);
  assert.match(app, /window\.confirm/);
  assert.match(app, /requiresExternalConsent/);
  assert.match(app, /Would you like me to add one-time external research for this question\?/);
});

test('external research renders and speaks as a separate layer from the main answer', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function renderExternalResearchSection\(externalCitations = \[\]\)/);
  assert.match(app, /External research/);
  assert.match(app, /details class="evidence-disclosure/);
  assert.match(app, /transcript panel/);
  assert.match(app, /function buildExternalResearchSpeech\(externalCitations = \[\]\)/);
  assert.match(app, /externalResearchSpeechText/);
  assert.doesNotMatch(app, /citation\.excerpt \|\| citation\.snippet \|\| citation\.title/);
});

test('realtime approved-answer playback also includes a separate external-research speech segment', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /buildApprovedSpeechRequest\(answerSpeechText, externalResearchSpeechText\)/);
  assert.match(app, /voiceCoordinator\.externalResearchSpeechText = buildExternalResearchSpeech\(result\.externalCitations \|\| \[\]\)/);
  assert.match(app, /voiceCoordinator\.externalResearchSpeechText = raw\.externalResearchSpeechText \|\| ''/);
  assert.match(app, /voiceCoordinator\.speakApprovedAnswer\(\{ answerSpeechText: raw\.answerSpeechText \}\)/);
});

test('voice accessibility messaging includes digest readiness, microphone denial, and transcript review state', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="voiceState"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="sourceDigestStatus"[^>]*aria-live="polite"/);
  assert.match(app, /Microphone access was denied/);
  assert.match(app, /review before sending/i);
  assert.match(app, /digest/i);
});

test('voice accessibility UI separates visible state, live announcements, captions, repeat controls, and typed fallback guidance', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /id="voiceStateLabel"/);
  assert.match(html, /id="voiceLiveRegion"[^>]*aria-live="polite"/);
  assert.match(html, /id="voiceCaptionText"[^>]*aria-live="polite"/);
  assert.match(html, /id="repeatSpokenLine"[^>]*type="button"[^>]*disabled/);
  assert.match(html, /id="voiceTranscriptReviewText"/);
  assert.match(html, /Ctrl\+Enter or Cmd\+Enter/);
  assert.match(app, /voiceStateLabel/);
  assert.match(app, /voiceLiveRegion/);
  assert.match(app, /repeatSpokenLine/);
  assert.match(app, /setAttribute\('aria-label', `Voice state:/);
  assert.match(app, /function focusTypedFallback\(/);
  assert.match(css, /\.sr-only\s*\{/);
  assert.match(css, /\.voice-caption\s*\{/);
});

test('conversation removes redundant question playback and highlights voice processing feedback', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="speakQuestion"/);
  assert.doesNotMatch(app, /\$\('#speakQuestion'\)/);
  assert.match(app, /voice-processing-message/);
  assert.match(app, /voiceState\.classList\.toggle\('voice-processing-message', statusHighlighted\)/);
  assert.doesNotMatch(app, /voiceCaption\.classList\.toggle\('voice-processing-message'/);
  assert.match(css, /#voiceState\.voice-processing-message\s*\{/);
});

test('ending requests preserve a closing notice when routing to the session summary', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /result\.sessionEnded/);
  assert.match(app, /async function completeSession\(\{ closingMessage = '' \} = \{\}\)/);
  assert.match(app, /\$\('#summaryStatus'\)\.textContent = closingMessage/);
});

test('voice recovery guidance covers unsupported speech recognition, saved retries, and reduced-motion users', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /Speech recognition is unavailable in this browser\./);
  assert.match(app, /Your transcript is saved for retry\./);
  assert.match(app, /returnFocusToRecoveryControl|focusRecoveryControl/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /animation:\s*none/);
  assert.match(css, /transition:\s*none/);
});

test('voice UI centralizes explicit browser conversation states through one render path', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /browserConversationState:\s*'idle'/);
  assert.match(app, /const BROWSER_CONVERSATION_STATES = \[/);
  for (const stateName of ['idle', 'ai-speaking', 'listening', 'user-speaking', 'processing', 'retryable-error', 'paused', 'completed']) {
    assert.match(app, new RegExp(`'${stateName}'`));
  }
  assert.match(app, /function transitionBrowserConversationState\(nextState, options = \{\}\)/);
  assert.match(app, /function renderBrowserConversationState\(\)/);
  assert.match(app, /function setVoiceAnnouncement\(message\) \{[\s\S]*renderBrowserConversationState\(\);[\s\S]*\}/);
  assert.match(app, /setAttribute\('data-voice-state', browserState\)/);
});

test('voice UI styles make shared browser conversation states visibly distinct', async () => {
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  for (const stateName of ['ai-speaking', 'listening', 'user-speaking', 'processing', 'retryable-error', 'paused']) {
    assert.match(css, new RegExp(`data-voice-state="${stateName}"`));
  }
  assert.match(css, /\.voice-state-active\s*\{/);
  assert.match(css, /\.voice-state-processing\s*\{/);
  assert.match(css, /\.voice-state-error\s*\{/);
});

test('source setup fields have explicit accessible labels', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /label for="sourceFile"/);
  assert.match(html, /label for="sourceName"/);
});

test('source processing status is announced accessibly', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="sourceStatus"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('source removal controls identify the document they remove', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /aria-label="Remove \$\{escapeHtml\(source\.name\)\}"/);
  assert.match(app, /type="button" class="quiet-button source-remove"/);
});

test('removing a source exposes a processing state', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function setSourceRemovalProcessing\(processing\)/);
  assert.match(app, /Removing source/);
  assert.match(app, /setSourceRemovalProcessing\(true\)/);
  assert.match(app, /setSourceRemovalProcessing\(false\)/);
});

test('removing a source clears stale material answers', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const removal = app.match(/\$\('#sourceList'\)\.addEventListener[\s\S]*?\n\}\);/)?.[0];
  assert.ok(removal, 'source removal handler should be present');
  assert.match(removal, /await api\([\s\S]*?\n\s*\$\('#materialAnswer'\)\.classList\.add\('hidden'\)/);
  assert.match(removal, /\$\('#materialAnswer'\)\.innerHTML = ''/);
});

test('materials Q&A falls back to general context when no sources remain', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const count = app.match(/function renderSourceCount\(sources\)[\s\S]*?\n\}/)?.[0];
  assert.ok(count, 'source count rendering should be present');
  assert.match(count, /querySelector\('option\[value="source"\]'\)/);
  assert.match(count, /disabled = !sources\.length/);
  assert.match(count, /value === 'source'/);
  assert.match(count, /value = 'general'/);
});

test('setup exposes the configured feedback style', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="feedbackStyle"/);
  assert.match(app, /feedbackStyle: \$\('#feedbackStyle'\)\.value/);
});

test('client restores durable server review records before stale browser session history', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /result\.session\.review/);
  assert.match(app, /review\.transcript/);
  assert.match(app, /review\.materialHistory/);
});

test('voice coaching turns render the same visible coaching notes as typed turns', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /turn\.voice \? '' :/);
  assert.match(app, /turn\.feedback \? `<details>/);
});
