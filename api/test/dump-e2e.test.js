'use strict';

const path = require('node:path');
const { buildBinHeader } = require('../src/bin-header');
const { parseRequest } = require('../src/request');
const { readRecords, TAGS, readContainer } = require('../src/tlv');
const { buildResponse } = require('../src/records');
const { findAlbumByRawToc, loadAlbums } = require('../src/albums');
const SEED_DIR = path.join(__dirname, 'seed');

// Kept identical to sample-album.json's rawTocKeys so this exercises the real
// request-parsing path against a seed album; it's an opaque disc identifier,
// not personal data.
const RAW_TOC_HEX =
  '2c257b792121745685c4723e6fa4748b6ff78c867a54836f783c7f3d000000003115f34a20b0ed4962b93561';

/**
 * Builds a synthetic 132-byte "BIN " DISCID packet with the same byte layout
 * as a real PS3 request (see src/bin-header.js and src/request.js), using a
 * fixture MAC/TOC instead of a captured console dump.
 * @returns {Buffer} the synthetic request body
 */
function buildFixtureDump() {
  const header = buildBinHeader({
    secret: '001122334455',
    user: 'AMG Test User',
    transformSelector: 3,
    integritySelector: 3,
    variant: 'H',
    flag: 'S',
  });
  const body = Buffer.alloc(0x84);
  header.copy(body, 0);
  body.writeUInt32LE(0x34, 0x34);
  body[0x38] = 0x54; // DISCID record tag
  body[0x39] = 4; // capabilities type
  Buffer.from(RAW_TOC_HEX, 'hex').copy(body, 0x50);
  body.write('\r\n--', 0x80, 'latin1');
  return body;
}

describe('Synthetic PS3 request packet (fixture, no captured console dump)', () => {
  let body;
  let req;
  beforeAll(() => {
    body = buildFixtureDump();
    req = parseRequest(body);
  });

  it('should be a 132-byte "BIN " packet', () => {
    expect(body.length).toBe(132);
    expect(body.subarray(0, 4).toString('latin1')).toBe('BIN ');
  });

  it('should carry the fixture MAC, AMG user, selectors 3/3, variant H and flag S in the header', () => {
    const h = req.header;
    expect(h.secret.subarray(0, 12).toString('latin1')).toBe('001122334455');
    expect(h.user.subarray(0, 13).toString('latin1')).toBe('AMG Test User');
    expect(h.integritySelector).toBe(3);
    expect(h.transformSelector).toBe(3);
    expect(h.variant).toBe('H');
    expect(h.flag).toBe('S');
  });

  it('should store the header length marker 0x34 as LE32 at offset 0x34', () => {
    expect(body.readUInt32LE(0x34)).toBe(0x34);
  });

  it('should start with the DISCID record tag 0x54 followed by capabilities type 4', () => {
    expect(body[0x38]).toBe(0x54);
    expect(body[0x39]).toBe(4);
  });

  it('should contain the 44-byte TOC field at offsets 0x50..0x7B', () => {
    expect(req.tocBytes.length).toBe(44);
    expect(req.rawTocHex).toBe(RAW_TOC_HEX);
  });

  it('should end with the multipart closing marker \r\n--', () => {
    expect(body.subarray(0x80, 0x84).toString('latin1')).toBe('\r\n--');
  });
});

describe('Sample album disc match (raw TOC from the fixture packet)', () => {
  beforeAll(() => loadAlbums(SEED_DIR));

  it('should match the raw fixture TOC to the sample seed album with 11 tracks', () => {
    const album = findAlbumByRawToc(RAW_TOC_HEX);
    expect(album).not.toBeNull();
    expect(album.title).toBe('Sample Sounds');
    expect(album.artist).toBe('Test Artist');
    expect(album.tracks.length).toBe(11);
  });

  it('should produce a single ALBUM record with the correct title and artist slots for the fixture', () => {
    const album = findAlbumByRawToc(RAW_TOC_HEX);
    expect(album).not.toBeNull();
    const resp = buildResponse({ album });
    const tags = readRecords(resp).map((r) => r.tag);
    expect(tags).toEqual([TAGS.ALBUM]);
    // album = 30-slot container, NUL-terminated text in slots 1/4/9
    const slots = readContainer(readRecords(resp)[0].payload);
    expect(slots[1].toString('utf8').replace(/\0/g, '')).toBe('Sample Sounds');
    expect(slots[4].toString('utf8').replace(/\0/g, '')).toBe('Test Artist');
    expect(slots[10].length).toBe(0); // slot 10 = ABSENT (hard-lock when text!)
  });

  it('should emit an E record with code 0x23 when no album matches', () => {
    const resp = buildResponse({ error: { code: 0x23, message: 'album not found' } });
    const records = readRecords(resp);
    expect(records[0].tag).toBe(TAGS.ERROR);
    // outer LE32 record → [tag][len LE32][payload]; payload = container
    expect(records[0].payload[0]).toBe(2); // 2 fields: code + message
    const fields = readContainer(records[0].payload);
    expect(fields[0].readUInt32LE(0)).toBe(0x23);
  });
});
