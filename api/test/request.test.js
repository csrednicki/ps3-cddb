'use strict';

/**
 * Coverage of sdk/request.js - parseRequest (logDebug, marker, TOC decoding).
 * Builds a synthetic request body, including variants triggering errors and
 * the DEBUG path (logDebug).
 */

const { buildBinHeader } = require('../src/bin-header');
const { encodeTocField } = require('../src/toc');

jest.mock('../src/consoles', () => ({
  getLastConsoleMac: () => '001122334455',
}));
jest.mock('../src/logger', () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { parseRequest } = require('../src/request');

/**
 * Builds a full 132-byte DISCID request body.
 * @param {object} [opts]
 * @param {number} [opts.nTracks=2] - track count to encode into the TOC
 * @param {Buffer} [opts.tocBytes] - explicit TOC field bytes (overrides nTracks-based encoding)
 * @param {number} [opts.marker=0x34] - header-length marker to write at 0x34
 * @param {number} [opts.recTag=0x54] - record tag byte at 0x38
 * @param {Buffer} [opts.trailer] - trailer bytes to copy at 0x7c
 * @returns {Buffer} the synthetic request body
 */
function buildFullBody(opts = {}) {
  const header = buildBinHeader({ secret: '001122334455' });
  const nTracks = opts.nTracks ?? 2;
  const toc = opts.tocBytes ?? encodeTocField(nTracks, 30000, [1000, 3000]);
  const body = Buffer.alloc(0x80 + 4); // up to 0x83 (closer)
  header.copy(body, 0);
  body.writeUInt32LE(opts.marker ?? 0x34, 0x34);
  body[0x38] = opts.recTag ?? 0x54;
  toc.copy(body, 0x50);
  if (opts.trailer) opts.trailer.copy(body, 0x7c);
  return body;
}

describe('parseRequest - valid packet', () => {
  it('should return the discid type with rawTocHex, tocBytes, prefix and blob', () => {
    const body = buildFullBody();
    const req = parseRequest(body);
    expect(req.type).toBe('discid');
    expect(req.rawTocHex).toHaveLength(44 * 2); // 44 B of TOC field
    expect(req.tocBytes.length).toBe(44);
    expect(req.prefix.length).toBe(0x7c);
    expect(req.header.transformSelector).toBeDefined();
    expect(req.blob.length).toBe(4); // 0x7c..0x80
  });

  it('should decode the TOC field and build the tocKey', () => {
    const body = buildFullBody();
    const req = parseRequest(body);
    expect(req.toc).not.toBeUndefined();
    expect(req.toc.nTracks).toBe(2);
    expect(req.tocKey.startsWith('2-')).toBe(true);
  });
});

describe('parseRequest - error paths and edges', () => {
  it('should throw "body too short" when the body is below 0x50 but has valid magic', () => {
    // body 0x34..0x4F (>= HEADER_SIZE=0x34, < 0x50) with a valid "BIN " - skips the
    // magic error (thrown in buildBinHeader for <0x34) and hits "body too short".
    const header = buildBinHeader({ secret: '001122334455' });
    const body = Buffer.alloc(0x40);
    header.copy(body, 0);
    expect(() => parseRequest(body)).toThrow('body too short');
  });

  it('should throw for an unknown record tag', () => {
    const body = buildFullBody({ recTag: 0x23 });
    expect(() => parseRequest(body)).toThrow(/unknown record tag/);
  });

  it('should not log a debug message when DEBUG is unset (logDebug branch)', () => {
    delete process.env.DEBUG;
    const body = buildFullBody({ marker: 0x1234 });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const req = parseRequest(body);
      expect(console.log).not.toHaveBeenCalled();
      expect(req.rawTocHex).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('should log a debug message when the header length marker is unexpected and DEBUG=1', () => {
    process.env.DEBUG = '1';
    const body = buildFullBody({ marker: 0x1234 });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const req = parseRequest(body);
      expect(console.log).toHaveBeenCalled();
      expect(req.rawTocHex).toBeTruthy();
    } finally {
      spy.mockRestore();
      delete process.env.DEBUG;
    }
  });
});