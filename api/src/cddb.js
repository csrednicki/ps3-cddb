'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const log = require('./logger');
const { loadConfig } = require('./config');
const cfg = loadConfig();

/**
 * Computes the classic FreeDB/CDDB disc id from a TOC.
 * @param {number[]} frameOffsets - per-track starting frame offsets
 * @param {number} nTracks - number of tracks
 * @param {number} leadoutSeconds - leadout position, in seconds
 * @returns {number} the 32-bit disc id (0 when nTracks < 1)
 */
function getDiscId(frameOffsets, nTracks, leadoutSeconds) {
  if (nTracks < 1) return 0;
  let checksum = 0;
  for (let i = 0; i < nTracks; i++) {
    let n = Math.floor(frameOffsets[i] / 75);
    while (n > 0) { checksum += n % 10; n = Math.floor(n / 10); }
  }
  const totalSeconds = leadoutSeconds - Math.floor(frameOffsets[0] / 75);
  return (((checksum % 255) << 24) | (totalSeconds << 8) | nTracks) >>> 0;
}

/**
 * Builds a gnudb CDDB HTTP request URL for a given command, appending the hello/proto handshake.
 * @param {string} cmd - CDDB command string (already `+`-encoded, e.g. "cddb+query+...")
 * @returns {string} the full request URL
 */
function gnudbUrl(cmd) {
  const hello = `${(cfg.gnudb.email || '').replace('@', '+')}+${cfg.client.name}+${cfg.client.version}`;
  const url = `http://${cfg.gnudb.host}/~cddb/cddb.cgi?cmd=${cmd}&hello=${hello}&proto=${cfg.gnudb.proto}`;
  log.debug(`[gnudb] url: ${url}`);
  return url;
}

/**
 * Builds the gnudb "cddb query" URL for a TOC.
 * @param {number} discId - CDDB disc id (see getDiscId)
 * @param {number[]} frameOffsets - per-track starting frame offsets
 * @param {number} nTracks - number of tracks
 * @param {number} leadoutSeconds - leadout position, in seconds
 * @returns {string} the full query URL
 */
function makeQueryUrl(discId, frameOffsets, nTracks, leadoutSeconds) {
  const hex = discId.toString(16).padStart(8, '0');
  const offsets = frameOffsets.slice(0, nTracks).join('+');
  return gnudbUrl(`cddb+query+${hex}+${nTracks}+${offsets}+${leadoutSeconds}`);
}

/**
 * User-Agent header sent on gnudb requests.
 * @returns {string} "<client.name>/<client.version>"
 */
function getUserAgent() {
  return `${cfg.client.name}/${cfg.client.version}`;
}

/**
 * Fetches a URL over http or https (picked from the scheme), collecting the full body as text.
 * @param {string} url - URL to fetch
 * @returns {Promise<{status: number, body: string}>} the HTTP status and response body
 */
function fetchData(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': getUserAgent() }, timeout: cfg.gnudb.timeoutMs }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/**
 * parseCddbStatus — first line of EVERY CDDB protocol reply carries a 3-digit
 * status code + human message, e.g.:
 *   "210 Found exact matches, list follows (until terminating `.')"
 *   "500 Unknown application, developer email for abcdef 2.9.3"
 * HTTP status is always 200 — the real result status lives HERE.
 * @param {string} reply - raw CDDB protocol reply body
 * @returns {{code: string, message: string}|null} the status, or null when there is no status line
 */
function parseCddbStatus(reply) {
  const m = String(reply).match(/^\s*(\d{3})(?:\s+([^\r\n]*))?/);
  if (!m) return null;
  return { code: m[1], message: (m[2] ?? '').trim() };
}

/**
 * 4xx/5xx CDDB codes = server-reported errors (500 = bad hello / registration).
 * @param {string} code - 3-digit CDDB status code
 * @returns {boolean} true when `code` is a 4xx or 5xx error code
 */
function isCddbErrorCode(code) {
  const n = parseInt(code, 10);
  return Number.isInteger(n) && n >= 400 && n <= 599;
}

/**
 * Parses a gnudb query reply (200/210/211) into its first match.
 * @param {string} reply - raw CDDB protocol reply body
 * @returns {{category: string, id: string}|null} the first match, or null when there is none
 */
function parseData(reply) {
  return parseMatches(reply)[0] ?? null;
}

/**
 * Like parseData, but returns EVERY match a 210/211 list carries (not just the
 * first) - a 200 reply still yields a single-element array. Used when the
 * caller wants to offer all candidate albums (e.g. the PS3 letting the user
 * pick) instead of silently committing to gnudb's first guess.
 * @param {string} reply - raw CDDB protocol reply body
 * @returns {Array<{category: string, id: string}>} every match (empty when there is none)
 */
function parseMatches(reply) {
  const code = (reply.match(/^\s*(\d{3})/) ?? [])[1];
  if (!code) return [];
  if (code === '200') {
    const m = reply.match(/^\s*200\s+(\S+)\s+(\S+)/);
    return m ? [{ category: m[1], id: m[2] }] : [];
  }
  if (code === '210' || code === '211') {
    const out = [];
    for (const line of reply.split(/\r?\n/)) {
      const m = line.trim().match(/^(\S+)\s+([0-9a-fA-F]{8})(?:\s|$)/);
      if (m && m[1] !== '.') out.push({ category: m[1], id: m[2].toLowerCase() });
    }
    return out;
  }
  return [];
}

/**
 * Parses a gnudb "read" record's DTITLE/DYEAR/DGENRE/TTITLE lines into an album.
 * @param {string} text - raw gnudb record text
 * @param {number} [maxTracks=99] - highest TTITLE index to accept (out-of-range indices are ignored)
 * @returns {{albumArtist: string, albumTitle: string, albumGenre: string, albumYear: string, albumDisc: number, tracks: Array<{title: string}>}}
 */
function parseAlbum(text, maxTracks = 99) {
  const album = { albumArtist: '', albumTitle: '', albumGenre: '', albumYear: '', albumDisc: 0, tracks: [] };
  const titles = new Array(maxTracks).fill('');
  let highest = -1;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine;
    if (line.startsWith('DTITLE=') && !album.albumTitle) {
      const value = line.slice(7);
      const sep = value.indexOf(' / ');
      if (sep !== -1) {
        album.albumArtist = value.slice(0, sep);
        album.albumTitle = value.slice(sep + 3);
      } else {
        album.albumTitle = value;
      }
    } else if (line.startsWith('DYEAR=') && !album.albumYear) {
      album.albumYear = line.slice(6).trim();
    } else if (line.startsWith('DGENRE=') && !album.albumGenre) {
      album.albumGenre = line.slice(7);
    } else if (line.startsWith('TTITLE')) {
      const m = line.match(/^TTITLE(\d+)=(.*)$/);
      if (!m) continue;
      const index = parseInt(m[1], 10);
      if (Number.isNaN(index) || index < 0 || index >= maxTracks) continue;
      if (!titles[index]) {
        titles[index] = m[2];
        if (index > highest) highest = index;
      }
    }
  }

  const n = highest + 1;
  for (let i = 0; i < n; i++) album.tracks.push({ title: titles[i] || '' });
  album.albumArtist = album.albumArtist.trim();
  album.albumTitle = album.albumTitle.trim();
  album.albumGenre = album.albumGenre.trim();
  album.albumYear = album.albumYear.trim();
  album.albumDisc = parseDiscNumber(album.albumTitle);
  return album;
}

/**
 * Extracts a disc number from an album title, e.g. "Bad (CD2)", "[Disc 3]", "Disc 2 of 3".
 * @param {string} title - album title
 * @returns {number} the parsed disc number, or 0 when the title carries no disc/CD marker
 */
function parseDiscNumber(title) {
  const m = String(title).match(/(?:\(|\[|\b|-)\s*(?:cd|disc)\s*(\d{1,2})(?:\s*(?:of|\/)\s*\d{1,2})?\s*(\)|\])?/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Fetches one gnudb record ("cddb read") for a category/id match.
 * @param {string} category - gnudb category (e.g. "rock")
 * @param {string} id - gnudb disc id (8 hex digits)
 * @returns {Promise<string>} the raw record text
 * @throws {Error} on a non-200 HTTP status or a CDDB protocol error status
 */
async function fetchCddbRecord(category, id) {
  const url = gnudbUrl(`cddb+read+${encodeURIComponent(category)}+${encodeURIComponent(id)}`);
  const { status, body } = await fetchData(url);
  if (status !== 200) throw new Error(`gnudb read status=${status}`);
  const st = parseCddbStatus(body);
  if (st && isCddbErrorCode(st.code)) {
    throw new Error(`gnudb read failed: ${st.code} ${st.message}`);
  }
  return body;
}

/**
 * Saves a raw gnudb record next to its paired response dump. No-op unless ENABLE_DUMPS=1.
 * @param {number|string} ts - timestamp used to pair this file with `resp_<ts>.bin`
 * @param {string} body - raw gnudb record text
 * @returns {void}
 */
function saveGnudbRecord(ts, body) {
  if (process.env.ENABLE_DUMPS !== '1') return;
  try {
    fs.mkdirSync(log.DUMPS_DIR, { recursive: true });
    const file = path.join(log.DUMPS_DIR, `resp_${ts}-gnudb.txt`);
    fs.writeFileSync(file, String(body), 'utf8');
    log.info(`gnudb record saved: ${file}`);
  } catch (e) {
    log.warn(`gnudb record save failed: ${e.message}`);
  }
}

/**
 * Runs the gnudb "cddb query" for a TOC and returns its raw reply body, after
 * validating the HTTP status and the CDDB protocol status line.
 * @param {number[]} frameOffsets - per-track starting frame offsets
 * @param {number} nTracks - number of tracks
 * @param {number} leadoutSeconds - leadout position, in seconds
 * @returns {Promise<string>} the raw CDDB reply body
 * @throws {Error} on a non-200 HTTP status or a CDDB protocol error status
 */
async function queryCddbRaw(frameOffsets, nTracks, leadoutSeconds) {
  const discId = getDiscId(frameOffsets, nTracks, leadoutSeconds);
  const { status, body } = await fetchData(makeQueryUrl(discId, frameOffsets, nTracks, leadoutSeconds));
  if (status !== 200) throw new Error(`gnudb query status=${status}`);
  const st = parseCddbStatus(body);
  if (st && isCddbErrorCode(st.code)) {
    // e.g. "500 Unknown application, developer email for abcdef 2.9.3"
    // (bad hello/registration) — must NOT be treated as "no match"
    throw new Error(`gnudb query failed: ${st.code} ${st.message}`);
  }
  return body;
}

/**
 * Queries gnudb for a TOC and resolves its first match.
 * @param {number[]} frameOffsets - per-track starting frame offsets
 * @param {number} nTracks - number of tracks
 * @param {number} leadoutSeconds - leadout position, in seconds
 * @returns {Promise<{category: string, id: string}|null>} the first match, or null when there is none
 * @throws {Error} on a non-200 HTTP status or a CDDB protocol error status
 */
async function queryCddb(frameOffsets, nTracks, leadoutSeconds) {
  const body = await queryCddbRaw(frameOffsets, nTracks, leadoutSeconds);
  return parseData(body);
}

/**
 * Like queryCddb, but resolves every candidate a 210/211 match list carries.
 * @param {number[]} frameOffsets - per-track starting frame offsets
 * @param {number} nTracks - number of tracks
 * @param {number} leadoutSeconds - leadout position, in seconds
 * @returns {Promise<Array<{category: string, id: string}>>} every match (empty when there is none)
 * @throws {Error} on a non-200 HTTP status or a CDDB protocol error status
 */
async function queryCddbMatches(frameOffsets, nTracks, leadoutSeconds) {
  const body = await queryCddbRaw(frameOffsets, nTracks, leadoutSeconds);
  return parseMatches(body);
}

module.exports = {
  getDiscId,
  makeQueryUrl,
  fetchData,
  parseData,
  parseMatches,
  parseCddbStatus,
  isCddbErrorCode,
  parseAlbum,
  parseDiscNumber,
  queryCddb,
  queryCddbMatches,
  fetchCddbRecord,
  saveGnudbRecord,
};
