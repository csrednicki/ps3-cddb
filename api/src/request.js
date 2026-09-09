'use strict';

const { parseBinHeader, HEADER_SIZE } = require('./bin-header');
const { decodeTocField, tocKey } = require('./toc');

/**
 * Prints a debug line, gated on the DEBUG env var (kept separate from ./logger
 * since this module is also used by standalone tools).
 * @param {string} msg - message to print
 * @returns {void}
 */
function logDebug(msg) {
  if (process.env.DEBUG) console.log(`[sdk] ${msg}`);
}

/**
 * Parses a PS3 "BIN " request body: the fixed header, the DISCID record tag,
 * and the raw TOC field. Only the DISCID record type is understood.
 * @param {Buffer} body - full POST body (after multipart extraction)
 * @returns {object} parsed request: `header`, `type`, `rawTocHex`, `tocBytes`, `toc` (best-effort), plus framing fields (`prefix`, `trailer`, `blob`)
 * @throws {Error} when the body is too short, the header marker is wrong, or the record tag isn't DISCID
 */
function parseRequest(body) {
  const header = parseBinHeader(body);

  if (body.length < 0x50) throw new Error('body too short');

  // Header length marker (LE32 = 0x34) - structure confirmation
  const marker = body.readUInt32LE(0x34);
  if (marker !== HEADER_SIZE) {
    logDebug(`unexpected header marker: 0x${marker.toString(16)}`);
  }

  const recTag = body[0x38];
  const REC_TAG_DISCID = 0x54;
  
  if (recTag !== REC_TAG_DISCID) {
    throw new Error(`unknown record tag 0x${recTag.toString(16)} (only DISCID supported)`);
  }

  // TOC field: fixed position 0x50, length 0x2C (confirmed by the dump)
  const tocStart = 0x50;
  const tocEnd = 0x7c;
  const tocBytes = body.subarray(tocStart, tocEnd);
  const trailerStart = tocEnd + 4;
  const trailer = body.subarray(trailerStart, body.length - 4);
  const prefix = body.subarray(0, tocEnd);

  const req = {
    header,
    type: 'discid',
    rawTocHex: tocBytes.toString('hex'),
    tocBytes,
    prefix,
    trailer,
    blob: body.subarray(tocEnd, trailerStart),
  };

  try {
    const decoded = decodeTocField(tocBytes);
    req.toc = decoded;
    req.tocKey = tocKey(decoded.nTracks, decoded.values);
  } catch {
    // decoding may fail for other variants - not critical
  }

  return req;
}

module.exports = { parseRequest };
