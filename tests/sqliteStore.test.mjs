import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../src/sqliteStore.mjs';

test('SQLite preserves voice discussion points and suggestions across reload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-voice-fields-'));
  const databasePath = path.join(directory, 'voice-fields.sqlite');
  const firstStore = new SqliteStore({ path: databasePath, sessionTtlMs: 60_000 });
  let created;
  try {
    created = firstStore.createSession({ topic: 'Persist voice fields', sourceMode: 'source' });
    const session = firstStore.get(created.session.id);
    session.voiceTurns.push({
      id: 'voice-persist-1',
      sequence: 0,
      inputMode: 'voice',
      transcript: 'What does this source claim?',
      transcriptConfidence: 0.95,
      transcriptReviewed: true,
      intent: 'source_question',
      status: 'answered',
      answerText: 'The source makes a claim.',
      answerSpeechText: 'The source makes a claim.',
      knowledgeLayers: ['source', 'llm'],
      citations: [],
      externalCitations: [],
      discussionPoints: ['Which evidence supports the claim?'],
      suggestions: ['Compare it with another study.'],
      confidence: 'high',
      followUp: 'What evidence supports it?',
      idempotencyKey: 'voice-persist-key',
      createdAt: new Date().toISOString(),
      answeredAt: new Date().toISOString()
    });
    firstStore.save(session);
  } finally {
    firstStore.close();
  }

  const secondStore = new SqliteStore({ path: databasePath, sessionTtlMs: 60_000 });
  try {
    const restored = secondStore.get(created.session.id);
    assert.deepEqual(restored.voiceTurns[0].discussionPoints, ['Which evidence supports the claim?']);
    assert.deepEqual(restored.voiceTurns[0].suggestions, ['Compare it with another study.']);
  } finally {
    secondStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite adds voice metadata columns when opening an older database', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-voice-migration-'));
  const databasePath = path.join(directory, 'voice-migration.sqlite');
  const initialStore = new SqliteStore({ path: databasePath, sessionTtlMs: 60_000 });
  initialStore.close();

  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec('ALTER TABLE voice_turns DROP COLUMN discussion_points_json');
  legacyDatabase.exec('ALTER TABLE voice_turns DROP COLUMN suggestions_json');
  legacyDatabase.close();

  const migratedStore = new SqliteStore({ path: databasePath, sessionTtlMs: 60_000 });
  try {
    const columns = migratedStore.db.prepare('PRAGMA table_info(voice_turns)').all().map(row => row.name);
    assert.ok(columns.includes('discussion_points_json'));
    assert.ok(columns.includes('suggestions_json'));
  } finally {
    migratedStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite reload preserves extracted PDF artifact collections from source metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-pdf-artifacts-'));
  const databasePath = path.join(directory, 'pdf-artifacts.sqlite');
  const store = new SqliteStore({ path: databasePath, sessionTtlMs: 60_000 });
  try {
    const created = store.createSession({ topic: 'Persist PDF artifacts', sourceMode: 'source' });
    const session = store.get(created.session.id);
    session.sources = [{
      id: 'pdf-source-1',
      name: 'paper.pdf',
      text: 'Table 1. Baseline characteristics',
      mimeType: 'application/pdf',
      warnings: [],
      chunks: [],
      metadata: {
        pageCount: 1,
        sectionCount: 0,
        tables: [{ tableId: 'table-1', page: 1, rows: [['Group', 'N']], text: 'Group | N' }],
        captions: [{ kind: 'table', label: 'Table 1', page: 1, text: 'Table 1. Baseline characteristics' }],
        figures: [{ figureId: 'figure-1', page: 1, extractionStatus: 'metadata_only' }]
      },
      tables: [{ tableId: 'table-1', page: 1, rows: [['Group', 'N']], text: 'Group | N' }],
      captions: [{ kind: 'table', label: 'Table 1', page: 1, text: 'Table 1. Baseline characteristics' }],
      figures: [{ figureId: 'figure-1', page: 1, extractionStatus: 'metadata_only' }],
      createdAt: new Date().toISOString()
    }];
    store.save(session);
    const restored = store.get(session.id);
    assert.equal(restored.sources[0].metadata.tables.length, 1);
    assert.equal(restored.sources[0].metadata.captions.length, 1);
    assert.equal(restored.sources[0].metadata.figures.length, 1);
    assert.equal(restored.sources[0].tables.length, 1);
    assert.equal(restored.sources[0].captions.length, 1);
    assert.equal(restored.sources[0].figures.length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite persists the separate source conversation skill', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-conversation-skill-'));
  const databasePath = path.join(directory, 'conversation-skill.sqlite');
  const firstStore = new SqliteStore({ path: databasePath, sessionTtlMs: 60_000 });
  const created = firstStore.createSession({
    topic: 'Discuss a research paper',
    sourceMode: 'source',
    skillId: 'academic-research',
    activeSkillId: 'academic-research',
    conversationSkillId: 'academic-conversation'
  });
  firstStore.close();

  const secondStore = new SqliteStore({ path: databasePath, sessionTtlMs: 60_000 });
  try {
    const restored = secondStore.get(created.session.id);
    assert.equal(restored.activeSkillId, 'academic-research');
    assert.equal(restored.conversationSkillId, 'academic-conversation');
    assert.equal(secondStore.publicSession(restored).conversationSkillId, 'academic-conversation');
  } finally {
    secondStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
