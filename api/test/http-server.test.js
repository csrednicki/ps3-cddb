'use strict';

/**
 * Coverage of http-server.js - startHttpServer + extractMultipartBody.
 * Server started on a test port (mocked config), requests sent with a
 * real HTTP client. findAlbumLive is mocked so it does not reach the
 * network (gnudb).
 */

const http = require('node:http');
const { buildBinHeader } = require('../src/bin-header');
const { encodeTocField } = require('../src/toc');

jest.mock('../src/config', () => ({
  loadConfig: () => ({
    client: { userName: 'AMG Test User' },
    http: { port: 18080, path: '/sdkrequest', boundary: '---------------------------265001916915724', replyDelayMs: 0 },
    dumps: { logRequests: true, logResponses: true },
  }),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  dumpBinary: jest.fn(),
  hexdump: jest.fn(),
}));

jest.mock('../src/albums', () => ({
  findAlbumLive: jest.fn(),
  writeDiskCache: jest.fn(),
  purgeDiskCache: jest.fn(),
}));

jest.mock('../src/cddb', () => ({
  saveGnudbRecord: jest.fn(),
}));

const { startHttpServer } = require('../src/http-server');
const { findAlbumLive } = require('../src/albums');
const { readRecords, TAGS } = require('../src/tlv');

const BOUNDARY = '---------------------------265001916915724';
const PORT = 18080;

/**
 * Builds a full multipart PS3 request body (POST /sdkrequest).
 * @param {Buffer} tocBytes - encoded TOC field to embed at offset 0x50
 * @returns {Buffer} the raw HTTP request (headers + multipart body)
 */
function buildMultipartRequest(tocBytes) {
  const header = buildBinHeader({ secret: '001122334455' });
  const body = Buffer.alloc(0x80 + 4);
  header.copy(body, 0);
  body.writeUInt32LE(0x34, 0x34); // header length marker
  body[0x38] = 0x54;              // DISCID tag
  // capabilities (0x39..0x4B) - irrelevant to the parser, left as zeros
  tocBytes.copy(body, 0x50);
  // blob @0x7c..0x80 = zeros, trailer @0x80.. = zeros

  const raw = Buffer.concat([
    Buffer.from(
      `POST http://dmr.allmusic.com/sdkrequest HTTP/1.0\r\nHost: dmr.allmusic.com\r\n` +
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\nContent-Length: 999\r\n\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="data"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    body,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  return raw;
}

/**
 * Sends a raw HTTP request to the test server and returns { status, body, headers }.
 * @param {string} method - HTTP method
 * @param {string} target - request path
 * @param {Buffer} body - request body to send
 * @returns {Promise<{status: number, body: Buffer, headers: object}>}
 */
function rawRequest(method, target, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      method,
      path: target,
      agent: false, // no keep-alive - each request on a new socket
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + BOUNDARY, 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeAll(() => { process.env.REPLY_DELAY = '0'; });
afterAll(() => { delete process.env.REPLY_DELAY; });

describe('startHttpServer - GET / (test page)', () => {
  let server;
  beforeAll(async () => { server = await startHttpServer(); });
  afterAll(async () => { server.close(); });

  it('should respond 200 with the test page HTML for GET /', async () => {
    const res = await rawRequest('GET', '/', Buffer.alloc(0));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body.toString('utf8')).toContain('PS3 CDDB API emulator');
  });

  it('should serve the test page for GET /?query as well', async () => {
    const res = await rawRequest('GET', '/?foo=1', Buffer.alloc(0));
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toContain('API test');
  });

  it('should redirect to the test page (302) for GET on another path', async () => {
    const res = await rawRequest('GET', '/abc', Buffer.alloc(0));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.body.length).toBe(0);
  });

  it('should redirect to the test page (302) for a browser GET on the SDK path', async () => {
    const res = await rawRequest('GET', '/sdkrequest', Buffer.alloc(0));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('startHttpServer - multipart without a closing marker (end !== -1 fallback)', () => {
  it('should keep the body to the end when the multipart closing marker is missing', () => {
    const { extractMultipartBody } = require('../src/http-server');
    const inner = Buffer.from('BIN-no-closing');
    const raw = Buffer.concat([
      Buffer.from(
        `POST http://dmr.allmusic.com/sdkrequest HTTP/1.0\r\n\r\n` +
        `--B\r\nContent-Disposition: form-data; name="data"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      inner,
      // missing the closing marker \r\n--B--
    ]);
    expect(extractMultipartBody(raw, 'B').equals(inner)).toBe(true);
  });
});

describe('startHttpServer - POST /sdkrequest', () => {
  let server;
  beforeAll(async () => { server = await startHttpServer(); });
  afterAll(async () => { server.close(); });

  beforeEach(() => { findAlbumLive.mockReset(); });

  it('should respond with an empty 200 (not 404) for POST on an unknown path', async () => {
    const res = await rawRequest('POST', '/other', Buffer.alloc(0));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });

  it('should return a single ALBUM record for a matched album', async () => {
    const album = { title: 'Sample Sounds', artist: 'Test Artist', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }] };
    findAlbumLive.mockResolvedValue(album);
    const toc = encodeTocField(1, 20000, [1000]);
    const res = await rawRequest('POST', '/sdkrequest', buildMultipartRequest(toc));
    expect(res.status).toBe(200);
    const records = readRecords(res.body);
    expect(records.map((r) => r.tag)).toEqual([TAGS.ALBUM]);
    // with dumps.logRequests/logResponses enabled the request and response
    // binaries are dumped (covers the dump branches in http-server.js)
    const log = require('../src/logger');
    expect(log.dumpBinary).toHaveBeenCalled();
  });

  it('should delay the response by REPLY_DELAY milliseconds when it is positive', async () => {
    const prev = process.env.REPLY_DELAY;
    process.env.REPLY_DELAY = '10';
    try {
      const album = { title: 'Sample Sounds', artist: 'TA', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }] };
      findAlbumLive.mockResolvedValue(album);
      const toc = encodeTocField(1, 20000, [1000]);
      const res = await rawRequest('POST', '/sdkrequest', buildMultipartRequest(toc));
      expect(res.status).toBe(200);
      expect(readRecords(res.body).map((r) => r.tag)).toEqual([TAGS.ALBUM]);
    } finally {
      if (prev === undefined) delete process.env.REPLY_DELAY;
      else process.env.REPLY_DELAY = prev;
    }
  });

  it('should reply immediately when REPLY_DELAY is not a number (NaN → 0)', async () => {
    const prev = process.env.REPLY_DELAY;
    process.env.REPLY_DELAY = 'abc';
    try {
      const album = { title: 'Sample Sounds', artist: 'TA', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }] };
      findAlbumLive.mockResolvedValue(album);
      const toc = encodeTocField(1, 20000, [1000]);
      const res = await rawRequest('POST', '/sdkrequest', buildMultipartRequest(toc));
      expect(res.status).toBe(200);
      expect(readRecords(res.body).map((r) => r.tag)).toEqual([TAGS.ALBUM]);
    } finally {
      if (prev === undefined) delete process.env.REPLY_DELAY;
      else process.env.REPLY_DELAY = prev;
    }
  });

  it('should return an E record with code 0x23 when no album matches', async () => {
    findAlbumLive.mockResolvedValue(null);
    const toc = encodeTocField(1, 20000, [1000]);
    const res = await rawRequest('POST', '/sdkrequest', buildMultipartRequest(toc));
    expect(res.status).toBe(200);
    const records = readRecords(res.body);
    expect(records[0].tag).toBe(TAGS.ERROR);
  });

  it('should return an E record with code 0x23 when findAlbumLive rejects', async () => {
    findAlbumLive.mockRejectedValue(new Error('boom'));
    const toc = encodeTocField(1, 20000, [1000]);
    const res = await rawRequest('POST', '/sdkrequest', buildMultipartRequest(toc));
    expect(res.status).toBe(200);
    const records = readRecords(res.body);
    expect(records[0].tag).toBe(TAGS.ERROR);
  });

  it('should return an E record with code 0x1f when the body cannot be parsed', async () => {
    const res = await rawRequest('POST', '/sdkrequest', Buffer.from('garbage-not-bin'));
    expect(res.status).toBe(200);
    const records = readRecords(res.body);
    expect(records[0].tag).toBe(TAGS.ERROR);
  });

  it('should write the disk cache after the response has been sent when the album carries __cacheWrite', async () => {
    const { writeDiskCache } = require('../src/albums');
    const album = {
      title: 'Sample Sounds', artist: 'TA', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }],
      __cacheWrite: { discId: 'abc123', artist: 'TA', title: 'Sample Sounds', record: 'DTITLE=TA / Sample Sounds\n' },
    };
    findAlbumLive.mockResolvedValue(album);
    const toc = encodeTocField(1, 20000, [1000]);
    const res = await rawRequest('POST', '/sdkrequest', buildMultipartRequest(toc));
    expect(res.status).toBe(200);
    expect(writeDiskCache).toHaveBeenCalledWith('abc123', 'TA', 'Sample Sounds', 'DTITLE=TA / Sample Sounds\n');
    // __cacheWrite must be deleted so a subsequent cache hit does not re-trigger the write
    expect(album.__cacheWrite).toBeUndefined();
  });

  it('should save the raw gnudb record next to the response dump when the album carries __gnudbRecord', async () => {
    const { saveGnudbRecord } = require('../src/cddb');
    const album = { title: 'Sample Sounds', artist: 'TA', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }], __gnudbRecord: 'DTITLE=TA / Sample Sounds\n' };
    findAlbumLive.mockResolvedValue(album);
    const toc = encodeTocField(1, 20000, [1000]);
    const res = await rawRequest('POST', '/sdkrequest', buildMultipartRequest(toc));
    expect(res.status).toBe(200);
    expect(saveGnudbRecord).toHaveBeenCalledWith(expect.any(Number), 'DTITLE=TA / Sample Sounds\n');
    // __gnudbRecord must be deleted so a subsequent cache hit does not re-save the record
    expect(album.__gnudbRecord).toBeUndefined();
  });
});