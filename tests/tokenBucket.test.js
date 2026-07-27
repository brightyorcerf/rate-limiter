'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TokenBucket = require('../src/algorithms/tokenBucket');

/** Controllable clock, so timing behaviour is tested without sleeping. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    set(ms) {
      now = ms;
    }
  };
}

test('rejects non-numeric and negative configuration', () => {
  assert.throws(() => new TokenBucket('5', 1), TypeError);
  assert.throws(() => new TokenBucket(NaN, 1), TypeError);
  assert.throws(() => new TokenBucket(Infinity, 1), TypeError);
  assert.throws(() => new TokenBucket(5, -1), RangeError);
  assert.throws(() => new TokenBucket(-5, 1), RangeError);
  assert.throws(() => new TokenBucket(undefined, 1), TypeError);
});

test('starts full and consumes down to empty', () => {
  const bucket = new TokenBucket(3, 1);
  assert.equal(bucket.getState().tokens, 3);
  assert.equal(bucket.consume(), true);
  assert.equal(bucket.consume(), true);
  assert.equal(bucket.consume(), true);
  assert.equal(bucket.consume(), false);
  assert.equal(bucket.getState().tokens, 0);
});

test('refills at the configured rate and clamps at capacity', () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(5, 2, { now: clock.now });

  for (let i = 0; i < 5; i += 1) bucket.consume();
  assert.equal(bucket.consume(), false);

  clock.advance(500); // 0.5s at 2/s == 1 token
  assert.equal(bucket.consume(), true);
  assert.equal(bucket.consume(), false);

  clock.advance(60_000); // far more than enough to overfill
  assert.equal(bucket.getState().tokens, 5, 'must clamp to capacity');
});

test('retryAfter is exact and never zero while denied', () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(1, 1, { now: clock.now });

  assert.equal(bucket.getRetryAfter(), 0, 'full bucket needs no wait');
  assert.equal(bucket.consume(), true);
  assert.equal(bucket.getRetryAfter(), 1000);

  clock.advance(400);
  assert.equal(bucket.getRetryAfter(), 600);

  clock.advance(600);
  assert.equal(bucket.getRetryAfter(), 0);
  assert.equal(bucket.consume(), true);
});

test('waiting exactly retryAfter is enough to succeed', () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(5, 5 / 60, { now: clock.now });

  for (let i = 0; i < 5; i += 1) assert.equal(bucket.consume(), true);
  const waitMs = bucket.getRetryAfter();
  assert.ok(Number.isFinite(waitMs) && waitMs > 0);

  clock.advance(waitMs);
  assert.equal(bucket.consume(), true, 'first retry after the advertised wait must succeed');
});

test('resetMs measures time back to capacity, not to the next token', () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(10, 1, { now: clock.now });

  assert.equal(bucket.getResetMs(), 0, 'a full bucket is already reset');
  for (let i = 0; i < 4; i += 1) bucket.consume();
  assert.equal(bucket.getResetMs(), 4000);

  clock.advance(1000);
  assert.equal(bucket.getResetMs(), 3000);
});

test('a request larger than capacity is unsatisfiable, not "retry in 5s"', () => {
  const bucket = new TokenBucket(5, 1);
  assert.equal(bucket.consume(10), false);
  assert.equal(bucket.getRetryAfter(10), Infinity);
});

test('zero refill rate denies everything and never advertises a retry', () => {
  const bucket = new TokenBucket(0, 0);
  assert.equal(bucket.consume(), false);
  assert.equal(bucket.getRetryAfter(), Infinity);
  assert.equal(bucket.getResetMs(), 0, 'an empty zero-capacity bucket is already "full"');
});

test('a clock moving backwards neither mints nor destroys tokens', () => {
  const clock = fakeClock(1_000_000);
  const bucket = new TokenBucket(5, 1, { now: clock.now });

  bucket.consume();
  bucket.consume();
  const before = bucket.getState().rawTokens;

  clock.set(900_000); // NTP step backwards
  assert.equal(bucket.getState().rawTokens, before, 'no change while the clock is behind');

  clock.advance(1000);
  assert.ok(
    Math.abs(bucket.getState().rawTokens - (before + 1)) < 1e-9,
    'accrual resumes from the earlier reading'
  );
});

test('frequent refills do not drift from a single long refill', () => {
  // Open question from the audit: refill() runs on every read and rewrites its
  // own anchor, so accumulated float error could silently starve clients.
  const fine = fakeClock();
  const coarse = fakeClock();
  const fineBucket = new TokenBucket(1000, 0.05, { now: fine.now });
  const coarseBucket = new TokenBucket(1000, 0.05, { now: coarse.now });

  fineBucket.consume(500);
  coarseBucket.consume(500);

  for (let i = 0; i < 10_000; i += 1) {
    fine.advance(1);
    fineBucket.refill();
  }
  coarse.advance(10_000);
  coarseBucket.refill();

  const drift = Math.abs(fineBucket.getState().rawTokens - coarseBucket.getState().rawTokens);
  assert.ok(drift < 1e-9, `drift after 10k refills was ${drift}`);
});

test('reconfigure preserves the consumed fraction', () => {
  const bucket = new TokenBucket(100, 1);
  bucket.consume(80); // 20% left

  bucket.reconfigure(10, 0.5);
  assert.equal(bucket.capacity, 10);
  assert.equal(bucket.refillRate, 0.5);
  assert.ok(Math.abs(bucket.getState().rawTokens - 2) < 1e-9, '20% of the new capacity');
});

test('reconfigure on a grow does not strip existing allowance', () => {
  const bucket = new TokenBucket(10, 1);
  bucket.consume(5);

  bucket.reconfigure(100, 1);
  assert.ok(Math.abs(bucket.getState().rawTokens - 50) < 1e-9);
});
