const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_CONSENT_TTL_MS = 60_000;

export function createResearchAdapter({
  enabled = false,
  provider = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  consentTtlMs = DEFAULT_CONSENT_TTL_MS
} = {}) {
  const normalizedEnabled = Boolean(enabled);
  const normalizedTimeoutMs = parsePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
  const normalizedConsentTtlMs = parsePositiveInteger(consentTtlMs, DEFAULT_CONSENT_TTL_MS);

  return {
    enabled: normalizedEnabled,

    approveConsent({ now = Date.now() } = {}) {
      const approvedAt = new Date(now).toISOString();
      return {
        approved: true,
        approvedAt,
        expiresAt: new Date(now + normalizedConsentTtlMs).toISOString(),
        usesRemaining: 1
      };
    },

    async lookup({ query, consent, now = Date.now() } = {}) {
      const normalizedQuery = normalizeOptionalString(query);
      const normalizedConsent = normalizeConsent(consent, now);

      if (!normalizedEnabled) {
        return buildLookupResult({
          status: 'disabled',
          requested: false,
          approved: false,
          requiresExternalConsent: false,
          results: [],
          nextConsent: normalizedConsent
        });
      }

      if (!normalizedQuery) {
        return buildLookupResult({
          status: 'not_requested',
          requested: false,
          approved: false,
          requiresExternalConsent: false,
          results: [],
          nextConsent: normalizedConsent
        });
      }

      if (!normalizedConsent.approved) {
        return buildLookupResult({
          status: 'consent_required',
          requested: true,
          approved: false,
          requiresExternalConsent: true,
          results: [],
          nextConsent: normalizedConsent
        });
      }

      const consumedConsent = consumeConsent(normalizedConsent);
      const searchableProvider = resolveProvider(provider);
      if (!searchableProvider) {
        return buildLookupResult({
          status: 'failed',
          requested: true,
          approved: false,
          requiresExternalConsent: false,
          results: [],
          nextConsent: consumedConsent
        });
      }

      try {
        const rawResults = await runWithTimeout(({ signal }) => searchableProvider({
          query: normalizedQuery,
          fetchImpl,
          signal
        }), parsePositiveInteger(provider?.timeoutMs, normalizedTimeoutMs));

        return buildLookupResult({
          status: 'approved',
          requested: true,
          approved: true,
          requiresExternalConsent: false,
          results: normalizeResults(rawResults, now),
          nextConsent: consumedConsent
        });
      } catch {
        return buildLookupResult({
          status: 'failed',
          requested: true,
          approved: false,
          requiresExternalConsent: false,
          results: [],
          nextConsent: consumedConsent
        });
      }
    }
  };
}

function buildLookupResult({ status, requested, approved, requiresExternalConsent, results, nextConsent }) {
  return {
    status,
    requested: Boolean(requested),
    approved: Boolean(approved),
    requiresExternalConsent: Boolean(requiresExternalConsent),
    results: Array.isArray(results) ? results : [],
    nextConsent: nextConsent || { approved: false, usesRemaining: 0 }
  };
}

function resolveProvider(provider) {
  if (typeof provider === 'function') return provider;
  if (provider && typeof provider.search === 'function') return input => provider.search(input);
  return null;
}

async function runWithTimeout(task, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      task({ signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('Research provider timed out.'));
          reject(new Error('Research provider timed out.'));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeConsent(consent, now) {
  const expiresAt = normalizeOptionalString(consent?.expiresAt);
  const usesRemaining = Number.isInteger(Number(consent?.usesRemaining))
    ? Math.max(0, Number(consent.usesRemaining))
    : 0;
  const approved = Boolean(
    consent?.approved
    && expiresAt
    && Date.parse(expiresAt) > now
    && usesRemaining > 0
  );

  return {
    approved,
    approvedAt: normalizeOptionalString(consent?.approvedAt),
    expiresAt,
    usesRemaining: approved ? usesRemaining : 0
  };
}

function consumeConsent(consent) {
  return {
    approved: false,
    approvedAt: consent?.approvedAt || null,
    expiresAt: consent?.expiresAt || null,
    usesRemaining: 0
  };
}

function normalizeResults(results, now) {
  const retrievedAtFallback = new Date(now).toISOString();
  return (Array.isArray(results) ? results : []).map((item, index) => {
    const title = normalizeOptionalString(item?.title || item?.headline) || `External research result ${index + 1}`;
    const url = normalizeOptionalString(item?.url || item?.link) || `about:blank#external-research-${index + 1}`;
    const publisher = normalizeOptionalString(item?.publisher || item?.provider || item?.source) || 'External source';
    const retrievedAt = normalizeOptionalString(item?.retrievedAt) || retrievedAtFallback;
    const excerpt = normalizeOptionalString(item?.excerpt || item?.snippet || item?.summary) || '';
    return {
      id: normalizeOptionalString(item?.id) || url,
      title,
      url,
      publisher,
      provider: publisher,
      retrievedAt,
      excerpt
    };
  });
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
