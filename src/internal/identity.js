'use strict';

const crypto = require('crypto');

/**
 * Identity handling.
 *
 * The identifier is attacker-controlled in every realistic deployment (an IP
 * can be rotated, a header can be forged), and it ends up in three dangerous
 * places: a Redis key, a Map key, and a log line. Everything that touches it
 * goes through here.
 */

// Long enough for an IPv6 address, a UUID, or a typical API key; anything
// longer is hashed so a client cannot inflate Redis key memory at will.
const MAX_IDENTIFIER_LENGTH = 128;

// C0 controls + DEL. These enable log injection and corrupt Redis keys.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Collapse an identifier to a bounded, log-safe, key-safe string.
 *
 * - IPv4-mapped IPv6 (`::ffff:127.0.0.1`) folds onto its IPv4 form so the same
 *   client cannot occupy two buckets.
 * - Control characters are stripped.
 * - Over-long values are replaced by a stable hash, never truncated (a
 *   truncated prefix collides trivially).
 *
 * @param {string|number} raw
 * @returns {string}
 */
function normalizeIdentifier(raw) {
  let id = typeof raw === 'string' ? raw : String(raw);

  const mapped = IPV4_MAPPED.exec(id);
  if (mapped) id = mapped[1];

  id = id.replace(CONTROL_CHARS, '').trim();

  if (id.length > MAX_IDENTIFIER_LENGTH) {
    return `h:${hashIdentifier(id)}`;
  }
  return id;
}

/**
 * Stable, non-reversible label for an identifier. Used for logging and for
 * anything that leaves the process, so client IPs and API keys are never
 * echoed verbatim.
 *
 * @param {string} identifier
 * @param {number} [length=16]
 * @returns {string}
 */
function hashIdentifier(identifier, length = 16) {
  return crypto.createHash('sha256').update(String(identifier)).digest('hex').slice(0, length);
}

/**
 * Derive the default bucket scope from a limiter's configuration.
 *
 * Two limiters with identical limits share a bucket; limiters with different
 * limits never do. The hash is a pure function of the config, so independent
 * servers agree on it without coordination - which is what makes distributed
 * limiting work while still keeping a 5/min endpoint out of a 120/min bucket.
 *
 * @param {{ capacity: number, refillRate: number, cost: number }} config
 * @returns {string}
 */
function scopeFor({ capacity, refillRate, cost }) {
  const canonical = `c=${capacity};r=${refillRate};t=${cost}`;
  return `auto-${crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 10)}`;
}

/**
 * Scopes become part of a Redis key, so they get the same treatment.
 *
 * @param {string} scope
 * @returns {string}
 */
function normalizeScope(scope) {
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new TypeError(`scope must be a non-empty string, received ${JSON.stringify(scope)}`);
  }
  if (!SCOPE_PATTERN.test(scope)) {
    throw new RangeError(
      `scope must match ${SCOPE_PATTERN}, received ${JSON.stringify(scope)}`
    );
  }
  return scope;
}

module.exports = {
  MAX_IDENTIFIER_LENGTH,
  normalizeIdentifier,
  hashIdentifier,
  scopeFor,
  normalizeScope
};
