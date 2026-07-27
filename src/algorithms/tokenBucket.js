'use strict';

const { assertNumber, assertFunction } = require('../internal/validate');

/**
 * Token bucket.
 *
 * Tokens accrue continuously at `refillRate` per second, clamped to
 * `capacity`. State is only ever advanced lazily, on read - there is no timer.
 *
 * Two edge cases are represented explicitly rather than by a wrong number:
 *   - `refillRate === 0` (deny-all): nothing ever refills.
 *   - `needed > capacity`: physically unsatisfiable, no amount of waiting helps.
 * Both report `Infinity` from getRetryAfter()/getResetMs(), and callers must
 * not turn that into an HTTP header (see the middleware).
 */
class TokenBucket {
  /**
   * @param {number} capacity - maximum tokens held (burst size); 0 denies all
   * @param {number} refillRate - tokens added per second; 0 never refills
   * @param {{ now?: () => number }} [options] - injectable clock, for tests
   */
  constructor(capacity, refillRate, options = {}) {
    this.capacity = assertNumber(capacity, 'capacity', { allowZero: true });
    this.refillRate = assertNumber(refillRate, 'refillRate', { allowZero: true });
    this.now = options.now ? assertFunction(options.now, 'options.now') : Date.now;

    this.tokens = capacity;
    this.lastRefill = this.now();
  }

  /**
   * Apply a configuration change to a live bucket.
   *
   * The consumed *fraction* is preserved rather than the absolute token count:
   * a client that had burned 80% of a 100-token bucket keeps 20% of a new
   * 10-token bucket. Preserving the absolute count would either hand out free
   * quota (on a shrink) or silently strip it (on a grow).
   *
   * @param {number} capacity
   * @param {number} refillRate
   */
  reconfigure(capacity, refillRate) {
    assertNumber(capacity, 'capacity', { allowZero: true });
    assertNumber(refillRate, 'refillRate', { allowZero: true });
    if (capacity === this.capacity && refillRate === this.refillRate) return;

    this.refill();
    const fractionRemaining = this.capacity === 0 ? 1 : this.tokens / this.capacity;
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = Math.min(capacity, capacity * fractionRemaining);
  }

  /**
   * Advance the bucket to the current time.
   *
   * A clock that moves backwards (NTP step, VM restore) must never mint or
   * destroy tokens, so negative elapsed time contributes zero and the anchor
   * is re-based on the earlier reading.
   */
  refill() {
    const now = this.now();
    const elapsedMs = now - this.lastRefill;

    if (elapsedMs <= 0) {
      this.lastRefill = now;
      return;
    }
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillRate);
    this.lastRefill = now;
  }

  /**
   * @param {number} [tokens=1]
   * @returns {boolean} true if the tokens were consumed
   */
  consume(tokens = 1) {
    assertNumber(tokens, 'tokens');
    this.refill();

    if (tokens > this.capacity) return false; // unsatisfiable, never succeeds
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  /**
   * @param {number} [needed=1]
   * @returns {number} ms until `needed` tokens exist; 0 now, Infinity never
   */
  getRetryAfter(needed = 1) {
    assertNumber(needed, 'needed');
    this.refill();

    if (this.tokens >= needed) return 0;
    if (needed > this.capacity || this.refillRate === 0) return Infinity;
    return Math.ceil(((needed - this.tokens) / this.refillRate) * 1000);
  }

  /**
   * @returns {number} ms until the bucket is back at capacity; 0 if full
   */
  getResetMs() {
    this.refill();

    if (this.tokens >= this.capacity) return 0;
    if (this.refillRate === 0) return Infinity;
    return Math.ceil(((this.capacity - this.tokens) / this.refillRate) * 1000);
  }

  /**
   * @returns {{tokens: number, rawTokens: number, capacity: number, refillRate: number, resetMs: number}}
   */
  getState() {
    this.refill();
    return {
      tokens: Math.floor(this.tokens),
      rawTokens: this.tokens,
      capacity: this.capacity,
      refillRate: this.refillRate,
      resetMs: this.getResetMs()
    };
  }
}

module.exports = TokenBucket;
