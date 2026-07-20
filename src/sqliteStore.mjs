import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureSourceContract, InMemoryStore } from './store.mjs';
import { maxQuestionsForSourceMode, SESSION_BUDGET_DEFAULTS } from './config.mjs';

function parseJsonObject(value) {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class SqliteStore extends InMemoryStore {
  constructor({
    path: filePath = './data/deepchat2learn.sqlite',
    sessionTtlMs,
    shortExpiryMs,
    defaultRetentionMode,
    turnBudget,
    modelTokenBudget
  } = {}) {
    super({ sessionTtlMs, shortExpiryMs, defaultRetentionMode, turnBudget, modelTokenBudget });
    fs.mkdirSync(pathModuleDir(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        capability_token TEXT NOT NULL,
        topic TEXT NOT NULL,
        goal TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        feedback_style TEXT NOT NULL,
        question_limit INTEGER NOT NULL,
        source_mode TEXT NOT NULL,
        skill_id TEXT NOT NULL DEFAULT 'none',
        active_skill_id TEXT NOT NULL DEFAULT 'none',
        conversation_skill_id TEXT NOT NULL DEFAULT 'none',
        skill_selection_reason TEXT NOT NULL DEFAULT 'No source-review skill selected.',
        status TEXT NOT NULL,
        current_question TEXT NOT NULL,
        digest_status TEXT,
        digest_json TEXT,
        digest_warnings_json TEXT,
        digest_error_json TEXT,
        retention_mode TEXT NOT NULL DEFAULT 'session',
        audio_storage TEXT NOT NULL DEFAULT 'never',
        turn_budget INTEGER NOT NULL DEFAULT ${SESSION_BUDGET_DEFAULTS.turnBudget},
        model_token_budget INTEGER NOT NULL DEFAULT ${SESSION_BUDGET_DEFAULTS.modelTokenBudget},
        model_tokens_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        mime_type TEXT,
        content_hash TEXT,
        warnings_json TEXT NOT NULL,
        digest_json TEXT,
        chunks_json TEXT,
        status TEXT,
        byte_count INTEGER,
        word_count INTEGER,
        page_count INTEGER,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        feedback_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_index)
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (session_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS voice_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER,
        input_mode TEXT NOT NULL,
        question TEXT,
        transcript TEXT NOT NULL,
        transcript_confidence REAL,
        transcript_reviewed INTEGER NOT NULL,
        intent TEXT NOT NULL,
        status TEXT NOT NULL,
        answer_text TEXT,
        answer_speech_text TEXT,
        knowledge_layers_json TEXT NOT NULL,
        citations_json TEXT NOT NULL,
        external_citations_json TEXT NOT NULL,
        discussion_points_json TEXT NOT NULL DEFAULT '[]',
        suggestions_json TEXT NOT NULL DEFAULT '[]',
        feedback_json TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        confidence TEXT,
        follow_up TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS voice_idempotency (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (session_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS source_chunks (
        chunk_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        page INTEGER,
        section TEXT,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sources_session_idx ON sources(session_id);
      CREATE INDEX IF NOT EXISTS source_chunks_session_idx ON source_chunks(session_id, source_id, ordinal);
      CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id);
      CREATE INDEX IF NOT EXISTS voice_turns_session_idx ON voice_turns(session_id, sequence, created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(source_id UNINDEXED, session_id UNINDEXED, content);
      CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(chunk_id UNINDEXED, source_id UNINDEXED, session_id UNINDEXED, source_name, section, content);
    `);
    try { this.db.exec('ALTER TABLE sources ADD COLUMN content_hash TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sources ADD COLUMN digest_json TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN digest_status TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN digest_json TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN digest_warnings_json TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN digest_error_json TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN retention_mode TEXT NOT NULL DEFAULT 'session'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN audio_storage TEXT NOT NULL DEFAULT 'never'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN skill_id TEXT NOT NULL DEFAULT 'none'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN active_skill_id TEXT NOT NULL DEFAULT 'none'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN conversation_skill_id TEXT NOT NULL DEFAULT 'none'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN skill_selection_reason TEXT NOT NULL DEFAULT 'No source-review skill selected.'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec(`ALTER TABLE sessions ADD COLUMN turn_budget INTEGER NOT NULL DEFAULT ${this.turnBudget}`); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec(`ALTER TABLE sessions ADD COLUMN model_token_budget INTEGER NOT NULL DEFAULT ${this.modelTokenBudget}`); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN model_tokens_used INTEGER NOT NULL DEFAULT 0'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sources ADD COLUMN chunks_json TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sources ADD COLUMN status TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sources ADD COLUMN byte_count INTEGER'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sources ADD COLUMN word_count INTEGER'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sources ADD COLUMN page_count INTEGER'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE sources ADD COLUMN metadata_json TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE voice_turns ADD COLUMN discussion_points_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE voice_turns ADD COLUMN suggestions_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE voice_turns ADD COLUMN question TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE voice_turns ADD COLUMN feedback_json TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE voice_turns ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* Existing databases already have the column. */ }
  }

  createSession(input) {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const retentionMode = ['session', 'until_deleted', 'short_expiry'].includes(input.retentionMode) ? input.retentionMode : this.defaultRetentionMode;
    const sourceMode = input.sourceMode || 'none';
    const maxQuestions = maxQuestionsForSourceMode(sourceMode);
    const defaultTurnBudget = sourceMode === 'source' ? Math.max(this.turnBudget, maxQuestions) : this.turnBudget;
    const sourceDefaults = sourceMode === 'source';
    const turnBudget = Number.isInteger(Number(input.turnBudget)) && Number(input.turnBudget) > 0 ? Number(input.turnBudget) : defaultTurnBudget;
    const modelTokenBudget = Number.isInteger(Number(input.modelTokenBudget)) && Number(input.modelTokenBudget) > 0 ? Number(input.modelTokenBudget) : this.modelTokenBudget;
    const session = {
      id,
      topic: input.topic,
      goal: input.goal || (sourceDefaults ? 'structure' : 'clarity'),
      difficulty: input.difficulty || (sourceDefaults ? 'intermediate' : 'beginner'),
      feedbackStyle: input.feedbackStyle || (sourceDefaults ? 'socratic' : 'supportive'),
      questionLimit: Math.min(Math.max(Number(input.questionLimit) || maxQuestions, 1), maxQuestions),
      sourceMode,
      skillId: input.skillId || (sourceMode === 'source' ? 'auto' : 'none'),
      activeSkillId: input.activeSkillId || 'none',
      conversationSkillId: input.conversationSkillId || (sourceMode === 'source' ? 'academic-conversation' : 'none'),
      skillSelectionReason: input.skillSelectionReason || 'No source-review skill selected.',
      status: 'active',
      currentQuestion: '',
      turns: [],
      sources: [],
      sourceDigest: null,
      digestStatus: null,
      digestWarnings: [],
      digestError: null,
      idempotency: new Map(),
      voiceTurns: [],
      voiceIdempotency: new Map(),
      retentionMode,
      audioStorage: 'never',
      turnBudget,
      modelTokenBudget,
      modelTokensUsed: 0,
      createdAt: new Date(now).toISOString(),
      expiresAt: retentionMode === 'until_deleted' ? null : now + (retentionMode === 'short_expiry' ? this.shortExpiryMs : this.sessionTtlMs),
      capabilityToken: token
    };
    this.save(session);
    return { session: this.publicSession(session), token };
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!row) return undefined;
    const sources = this.db.prepare('SELECT * FROM sources WHERE session_id = ? ORDER BY rowid').all(id).map(source => {
      const metadata = source.metadata_json ? JSON.parse(source.metadata_json) : { pageCount: source.page_count === null ? null : Number(source.page_count), sectionCount: 0 };
      return ensureSourceContract({
        id: source.id,
        name: source.name,
        text: source.text,
        mimeType: source.mime_type || 'text/plain',
        hash: source.content_hash || undefined,
        warnings: JSON.parse(source.warnings_json || '[]'),
        digest: source.digest_json ? JSON.parse(source.digest_json) : undefined,
        chunks: JSON.parse(source.chunks_json || '[]'),
        status: source.status || 'ready',
        byteCount: source.byte_count === null ? undefined : Number(source.byte_count),
        wordCount: source.word_count === null ? undefined : Number(source.word_count),
        pageCount: source.page_count === null ? undefined : Number(source.page_count),
        metadata,
        tables: Array.isArray(metadata.tables) ? metadata.tables : [],
        captions: Array.isArray(metadata.captions) ? metadata.captions : [],
        figures: Array.isArray(metadata.figures) ? metadata.figures : [],
        createdAt: source.created_at
      }, row.digest_status || null);
    });
    const turns = this.db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index').all(id).map(turn => ({
      index: turn.turn_index,
      question: turn.question,
      answer: turn.answer,
      feedback: JSON.parse(turn.feedback_json),
      createdAt: turn.created_at
    }));
    const idempotency = new Map(this.db.prepare('SELECT * FROM idempotency WHERE session_id = ?').all(id).map(item => [item.idempotency_key, JSON.parse(item.result_json)]));
    const voiceTurns = this.db.prepare('SELECT * FROM voice_turns WHERE session_id = ? ORDER BY sequence, created_at').all(id).map(turn => {
      const metadata = parseJsonObject(turn.metadata_json);
      return {
        id: turn.id,
        sessionId: turn.session_id,
        sequence: turn.sequence === null ? null : Number(turn.sequence),
        inputMode: turn.input_mode,
        question: turn.question || null,
        transcript: turn.transcript,
        transcriptConfidence: turn.transcript_confidence === null ? null : Number(turn.transcript_confidence),
        transcriptReviewed: Boolean(turn.transcript_reviewed),
        intent: turn.intent,
        status: turn.status,
        answerText: turn.answer_text,
        answerSpeechText: turn.answer_speech_text,
        knowledgeLayers: JSON.parse(turn.knowledge_layers_json || '[]'),
        citations: JSON.parse(turn.citations_json || '[]'),
        externalCitations: JSON.parse(turn.external_citations_json || '[]'),
        discussionPoints: JSON.parse(turn.discussion_points_json || '[]'),
        suggestions: JSON.parse(turn.suggestions_json || '[]'),
        feedback: turn.feedback_json ? JSON.parse(turn.feedback_json) : null,
        unsupportedOrUnresolved: Array.isArray(metadata.unsupportedOrUnresolved) ? metadata.unsupportedOrUnresolved : [],
        conflicts: Array.isArray(metadata.conflicts) ? metadata.conflicts : [],
        academicAssessment: metadata.academicAssessment || null,
        sourceSupportStatus: metadata.sourceSupportStatus || 'not_applicable',
        externalKnowledgeStatus: metadata.externalKnowledgeStatus || 'not_requested',
        confidence: turn.confidence,
        followUp: turn.follow_up,
        idempotencyKey: turn.idempotency_key,
        createdAt: turn.created_at,
        answeredAt: turn.answered_at
      };
    });
    const voiceIdempotency = new Map(this.db.prepare('SELECT * FROM voice_idempotency WHERE session_id = ?').all(id).map(item => [item.idempotency_key, JSON.parse(item.result_json)]));
    return {
      id: row.id,
      topic: row.topic,
      goal: row.goal,
      difficulty: row.difficulty,
      feedbackStyle: row.feedback_style,
      questionLimit: row.question_limit,
      sourceMode: row.source_mode,
      skillId: row.skill_id || (row.source_mode === 'source' ? 'auto' : 'none'),
      activeSkillId: row.active_skill_id || 'none',
      conversationSkillId: row.conversation_skill_id || (row.source_mode === 'source' ? 'academic-conversation' : 'none'),
      skillSelectionReason: row.skill_selection_reason || 'No source-review skill selected.',
      status: row.status,
      currentQuestion: row.current_question,
      turns,
      sources,
      sourceDigest: row.digest_json ? JSON.parse(row.digest_json) : null,
      digestStatus: row.digest_status || null,
      digestWarnings: JSON.parse(row.digest_warnings_json || '[]'),
      digestError: row.digest_error_json ? JSON.parse(row.digest_error_json) : null,
      idempotency,
      voiceTurns,
      voiceIdempotency,
      retentionMode: row.retention_mode || 'session',
      audioStorage: row.audio_storage || 'never',
      turnBudget: Number(row.turn_budget || this.turnBudget),
      modelTokenBudget: Number(row.model_token_budget || this.modelTokenBudget),
      modelTokensUsed: Number(row.model_tokens_used || 0),
      createdAt: row.created_at,
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      capabilityToken: row.capability_token
    };
  }

  save(session) {
    ensureSessionCollections(session);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE sessions SET capability_token = ?, topic = ?, goal = ?, difficulty = ?, feedback_style = ?, question_limit = ?, source_mode = ?, skill_id = ?, active_skill_id = ?, conversation_skill_id = ?, skill_selection_reason = ?, status = ?, current_question = ?, retention_mode = ?, audio_storage = ?, turn_budget = ?, model_token_budget = ?, model_tokens_used = ?, created_at = ?, expires_at = ? WHERE id = ?`).run(
        session.capabilityToken, session.topic, session.goal, session.difficulty, session.feedbackStyle, session.questionLimit, session.sourceMode, session.skillId || 'none', session.activeSkillId || 'none', session.conversationSkillId || (session.sourceMode === 'source' ? 'academic-conversation' : 'none'), session.skillSelectionReason || 'No source-review skill selected.', session.status, session.currentQuestion, session.retentionMode || 'session', session.audioStorage || 'never', session.turnBudget ?? this.turnBudget, session.modelTokenBudget ?? this.modelTokenBudget, session.modelTokensUsed ?? 0, session.createdAt, session.expiresAt, session.id
      );
      if (!this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(session.id)) {
        this.db.prepare(`INSERT INTO sessions (id, capability_token, topic, goal, difficulty, feedback_style, question_limit, source_mode, skill_id, active_skill_id, conversation_skill_id, skill_selection_reason, status, current_question, digest_status, digest_json, digest_warnings_json, digest_error_json, retention_mode, audio_storage, turn_budget, model_token_budget, model_tokens_used, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          session.id, session.capabilityToken, session.topic, session.goal, session.difficulty, session.feedbackStyle, session.questionLimit, session.sourceMode, session.skillId || 'none', session.activeSkillId || 'none', session.conversationSkillId || (session.sourceMode === 'source' ? 'academic-conversation' : 'none'), session.skillSelectionReason || 'No source-review skill selected.', session.status, session.currentQuestion, session.digestStatus || null, session.sourceDigest ? JSON.stringify(session.sourceDigest) : null, JSON.stringify(session.digestWarnings || []), session.digestError ? JSON.stringify(session.digestError) : null, session.retentionMode || 'session', session.audioStorage || 'never', session.turnBudget ?? this.turnBudget, session.modelTokenBudget ?? this.modelTokenBudget, session.modelTokensUsed ?? 0, session.createdAt, session.expiresAt
        );
      }
      this.db.prepare('UPDATE sessions SET digest_status = ?, digest_json = ?, digest_warnings_json = ?, digest_error_json = ? WHERE id = ?').run(session.digestStatus || null, session.sourceDigest ? JSON.stringify(session.sourceDigest) : null, JSON.stringify(session.digestWarnings || []), session.digestError ? JSON.stringify(session.digestError) : null, session.id);
      this.db.prepare('DELETE FROM sources WHERE session_id = ?').run(session.id);
      this.db.prepare('DELETE FROM source_fts WHERE session_id = ?').run(session.id);
      this.db.prepare('DELETE FROM source_chunks WHERE session_id = ?').run(session.id);
      this.db.prepare('DELETE FROM source_chunks_fts WHERE session_id = ?').run(session.id);
      for (const source of session.sources) this.db.prepare('INSERT INTO sources (id, session_id, name, text, mime_type, content_hash, warnings_json, digest_json, chunks_json, status, byte_count, word_count, page_count, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(source.id, session.id, source.name, source.text, source.mimeType || 'text/plain', source.hash || null, JSON.stringify(source.warnings || []), source.digest ? JSON.stringify(source.digest) : null, JSON.stringify(source.chunks || []), source.status || 'ready', source.byteCount ?? null, source.wordCount ?? null, source.pageCount ?? null, JSON.stringify(source.metadata || { pageCount: source.pageCount ?? null, sectionCount: 0 }), source.createdAt);
      for (const source of session.sources) this.db.prepare('INSERT INTO source_fts (source_id, session_id, content) VALUES (?, ?, ?)').run(source.id, session.id, source.text);
      for (const source of session.sources) {
        for (const chunk of source.chunks || []) {
          this.db.prepare('INSERT INTO source_chunks (chunk_id, session_id, source_id, ordinal, text, page, section, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
            chunk.id,
            session.id,
            source.id,
            chunk.ordinal ?? 0,
            chunk.text,
            chunk.page ?? null,
            chunk.section ?? null,
            chunk.start ?? 0,
            chunk.end ?? 0
          );
          this.db.prepare('INSERT INTO source_chunks_fts (chunk_id, source_id, session_id, source_name, section, content) VALUES (?, ?, ?, ?, ?, ?)').run(
            chunk.id,
            source.id,
            session.id,
            source.name,
            chunk.section ?? '',
            chunk.text
          );
        }
      }
      this.db.prepare('DELETE FROM turns WHERE session_id = ?').run(session.id);
      for (const turn of session.turns) this.db.prepare('INSERT INTO turns (session_id, turn_index, question, answer, feedback_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(session.id, turn.index, turn.question, turn.answer, JSON.stringify(turn.feedback), turn.createdAt);
      this.db.prepare('DELETE FROM idempotency WHERE session_id = ?').run(session.id);
      for (const [key, result] of session.idempotency) this.db.prepare('INSERT INTO idempotency (session_id, idempotency_key, result_json) VALUES (?, ?, ?)').run(session.id, key, JSON.stringify(result));
      this.db.prepare('DELETE FROM voice_turns WHERE session_id = ?').run(session.id);
      for (const turn of session.voiceTurns) this.db.prepare(`INSERT INTO voice_turns (
        id, session_id, sequence, input_mode, question, transcript, transcript_confidence, transcript_reviewed, intent, status,
        answer_text, answer_speech_text, knowledge_layers_json, citations_json, external_citations_json, discussion_points_json, suggestions_json, feedback_json, metadata_json, confidence,
        follow_up, idempotency_key, created_at, answered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        turn.id,
        session.id,
        turn.sequence ?? null,
        turn.inputMode,
        turn.question ?? null,
        turn.transcript,
        turn.transcriptConfidence ?? null,
        turn.transcriptReviewed ? 1 : 0,
        turn.intent,
        turn.status,
        turn.answerText ?? null,
        turn.answerSpeechText ?? null,
        JSON.stringify(turn.knowledgeLayers || []),
        JSON.stringify(turn.citations || []),
        JSON.stringify(turn.externalCitations || []),
        JSON.stringify(turn.discussionPoints || []),
        JSON.stringify(turn.suggestions || []),
        turn.feedback ? JSON.stringify(turn.feedback) : null,
        JSON.stringify({
          unsupportedOrUnresolved: turn.unsupportedOrUnresolved || [],
          conflicts: turn.conflicts || [],
          academicAssessment: turn.academicAssessment || null,
          sourceSupportStatus: turn.sourceSupportStatus || 'not_applicable',
          externalKnowledgeStatus: turn.externalKnowledgeStatus || 'not_requested'
        }),
        turn.confidence ?? null,
        turn.followUp ?? null,
        turn.idempotencyKey ?? null,
        turn.createdAt,
        turn.answeredAt ?? null
      );
      this.db.prepare('DELETE FROM voice_idempotency WHERE session_id = ?').run(session.id);
      for (const [key, result] of session.voiceIdempotency) this.db.prepare('INSERT INTO voice_idempotency (session_id, idempotency_key, result_json) VALUES (?, ?, ?)').run(session.id, key, JSON.stringify(result));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  delete(id) {
    return this.deleteSession(id);
  }

  deleteSession(id) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM source_fts WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM source_chunks_fts WHERE session_id = ?').run(id);
      const deleted = Boolean(this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes);
      this.db.exec('COMMIT');
      return deleted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cleanupExpired() {
    const expiredIds = this.db.prepare('SELECT id FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?').all(Date.now()).map(row => row.id);
    let removed = 0;
    for (const id of expiredIds) {
      if (this.deleteSession(id)) removed += 1;
    }
    return removed;
  }

  searchSources(sessionId, query, limit = 5) {
    const chunkMatches = this.retrieveSourceChunks(sessionId, query, Math.min(Math.max(Number(limit) || 5, 1), 10));
    if (chunkMatches.length) {
      const sources = new Map((this.get(sessionId)?.sources || []).map(source => [source.id, source]));
      return [...new Set(chunkMatches.map(chunk => chunk.sourceId))].map(sourceId => sources.get(sourceId)).filter(Boolean).slice(0, limit);
    }
    const tokens = String(query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    if (!tokens.length) return [];
    const match = [...new Set(tokens)].map(token => `${token}*`).join(' OR ');
    const rows = this.db.prepare('SELECT source_id FROM source_fts WHERE session_id = ? AND source_fts MATCH ? ORDER BY bm25(source_fts) LIMIT ?').all(sessionId, match, Math.min(Math.max(Number(limit) || 5, 1), 10));
    const sources = new Map((this.get(sessionId)?.sources || []).map(source => [source.id, source]));
    return rows.map(row => sources.get(row.source_id)).filter(Boolean);
  }

  retrieveSourceChunks(sessionId, query, limit = 10) {
    const tokens = String(query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    if (!tokens.length) return [];
    const match = [...new Set(tokens)].map(token => `${token}*`).join(' OR ');
    const rows = this.db.prepare(`
      SELECT
        c.chunk_id AS id,
        c.source_id AS sourceId,
        s.name AS sourceName,
        c.ordinal AS ordinal,
        c.text AS text,
        c.page AS page,
        c.section AS section,
        c.start_offset AS start,
        c.end_offset AS end,
        bm25(source_chunks_fts, 5.0, 1.0, 0.5, 2.0, 1.0) AS rank
      FROM source_chunks_fts
      JOIN source_chunks c ON c.chunk_id = source_chunks_fts.chunk_id
      JOIN sources s ON s.id = c.source_id
      WHERE source_chunks_fts.session_id = ? AND source_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sessionId, match, Math.min(Math.max(Number(limit) || 10, 1), 25));
    return rows.map(row => ({
      id: row.id,
      sourceId: row.sourceId,
      sourceName: row.sourceName,
      ordinal: Number(row.ordinal),
      text: row.text,
      page: row.page === null ? null : Number(row.page),
      section: row.section || null,
      start: Number(row.start),
      end: Number(row.end),
      relevanceScore: Math.max(1, 100 - Number(row.rank || 0))
    }));
  }

  close() { this.db.close(); }
}

function pathModuleDir(filePath) {
  const directory = path.dirname(filePath);
  return directory === '.' ? process.cwd() : directory;
}

function ensureSessionCollections(session) {
  if (!Array.isArray(session.turns)) session.turns = [];
  if (!Array.isArray(session.sources)) session.sources = [];
  if (!Array.isArray(session.digestWarnings)) session.digestWarnings = [];
  if (!('sourceDigest' in session)) session.sourceDigest = null;
  if (!('digestStatus' in session)) session.digestStatus = null;
  if (!('digestError' in session)) session.digestError = null;
  if (!('retentionMode' in session)) session.retentionMode = 'session';
  if (!('audioStorage' in session)) session.audioStorage = 'never';
  if (!('skillId' in session)) session.skillId = session.sourceMode === 'source' ? 'auto' : 'none';
  if (!('activeSkillId' in session)) session.activeSkillId = 'none';
  if (!('conversationSkillId' in session)) session.conversationSkillId = session.sourceMode === 'source' ? 'academic-conversation' : 'none';
  if (!('skillSelectionReason' in session)) session.skillSelectionReason = 'No source-review skill selected.';
  if (!('turnBudget' in session)) session.turnBudget = SESSION_BUDGET_DEFAULTS.turnBudget;
  if (!('modelTokenBudget' in session)) session.modelTokenBudget = SESSION_BUDGET_DEFAULTS.modelTokenBudget;
  if (!('modelTokensUsed' in session)) session.modelTokensUsed = 0;
  for (const source of session.sources) {
    if (!Array.isArray(source.warnings)) source.warnings = [];
    if (!Array.isArray(source.chunks)) source.chunks = [];
  }
  if (!(session.idempotency instanceof Map)) session.idempotency = new Map(session.idempotency || []);
  if (!Array.isArray(session.voiceTurns)) session.voiceTurns = [];
  if (!(session.voiceIdempotency instanceof Map)) session.voiceIdempotency = new Map(session.voiceIdempotency || []);
}
