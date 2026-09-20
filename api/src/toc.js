'use strict';

const DIGIT_BASE = 0xdf; // 223
const DIGIT_OFFSET = 0x21;
const B2 = DIGIT_BASE * DIGIT_BASE; // 0xC241 = 49697
const TWO_DIGIT_MAX = 0xc161; // 49569 - the largest value encoded with 2 digits

/**
 * Encodes one TOC value as 2, 3 or 4 base-223 "digits" (each offset by
 * DIGIT_OFFSET so the byte range stays printable), matching the PS3's
 * on-the-wire TOC field encoding.
 * @param {Buffer} buf - destination buffer
 * @param {number} off - byte offset in `buf` to write at
 * @param {number} value - value to encode
 * @param {number} threeDigitFlag - non-zero forces the fixed 3-digit form (used for the leadout)
 * @returns {number} number of bytes written (2, 3 or 4)
 */
function encodeValue(buf, off, value, threeDigitFlag) {
  const v = value;
  const d0 = Math.floor(v / B2) + DIGIT_OFFSET;
  const d1 = (Math.floor(v / DIGIT_BASE) % DIGIT_BASE) + DIGIT_OFFSET;
  const d2 = (v % DIGIT_BASE) + DIGIT_OFFSET;
  if (threeDigitFlag !== 0) {
    buf[off] = d0; buf[off + 1] = d1; buf[off + 2] = d2;
    return 3;
  }
  if (v > TWO_DIGIT_MAX) {
    buf[off] = 0xff;
    buf[off + 1] = d0; buf[off + 2] = d1; buf[off + 3] = d2;
    return 4;
  }
  buf[off] = d1; buf[off + 1] = d2;
  return 2;
}

/**
 * Number of bytes encodeValue() would write for `value` without actually encoding it.
 * @param {number} value - value that would be encoded
 * @param {number} threeDigitFlag - non-zero forces the fixed 3-digit form
 * @returns {number} 2, 3 or 4
 */
function encodedSize(value, threeDigitFlag) {
  if (threeDigitFlag !== 0) return 3;
  return value > TWO_DIGIT_MAX ? 4 : 2;
}

/**
 * Builds a full TOC field: track count byte, then the END (fixed 3 digits),
 * START and each track's length. Mirrors the PS3's wire format - mainly used by
 * tests to construct requests without a real disc.
 * @param {number} nTracks - number of audio tracks on the disc
 * @param {number} leadOut - END position (frames)
 * @param {number[]} lengths - per-track lengths (frames)
 * @param {number} [start=0] - START (first track position, frames)
 * @returns {Buffer} the encoded TOC field
 */
function encodeTocField(nTracks, leadOut, lengths, start = 0) {
  const values = [start, ...lengths];
  const sizes = 1 + 3 + values.reduce((s, o) => s + encodedSize(o, 0), 0);
  const buf = Buffer.alloc(sizes);
  let pos = 0;
  buf[pos++] = nTracks + DIGIT_OFFSET;
  pos += encodeValue(buf, pos, leadOut, 1);
  for (const o of values) {
    pos += encodeValue(buf, pos, o, 0);
  }
  return buf;
}

/**
 * Decodes a raw PS3 TOC field into the track count and a values array.
 *
 * Layout: `[N][END: 3 digits][START][L_1]…[L_N]`, i.e. END followed by
 * nTracks+1 values (START plus one length per audio track). `values` therefore
 * has nTracks+2 entries: values[0] = END (lead-out), values[1] = START,
 * values[2..] = per-track lengths. The END field is always exactly 3 digits.
 * The byte budget ends the loop early for a truncated field.
 * @param {Buffer} buf - raw TOC field bytes from the request
 * @returns {{nTracks: number, values: number[]}} decoded TOC
 * @throws {Error} when `buf` is too short to contain the track count or lead-out
 */
function decodeTocField(buf) {
  if (buf.length < 1) throw new Error('TOC field too short');
  const nTracks = buf[0] - DIGIT_OFFSET;
  if (nTracks < 0) throw new Error('invalid track count');
  let pos = 1;
  if (pos + 3 > buf.length) throw new Error('TOC field too short');

  const leadOut =
    (buf[pos] - DIGIT_OFFSET) * B2 +
    (buf[pos + 1] - DIGIT_OFFSET) * DIGIT_BASE +
    (buf[pos + 2] - DIGIT_OFFSET);
  pos += 3;

  const values = [leadOut];
  for (let t = 0; t <= nTracks; t++) {
    if (pos + 2 > buf.length) break;
    if (buf[pos] === 0xff) {
      if (pos + 4 > buf.length) break;
      values.push(
        (buf[pos + 1] - DIGIT_OFFSET) * B2 +
          (buf[pos + 2] - DIGIT_OFFSET) * DIGIT_BASE +
          (buf[pos + 3] - DIGIT_OFFSET),
      );
      pos += 4;
    } else {
      values.push(
        (buf[pos] - DIGIT_OFFSET) * DIGIT_BASE + (buf[pos + 1] - DIGIT_OFFSET),
      );
      pos += 2;
    }
  }
  return { nTracks, values };
}

/**
 * Total byte size a TOC field built from these values would occupy, without building it.
 * @param {number} nTracks - number of audio tracks on the disc
 * @param {number} leadOut - END position (frames)
 * @param {number[]} lengths - per-track lengths (frames)
 * @param {number} [start=0] - START (first track position, frames)
 * @returns {number} total encoded size in bytes
 */
function tocFieldSize(nTracks, leadOut, lengths, start = 0) {
  return (
    1 +
    3 +
    [start, ...lengths].reduce((s, o) => s + encodedSize(o, 0), 0)
  );
}

/**
 * Builds a stable string key from a decoded TOC, suitable for use as a Map/index key.
 * @param {number} nTracks - number of tracks on the disc
 * @param {number[]} values - decoded TOC values (leadout + per-track offsets)
 * @returns {string} dash-joined key, e.g. "2-16000-1000-2000"
 */
function tocKey(nTracks, values) {
  return [nTracks, ...values].join('-');
}

module.exports = {
  encodeTocField,
  decodeTocField,
  encodeValue,
  encodedSize,
  tocFieldSize,
  tocKey,
  DIGIT_BASE,
  DIGIT_OFFSET,
  B2,
  TWO_DIGIT_MAX,
};
