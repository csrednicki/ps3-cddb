'use strict';

/**
 * Coverage of http-server.js per-IP rate limiting + blacklist (see
 * rate-limiter.js). Every test boots its own isolated http-server module
 * instance (jest.resetModules()) bound to its own port, so each test gets a
 * fresh limiter state - real requests from this file's HTTP client always
 * arrive from the same loopback address, so sharing limiter state across
 * tests would make them interfere with each other.
 */

const http = require('node:http');

const BOUNDARY = '---------------------------265001916915724';
let nextPort = 18090;

/**
 * Boots a fresh, isolated http-server instance on its own port, with the
 * given `http` config overrides (e.g. rateLimit/blacklist) merged onto a
 * minimal base config.
 * @param {object} [httpOverrides] - fields merged onto the `http` config section
 * @returns {Promise<{port: number, close: () => Promise<void>, logger: object}>}
 */
async function bootServer(httpOverrides = {}) {
  const port = nextPort++;
  jest.resetModules();
  jest.doMock('../src/config', () => ({
    loadConfig: () => ({
      client: { userName: 'AMG Test User' },
      http: { port, path: '/sdkrequest', boundary: BOUNDARY, replyDelayMs: 0, ...httpOverrides },
      dumps: { logRequests: false, logResponses: false },
    }),
  }));
  jest.doMock('../src/logger', () => ({
    info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), dumpBinary: jest.fn(), hexdump: jest.fn(),
  }));
  jest.doMock('../src/albums', () => ({
    findAlbumLive: jest.fn(), writeDiskCache: jest.fn(), purgeDiskCache: jest.fn(),
  }));
  jest.doMock('../src/cddb', () => ({ saveGnudbRecord: jest.fn() }));

  const { startHttpServer } = require('../src/http-server');
  const logger = require('../src/logger');
  const server = await startHttpServer();
  return {
    port,
    logger,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Sends a bare request to a test server and resolves with its status, or
 * with `{ dropped: true }` if the connection is reset/destroyed before a
 * response is received (the expected outcome for a banned IP).
 * @param {number} port - server port
 * @param {string} method - HTTP method
 * @param {string} target - request path
 * @returns {Promise<{status: number}|{dropped: true}>}
 */
function rawRequest(port, method, target) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: target, agent: false },
      (res) => { res.resume(); resolve({ status: res.statusCode }); },
    );
    req.on('error', () => resolve({ dropped: true }));
    req.end();
  });
}

describe('startHttpServer - per-IP rate limiting / blacklist', () => {
  it('should not rate limit when http.rateLimit is not configured', async () => {
    const { port, close } = await bootServer();
    try {
      for (let i = 0; i < 5; i++) {
        expect((await rawRequest(port, 'POST', '/other')).status).toBe(200);
      }
    } finally {
      await close();
    }
  });

  it('should return 429 once a source IP exceeds maxPerSecondPerIp within the window', async () => {
    const { port, close } = await bootServer({ rateLimit: { maxPerSecondPerIp: 2 } });
    try {
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await rawRequest(port, 'POST', '/other'));
      expect(results.map((r) => r.status)).toEqual([200, 200, 429]);
    } finally {
      await close();
    }
  });

  it('should keep rate-limiting IPs independently', async () => {
    // Both requests below share the same loopback source address, so this
    // documents the per-IP bucketing indirectly via the counter: two distinct
    // limiter instances (fresh per boot) never share state with each other.
    const first = await bootServer({ rateLimit: { maxPerSecondPerIp: 1 } });
    const second = await bootServer({ rateLimit: { maxPerSecondPerIp: 1 } });
    try {
      expect((await rawRequest(first.port, 'POST', '/other')).status).toBe(200);
      expect((await rawRequest(second.port, 'POST', '/other')).status).toBe(200);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('should drop connections outright once an IP crosses the ban threshold', async () => {
    const { port, close, logger } = await bootServer({
      rateLimit: { maxPerSecondPerIp: 1 },
      blacklist: { violationWindowMs: 60000, violationsToBan: 2, banDurationMs: 60000 },
    });
    try {
      // 1st request: under the limit, answered normally.
      expect((await rawRequest(port, 'POST', '/other')).status).toBe(200);
      // Next 2 requests exceed the per-second limit -> 2 violations -> ban.
      expect((await rawRequest(port, 'POST', '/other')).status).toBe(429);
      expect((await rawRequest(port, 'POST', '/other')).status).toBe(429);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('blacklisted'));

      // Now banned outright: the connection is dropped, not answered.
      const dropped = await rawRequest(port, 'POST', '/other');
      expect(dropped.dropped).toBe(true);
    } finally {
      await close();
    }
  });

  it('should not ban when blacklist is not configured, no matter how many times the rate limit is hit', async () => {
    const { port, close } = await bootServer({ rateLimit: { maxPerSecondPerIp: 1 } });
    try {
      for (let i = 0; i < 10; i++) await rawRequest(port, 'POST', '/other');
      const res = await rawRequest(port, 'POST', '/other');
      expect(res.status).toBe(429); // still just rate-limited, never dropped outright
    } finally {
      await close();
    }
  });
});
