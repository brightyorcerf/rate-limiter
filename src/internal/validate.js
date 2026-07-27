'use strict';

/**
 * Shared argument validation.
 *
 * Every public entry point validates eagerly and throws with the offending
 * value in the message. Silently coercing bad config is how a rate limiter
 * ends up emitting `Retry-After: -1` or locking an endpoint forever.
 */

/**
 * @param {*} value
 * @param {string} name - used in the error message
 * @param {{ allowZero?: boolean, max?: number, integer?: boolean }} [opts]
 * @returns {number}
 */
function assertNumber(value, name, opts = {}) {
  const { allowZero = false, max = Number.MAX_SAFE_INTEGER, integer = false } = opts;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(
      `${name} must be a finite number, received ${typeof value} ${JSON.stringify(value)}`
    );
  }
  if (integer && !Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer, received ${value}`);
  }
  if (value < 0 || (!allowZero && value === 0)) {
    throw new RangeError(`${name} must be ${allowZero ? '>= 0' : '> 0'}, received ${value}`);
  }
  if (value > max) {
    throw new RangeError(`${name} must be <= ${max}, received ${value}`);
  }
  return value;
}

/**
 * @param {*} value
 * @param {string} name
 * @returns {Function}
 */
function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function, received ${typeof value}`);
  }
  return value;
}

/**
 * Duck-type check for the store contract. Catches a typo'd store at wire-up
 * time instead of on the first request in production.
 *
 * @param {*} store
 * @param {string} name
 */
function assertStore(store, name) {
  if (!store || typeof store !== 'object') {
    throw new TypeError(`${name} must be an object implementing checkLimit()`);
  }
  for (const method of ['checkLimit', 'reset']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`${name} is missing required method ${method}()`);
    }
  }
  return store;
}

/**
 * Wrap a promise so a hung dependency cannot hang a request.
 *
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} label - included in the timeout error
 */
function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'ERR_TIMEOUT';
      reject(err);
    }, ms);
    // Never let the timeout itself keep the event loop alive.
    if (typeof timer.unref === 'function') timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { assertNumber, assertFunction, assertStore, withTimeout };
