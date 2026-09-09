'use strict';

const { TAGS, writeRecord, writeContainer, writeStr, writeYear, writeI16, writeI32 } = require('./tlv');

/**
 * Builds the container payload for one TRACK record.
 * @param {{title: string, artist?: string}} t - track title and (optional) artist
 * @returns {Buffer} the encoded track container
 */
function trackRecord(t) {
  const parts = writeContainer([
    writeStr(t.title), // title
    writeStr(t.artist ?? ''), // artist
    writeStr(''), // unknown
    writeStr(''), // unknown
  ]);
  const partsList = writeContainer([parts]);

  const fields = new Array(17).fill(Buffer.alloc(0));
  fields[1] = writeStr(t.title);
  fields[6] = partsList;
  fields[15] = writeI16(0); // MANDATORY
  fields[16] = writeI16(0); // MANDATORY
  return writeContainer(fields);
}

/**
 * Builds the 30-slot container payload for one ALBUM record, including its
 * nested track list.
 * @param {object} album - album data: title, artist, genre (or genres[0].main), year, numDiscs, discNumber, tracks
 * @returns {Buffer} the encoded album container
 */
function albumRecord(album) {
  const trackCount = Math.min(album.tracks?.length ?? 0, 99);
  const numDiscs = Math.max(1, Math.min(album.numDiscs ?? 1, 99));
  const discNumber = Math.max(1, Math.min(album.discNumber ?? 1, numDiscs));
  const albumArtist = album.artist ?? '';
  const albumTitle = album.title ?? '';
  const albumGenre = album.genre ?? album.genres?.[0]?.main ?? '';
  const albumYear = album.year;

  const trackFields = [];
  
  for (let i = 0; i < trackCount; i++) {
    trackFields.push(trackRecord({
      title: album.tracks[i].title,
      artist: album.tracks[i].artist ?? ''
    }));
  }
  const albumTracks = writeContainer([writeContainer(trackFields), writeI16(discNumber), writeI16(trackCount)]);

  // 30 slots; an empty Buffer = "absent" (safe), a bare NUL = "empty string"
  const af = new Array(30).fill(Buffer.alloc(0));
  for (const s of [0, 2, 3, 5, 8, 12, 19, 20, 26, 27]) af[s] = writeStr('');
  af[1] = writeStr(albumTitle); // album title
  af[4] = writeStr(albumArtist); // album artist
  af[6] = writeI16(trackCount); // album track count
  af[7] = writeI16(discNumber); // disc number within set
  af[9] = writeStr(albumGenre); // album genre
  af[11] = writeI16(numDiscs); // total discs in set
  af[15] = writeContainer([albumTracks]); // tracks group (tracklist, disc number, track count)
  af[22] = writeYear(albumYear); // album year
  af[28] = writeI16(0); // mandatory i16 (unknown)
  af[29] = writeI16(7); // mandatory i16 (track view > 6, otherwise the PS3 plugin ignores the tracks)

  return writeContainer(af);
}

/**
 * Error record 'E' - used when there is no match (the console handles it cleanly).
 * @param {number} code - error code (u32)
 * @param {string} [message] - human-readable message
 * @returns {Buffer} the encoded error container
 */
function errorRecord(code, message) {
  return writeContainer([writeI32(code), writeStr(message ?? '')]);
}

/**
 * Builds the full TLV response body for a PS3 request: an error record when
 * given, otherwise one or more record types selected by the RESPONSE_FORMAT
 * env var (default 'A'), built from `album`.
 * @param {object} [opts]
 * @param {object|null} [opts.album] - resolved album (may carry `candidates` for multiple ALBUM records)
 * @param {{code: number, message?: string}|null} [opts.error] - error to report instead of an album
 * @returns {Buffer} the encoded response body (empty when neither album nor error is given)
 */
function buildResponse({ album = null, error = null } = {}) {
  const out = [];
  if (error) {
    out.push(writeRecord(TAGS.ERROR, errorRecord(error.code, error.message)));
    return Buffer.concat(out);
  }
  if (!album) return Buffer.alloc(0);

  const builders = {
    // A gnudb query can come back with several ambiguous candidates - one
    // ALBUM record per candidate lets the PS3 present them as a picklist
    // instead of us silently guessing the first one.
    A: () => {
      const list = album.candidates?.length ? album.candidates : [album];
      return Buffer.concat(list.map((a) => writeRecord(TAGS.ALBUM, albumRecord(a))));
    },
    D: () => writeRecord(TAGS.DISC, writeContainer([writeStr(album.title ?? '')])),
    G: () => writeRecord(TAGS.GENRE, writeContainer([writeStr(album.genre ?? album.genres?.[0]?.main ?? '')])),
    T: () => Buffer.concat((album.tracks ?? []).map((t) => writeRecord(TAGS.TRACK, trackRecord(t)))),
  };
  const fmt = (process.env.RESPONSE_FORMAT ?? 'A').toUpperCase().trim();
  const tags = fmt.split(',').map((s) => s.trim()).filter((s) => builders[s]);
  if (!tags.length) tags.push('A');
  for (const t of tags) out.push(builders[t]());
  return Buffer.concat(out);
}

module.exports = { albumRecord, trackRecord, errorRecord, buildResponse };
