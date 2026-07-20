import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rateLimit.mjs';

test('rate limiter rejects requests after the configured window budget', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 100 });
  limiter.check('client', 0);
  limiter.check('client', 1);
  assert.throws(() => limiter.check('client', 2), error => error.code === 'RATE_LIMITED');
  limiter.check('client', 100);
});
