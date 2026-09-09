'use strict';

/**
 * Coverage of cddb.js - getDiscId, makeQueryUrl, parseData,
 * parseAlbum, fetchData, queryCddb, fetchCddbRecord.
 * Network mocked via node:http / node:https.
 */

const { EventEmitter } = require('node:events');

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const {
  getDiscId,
  makeQueryUrl,
  parseData,
  parseMatches,
  parseAlbum,
  parseDiscNumber,
  queryCddb,
  queryCddbMatches,
  fetchCddbRecord,
  saveGnudbRecord,
  fetchData,
} = require('../src/cddb');

/**
 * Mocks http.get (and optionally https.get) to return a fake response stream.
 * @param {number} status - HTTP status code the fake response reports
 * @param {string} body - response body to emit
 * @param {'http'|'https'} [proto='http'] - which module to mock
 * @returns {{mockFn: jest.Mock, restore: () => void}} the mock and a restore function
 */
function mockHttpGet(status, body, proto = 'http') {
  const mod = proto === 'https' ? https : http;
  const orig = mod.get;
  const mockFn = jest.fn((url, opts, cb) => {
    const cbFn = typeof opts === 'function' ? opts : cb;
    const res = new EventEmitter();
    res.statusCode = status;
    res.setEncoding = jest.fn();
    cbFn(res);
    setImmediate(() => res.emit('data', Buffer.from(body)));
    setImmediate(() => res.emit('end'));
    const req = new EventEmitter();
    req.destroy = jest.fn();
    req.on = jest.fn();
    return req;
  });
  mod.get = mockFn;
  return { mockFn, restore: () => { mod.get = orig; } };
}

describe('getDiscId', () => {
  it('should return 0 when there are fewer than 1 tracks', () => {
    expect(getDiscId([], 0, 0)).toBe(0);
  });

  it('should compute the freedb discid from frame offsets, nTracks and leadout seconds', () => {
    // small disc: 2 tracks starting [150, 20000], leadout 5000s
    // checksum = sumDigitSum(150/75=2) + sumDigitSum(20000/75=266 -> 2+6+6=14) = 2+14 = 16
    // totalSeconds = 5000 - (150/75=2) = 4998
    // id = ((16&255)<<24) | (4998<<8) | 2
    const id = getDiscId([150, 20000], 2, 5000);
    expect(id).toBe((((16 & 255) << 24) | (4998 << 8) | 2) >>> 0);
  });

  it('should wrap the checksum modulo 255 and place nTracks in the low bits', () => {
    // many offsets, high checksum (mod 255)
    const offs = new Array(50).fill(0).map((_, i) => 150 + i * 150);
    const id = getDiscId(offs, 50, 30000);
    expect(id & 0xff).toBe(50);
  });
});

describe('makeQueryUrl', () => {
  it('should build the cddb+query URL with frame offsets, leadout in seconds and the hello string', () => {
    const cfg = require('../src/config').loadConfig();
    const url = makeQueryUrl(0xaa11bb22, [150, 18737, 41102], 3, 2898);
    const expectedCmd = 'cddb+query+aa11bb22+3+150+18737+41102+2898';
    const expectedHello = `&hello=${cfg.gnudb.email.replace('@', '+')}+${cfg.client.name}+${cfg.client.version}&proto=${cfg.gnudb.proto}`;
    expect(url).toContain(`/~cddb/cddb.cgi?cmd=${expectedCmd}`);
    expect(url).toContain(expectedHello);
  });

  it('should zero-pad the discid to 8 hex digits', () => {
    const url = makeQueryUrl(7, [150], 1, 2000);
    expect(url).toContain('cddb+query+00000007');
  });
});

describe('parseData', () => {
  it('should return { category, id } for a 200 reply', () => {
    expect(parseData('200 rock aa11bb22 Test Artist / Sample Sounds')).toEqual({
      category: 'rock',
      id: 'aa11bb22',
    });
  });

  it('should return the first list entry for a 210 reply', () => {
    const reply = '210 Found exact matches\nrock aa11bb22 Test Artist / Sample Sounds\nother 12345678 Foo / Bar\n.';
    expect(parseData(reply)).toEqual({ category: 'rock', id: 'aa11bb22' });
  });

  it('should return the first list entry for a 211 reply', () => {
    const reply = '211 Found inexact matches\npop abcdef12 Artist / Title\n.';
    expect(parseData(reply)).toEqual({ category: 'pop', id: 'abcdef12' });
  });

  it('should return null for a 202 (no match) reply', () => {
    expect(parseData('202 No match found.')).toBeNull();
  });

  it('should return null when the reply has no status code', () => {
    expect(parseData('garbage')).toBeNull();
  });

  it('should return null when a 210 list contains only the dot terminator', () => {
    expect(parseData('210 Found\n.\n')).toBeNull();
  });

  it('should return null when a 200 reply has no category/id fields', () => {
    expect(parseData('200 ')).toBeNull();
  });
});

describe('parseMatches', () => {
  it('should return a single-element array for a 200 reply', () => {
    expect(parseMatches('200 rock aa11bb22 Test Artist / Sample Sounds'))
      .toEqual([{ category: 'rock', id: 'aa11bb22' }]);
  });

  it('should return every list entry for a 210 reply, not just the first', () => {
    const reply = '210 Found exact matches\nrock aa11bb22 Test Artist / Sample Sounds\nother 12345678 Foo / Bar\n.';
    expect(parseMatches(reply)).toEqual([
      { category: 'rock', id: 'aa11bb22' },
      { category: 'other', id: '12345678' },
    ]);
  });

  it('should return every list entry for a 211 reply', () => {
    const reply = '211 Found inexact matches\npop abcdef12 Artist / Title\nrock deadbeef Other / Title\n.';
    expect(parseMatches(reply)).toEqual([
      { category: 'pop', id: 'abcdef12' },
      { category: 'rock', id: 'deadbeef' },
    ]);
  });

  it('should return an empty array for a 202 (no match) reply', () => {
    expect(parseMatches('202 No match found.')).toEqual([]);
  });

  it('should return an empty array when the reply has no status code', () => {
    expect(parseMatches('garbage')).toEqual([]);
  });

  it('should return an empty array when a 210 list contains only the dot terminator', () => {
    expect(parseMatches('210 Found\n.\n')).toEqual([]);
  });
});

describe('parseCddbStatus / isCddbErrorCode', () => {
  const { parseCddbStatus, isCddbErrorCode } = require('../src/cddb');

  it('should parse a 210 exact-match status with its message', () => {
    expect(parseCddbStatus("210 Found exact matches, list follows (until terminating `.')"))
      .toEqual({ code: '210', message: "Found exact matches, list follows (until terminating `.')" });
  });

  it('should parse a 500 registration error with the server message', () => {
    expect(parseCddbStatus('500 Unknown application, developer email for abcdef 2.9.3'))
      .toEqual({ code: '500', message: 'Unknown application, developer email for abcdef 2.9.3' });
  });

  it('should return an empty message when the status line has no text', () => {
    expect(parseCddbStatus('202')).toEqual({ code: '202', message: '' });
  });

  it('should return null when the reply has no status code', () => {
    expect(parseCddbStatus('garbage')).toBeNull();
  });

  it('should classify 4xx/5xx codes as errors and success codes as non-errors', () => {
    expect(isCddbErrorCode('500')).toBe(true);
    expect(isCddbErrorCode('403')).toBe(true);
    expect(isCddbErrorCode('200')).toBe(false);
    expect(isCddbErrorCode('210')).toBe(false);
    expect(isCddbErrorCode('202')).toBe(false);
  });
});

describe('parseAlbum', () => {
  it('should split DTITLE with the " / " separator into artist and title', () => {
    const rec = parseAlbum('DTITLE=Test Artist / Sample Sounds\nDGENRE=Pop\nTTITLE0=Sample Sounds\nTTITLE1=Second Track\n');
    expect(rec.albumArtist).toBe('Test Artist');
    expect(rec.albumTitle).toBe('Sample Sounds');
    expect(rec.albumGenre).toBe('Pop');
    expect(rec.tracks).toEqual([{ title: 'Sample Sounds' }, { title: 'Second Track' }]);
  });

  it('should leave the artist empty when DTITLE has no " / " separator', () => {
    const rec = parseAlbum('DTITLE=Single Title\n');
    expect(rec.albumArtist).toBe('');
    expect(rec.albumTitle).toBe('Single Title');
  });

  it('should parse DYEAR into albumYear and keep only the first occurrence', () => {
    const rec = parseAlbum('DTITLE=A / B\nDYEAR=1987\nDYEAR=1999\n');
    expect(rec.albumYear).toBe('1987');
  });

  it('should leave albumYear empty when there is no DYEAR line', () => {
    const rec = parseAlbum('DTITLE=A / B\n');
    expect(rec.albumYear).toBe('');
  });

  it('should keep the first DTITLE/DGENRE occurrence and ignore subsequent ones', () => {
    const rec = parseAlbum('DTITLE=A / One\nDTITLE=B / Two\nDGENRE=X\nDGENRE=Y\n');
    expect(rec.albumTitle).toBe('One');
    expect(rec.albumGenre).toBe('X');
  });

  it('should ignore TTITLE lines with out-of-range or unparseable indices', () => {
    const rec = parseAlbum('TTITLE999=No\nTTITLEabc=No\nDTITLE=Artist / Title\n');
    expect(rec.tracks.length).toBe(0);
  });

  it('should trim artist/title/genre but keep TTITLE text raw', () => {
    const rec = parseAlbum('DTITLE=  Artist  /  Title  \nDGENRE=  Jazz  \nTTITLE0=  \n');
    expect(rec.albumArtist).toBe('Artist');
    expect(rec.albumTitle).toBe('Title');
    expect(rec.albumGenre).toBe('Jazz');
    expect(rec.tracks).toEqual([{ title: '  ' }]); // TTITLE is not trimmed
  });

  it('should keep the first TTITLE occurrence for a duplicated index', () => {
    const rec = parseAlbum('DTITLE=A / B\nTTITLE0=First\nTTITLE0=Second\n');
    expect(rec.tracks).toEqual([{ title: 'First' }]);
  });

  it('should raise the track count only for the highest seen index', () => {
    const rec = parseAlbum('DTITLE=A / B\nTTITLE2=C\nTTITLE0=A\n');
    expect(rec.tracks).toEqual([{ title: 'A' }, { title: '' }, { title: 'C' }]);
  });

  it('should limit tracked TTITLE indices to maxTracks', () => {
    const rec = parseAlbum('DTITLE=A / B\nTTITLE0=X\nTTITLE5=Y\n', 3);
    expect(rec.tracks.length).toBe(1); // only index 0 < 3
  });
});

describe('fetchData', () => {
  it('should resolve the body of an http response into { status, body }', async () => {
    const { restore } = mockHttpGet(200, 'hello world', 'http');
    try {
      const res = await fetchData('http://example.com/');
      expect(res).toEqual({ status: 200, body: 'hello world' });
    } finally { restore(); }
  });

  it('should use the https module for https URLs', async () => {
    const { restore } = mockHttpGet(200, 'secure', 'https');
    try {
      const res = await fetchData('https://example.com/');
      expect(res.body).toBe('secure');
    } finally { restore(); }
  });

  it('should reject with a timeout error when the request times out', async () => {
    const mod = http;
    const orig = mod.get;
    mod.get = jest.fn((url, opts, cb) => {
      const req = new EventEmitter();
      req.destroy = (err) => { if (err) req.emit('error', err); };
      setImmediate(() => req.emit('timeout')); // the code does req.destroy(new Error('timeout'))
      return req;
    });
    try {
      await expect(fetchData('http://example.com/')).rejects.toThrow('timeout');
    } finally { mod.get = orig; }
  });

  it('should reject when the request emits an error', async () => {
    const mod = http;
    const orig = mod.get;
    mod.get = jest.fn((url, opts, cb) => {
      const req = new EventEmitter();
      req.destroy = jest.fn();
      setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
      return req;
    });
    try {
      await expect(fetchData('http://example.com/')).rejects.toThrow('ECONNREFUSED');
    } finally { mod.get = orig; }
  });
});

describe('queryCddb / fetchCddbRecord', () => {
  it('should return { category, id } when the gnudb query answers 200', async () => {
    const { restore } = mockHttpGet(200, '200 rock aa11bb22 Test Artist / Sample Sounds\n');
    try {
      const m = await queryCddb([150, 18737], 2, 2898);
      expect(m).toEqual({ category: 'rock', id: 'aa11bb22' });
    } finally { restore(); }
  });

  it('should throw when the gnudb query responds with a non-200 status', async () => {
    const { restore } = mockHttpGet(500, '');
    try {
      await expect(queryCddb([150], 1, 2000)).rejects.toThrow('query status=500');
    } finally { restore(); }
  });

  it('should throw a descriptive error when the CDDB protocol status is 500 (bad hello/registration)', async () => {
    const { restore } = mockHttpGet(200, '500 Unknown application, developer email for abcdef 2.9.3\n');
    try {
      await expect(queryCddb([150], 1, 2000))
        .rejects.toThrow('gnudb query failed: 500 Unknown application, developer email for abcdef 2.9.3');
    } finally { restore(); }
  });

  it('should throw a descriptive error when the CDDB protocol status is 403', async () => {
    const { restore } = mockHttpGet(200, '403 No such CDDB command\n');
    try {
      await expect(queryCddb([150], 1, 2000)).rejects.toThrow('gnudb query failed: 403 No such CDDB command');
    } finally { restore(); }
  });

  it('should return null (no match) for a 202 protocol reply', async () => {
    const { restore } = mockHttpGet(200, '202 No match found\n');
    try {
      await expect(queryCddb([150], 1, 2000)).resolves.toBeNull();
    } finally { restore(); }
  });

  it('queryCddbMatches should resolve every candidate for a 210 reply (not just the first)', async () => {
    const { restore } = mockHttpGet(200, '210 Found exact matches\nrock aa11bb22 Test Artist / Sample Sounds\nother 12345678 Foo / Bar\n.\n');
    try {
      const matches = await queryCddbMatches([150], 1, 2000);
      expect(matches).toEqual([
        { category: 'rock', id: 'aa11bb22' },
        { category: 'other', id: '12345678' },
      ]);
    } finally { restore(); }
  });

  it('queryCddbMatches should resolve an empty array for a 202 (no match) reply', async () => {
    const { restore } = mockHttpGet(200, '202 No match found\n');
    try {
      await expect(queryCddbMatches([150], 1, 2000)).resolves.toEqual([]);
    } finally { restore(); }
  });

  it('queryCddbMatches should throw the same way as queryCddb on a non-200 HTTP status', async () => {
    const { restore } = mockHttpGet(500, '');
    try {
      await expect(queryCddbMatches([150], 1, 2000)).rejects.toThrow('query status=500');
    } finally { restore(); }
  });

  it('should return the record body when the gnudb read responds 200', async () => {
    const { restore } = mockHttpGet(200, 'DTITLE=A / B\n');
    try {
      const body = await fetchCddbRecord('rock', 'aa11bb22');
      expect(body).toContain('DTITLE');
    } finally { restore(); }
  });

  it('should throw when the gnudb read responds with a non-200 status', async () => {
    const { restore } = mockHttpGet(404, '');
    try {
      await expect(fetchCddbRecord('rock', 'x')).rejects.toThrow('read status=404');
    } finally { restore(); }
  });

  it('should throw a descriptive error when the read CDDB protocol status is an error code', async () => {
    const { restore } = mockHttpGet(200, "401 No such disc ID in database\n");
    try {
      await expect(fetchCddbRecord('rock', 'deadbeef'))
        .rejects.toThrow('gnudb read failed: 401 No such disc ID in database');
    } finally { restore(); }
  });
});

describe('parseDiscNumber', () => {
  it('should return 0 when there is no disc/CD marker', () => {
    expect(parseDiscNumber('NoDiscMarker')).toBe(0);
  });

  it('should parse a trailing "CD2" suffix', () => {
    expect(parseDiscNumber('Some Album CD2')).toBe(2);
  });

  it('should parse "(Cd 2)" case-insensitively', () => {
    expect(parseDiscNumber('Some Album (Cd 2)')).toBe(2);
  });

  it('should parse "[Disc 3]"', () => {
    expect(parseDiscNumber('Some Album [Disc 3]')).toBe(3);
  });

  it('should parse "Disc 2 of 3" and return only the disc number', () => {
    expect(parseDiscNumber('Some Album Disc 2 of 3')).toBe(2);
  });

  it('should parse a dash-prefixed "- CD1"', () => {
    expect(parseDiscNumber('Some Album - CD1')).toBe(1);
  });
});

describe('saveGnudbRecord', () => {
  beforeEach(() => { process.env.ENABLE_DUMPS = '1'; });
  afterEach(() => { delete process.env.ENABLE_DUMPS; });

  it('should write the raw gnudb record text to dumps/resp_<ts>-gnudb.txt', () => {
    const ts = Date.now();
    saveGnudbRecord(ts, 'DTITLE=Test Artist / Sample Sounds\n');
    const log = require('../src/logger');
    const file = path.join(log.DUMPS_DIR, `resp_${ts}-gnudb.txt`);
    try {
      expect(fs.readFileSync(file, 'utf8')).toBe('DTITLE=Test Artist / Sample Sounds\n');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('should log a warning and not throw when the write fails', () => {
    const log = require('../src/logger');
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    const warnSpy = jest.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      expect(() => saveGnudbRecord(123, 'text')).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});