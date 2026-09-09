'use strict';

const log = require('./logger');

// Sliding window used for the per-second request cap.
const RATE_WINDOW_MS = 1000;

// How often the tracking maps are swept for stale entries - purely a
// memory-bounding safety net (rate-limit/ban expiry itself is checked by
// timestamp on every access, not by this sweep).
const CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * Creates an independent per-source-IP request-rate limiter with an
 * automatic ban list for repeat offenders. Used by both the DNS and HTTP
 * servers, each with its own instance and its own (live-reloadable) config,
 * so a flood on one protocol cannot exhaust or interfere with the other's
 * tracking state.
 * @param {object} opts
 * @param {string} opts.logTag - prefix for log lines (e.g. '[dns]', '[http]')
 * @param {() => number|undefined} opts.getMaxPerSecondPerIp - current per-IP-per-second cap; falsy disables rate limiting
 * @param {() => {violationWindowMs?: number, violationsToBan?: number, banDurationMs?: number}|undefined} opts.getBlacklistConfig - current blacklist config; falsy (or a falsy violationsToBan) disables banning
 * @returns {{isRateLimited: (ip: string) => boolean, isBlacklisted: (ip: string) => boolean, recordViolation: (ip: string) => void}}
 */
function createIpLimiter({ logTag, getMaxPerSecondPerIp, getBlacklistConfig }) {
  // Per-source-IP sliding window for rate limiting. Bounded via periodic
  // pruning below so a flood of distinct (possibly spoofed) source addresses
  // cannot grow this into a memory-exhaustion vector of its own.
  const rateBuckets = new Map();

  // Blacklist: IPs banned outright after repeatedly hitting the rate limit.
  // violationBuckets counts rate-limit hits per IP within a rolling window;
  // crossing the threshold promotes the IP into `blacklist` for banDurationMs,
  // after which every request is dropped up front (no rate-limit accounting,
  // nothing) without it needing to re-offend every second.
  const blacklist = new Map(); // ip -> banExpiresAt (ms epoch)
  const violationBuckets = new Map(); // ip -> { count, windowStart }

  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of rateBuckets) {
      if (now - b.windowStart > RATE_WINDOW_MS * 5) rateBuckets.delete(ip);
    }
    for (const [ip, expiresAt] of blacklist) {
      if (now >= expiresAt) blacklist.delete(ip);
    }
    const violationWindowMs = getBlacklistConfig()?.violationWindowMs ?? 60_000;
    for (const [ip, b] of violationBuckets) {
      if (now - b.windowStart > violationWindowMs * 2) violationBuckets.delete(ip);
    }
  }, CLEANUP_INTERVAL_MS).unref();

  /**
   * True while `ip` is serving an active ban (expired entries are pruned lazily here too).
   * @param {string} ip - source IP to check
   * @returns {boolean} true when `ip` is currently banned
   */
  function isBlacklisted(ip) {
    const expiresAt = blacklist.get(ip);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
      blacklist.delete(ip);
      return false;
    }
    return true;
  }

  /**
   * Simple per-source-IP request cap (RRL-style).
   * @param {string} ip - source IP of the request
   * @returns {boolean} true when `ip` has exceeded its per-second budget
   */
  function isRateLimited(ip) {
    const limit = getMaxPerSecondPerIp();
    if (!limit) return false;
    const now = Date.now();
    let b = rateBuckets.get(ip);
    if (!b || now - b.windowStart >= RATE_WINDOW_MS) {
      b = { count: 0, windowStart: now };
      rateBuckets.set(ip, b);
    }
    b.count += 1;
    return b.count > limit;
  }

  /**
   * Records a rate-limit violation for `ip`; bans it once violations cross the configured threshold.
   * @param {string} ip - source IP that was just rate-limited
   * @returns {void}
   */
  function recordViolation(ip) {
    const bl = getBlacklistConfig();
    if (!bl?.violationsToBan) return;
    const now = Date.now();
    const windowMs = bl.violationWindowMs ?? 60_000;
    let b = violationBuckets.get(ip);
    if (!b || now - b.windowStart >= windowMs) {
      b = { count: 0, windowStart: now };
      violationBuckets.set(ip, b);
    }
    b.count += 1;
    if (b.count >= bl.violationsToBan) {
      const banDurationMs = bl.banDurationMs ?? 600_000;
      blacklist.set(ip, now + banDurationMs);
      violationBuckets.delete(ip);
      log.warn(`${logTag} blacklisted ${ip} for ${Math.round(banDurationMs / 1000)}s (repeated rate-limit violations)`);
    }
  }

  return { isRateLimited, isBlacklisted, recordViolation };
}

module.exports = { createIpLimiter };
