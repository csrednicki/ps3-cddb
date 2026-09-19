'use strict';

const { TAGS, writeRecord, writeContainer, writeStr, writeI16, writeI32 } = require('./tlv');

/**
 * String slot encoder: a present value is NUL-terminated, a missing value is an
 * empty (absent) element. The firmware distinguishes "absent" (length 0 -> NULL,
 * which triggers its own fallbacks) from "present but empty" (a lone NUL), so
 * missing album title/artist/genre must be absent rather than NUL (fact 5:
 * an absent album artist makes tracks fall back to "various artist").
 * @param {*} s - value to encode
 * @returns {Buffer} the encoded element, or an empty buffer when falsy
 */
const optStr = (s) => (s ? writeStr(s) : Buffer.alloc(0));

/**
 * u16 seconds encoder for duration slots: clamped to 65535, and an empty
 * (absent) element when the value is missing or non-positive.
 * @param {*} v - duration in seconds
 * @returns {Buffer} the encoded 2-byte element, or an empty buffer when unknown
 */
const optSecs = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? writeI16(Math.min(Math.round(n), 65535)) : Buffer.alloc(0);
};

/**
 * u16 seconds encoder that is always exactly 2 bytes, defaulting to 0 when the
 * value is missing (used where the firmware expects a number rather than an
 * absent element, e.g. the track group's disc length).
 * @param {*} v - duration in seconds
 * @returns {Buffer} the encoded 2-byte element (0 when unknown)
 */
const secs16 = (v) => {
  const n = Number(v);
  return writeI16(Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 65535) : 0);
};

/**
 * Normalizes a release date to "YYYY-MM-DD" and encodes it as a NUL-terminated
 * string, or returns an empty buffer when no usable year is present.
 *
 * The firmware parses album slot 22 by reading digits at string offsets 0, 5
 * and 8 with no length check (fact 6), so a bare year would yield a garbage
 * month/day. gnudb only gives us a year (DYEAR=2000), so a missing month/day
 * defaults to 01-01; a full date is preserved.
 * @param {*} value - a year ("2000"), a full date ("2000-05-12"), or nothing
 * @returns {Buffer} the encoded date, or an empty (absent) buffer when unknown
 */
function dateField(value) {
  const m = String(value ?? '').match(/(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/);
  if (!m || Number(m[1]) < 1) return Buffer.alloc(0);
  const pad = (n) => String(n).padStart(2, '0');
  const mm = Math.min(Math.max(Number(m[2] ?? 1), 1), 12);
  const dd = Math.min(Math.max(Number(m[3] ?? 1), 1), 31);
  return writeStr(`${m[1]}-${pad(mm)}-${pad(dd)}`);
}

/**
 * Track lengths in frames derived from gnudb's "# Track frame offsets:" list and
 * "# Leadout:" (each length is the gap to the next offset; the last is
 * leadout - last offset). Returns null when the record carries no usable offsets.
 * @param {number[]} [frameOffsets] - gnudb track frame offsets
 * @param {number|null} [leadout] - gnudb leadout (frames)
 * @returns {number[]|null} per-track lengths in frames, or null when unavailable
 */
function gnudbTrackLengths(frameOffsets, leadout) {
  if (!Array.isArray(frameOffsets) || frameOffsets.length === 0) return null;
  if (!Number.isFinite(leadout) || leadout <= frameOffsets[frameOffsets.length - 1]) return null;
  const lens = [];
  for (let i = 0; i < frameOffsets.length - 1; i++) lens.push(frameOffsets[i + 1] - frameOffsets[i]);
  lens.push(leadout - frameOffsets[frameOffsets.length - 1]);
  return lens;
}

/**
 * Finds where the disc's audio track lengths start inside gnudb's track lengths.
 *
 * Matching lengths (rather than offsets) avoids the LBA vs LBA+150 ambiguity of
 * comparing gnudb offsets with the request's START. The last audio track is
 * excluded from the comparison because it may carry the hidden-track gap, so a
 * return of 1 means a leading data track (mixed-mode CD) that must be skipped.
 * @param {number[]} [ps3Lens] - audio track lengths from the PS3 TOC (frames)
 * @param {number[]} [gnuLens] - gnudb track lengths (frames)
 * @param {number} [tol] - allowed difference per track (frames)
 * @returns {number} the index to start at (0 when unknown or already aligned)
 */
function alignOffset(ps3Lens, gnuLens, tol = 75) {
  if (!Array.isArray(ps3Lens) || !Array.isArray(gnuLens) || !ps3Lens.length || !gnuLens.length) return 0;
  const n = ps3Lens.length - 1;
  for (let k = 0; k + n <= gnuLens.length; k++) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (Math.abs(ps3Lens[i] - gnuLens[k + i]) > tol) { ok = false; break; }
    }
    if (ok) return k;
  }
  return 0;
}

/**
 * Aligns the album's track list with the disc actually in the drive.
 *
 * The console's TOC already skips a leading data track (mixed-mode CDs) and
 * stops at a data track that follows audio (enhanced CDs), so its track count is
 * the number of audio tracks. `k` (from alignOffset) drops any leading gnudb
 * track that has no counterpart on the disc; the list is then truncated to the
 * audio track count.
 * @param {Array<object>} tracks - album tracks
 * @param {number} k - number of leading tracks to drop
 * @param {{audioTrackCount?: number, trackLengths?: number[]}} [toc] - decoded PS3 TOC info
 * @returns {Array<object>} the aligned track list
 */
function alignTracks(tracks, k, toc) {
  let out = k > 0 ? tracks.slice(k) : tracks;
  const n = Number(toc?.audioTrackCount);
  if (Number.isFinite(n) && n > 0 && out.length > n) out = out.slice(0, n);
  return out;
}

/**
 * Whether the album is a compilation. The firmware only shows per-track artists
 * (track slot 6, sub-string 1) when the album is flagged as a compilation
 * (fact 4); the flag is album slot 3 starting with "VA", which also makes the
 * console relabel the album-level artist as the literal "various artist".
 *
 * To avoid flagging a normal album that merely has one duet ("Queen & David
 * Bowie"), artists are compared case/whitespace-insensitively and the flag is
 * set only when the album artist is "various ..." or at least half of ALL
 * tracks credit a different artist.
 * @param {string} albumArtist - album-level artist
 * @param {Array<object>} tracks - album tracks
 * @returns {boolean} true when the compilation flag applies
 */
function isCompilation(albumArtist, tracks) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const albumNorm = norm(albumArtist);
  if (/^various/.test(albumNorm)) return true;
  if (!tracks.length) return false;
  const different = tracks.filter((t) => t && t.artist && norm(t.artist) !== albumNorm).length;
  return different * 2 >= tracks.length;
}

/**
 * Builds the container payload for one TRACK record.
 * @param {{title: string, artist?: string, duration?: number}} t - track data; `duration` is in seconds
 * @returns {Buffer} the encoded track container (17 slots)
 */
function trackRecord(t) {
  const parts = writeContainer([
    writeStr(t.title ?? ''), // sub-string 0: unused by the firmware (not a title)
    writeStr(t.artist ?? ''), // sub-string 1: per-track artist (compilations only)
    writeStr(''), // unused
    writeStr(''), // unused
  ]);
  const partsList = writeContainer([parts]);

  const fields = new Array(17).fill(Buffer.alloc(0));
  fields[1] = writeStr(t.title ?? '');
  fields[3] = optSecs(t.duration); // track length [s] (absent when unknown)
  fields[6] = partsList;
  fields[15] = writeI16(0); // MANDATORY: must be exactly 2 bytes
  fields[16] = writeI16(0); // MANDATORY: must be exactly 2 bytes
  return writeContainer(fields);
}

/**
 * Builds the 30-slot container payload for one ALBUM record, including its
 * nested track list.
 * @param {object} album - album data: title, artist, genre (or genres[0].main), year, numDiscs, discNumber, tracks, totalDuration, frameOffsets, leadout
 * @param {{audioTrackCount?: number, trackLengths?: number[]}} [toc] - optional decoded PS3 TOC, used to align the track list
 * @returns {Buffer} the encoded album container
 */
function albumRecord(album, toc) {
  // Derive per-track lengths (frames) from the gnudb offsets, falling back to the
  // TOC's own lengths (which the console sends anyway). Used both to detect a
  // leading data track and to fill the duration slots.
  const gnuLens = gnudbTrackLengths(album.frameOffsets, album.leadout);
  const ps3Lens = Array.isArray(toc?.trackLengths) && toc.trackLengths.length ? toc.trackLengths : null;
  const k = alignOffset(ps3Lens, gnuLens);
  const tracks = alignTracks(album.tracks ?? [], k, toc);
  const trackCount = Math.min(tracks.length, 99);
  const numDiscs = Math.max(1, Math.min(album.numDiscs ?? 1, 99));
  const discNumber = Math.max(1, Math.min(album.discNumber ?? 1, numDiscs));
  const albumArtist = album.artist ?? '';
  const albumTitle = album.title ?? '';
  const albumGenre = album.genre ?? album.genres?.[0]?.main ?? '';
  const compilation = isCompilation(albumArtist, tracks);

  // Resolve each track's duration (seconds) before encoding: gnudb's own track
  // length (after the alignment shift), else the TOC length, else the album
  // data's own duration.
  const resolved = tracks.slice(0, trackCount).map((t, i) => {
    const frames = gnuLens?.[k + i] ?? ps3Lens?.[i];
    const duration = Number(t.duration) > 0 ? Number(t.duration) : (frames != null ? frames / 75 : undefined);
    return { title: t.title, artist: t.artist || albumArtist, duration };
  });

  const trackFields = resolved.map((t) => trackRecord(t));

  // Disc length [s]: the album total when known, otherwise the sum of the
  // per-track durations. Left unknown -> 0 in the group element.
  const trackSeconds = resolved.reduce((s, t) => s + (Number(t.duration) > 0 ? Number(t.duration) : 0), 0);
  const albumSeconds = Number(album.totalDuration) > 0 ? Number(album.totalDuration) : trackSeconds;

  // Track group: [trackList, disc number, disc length [s]] - element 2 is the
  // disc length in seconds, NOT a track count (fact 9); 0 when unknown. Only
  // group [0] is used.
  const albumTracks = writeContainer([writeContainer(trackFields), writeI16(discNumber), secs16(albumSeconds)]);

  const fields = buildFieldsObject();

  fields[1] = optStr(albumTitle); // album title
  // Compilation flag: slot 3 starting with "VA" makes the firmware show the
  // per-track artists and relabel the album artist as "various artist".
  fields[3] = compilation ? writeStr('VA') : Buffer.alloc(0);
  fields[4] = optStr(albumArtist); // album artist
  fields[6] = writeI16(trackCount); // unused by the firmware (kept for compatibility)
  fields[7] = writeI16(discNumber); // unused by the firmware (kept for compatibility)
  fields[8] = optStr(albumGenre); // genre (the console also fills this when uploading)
  fields[9] = optStr(albumGenre); // genre
  fields[11] = writeI16(numDiscs); // total discs in set
  fields[15] = writeContainer([albumTracks]); // tracks group (one group only)
  fields[22] = dateField(album.year); // release date "YYYY-MM-DD"
  fields[23] = optSecs(albumSeconds); // album length [s] (absent when unknown)
  fields[28] = writeI16(0); // language code: 0 = none; MANDATORY exactly 2 bytes
  // Acceptance threshold for a single result: > 6, otherwise the console reports
  // NO_DATASET. MANDATORY exactly 2 bytes.
  fields[29] = writeI16(7);

  return writeContainer(fields);
}

/**
 * Error record 'E' - used when there is no match. A body made only of a
 * non-'A' record makes the SDK report 0 results, which the console maps to
 * NO_DATASET (a clean "no match"); an empty body instead is a parse error and
 * records no status at all (fact 2).
 * @param {number} code - error code (u32)
 * @param {string} [message] - human-readable message
 * @returns {Buffer} the encoded error container
 */
function errorRecord(code, message) {
  return writeContainer([writeI32(code), writeStr(message ?? '')]);
}

/**
 * Builds the full TLV response body for a PS3 request. Only 'A' (ALBUM) records
 * are ever emitted: any other record type makes the SDK report 0 results for
 * the whole response (fact 1). A single 'A' record is accepted only when album
 * slot 29 > 6 (fact 3).
 * @param {object} [opts]
 * @param {object|null} [opts.album] - resolved album (may carry `candidates` for multiple ALBUM records)
 * @param {{code: number, message?: string}|null} [opts.error] - error to report instead of an album
 * @param {{audioTrackCount?: number, trackLengths?: number[]}} [opts.toc] - decoded PS3 TOC, used to align tracks
 * @returns {Buffer} the encoded response body: 'A' records, or exactly one 'E' record when there is no match
 */
function buildResponse({ album = null, error = null, toc = null } = {}) {
  if (error) {
    return writeRecord(TAGS.ERROR, errorRecord(error.code, error.message));
  }
  if (!album) {
    // No match: answer with a single 'E' record so the console records
    // NO_DATASET instead of a bodyless parse error (fact 2).
    return writeRecord(TAGS.ERROR, errorRecord(0, 'no match'));
  }

  // An ambiguous gnudb query can return several candidates; one 'A' record per
  // candidate lets the PS3 present a picklist. The console stores candidate
  // pointers in a fixed-size stack array, so never exceed 10 records (fact 3).
  const list = (album.candidates?.length ? album.candidates : [album]).slice(0, 10);
  return Buffer.concat(list.map((a) => writeRecord(TAGS.ALBUM, albumRecord(a, toc))));
}

/**
 * Builds the 30-slot fields array used as a base for album responses.
 * An empty Buffer marks a slot as absent (safe default); a bare NUL (from
 * `writeStr('')`) marks it as present but an empty string. Slots 10, 13, 14,
 * 16, 17, 18, 21, 24 and 25 are containers/lists and are left absent: writing a
 * raw string there makes the firmware read the string's first byte as an
 * element count and locks the console (fact 8).
 * @returns {Buffer[]} Array of 30 buffers, one per field slot
 */
function buildFieldsObject() {
  const emptyStringSlots = new Set([0, 2, 5, 12, 19, 20, 26, 27]);

  return Array.from({ length: 30 }, (_, i) =>
    emptyStringSlots.has(i) ? writeStr('') : Buffer.alloc(0)
  );
}

module.exports = {
  albumRecord,
  trackRecord,
  errorRecord,
  buildResponse,
};
