import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildConsolidatedDigest, chunkSource, retrieveSourceChunks } from '../src/sourceKnowledge.mjs';
import { SqliteStore } from '../src/sqliteStore.mjs';

const FIXTURE_DIR = new URL('./fixtures/voice-source/', import.meta.url);

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURE_DIR), 'utf8'));
}

function materializeSource(sourceFixture) {
  const warnings = Array.isArray(sourceFixture.warnings) ? sourceFixture.warnings.slice() : [];
  let cursor = 0;
  const pages = [];
  const text = (sourceFixture.segments || []).map((segment, index) => {
    const prefix = index === 0 ? '' : ' ';
    const start = cursor + prefix.length;
    const end = start + segment.text.length;
    pages.push({ page: segment.page, section: segment.section, start, end });
    cursor = end;
    return `${prefix}${segment.text}`;
  }).join('');
  return {
    id: sourceFixture.id,
    name: sourceFixture.name,
    text,
    pages,
    warnings
  };
}

test('chunkSource preserves page and section metadata with deterministic overlap', () => {
  const pageOne = 'alpha beta gamma delta epsilon zeta';
  const pageTwo = 'eta theta iota kappa lambda mu';
  const text = `${pageOne} ${pageTwo}`;
  const pages = [
    { page: 1, section: 'Introduction', start: 0, end: pageOne.length },
    { page: 2, section: 'Methods', start: pageOne.length + 1, end: text.length }
  ];

  const chunks = chunkSource({ sourceId: 'source-1', text, pages, targetWords: 4, overlapWords: 2 });

  assert.deepEqual(chunks.map(chunk => chunk.ordinal), [1, 2, 3, 4, 5]);
  assert.equal(chunks[0].page, 1);
  assert.equal(chunks[0].section, 'Introduction');
  assert.equal(chunks.at(-1).page, 2);
  assert.equal(chunks.at(-1).section, 'Methods');
  assert.equal(chunks[0].text, text.slice(chunks[0].start, chunks[0].end));
  assert.equal(chunks[1].text.split(/\s+/).slice(0, 2).join(' '), chunks[0].text.split(/\s+/).slice(-2).join(' '));
});

test('buildConsolidatedDigest preserves extraction warnings and surfaces source conflicts', async () => {
  const sources = [
    {
      id: 'source-1',
      name: 'paper-a.txt',
      text: 'Spaced practice improves long-term retention.',
      warnings: ['Table text may be incomplete.']
    },
    {
      id: 'source-2',
      name: 'paper-b.txt',
      text: 'Spaced practice does not improve long-term retention.',
      warnings: []
    }
  ];
  const chunks = sources.flatMap(source => chunkSource({ sourceId: source.id, text: source.text, pages: null, targetWords: 8, overlapWords: 2 }));

  const digest = await buildConsolidatedDigest({ sources, chunks, coach: null });

  assert.equal(digest.mode, 'extractive');
  assert.match(digest.mainArgument, /Spaced practice/i);
  assert.equal(digest.conflicts.length, 1);
  assert.deepEqual(new Set(digest.conflicts[0].chunkIds), new Set(chunks.map(chunk => chunk.id)));
  assert.match(digest.warnings.join(' '), /incomplete/i);
});

test('buildConsolidatedDigest rejects model claims that are not exact chunk substrings', async () => {
  const source = {
    id: 'source-1',
    name: 'paper.txt',
    text: 'Retrieval practice boosts long-term retention in this course.',
    warnings: []
  };
  const chunks = chunkSource({ sourceId: source.id, text: source.text, pages: null, targetWords: 10, overlapWords: 2 });
  const digest = await buildConsolidatedDigest({
    sources: [source],
    chunks,
    coach: {
      async buildConsolidatedDigest() {
        return {
          mainArgument: 'Retrieval practice boosts durable learning.',
          keyPoints: [{ text: 'Retrieval practice boosts durable learning.', sourceIds: ['source-1'], chunkIds: [chunks[0].id] }],
          importantTerms: [],
          evidence: [{ claim: 'Retrieval practice boosts durable learning.', chunkIds: [chunks[0].id] }],
          conflicts: [],
          openQuestions: [],
          warnings: []
        };
      }
    }
  });

  assert.equal(digest.mode, 'extractive');
  assert.match(digest.warnings.join(' '), /partial/i);
  assert.equal(digest.evidence[0].chunkIds[0], chunks[0].id);
});

test('buildConsolidatedDigest forwards the active skill profile to the coach', async () => {
  const source = { id: 'source-1', name: 'paper.txt', text: 'A cohort study reports an association.', warnings: [] };
  const chunks = chunkSource({ sourceId: source.id, text: source.text, pages: null, targetWords: 20, overlapWords: 2 });
  let receivedSkillProfile;
  const digest = await buildConsolidatedDigest({
    sources: [source],
    chunks,
    skillProfile: { id: 'epi-research' },
    coach: {
      async buildConsolidatedDigest(input) {
        receivedSkillProfile = input.skillProfile;
        return {
          mainArgument: chunks[0].text,
          keyPoints: [{ text: chunks[0].text, sourceIds: [source.id], chunkIds: [chunks[0].id] }],
          importantTerms: [],
          evidence: [{ claim: chunks[0].text, chunkIds: [chunks[0].id] }],
          conflicts: [],
          openQuestions: [],
          warnings: []
        };
      }
    }
  });
  assert.equal(receivedSkillProfile.id, 'epi-research');
  assert.equal(digest.mode, 'model');
});

test('buildConsolidatedDigest rejects a claim when any referenced chunkId fails exact evidence validation', async () => {
  const source = {
    id: 'source-1',
    name: 'paper.txt',
    text: 'Retrieval practice boosts long-term retention. Worked examples improve initial performance.',
    warnings: []
  };
  const chunks = chunkSource({ sourceId: source.id, text: source.text, pages: null, targetWords: 5, overlapWords: 1 });
  const exactClaim = chunks[0].text;
  const digest = await buildConsolidatedDigest({
    sources: [source],
    chunks,
    coach: {
      async buildConsolidatedDigest() {
        return {
          mainArgument: exactClaim,
          keyPoints: [{ text: exactClaim, sourceIds: ['source-1'], chunkIds: [chunks[0].id, chunks[1].id] }],
          importantTerms: [],
          evidence: [{ claim: exactClaim, chunkIds: [chunks[0].id, chunks[1].id] }],
          conflicts: [],
          openQuestions: [],
          warnings: []
        };
      }
    }
  });

  assert.equal(digest.mode, 'extractive');
  assert.match(digest.warnings.join(' '), /validated/i);
});

test('retrieveSourceChunks ranks a known concept into the top 10 with source metadata and de-duplication', async () => {
  const session = {
    id: 'session-1',
    sources: [
      {
        id: 'source-1',
        name: 'Learning Science Notes',
        text: 'Spaced practice improves long-term retention for complex material. Spacing also helps recall over time.',
        chunks: chunkSource({
          sourceId: 'source-1',
          text: 'Spaced practice improves long-term retention for complex material. Spacing also helps recall over time.',
          pages: [{ page: 3, section: 'Results', start: 0, end: 'Spaced practice improves long-term retention for complex material. Spacing also helps recall over time.'.length }],
          targetWords: 8,
          overlapWords: 3
        })
      },
      {
        id: 'source-2',
        name: 'Other Notes',
        text: 'Worked examples help beginners manage cognitive load.',
        chunks: chunkSource({
          sourceId: 'source-2',
          text: 'Worked examples help beginners manage cognitive load.',
          pages: [{ page: 1, section: 'Summary', start: 0, end: 'Worked examples help beginners manage cognitive load.'.length }],
          targetWords: 8,
          overlapWords: 2
        })
      }
    ]
  };

  const matches = await retrieveSourceChunks({
    sessionId: session.id,
    query: 'What does the source say about spaced practice retention?',
    limit: 10,
    store: { get(id) { return id === session.id ? session : null; } }
  });

  assert.ok(matches.length >= 1);
  assert.ok(matches.length <= 10);
  assert.match(matches[0].text, /Spaced practice improves long-term retention/i);
  assert.equal(matches[0].sourceId, 'source-1');
  assert.equal(matches[0].sourceName, 'Learning Science Notes');
  assert.equal(matches[0].page, 3);
  assert.equal(matches[0].section, 'Results');
  assert.equal(typeof matches[0].start, 'number');
  assert.equal(typeof matches[0].end, 'number');
  assert.equal(new Set(matches.map(chunk => chunk.id)).size, matches.length);
});

test('retrieveSourceChunks returns equivalent ordering for in-memory and SQLite fixtures', async () => {
  const textA = 'Retrieval practice improves durable learning outcomes for students. Retrieval practice improves durable learning outcomes for students. Retrieval practice improves durable learning outcomes for students.';
  const textB = 'Spacing helps with recall across a longer time horizon for learners. Spacing helps with recall across a longer time horizon for learners.';
  const session = {
    id: 'session-equivalent',
    sources: [
      {
        id: 'source-1',
        name: 'Retrieval Handbook',
        text: textA,
        chunks: chunkSource({
          sourceId: 'source-1',
          text: textA,
          pages: [{ page: 1, section: 'Results', start: 0, end: textA.length }],
          targetWords: 6,
          overlapWords: 3
        })
      },
      {
        id: 'source-2',
        name: 'Spacing Overview',
        text: textB,
        chunks: chunkSource({
          sourceId: 'source-2',
          text: textB,
          pages: [{ page: 2, section: 'Summary', start: 0, end: textB.length }],
          targetWords: 6,
          overlapWords: 3
        })
      }
    ]
  };

  const memoryMatches = await retrieveSourceChunks({
    sessionId: session.id,
    query: 'retrieval practice results durable learning',
    limit: 4,
    store: { get(id) { return id === session.id ? session : null; } }
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-task4-'));
  const sqlite = new SqliteStore({ path: path.join(directory, 'retrieval.sqlite'), sessionTtlMs: 60_000 });
  try {
    const created = sqlite.createSession({ topic: 'Task 4', sourceMode: 'source' });
    const sqliteSession = sqlite.get(created.session.id);
    sqliteSession.id = session.id;
    sqliteSession.sources = session.sources.map(source => ({
      ...source,
      createdAt: source.createdAt || new Date().toISOString()
    }));
    sqlite.save(sqliteSession);
    const sqliteMatches = await retrieveSourceChunks({
      sessionId: session.id,
      query: 'retrieval practice results durable learning',
      limit: 4,
      store: sqlite
    });

    assert.deepEqual(
      sqliteMatches.map(({ id, sourceId, ordinal, page, section }) => ({ id, sourceId, ordinal, page, section })),
      memoryMatches.map(({ id, sourceId, ordinal, page, section }) => ({ id, sourceId, ordinal, page, section }))
    );
  } finally {
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('fixture retrieval keeps complementary source evidence in the top 10 with exact excerpts', async () => {
  const fixture = await readFixture('complementary-sources.json');
  const sources = fixture.sources.map(materializeSource).map(source => ({
    ...source,
    chunks: chunkSource({
      sourceId: source.id,
      text: source.text,
      pages: source.pages,
      targetWords: 12,
      overlapWords: 4
    })
  }));
  const session = { id: 'fixture-session', sources };

  const matches = await retrieveSourceChunks({
    sessionId: session.id,
    query: 'How do spacing and retrieval practice work together for retention?',
    limit: 10,
    store: { get(id) { return id === session.id ? session : null; } }
  });

  assert.ok(matches.length >= 2);
  assert.ok(matches.length <= 10);
  assert.deepEqual(new Set(matches.slice(0, 4).map(match => match.sourceId)), new Set(['comp-1', 'comp-2']));
  for (const match of matches) {
    const source = sources.find(candidate => candidate.id === match.sourceId);
    assert.equal(match.text, source.text.slice(match.start, match.end));
  }
});

test('fixture digest surfaces both conflicts and incomplete extraction warnings', async () => {
  const conflict = await readFixture('conflict.json');
  const incomplete = await readFixture('incomplete-extraction.json');
  const sources = [...conflict.sources, incomplete.source].map(materializeSource);
  const chunks = sources.flatMap(source => chunkSource({
    sourceId: source.id,
    text: source.text,
    pages: source.pages,
    targetWords: 12,
    overlapWords: 3
  }));

  const digest = await buildConsolidatedDigest({ sources, chunks, coach: null });

  assert.equal(digest.mode, 'extractive');
  assert.ok(digest.conflicts.length >= 1);
  assert.match(digest.warnings.join(' '), /Table text may be incomplete/i);
});

test('buildConsolidatedDigest adds a clear readiness warning when source processing is still underway', async () => {
  const source = {
    id: 'source-1',
    name: 'paper.txt',
    text: 'Retrieval practice improves long-term retention.',
    warnings: [],
    status: 'digesting',
    metrics: {
      bytes: 43,
      words: 5,
      pages: null,
      chunkCount: 1,
      tableCount: 0,
      figureCount: 0,
      captionCount: 0,
      extractionMethod: 'text-direct'
    }
  };
  const chunks = chunkSource({ sourceId: source.id, text: source.text, pages: null, targetWords: 8, overlapWords: 2 });

  const digest = await buildConsolidatedDigest({ sources: [source], chunks, coach: null });

  assert.match(digest.warnings.join(' '), /still processing/i);
  assert.match(digest.warnings.join(' '), /grounded answers are not ready/i);
});

test('deleting a fixture-backed sqlite session removes source chunks, digests, and retrieval matches', async () => {
  const paperFixture = await readFixture('paper.json');
  const source = materializeSource(paperFixture.source);
  const sourceWithChunks = {
    ...source,
    createdAt: new Date('2026-07-14T00:00:00.000Z').toISOString(),
    digest: {
      mode: 'extractive',
      mainArgument: paperFixture.source.segments[0].text,
      keyPoints: [{ text: paperFixture.source.segments[0].text, sourceIds: [source.id], chunkIds: [`${source.id}:chunk:1`] }],
      importantTerms: [],
      evidence: [{ claim: paperFixture.source.segments[0].text, chunkIds: [`${source.id}:chunk:1`] }],
      conflicts: [],
      openQuestions: [],
      warnings: []
    },
    chunks: chunkSource({
      sourceId: source.id,
      text: source.text,
      pages: source.pages,
      targetWords: 12,
      overlapWords: 4
    })
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat2learn-task10-'));
  const sqlite = new SqliteStore({ path: path.join(directory, 'task10.sqlite'), sessionTtlMs: 60_000 });

  try {
    const created = sqlite.createSession({ topic: 'Task 10', sourceMode: 'source', retentionMode: 'until_deleted' });
    const session = sqlite.get(created.session.id);
    session.sources = [sourceWithChunks];
    session.sourceDigest = sourceWithChunks.digest;
    session.digestStatus = 'ready';
    sqlite.save(session);

    const beforeDelete = await retrieveSourceChunks({
      sessionId: session.id,
      query: 'retrieval practice retention',
      limit: 10,
      store: sqlite
    });
    assert.ok(beforeDelete.length >= 1);

    assert.equal(sqlite.deleteSession(session.id), true);
    assert.equal(sqlite.get(session.id), undefined);
    assert.equal(sqlite.db.prepare('SELECT COUNT(*) AS count FROM sources').get().count, 0);
    assert.equal(sqlite.db.prepare('SELECT COUNT(*) AS count FROM source_chunks').get().count, 0);
    assert.equal(sqlite.db.prepare('SELECT COUNT(*) AS count FROM source_chunks_fts').get().count, 0);
  } finally {
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  }
});
