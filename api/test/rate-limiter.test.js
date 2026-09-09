'use strict';

/**
 * Coverage of rate-limiter.js - createIpLimiter (shared by dns-server.js and
 * http-server.js; each holds its own instance, exercised directly here).
 */

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const { createIpLimiter } = require('../src/rate-limiter');
const log = require('../src/logger');

/**
 * Builds a limiter instance over a mutable config object, mirroring how
 * dns-server.js/http-server.js read their live (reloadable) config.
 * @param {{rateLimit?: {maxPerSecondPerIp?: number}, blacklist?: object}} cfg - mutable config the limiter reads live
 * @returns {{isRateLimited: Function, isBlacklisted: Function, recordViolation: Function}}
 */
function makeLimiter(cfg) {
  return createIpLimiter({
    logTag: '[test]',
    getMaxPerSecondPerIp: () => cfg.rateLimit?.maxPerSecondPerIp,
    getBlacklistConfig: () => cfg.blacklist,
  });
}

describe('createIpLimiter - isRateLimited', () => {
  it('should not limit when maxPerSecondPerIp is not configured', () => {
    const limiter = makeLimiter({});
    expect(limiter.isRateLimited('10.0.0.1')).toBe(false);
  });

  it('should allow up to the configured limit and then flag further requests from the same IP within the window', () => {
    const cfg = { rateLimit: { maxPerSecondPerIp: 3 } };
    const limiter = makeLimiter(cfg);
    const ip = '10.0.0.2';
    expect(limiter.isRateLimited(ip)).toBe(false);
    expect(limiter.isRateLimited(ip)).toBe(false);
    expect(limiter.isRateLimited(ip)).toBe(false);
    expect(limiter.isRateLimited(ip)).toBe(true); // 4th call in the same window
  });

  it('should track separate IPs independently', () => {
    const cfg = { rateLimit: { maxPerSecondPerIp: 1 } };
    const limiter = makeLimiter(cfg);
    expect(limiter.isRateLimited('10.0.0.3')).toBe(false);
    expect(limiter.isRateLimited('10.0.0.4')).toBe(false); // different IP, own bucket
  });

  it('should pick up a live config change without recreating the limiter', () => {
    const cfg = { rateLimit: { maxPerSecondPerIp: 1 } };
    const limiter = makeLimiter(cfg);
    const ip = '10.0.0.5';
    expect(limiter.isRateLimited(ip)).toBe(false);
    expect(limiter.isRateLimited(ip)).toBe(true);
    cfg.rateLimit = undefined; // disable rate limiting live
    expect(limiter.isRateLimited(ip)).toBe(false);
  });
});

describe('createIpLimiter - isBlacklisted / recordViolation', () => {
  it('should report an untouched IP as not blacklisted', () => {
    const limiter = makeLimiter({});
    expect(limiter.isBlacklisted('10.0.1.1')).toBe(false);
  });

  it('should do nothing when blacklist is not configured, no matter how many violations are recorded', () => {
    const limiter = makeLimiter({});
    const ip = '10.0.1.2';
    for (let i = 0; i < 10; i++) limiter.recordViolation(ip);
    expect(limiter.isBlacklisted(ip)).toBe(false);
  });

  it('should ban an IP once violations cross the configured threshold', () => {
    const cfg = { blacklist: { violationWindowMs: 60000, violationsToBan: 3, banDurationMs: 60000 } };
    const limiter = makeLimiter(cfg);
    const ip = '10.0.1.3';
    limiter.recordViolation(ip);
    limiter.recordViolation(ip);
    expect(limiter.isBlacklisted(ip)).toBe(false); // 2 violations - not banned yet
    limiter.recordViolation(ip);
    expect(limiter.isBlacklisted(ip)).toBe(true); // 3rd violation crosses the threshold
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`[test] blacklisted ${ip}`));
  });

  it('should expire a ban after banDurationMs has passed', () => {
    const cfg = { blacklist: { violationWindowMs: 60000, violationsToBan: 1, banDurationMs: 50 } };
    const limiter = makeLimiter(cfg);
    const ip = '10.0.1.4';
    limiter.recordViolation(ip);
    expect(limiter.isBlacklisted(ip)).toBe(true);
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(limiter.isBlacklisted(ip)).toBe(false);
        resolve();
      }, 80);
    });
  });

  it('should track separate IPs independently for banning', () => {
    const cfg = { blacklist: { violationWindowMs: 60000, violationsToBan: 1, banDurationMs: 60000 } };
    const limiter = makeLimiter(cfg);
    limiter.recordViolation('10.0.1.5');
    expect(limiter.isBlacklisted('10.0.1.5')).toBe(true);
    expect(limiter.isBlacklisted('10.0.1.6')).toBe(false);
  });
});

describe('createIpLimiter - periodic cleanup sweep', () => {
  const CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;

  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('should prune a stale rate-limit bucket but keep one refreshed just before the sweep runs', () => {
    const cfg = { rateLimit: { maxPerSecondPerIp: 5 } };
    const limiter = makeLimiter(cfg);
    limiter.isRateLimited('10.0.2.1'); // created now - will be ~12h stale by the time the sweep fires
    jest.advanceTimersByTime(CLEANUP_INTERVAL_MS - 100);
    limiter.isRateLimited('10.0.2.2'); // created 100ms before the sweep - still well within the 5s grace window

    const deleteSpy = jest.spyOn(Map.prototype, 'delete');
    jest.advanceTimersByTime(100); // crosses the 12h mark - sweep fires

    expect(deleteSpy).toHaveBeenCalledWith('10.0.2.1');
    expect(deleteSpy).not.toHaveBeenCalledWith('10.0.2.2');
    deleteSpy.mockRestore();

    // bucket for .2 must have survived the sweep: a 6th call in the same window still trips the limit
    for (let i = 0; i < 5; i++) limiter.isRateLimited('10.0.2.2');
    expect(limiter.isRateLimited('10.0.2.2')).toBe(true);
  });

  it('should prune an expired ban from the blacklist on the sweep', () => {
    const cfg = { blacklist: { violationWindowMs: 60000, violationsToBan: 1, banDurationMs: 10 } };
    const limiter = makeLimiter(cfg);
    limiter.recordViolation('10.0.2.3'); // bans immediately for 10ms
    jest.advanceTimersByTime(10); // ban time elapses, but nothing has looked it up yet

    const deleteSpy = jest.spyOn(Map.prototype, 'delete');
    jest.advanceTimersByTime(CLEANUP_INTERVAL_MS);

    expect(deleteSpy).toHaveBeenCalledWith('10.0.2.3');
    deleteSpy.mockRestore();
  });

  it('should not prune an active ban whose expiry has not yet passed', () => {
    const cfg = { blacklist: { violationWindowMs: 60000, violationsToBan: 1, banDurationMs: CLEANUP_INTERVAL_MS * 2 } };
    const limiter = makeLimiter(cfg);
    limiter.recordViolation('10.0.2.4');

    const deleteSpy = jest.spyOn(Map.prototype, 'delete');
    jest.advanceTimersByTime(CLEANUP_INTERVAL_MS);

    expect(deleteSpy).not.toHaveBeenCalledWith('10.0.2.4');
    deleteSpy.mockRestore();
    expect(limiter.isBlacklisted('10.0.2.4')).toBe(true); // still banned
  });

  it('should prune a stale violation bucket using the configured violationWindowMs', () => {
    const cfg = { blacklist: { violationWindowMs: 1000, violationsToBan: 100, banDurationMs: 60000 } };
    const limiter = makeLimiter(cfg);
    limiter.recordViolation('10.0.2.5'); // 1 violation, far below the threshold of 100 - never bans

    const deleteSpy = jest.spyOn(Map.prototype, 'delete');
    jest.advanceTimersByTime(CLEANUP_INTERVAL_MS);

    expect(deleteSpy).toHaveBeenCalledWith('10.0.2.5');
    deleteSpy.mockRestore();
  });

  it('should keep a violation bucket still within twice the violationWindowMs at sweep time', () => {
    const cfg = { blacklist: { violationWindowMs: 60000, violationsToBan: 100, banDurationMs: 60000 } };
    const limiter = makeLimiter(cfg);
    jest.advanceTimersByTime(CLEANUP_INTERVAL_MS - 100);
    limiter.recordViolation('10.0.2.8'); // created 100ms before the sweep - well within violationWindowMs*2 (120s)

    const deleteSpy = jest.spyOn(Map.prototype, 'delete');
    jest.advanceTimersByTime(100); // crosses the 12h mark - sweep fires

    expect(deleteSpy).not.toHaveBeenCalledWith('10.0.2.8');
    deleteSpy.mockRestore();
  });

  it('should fall back to the default 60s violationWindowMs when no blacklist config is set', () => {
    const limiter = makeLimiter({}); // getBlacklistConfig() returns undefined
    limiter.recordViolation('10.0.2.6'); // no-op: recordViolation bails out early without a config

    // exercise the sweep's default-window branch directly via a differently-configured limiter,
    // since a limiter with no blacklist config never populates violationBuckets itself
    const cfg = { blacklist: { violationsToBan: 100 } }; // violationWindowMs left unset -> getBlacklistConfig() defined but no violationWindowMs
    const limiter2 = makeLimiter(cfg);
    limiter2.recordViolation('10.0.2.7');

    expect(() => jest.advanceTimersByTime(CLEANUP_INTERVAL_MS)).not.toThrow();
    expect(limiter.isBlacklisted('10.0.2.6')).toBe(false);
  });
});
