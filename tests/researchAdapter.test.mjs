import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchAdapter } from '../src/researchAdapter.mjs';

test('disabled research never calls the provider and reports a disabled status', async () => {
  let called = false;
  const adapter = createResearchAdapter({
    enabled: false,
    provider: {
      async search() {
        called = true;
        return [];
      }
    }
  });

  const consent = adapter.approveConsent();
  const result = await adapter.lookup({ query: 'spacing effect', consent });

  assert.equal(called, false);
  assert.equal(result.status, 'disabled');
  assert.equal(result.requiresExternalConsent, false);
  assert.deepEqual(result.results, []);
});

test('enabled research requires explicit one-turn consent before calling the provider', async () => {
  let called = false;
  const adapter = createResearchAdapter({
    enabled: true,
    provider: {
      async search() {
        called = true;
        return [{
          headline: 'Spacing effect overview',
          link: 'https://example.test/spacing-effect',
          source: 'Example Journal',
          retrievedAt: '2026-07-14T12:00:00.000Z',
          snippet: 'Spacing improves retention over time.'
        }];
      }
    }
  });

  const blocked = await adapter.lookup({ query: 'spacing effect' });
  assert.equal(blocked.status, 'consent_required');
  assert.equal(blocked.requiresExternalConsent, true);
  assert.equal(called, false);

  const now = Date.now();
  const approvedConsent = adapter.approveConsent({ now });
  const approved = await adapter.lookup({ query: 'spacing effect', consent: approvedConsent, now });
  assert.equal(called, true);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.requiresExternalConsent, false);
  assert.deepEqual(approved.results, [{
    id: 'https://example.test/spacing-effect',
    title: 'Spacing effect overview',
    url: 'https://example.test/spacing-effect',
    publisher: 'Example Journal',
    provider: 'Example Journal',
    retrievedAt: '2026-07-14T12:00:00.000Z',
    excerpt: 'Spacing improves retention over time.'
  }]);
  assert.equal(approved.nextConsent.approved, false);

  const consumed = await adapter.lookup({ query: 'spacing effect', consent: approved.nextConsent });
  assert.equal(consumed.status, 'consent_required');
  assert.equal(consumed.requiresExternalConsent, true);
});

test('provider timeout fails safely and consumes the approved one-turn consent', async () => {
  const adapter = createResearchAdapter({
    enabled: true,
    provider: {
      timeoutMs: 10,
      async search() {
        await new Promise(resolve => setTimeout(resolve, 50));
        return [{
          title: 'Too late',
          url: 'https://example.test/late',
          publisher: 'Slow Source',
          excerpt: 'This should not arrive in time.'
        }];
      }
    }
  });

  const now = Date.now();
  const consent = adapter.approveConsent({ now });
  const timedOut = await adapter.lookup({ query: 'slow search', consent, now });

  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.requiresExternalConsent, false);
  assert.deepEqual(timedOut.results, []);
  assert.equal(timedOut.nextConsent.approved, false);
});
