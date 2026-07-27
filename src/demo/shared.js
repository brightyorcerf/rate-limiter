'use strict';

const crypto = require('crypto');
const { hashIdentifier } = require('../internal/identity');

/**
 * Pieces both demo servers need. Kept here so the two demos cannot drift apart
 * on the parts that are easy to get wrong: admin auth and shutdown.
 */

/**
 * Constant-time secret comparison over digests, so neither the length nor the
 * position of the first mismatch leaks.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Bearer-token gate for the admin routes.
 *
 * Returns null when no token is configured, and the caller must then refuse to
 * mount the routes at all: administrative endpoints that reset limits and
 * enumerate clients cannot default to open.
 *
 * @param {string|undefined} token - typically process.env.ADMIN_TOKEN
 * @returns {Function|null}
 */
function createAdminAuth(token) {
  if (!token) return null;
  if (token.length < 16) {
    throw new Error('ADMIN_TOKEN must be at least 16 characters');
  }

  return function adminAuth(req, res, next) {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!presented || !secretsMatch(presented, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  };
}

/**
 * Request logger.
 *
 * Client addresses are pseudonymised by default: a rate limiter's log is a
 * complete record of who talked to the service, and in the API-key
 * configuration the identifier is a credential.
 *
 * @param {{ logClientIps?: boolean, logger?: object }} [options]
 */
function createRequestLogger(options = {}) {
  const logger = options.logger ?? console;
  const logClientIps = options.logClientIps === true;

  return function requestLogger(req, res, next) {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const client = logClientIps
        ? (req.ip ?? 'unknown')
        : `anon:${hashIdentifier(req.ip ?? 'unknown', 8)}`;

      logger.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Number(durationMs.toFixed(2)),
          client
        })
      );
    });

    next();
  };
}

/**
 * Drain on SIGTERM as well as SIGINT.
 *
 * SIGTERM is what Docker and Kubernetes send; handling only SIGINT means the
 * process is killed without ever closing Redis in the environment it actually
 * runs in. In-flight requests get `graceMs` to finish before the process is
 * forced down.
 *
 * @param {import('http').Server} server
 * @param {{ onShutdown?: () => Promise<void>, graceMs?: number, logger?: object }} [options]
 */
function installShutdownHandlers(server, options = {}) {
  const logger = options.logger ?? console;
  const graceMs = options.graceMs ?? 10_000;
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`[Server] ${signal} received, draining connections...`);

    const forceExit = setTimeout(() => {
      logger.error(`[Server] did not drain within ${graceMs}ms, exiting`);
      process.exit(1);
    }, graceMs);
    forceExit.unref();

    try {
      await new Promise((resolve) => server.close(resolve));
      // Cut idle keep-alive sockets that would otherwise hold the drain open.
      server.closeIdleConnections?.();
      await options.onShutdown?.();
      clearTimeout(forceExit);
      logger.log('[Server] shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('[Server] error during shutdown:', err);
      process.exit(1);
    }
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return shutdown;
}

module.exports = {
  secretsMatch,
  createAdminAuth,
  createRequestLogger,
  installShutdownHandlers
};
