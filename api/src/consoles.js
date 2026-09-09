'use strict';

const consoles = new Map();

/**
 * Records a sighting of a console by MAC, creating or updating its tracking entry.
 * @param {string} mac - raw MAC/secret bytes as a string; non-hex characters are stripped
 * @param {object} [meta] - optional metadata to attach
 * @param {string} [meta.userAgent] - HTTP User-Agent of the request
 * @param {string} [meta.url] - request URL
 * @returns {{mac: string, firstSeen: string, lastSeen: string, requests: number}|null} the entry, or null when `mac` has no hex digits
 */
function registerConsole(mac, meta = {}) {
  const key = String(mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (key.length === 0) return null;
  const now = new Date().toISOString();
  let entry = consoles.get(key);
  if (!entry) {
    entry = { mac: key, firstSeen: now, lastSeen: now, requests: 0 };
    consoles.set(key, entry);
  }
  entry.lastSeen = now;
  entry.requests += 1;
  if (meta.userAgent) entry.userAgent = meta.userAgent;
  if (meta.url) entry.lastUrl = meta.url;
  return entry;
}

/**
 * Finds the most recently seen console's MAC, used by buildBinHeader() to
 * default the secret when a caller doesn't supply one.
 * @returns {string|null} the MAC of the most recently seen console, or null when none has been seen
 */
function getLastConsoleMac() {
  let last = null;
  for (const entry of consoles.values()) {
    if (!last || entry.lastSeen > last.lastSeen) last = entry;
  }
  return last ? last.mac : null;
}

/**
 * Lists every console seen so far.
 * @returns {Array<{mac: string, firstSeen: string, lastSeen: string, requests: number, userAgent?: string}>}
 */
function listConsoles() {
  return [...consoles.values()].map((e) => ({
    mac: e.mac,
    firstSeen: e.firstSeen,
    lastSeen: e.lastSeen,
    requests: e.requests,
    userAgent: e.userAgent,
  }));
}

/**
 * Clears all tracked console entries (used by tests to isolate state between runs).
 * @returns {void}
 */
function resetConsoles() {
  consoles.clear();
}

module.exports = { registerConsole, getLastConsoleMac, listConsoles, resetConsoles };
