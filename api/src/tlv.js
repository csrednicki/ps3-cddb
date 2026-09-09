'use strict';

const TAGS = {
  ALBUM: 0x41, // 'A'
  TRACK: 0x54, // 'T'
  DISC: 0x44,  // 'D'
  GENRE: 0x47, // 'G'
  ERROR: 0x45, // 'E'
};

/**
 * Outer record: [tag][len u32 LE][payload].
 * @param {number} tag - one-byte record tag (see TAGS)
 * @param {Buffer} payload - record payload (typically a container)
 * @returns {Buffer} the encoded record
 */
function writeRecord(tag, payload) {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = tag;
  out.writeUInt32LE(payload.length, 1);
  payload.copy(out, 5);
  return out;
}

/**
 * Outer-record reader (LE) - for tests and tools.
 * @param {Buffer} buf - buffer containing zero or more concatenated records
 * @returns {Array<{tag: number, payload: Buffer}>} the decoded records
 * @throws {Error} on a truncated record or trailing bytes that don't form a full record
 */
function readRecords(buf) {
  const records = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const tag = buf[pos];
    const len = buf.readUInt32LE(pos + 1);
    if (pos + 5 + len > buf.length) throw new Error(`truncated record at ${pos}`);
    records.push({ tag, payload: buf.subarray(pos + 5, pos + 5 + len) });
    pos += 5 + len;
  }
  if (pos !== buf.length) throw new Error('trailing garbage after records');
  return records;
}

/**
 * Container like emitContainer(): [count][(count+1) u32 LE offsets][data].
 * @param {Buffer[]} values - positional values (index = slot); 0-byte = absent
 * @returns {Buffer} the encoded container
 */
function writeContainer(values) {
  const n = values.length;
  const header = 1 + (n + 1) * 4;
  let dataLen = 0;
  for (const v of values) dataLen += v.length;
  const out = Buffer.alloc(header + dataLen);
  out[0] = n;
  let off = header;
  out.writeUInt32LE(off, 1); // offset[0]
  let w = header;
  for (let i = 0; i < n; i++) {
    off += values[i].length;
    out.writeUInt32LE(off, 1 + (i + 1) * 4);
    values[i].copy(out, w);
    w += values[i].length;
  }
  return out;
}

/**
 * Container reader - returns an array of values (Buffer[]) according to the offsets.
 * @param {Buffer} buf - encoded container
 * @returns {Buffer[]} decoded slot values (an empty Buffer for any slot with invalid/absent offsets)
 */
function readContainer(buf) {
  if (buf.length < 1) return [];
  const n = buf[0];
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = buf.readUInt32LE(1 + i * 4);
    const e = buf.readUInt32LE(1 + (i + 1) * 4);
    if (s > buf.length || e > buf.length || e < s) { out.push(Buffer.alloc(0)); continue; }
    out.push(buf.subarray(s, e));
  }
  return out;
}

/**
 * NUL-terminated string (emitStr): length = strlen+1; empty string = 1 NUL byte.
 * @param {*} s - value to stringify and encode (null/undefined become an empty string)
 * @returns {Buffer} the UTF-8, NUL-terminated bytes
 */
function writeStr(s) {
  return Buffer.from(`${s ?? ''}\0`, 'utf8');
}

/**
 * Encodes a year as plain ASCII digits, no NUL terminator (matches PS3 ground-truth captures).
 * @param {*} year - value to stringify (null/undefined become "0")
 * @returns {Buffer} the ASCII-encoded year
 */
function writeYear(year) {
  return Buffer.from(`${year ?? '0'}`, 'ascii');
}

/**
 * u16 LE (emitI16).
 * @param {number} v - value to encode (masked to 16 bits)
 * @returns {Buffer} 2-byte little-endian buffer
 */
function writeI16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff, 0);
  return b;
}

/**
 * u32 LE (emitI32).
 * @param {number} v - value to encode (coerced to an unsigned 32-bit int)
 * @returns {Buffer} 4-byte little-endian buffer
 */
function writeI32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

module.exports = {
  TAGS,
  writeRecord,
  readRecords,
  writeContainer,
  readContainer,
  writeStr,
  writeI16,
  writeI32,
  writeYear
};
