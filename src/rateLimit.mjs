import { HttpError } from './store.mjs';

export class RateLimiter {
  constructor({ limit = 120, windowMs = 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  check(key, now = Date.now()) {
    const current = this.buckets.get(key);
    if (!current || current.startedAt + this.windowMs <= now) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > this.limit) throw new HttpError(429, 'Too many requests. Please wait a moment and try again.', 'RATE_LIMITED');
  }

  prune(now = Date.now()) {
    for (const [key, bucket] of this.buckets) if (bucket.startedAt + this.windowMs <= now) this.buckets.delete(key);
  }
}
