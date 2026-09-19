'use strict';

const fs = require('node:fs');
const path = require('node:path');
const log = require('./logger');
const { loadConfig } = require('./config');
const { decodeTocField } = require('./toc');
const { queryCddbMatches, fetchCddbRecord, parseAlbum, getDiscId } = require('./cddb');

const cfg = loadConfig();
const CACHE_DIR = path.resolve(__dirname, "..", "..", cfg.gnudbCache.dir);
const CACHE_TTL_MS = Math.max(0, cfg.gnudbCache.ttlSeconds * 1000);
// gnudb can list many candidates for an ambiguous TOC - cap the per-candidate
// detail fetches so one lookup can't fan out into an unbounded burst of requests.
const MAX_MATCHES = 5;
const indexByRaw = new Map();

const cache = new Map();
const inflight = new Map();

// Test mode (GNUDB_TEST_RECORD): one fixed gnudb record served for every disc
// that is inserted, with the disc id recomputed from the disc actually in the
// drive. Used to exercise the PS3 response path without touching gnudb.
//
// The record can be held either inline (setTestRecord, used by tests) or as a
// file path (setTestRecordFile / GNUDB_TEST_RECORD). A path is re-read whenever
// the file changes on disk, so editing the sample while the server runs takes
// effect on the next disc without a restart.
let testRecord = null;
let testRecordPath = null;
let testRecordMtime = -1;
let testRecordSize = -1;

/**
 * Enables/disables test mode from an inline record: the raw gnudb record text
 * to serve for every disc, or null/undefined to restore normal lookups.
 * @param {string|null} [record] - raw gnudb record text (see api/samples/gnudb-sample.txt)
 * @returns {void}
 */
function setTestRecord(record) {
  testRecord = record ? String(record) : null;
  testRecordPath = null;
  testRecordMtime = -1;
  testRecordSize = -1;
}

/**
 * Enables/disables test mode from a file: the raw gnudb record is (re)read from
 * `file` whenever its mtime/size change, so edits are picked up live.
 * @param {string|null} [file] - path to a raw gnudb record file, or null to disable
 * @returns {void}
 */
function setTestRecordFile(file) {
  testRecordPath = file ? String(file) : null;
  testRecord = null;
  testRecordMtime = -1;
  testRecordSize = -1;
}

/**
 * Whether test mode is currently active.
 * @returns {boolean} true when a test record (inline or file-backed) is configured
 */
function isTestMode() {
  return testRecord !== null || testRecordPath !== null;
}

/**
 * Resolves the raw gnudb record to serve right now. A file-backed record is
 * re-read when its mtime/size differ from the cached ones; on a read error the
 * last good content is kept (and a warning is logged) so a transient failure
 * cannot take the server down mid-session.
 * @returns {string|null} the record text, or null when test mode is inactive/unusable
 */
function currentTestRecord() {
  if (!testRecordPath) return testRecord;
  try {
    const { mtimeMs, size } = fs.statSync(testRecordPath);
    if (mtimeMs !== testRecordMtime || size !== testRecordSize) {
      testRecord = fs.readFileSync(testRecordPath, 'utf8');
      testRecordMtime = mtimeMs;
      testRecordSize = size;
      log.info(`[test] reloaded ${testRecordPath} (${size} B)`);
    }
  } catch (e) {
    log.warn(`[test] cannot re-read ${testRecordPath} (${e.message}) - keeping last good record`);
  }
  return testRecord;
}

/**
 * Loads test mode from the GNUDB_TEST_RECORD env var at startup. Accepts
 * either a path to a raw gnudb record file or a truthy flag ("1"/"true"),
 * which loads the bundled sample at api/samples/gnudb-sample.txt.
 * @returns {boolean} true when a record was loaded
 */
function loadTestRecordFromEnv() {
  const val = process.env.GNUDB_TEST_RECORD;
  if (!val) return false;
  const isFlag = /^(1|true|yes)$/i.test(val);
  const file = isFlag ? path.join(__dirname, '..', 'samples', 'gnudb-sample.txt') : val;
  setTestRecordFile(file);
  if (!currentTestRecord()) {
    log.error(`[test] GNUDB_TEST_RECORD: cannot read ${file} - falling back to gnudb`);
    setTestRecordFile(null);
    return false;
  }
  log.info(`[test] GNUDB_TEST_RECORD active - every disc answers with ${file} (edits are picked up live)`);
  return true;
}

/**
 * Rewrites the DISCID line of a raw gnudb record so it carries the disc id of
 * the disc actually in the drive instead of the one from the test record.
 * @param {string} record - raw gnudb record text
 * @param {string} discId - disc id (8 hex digits) to write
 * @returns {string} the record with its DISCID line replaced
 */
function withDiscId(record, discId) {
  return String(record).replace(/^DISCID=.*$/m, `DISCID=${discId}`);
}

/**
 * Loads every seed album (.json) from `dir` and indexes it by its rawToc keys
 * for instant lookup, bypassing gnudb entirely for known discs.
 * @param {string} dir - directory containing seed album .json files
 * @returns {number} total number of rawToc keys now indexed
 */
function loadAlbums(dir) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const album = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const key of album.rawTocKeys ?? []) indexByRaw.set(key.toLowerCase(), album);
  }
  return indexByRaw.size;
}

/**
 * Looks up a seed album by the PS3's raw TOC hex (case-insensitive), loaded via loadAlbums.
 * @param {string} rawTocHex - raw TOC field from the request, hex-encoded
 * @returns {object|null} the matching seed album, or null when unknown/empty
 */
function findAlbumByRawToc(rawTocHex) {
  if (!rawTocHex) return null;
  return indexByRaw.get(String(rawTocHex).toLowerCase()) ?? null;
}

/**
 * Builds the on-disk cache filename stem "<discId>-<artist>-<title>" (without
 * extension), sanitizing artist/title to safe, length-capped path segments.
 * @param {string} discId - CDDB disc id (8 hex digits), the stable cache key
 * @param {string} artist - album artist, sanitized for use in a filename
 * @param {string} title - album title, sanitized for use in a filename
 * @returns {string} the cache filename stem
 */
function cacheFileStem(discId, artist, title) {
  const safe = (s) => String(s ?? '')
    .replace(/[^\w .-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60);
  const suffix = `${safe(artist)}-${safe(title)}`;
  return `${discId}-${suffix}`;
}

/**
 * Sweeps the disk cache and deletes every .txt entry whose age exceeds the
 * configured TTL. Deferred via setImmediate so it never delays the response
 * that triggered it; readDiskCache() renews any entry it actively reuses, so
 * a file being asked about right now will not be caught by this sweep.
 * @returns {void}
 */
function purgeDiskCache() {
  setImmediate(() => {
    try {
      for (const f of fs.readdirSync(CACHE_DIR)) {
        if (!f.endsWith('.txt')) continue;
        const full = path.join(CACHE_DIR, f);
        try {
          const { mtimeMs } = fs.statSync(full);
          if (Date.now() - mtimeMs > CACHE_TTL_MS) {
            fs.unlinkSync(full);
            const expiredAt = new Date(mtimeMs + CACHE_TTL_MS).toISOString().slice(11, 19) + 'Z';
            log.info(`[cache] purged: ${f} (expired at ${expiredAt})`);
          }
        } catch { /* file vanished mid-scan - ignore */ }
      }
    } catch { /* cache dir unreadable - ignore */ }
  });
}

/**
 * Reads the cached gnudb record for `discId`, if any. An entry past its TTL
 * is not treated as a miss: it is renewed (mtime bumped to now) and served
 * anyway, since the disc being asked about right now is exactly the one
 * purgeDiskCache() would otherwise delete.
 * @param {string} discId - CDDB disc id (8 hex digits)
 * @returns {{record: string, mtimeMs: number, file: string}|null} the cache hit, or null on a genuine miss
 */
function readDiskCache(discId) {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.startsWith(`${discId}-`) || !f.endsWith('.txt')) continue;
      const full = path.join(CACHE_DIR, f);
      const { mtimeMs } = fs.statSync(full);
      const record = fs.readFileSync(full, 'utf8');
      const now = Date.now();
      if (now - mtimeMs > CACHE_TTL_MS) {
        // Someone is asking about this exact disc right now - reuse what we
        // have instead of both discarding it and re-hitting gnudb for data
        // that almost certainly hasn't changed. Renewing the mtime also means
        // a purgeDiskCache() sweep racing this read will see it as fresh and
        // leave the file alone instead of deleting it out from under us.
        fs.utimesSync(full, new Date(now), new Date(now));
        log.info(`[cache] renewed: ${f} (was expired - reused instead of a fresh gnudb lookup)`);
        return { record, mtimeMs: now, file: f };
      }
      return { record, mtimeMs, file: f };
    }
  } catch { /* no cache dir / unreadable - treat as a miss */ }
  return null;
}

/**
 * Persists a raw gnudb record to disk under its discId-derived filename.
 * Called by http-server after the response has been sent to the PS3, so the
 * write never delays the reply.
 * @param {string} discId - CDDB disc id (8 hex digits), the stable cache key
 * @param {string} artist - album artist, used only for a human-readable filename
 * @param {string} title - album title, used only for a human-readable filename
 * @param {string} record - raw gnudb record text to cache
 * @returns {void}
 */
function writeDiskCache(discId, artist, title, record) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = path.join(CACHE_DIR, `${cacheFileStem(discId, artist, title)}.txt`);
    fs.writeFileSync(file, String(record), 'utf8');
    const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString().slice(11, 19) + 'Z';
    log.info(`[cache] saved: ${path.basename(file)} (fresh until ${expiresAt})`);
  } catch (e) {
    log.warn(`[cache] write failed: ${e.message}`);
  }
}

/**
 * Derives CDDB query inputs (per-track frame offsets, leadout in seconds,
 * track count) from a parsed PS3 request's TOC.
 * @param {object} req - parsed request; carries either `toc` (decoded) or `tocBytes` (raw)
 * @returns {{frameOffsets: number[], leadoutSeconds: number, nTracks: number}|null} null when the TOC has no tracks
 */
function tocFromRequest(req) {
  const dec = req.toc ?? decodeTocField(req.tocBytes);
  if (!dec || dec.nTracks < 1) return null;
  let acc = 150;
  const frameOffsets = [150];
  for (let i = 2; i < dec.values.length; i++) {   // skip d1 (=0)
    acc += dec.values[i];
    frameOffsets.push(acc);
  }
  const leadoutSeconds = Math.floor(dec.values[0] / 75);
  return { frameOffsets, leadoutSeconds, nTracks: dec.nTracks };
}

/**
 * Fetches and parses one gnudb match into the album shape used throughout.
 * @param {{category: string, id: string}} match - one gnudb query match
 * @param {{frameOffsets: number[], leadoutSeconds: number, nTracks: number}} toc - decoded TOC, used to clip track count
 * @returns {Promise<object|null>} the album, or null when its record has no tracks
 */
async function fetchCandidate(match, toc) {
  const record = await fetchCddbRecord(match.category, match.id);
  const album = parseAlbum(record, 99);
  if (!album.tracks.length) return null;

  const numDiscs = Math.max(1, album.albumDisc || 1);
  if (album.albumDisc > 1) {
    log.info(`[gnudb] disc ${album.albumDisc} parsed from DTITLE - setting numDiscs=${numDiscs}`);
  }
  if (album.tracks.length > toc.nTracks) album.tracks = album.tracks.slice(0, toc.nTracks);

  return {
    title: album.albumTitle,
    artist: album.albumArtist,
    genre: album.albumGenre,
    year: album.albumYear,
    numDiscs,
    discNumber: album.albumDisc || 1, // disc number within the set (from DTITLE heuristic)
    tracks: album.tracks,
    frameOffsets: album.albumFrameOffsets, // gnudb "# Track frame offsets:" (frames)
    leadout: album.albumLeadout, // gnudb "# Leadout:" (frames)
    __gnudbRecord: record, // raw gnudb text - saved next to the response dump
  };
}

/**
 * Runs a live gnudb lookup for a PS3 request: queries by TOC, then fetches
 * every usable match. When gnudb's query answers with several candidates
 * (210/211 - ambiguous TOC), we no longer silently commit to the first one:
 * every usable match is fetched and returned as `candidates`, so the
 * response can carry an ALBUM record per candidate and let the PS3 present a
 * picker instead of guessing.
 * @param {object} req - parsed PS3 request (see tocFromRequest)
 * @returns {Promise<object|null>} the primary album (spread) plus a `candidates` array, or null on no/empty match
 */
async function lookupLive(req) {
  const toc = tocFromRequest(req);
  if (!toc) return null;

  const frameOffsets = toc.frameOffsets;
  const leadoutSeconds = toc.leadoutSeconds;
  const nTracks = Math.min(toc.nTracks, 99);

  const matches = await queryCddbMatches(frameOffsets, nTracks, leadoutSeconds);
  if (!matches.length) {
    log.info(`[gnudb] no match for disc (n=${nTracks})`);
    return null;
  }

  const candidates = [];
  for (const match of matches.slice(0, MAX_MATCHES)) {
    let candidate;
    try {
      candidate = await fetchCandidate(match, toc);
    } catch (e) {
      log.warn(`[gnudb] fetch failed for ${match.category}/${match.id}: ${e.message}`);
      continue;
    }
    if (!candidate) continue;
    log.info(`[gnudb] ${match.category}/${match.id} → "${candidate.title}" - ${candidate.artist} (${candidate.tracks.length} tracks), DYEAR: ${candidate.year || 'NONE in gnudb record'}`);
    candidates.push(candidate);
  }

  if (!candidates.length) {
    log.info('[gnudb] empty record');
    return null;
  }

  if (candidates.length > 1) {
    log.info(`[gnudb] ${candidates.length} candidate albums for this disc - returning all for the user to pick`);
  }

  // primary = first candidate, kept at the top level for existing single-album
  // consumers (logging, disk cache, D/G/T response tags); `candidates` carries
  // every match so the 'A' response tag can emit one ALBUM record each.
  return { ...candidates[0], candidates };
}

/**
 * Resolves the album for a PS3 request, in order: in-memory cache, disk
 * cache, then a live gnudb lookup (deduped across concurrent requests for
 * the same rawToc via `inflight`).
 * @param {object} req - parsed PS3 request; must carry `rawTocHex`
 * @returns {Promise<object|null>} the resolved album, or null when nothing matches
 */
async function findAlbumLive(req) {
  const key = String(req.rawTocHex ?? '').toLowerCase();
  if (!key) return null;

  // Test mode wins over every other source: whatever disc is inserted, answer
  // with the fixed record, only swapping in that disc's own DISCID. A
  // file-backed record is re-read here, so live edits take effect immediately.
  const record = currentTestRecord();
  if (record) {
    const toc = tocFromRequest(req);
    const discId = toc
      ? getDiscId(toc.frameOffsets, toc.nTracks, toc.leadoutSeconds).toString(16).padStart(8, '0')
      : null;
    const served = discId ? withDiscId(record, discId) : record;
    const album = parseAlbum(served, 99);
    const built = {
      title: album.albumTitle,
      artist: album.albumArtist,
      genre: album.albumGenre,
      year: album.albumYear || '',
      numDiscs: Math.max(1, album.albumDisc || 1),
      discNumber: album.albumDisc || 1,
      tracks: album.tracks,
      frameOffsets: album.albumFrameOffsets,
      leadout: album.albumLeadout,
      __gnudbRecord: served,
      __fromTest: true,
      discId,
    };
    log.info(`[test] fixed record for discId=${discId ?? 'unknown'}: "${built.title}" - ${built.artist} (${built.tracks.length} tracks)`);
    return built;
  }

  if (cache.has(key)) {
    const album = cache.get(key);
    log.info(`[cache] memory: "${album.title}" - ${album.artist}`);
    return album;
  }

  purgeDiskCache();

  // stable cache key = CDDB discid (rawTocHex varies between PS3 reads)
  const toc = tocFromRequest(req);
  const discId = toc
    ? getDiscId(toc.frameOffsets, toc.nTracks, toc.leadoutSeconds).toString(16).padStart(8, '0')
    : null;

  const hit = discId ? readDiskCache(discId) : null;
  if (hit) {
    const ageS = Math.round((Date.now() - hit.mtimeMs) / 1000);
    const expiresAt = new Date(hit.mtimeMs + CACHE_TTL_MS).toISOString().slice(11, 19) + 'Z';
    log.info(`[cache] disk: ${hit.file}, age ${ageS}s, fresh until ${expiresAt}`);
    const album = parseAlbum(hit.record, 99);
    const built = {
      title: album.albumTitle,
      artist: album.albumArtist,
      genre: album.albumGenre,
      year: album.albumYear || '',
      numDiscs: Math.max(1, album.albumDisc || 1),
      frameOffsets: album.albumFrameOffsets,
      leadout: album.albumLeadout,
      discNumber: album.albumDisc || 1,
      tracks: album.tracks,
      __gnudbRecord: hit.record,
      __fromCache: true,
    };
    cache.set(key, built);
    return built;
  }

  if (!inflight.has(key)) {
    inflight.set(
      key,
      lookupLive(req)
        .then((album) => {
          if (album) {
            cache.set(key, album);
            // cache write is deferred: http-server calls writeDiskCache
            // after the response frame has been sent to the PS3
            album.__cacheWrite = {
              discId,
              artist: album.artist,
              title: album.title,
              record: album.__gnudbRecord,
            };
          }
          return album;
        })
        .catch((e) => {
          log.warn(`[gnudb] lookup failed: ${e.message}`);
          return null;
        })
        .finally(() => inflight.delete(key)),
    );
  }
  return inflight.get(key);
}

module.exports = { loadAlbums, findAlbumByRawToc, findAlbumLive, lookupLive, writeDiskCache, purgeDiskCache, setTestRecord, setTestRecordFile, isTestMode, loadTestRecordFromEnv };
