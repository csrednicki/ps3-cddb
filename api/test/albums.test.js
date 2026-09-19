'use strict';

/**
 * Coverage of store/albums.js - loadAlbums, findAlbumByRawToc, findAlbumLive
 * (order: cache → seed → gnudb with dedupe). cddb mocked (no network),
 * logger mocked.
 */

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  dumpBinary: jest.fn(),
  hexdump: jest.fn(),
}));

jest.mock('../src/cddb', () => ({
  ...jest.requireActual('../src/cddb'),
  queryCddbMatches: jest.fn(),
  fetchCddbRecord: jest.fn(),
  parseAlbum: jest.fn(),
}));

const { queryCddbMatches, fetchCddbRecord, parseAlbum, getDiscId } = require('../src/cddb');
const albums = require('../src/albums');
const fs = require('node:fs');
const path = require('node:path');
const SEED_DIR = path.join(__dirname, 'seed');
const SEED_KEY = require('./seed/sample-album.json').rawTocKeys[0];
const CACHE_DIR = path.resolve(__dirname, "..", "..", 'cache');

describe('loadAlbums / findAlbumByRawToc (seed sample-album.json)', () => {
  it('should load rawToc keys from .json files in the seed directory', () => {
    expect(albums.loadAlbums(SEED_DIR)).toBeGreaterThanOrEqual(1);
  });

  it('should find the seed album by a rawToc key regardless of case', () => {
    albums.loadAlbums(SEED_DIR);
    expect(albums.findAlbumByRawToc(SEED_KEY.toUpperCase())).not.toBeNull();
    expect(albums.findAlbumByRawToc(SEED_KEY.toLowerCase()).title).toBe('Sample Sounds');
  });

  it('should return null when rawTocHex is empty or null', () => {
    expect(albums.findAlbumByRawToc(null)).toBeNull();
    expect(albums.findAlbumByRawToc('')).toBeNull();
  });

  it('should return null for an unknown rawToc key', () => {
    expect(albums.findAlbumByRawToc('deadbeef')).toBeNull();
  });

  it('should skip non-.json files and handle albums without rawTocKeys gracefully', () => {
    const dirSpy = jest.spyOn(fs, 'readdirSync')
      .mockImplementationOnce(() => ['not-an-album.txt', 'keyless.json']);
    const readSpy = jest.spyOn(fs, 'readFileSync')
      .mockImplementationOnce(() => JSON.stringify({ title: 'Keyless' })); // no rawTocKeys
    albums.loadAlbums(SEED_DIR);
    dirSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe('findAlbumLive - gnudb (lookup live)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // isolate the on-disk gnudb cache between tests
    const cacheDir = path.resolve(__dirname, '..', 'cache');
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('should return null without querying gnudb when rawTocHex is missing or empty', async () => {
    expect(await albums.findAlbumLive({})).toBeNull();
    expect(await albums.findAlbumLive({ rawTocHex: '' })).toBeNull();
    expect(queryCddbMatches).not.toHaveBeenCalled();
  });

  /** Mocks queryCddbMatches/fetchCddbRecord/parseAlbum to a single successful "Sample Sounds" match. */
  function seedLiveMatch() {
    queryCddbMatches.mockResolvedValue([{ category: 'rock', id: 'aa11bb22' }]);
    fetchCddbRecord.mockResolvedValue('DTITLE=Test Artist / Sample Sounds\n');
    parseAlbum.mockReturnValue({
      albumTitle: 'Sample Sounds', albumArtist: 'Test Artist', albumGenre: 'Pop',
      tracks: [{ title: 'Sample Sounds' }, { title: 'Second Track' }],
    });
  }

  /**
   * Minimal req passing tocFromRequest (nTracks >= 1, leadout+track values).
   * @param {string} tocHex - value to use as rawTocHex (the memory-cache key)
   * @returns {object} a parsed-request-shaped object suitable for findAlbumLive
   */
  function liveReq(tocHex) {
    return { rawTocHex: tocHex, toc: { nTracks: 2, values: [16000, 0, 1000, 2000] } };
  }

  it('should map gnudb record fields onto the album object', async () => {
    seedLiveMatch();
    const album = await albums.findAlbumLive(liveReq('aabbccdd'));
    expect(album.title).toBe('Sample Sounds');
    expect(album.artist).toBe('Test Artist');
    expect(album.genre).toBe('Pop');
    expect(album.tracks).toHaveLength(2);
    expect(queryCddbMatches).toHaveBeenCalledTimes(1);
  });

  it('should perform only one gnudb lookup when concurrent requests share the same key', async () => {
    seedLiveMatch();
    const key = 'feedbeefdeadbeef';
    await Promise.all([
      albums.findAlbumLive(liveReq(key)),
      albums.findAlbumLive(liveReq(key)),
    ]);
    expect(queryCddbMatches).toHaveBeenCalledTimes(1);
  });

  it('should not re-lookup a cached album on a subsequent request for the same key', async () => {
    seedLiveMatch();
    const key = 'bbbbbbbbbbbb';
    await albums.findAlbumLive(liveReq(key));
    await albums.findAlbumLive(liveReq(key));
    expect(queryCddbMatches).toHaveBeenCalledTimes(1);
  });

  it('should return null when the gnudb query has no match', async () => {
    queryCddbMatches.mockResolvedValue([]);
    expect(await albums.findAlbumLive(liveReq('abcde'))).toBeNull();
    expect(fetchCddbRecord).not.toHaveBeenCalled();
  });

  it('should return null when the gnudb record contains no tracks', async () => {
    queryCddbMatches.mockResolvedValue([{ category: 'rock', id: 'x' }]);
    fetchCddbRecord.mockResolvedValue('DTITLE=A / B\n');
    parseAlbum.mockReturnValue({ albumTitle: 'B', albumArtist: 'A', albumGenre: '', tracks: [] });
    expect(await albums.findAlbumLive(liveReq('abcde'))).toBeNull();
  });

  it('should return null and log a warning when the gnudb lookup rejects', async () => {
    queryCddbMatches.mockRejectedValue(new Error('network down'));
    expect(await albums.findAlbumLive(liveReq('ffff'))).toBeNull();
    expect(require('../src/logger').warn).toHaveBeenCalled();
  });

  it('should return null when toc has no tracks (nTracks < 1)', async () => {
    const album = await albums.findAlbumLive({ rawTocHex: 'aaa000bb', toc: { nTracks: 0, values: [] } });
    expect(album).toBeNull();
    expect(queryCddbMatches).not.toHaveBeenCalled();
  });

  it('should decode the TOC from req.tocBytes when req.toc is absent (tocFromRequest path)', async () => {
    // albums.js uses the REAL decodeTocField; build a valid TOC field with it
    jest.dontMock('../src/toc');
    const { encodeTocField } = jest.requireActual('../src/toc');
    seedLiveMatch();
    // [END, START, L_1, L_2] with END = START + ΣDL − 1
    const tocBytes = encodeTocField(2, 16000, [1000, 2000], 150);
    const album = await albums.findAlbumLive({ rawTocHex: '00112233', tocBytes });
    expect(album.title).toBe('Sample Sounds');
    // tocFromRequest: freedb offsets = START+150, then +DL1 → [300, 1300]
    expect(queryCddbMatches).toHaveBeenCalledWith([300, 1300], 2, 215);
  });

  it('should build a single frame offset for a one-track disc', () => {
    const toc = albums.tocFromRequest({ toc: { nTracks: 1, values: [9000, 150, 8850] } });
    expect(toc.frameOffsets).toEqual([300]); // 150 START + 150 lead-in
    expect(toc.leadoutSeconds).toBe(122);    // (9000 + 1 + 150) / 75
  });

  it('should fall back to START=0 when a decoded TOC has no START value', () => {
    const toc = albums.tocFromRequest({ toc: { nTracks: 2, values: [9000] } });
    expect(toc.frameOffsets).toEqual([150, 150]); // 0 START + 150 lead-in
  });

  it('should slice tracks down to the physical disc track count when gnudb returns more', async () => {
    seedLiveMatch();
    parseAlbum.mockReturnValue({
      albumTitle: 'Sample Sounds', albumArtist: 'TA', albumGenre: 'Pop',
      tracks: [{ title: 'A' }, { title: 'B' }, { title: 'C' }], // more than the disc has
    });
    const album = await albums.findAlbumLive(liveReq('ddee0011'));
    expect(album.tracks).toHaveLength(2); // clipped to toc.nTracks
  });

  it('should set numDiscs and log when the DTITLE-derived disc number is greater than 1', async () => {
    seedLiveMatch();
    parseAlbum.mockReturnValue({
      albumTitle: 'Sample Sounds (CD2)', albumArtist: 'Test Artist', albumGenre: 'Pop',
      albumDisc: 2,
      tracks: [{ title: 'Sample Sounds' }, { title: 'Second Track' }],
    });
    const album = await albums.findAlbumLive(liveReq('11223344'));
    expect(album.numDiscs).toBe(2);
    expect(album.discNumber).toBe(2);
    expect(require('../src/logger').info).toHaveBeenCalledWith(
      expect.stringContaining('disc 2 parsed from DTITLE - setting numDiscs=2'),
    );
  });

  it('should return every usable gnudb match as candidates when the query is ambiguous', async () => {
    queryCddbMatches.mockResolvedValue([
      { category: 'rock', id: 'aaaaaaaa' },
      { category: 'pop', id: 'bbbbbbbb' },
    ]);
    fetchCddbRecord.mockImplementation((category, id) => Promise.resolve(`DTITLE=Artist / Title-${id}\n`));
    parseAlbum.mockImplementation((text) => {
      const m = text.match(/Title-(\w+)/);
      return {
        albumTitle: `Title-${m[1]}`, albumArtist: 'Artist', albumGenre: 'Pop',
        tracks: [{ title: 'T1' }],
      };
    });

    const album = await albums.findAlbumLive(liveReq('cafe0001'));
    expect(album.candidates).toHaveLength(2);
    expect(album.candidates.map((c) => c.title)).toEqual(['Title-aaaaaaaa', 'Title-bbbbbbbb']);
    expect(album.title).toBe('Title-aaaaaaaa'); // primary = first candidate, kept at the top level
    expect(fetchCddbRecord).toHaveBeenCalledTimes(2);
  });

  it('should drop candidates whose gnudb record has no tracks but keep the usable ones', async () => {
    queryCddbMatches.mockResolvedValue([
      { category: 'rock', id: 'empty001' },
      { category: 'pop', id: 'good0001' },
    ]);
    fetchCddbRecord.mockImplementation((category, id) => Promise.resolve(`id:${id}`));
    parseAlbum.mockImplementation((text) => (
      text.includes('empty001')
        ? { albumTitle: 'Empty', albumArtist: '', albumGenre: '', tracks: [] }
        : { albumTitle: 'Good', albumArtist: 'Artist', albumGenre: '', tracks: [{ title: 'T1' }] }
    ));

    const album = await albums.findAlbumLive(liveReq('cafe0002'));
    expect(album.candidates).toHaveLength(1);
    expect(album.title).toBe('Good');
  });

  it('should skip a candidate whose gnudb read fails and still return the rest', async () => {
    queryCddbMatches.mockResolvedValue([
      { category: 'rock', id: 'fails001' },
      { category: 'pop', id: 'good0002' },
    ]);
    fetchCddbRecord.mockImplementation((category, id) => (
      id === 'fails001' ? Promise.reject(new Error('read status=404')) : Promise.resolve('DTITLE=Artist / Good\n')
    ));
    parseAlbum.mockReturnValue({ albumTitle: 'Good', albumArtist: 'Artist', albumGenre: '', tracks: [{ title: 'T1' }] });

    const album = await albums.findAlbumLive(liveReq('cafe0003'));
    expect(album.candidates).toHaveLength(1);
    expect(album.title).toBe('Good');
    expect(require('../src/logger').warn).toHaveBeenCalledWith(expect.stringContaining('fails001'));
  });
});

describe('writeDiskCache / purgeDiskCache - on-disk gnudb cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  });
  afterAll(() => { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); });

  it('should write the raw gnudb record to a discId-artist-title.txt file', () => {
    albums.writeDiskCache('aa11bb22', 'Test Artist', 'Sample Sounds', 'DTITLE=Test Artist / Sample Sounds\n');
    const files = fs.readdirSync(CACHE_DIR);
    expect(files).toEqual(['aa11bb22-Test_Artist-Sample_Sounds.txt']);
    expect(fs.readFileSync(path.join(CACHE_DIR, files[0]), 'utf8')).toBe('DTITLE=Test Artist / Sample Sounds\n');
    expect(require('../src/logger').info).toHaveBeenCalledWith(expect.stringContaining('[cache] saved:'));
    expect(require('../src/logger').info).toHaveBeenCalledWith(expect.stringContaining('fresh until'));
  });

  it('should strip unsafe characters from the artist/title and truncate long names in the file stem', () => {
    const longName = 'x'.repeat(100);
    albums.writeDiskCache('deadbeef', 'A/B:C*D', longName, 'DTITLE=A / B\n');
    const [file] = fs.readdirSync(CACHE_DIR);
    expect(file.startsWith('deadbeef-ABCD-')).toBe(true);
    // the safe() helper caps each side at 60 chars
    expect(file.length).toBeLessThan('deadbeef-'.length + 60 + 1 + 60 + '.txt'.length + 1);
  });

  it('should still join with a dash when artist and title are both empty (empty-but-truthy suffix)', () => {
    albums.writeDiskCache('cafebabe', '', '', 'DTITLE=A / B\n');
    expect(fs.readdirSync(CACHE_DIR)).toEqual(['cafebabe--.txt']);
  });

  it('should log a warning and not throw when the disk write fails', () => {
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => albums.writeDiskCache('badid', 'A', 'B', 'text')).not.toThrow();
    expect(require('../src/logger').warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    spy.mockRestore();
  });

  it('should use empty string for null/undefined artist or title in the file stem', () => {
    albums.writeDiskCache('ffffffff', undefined, null, 'DTITLE=A / B\n');
    const [file] = fs.readdirSync(CACHE_DIR);
    expect(file.startsWith('ffffffff--')).toBe(true);
  });

  it('should purge expired cache files (mtime older than the TTL) but keep fresh ones', async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const oldFile = path.join(CACHE_DIR, 'old-A-B.txt');
    const freshFile = path.join(CACHE_DIR, 'fresh-A-B.txt');
    const nonTxt = path.join(CACHE_DIR, 'ignored.json');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(freshFile, 'fresh');
    fs.writeFileSync(nonTxt, '{}');
    const oldTime = new Date(Date.now() - 999_999_999);
    fs.utimesSync(oldFile, oldTime, oldTime);

    albums.purgeDiskCache();
    // purgeDiskCache defers its work via setImmediate - flush the microtask/immediate queue
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const remaining = fs.readdirSync(CACHE_DIR).sort();
    expect(remaining).toEqual(['fresh-A-B.txt', 'ignored.json']);
    expect(require('../src/logger').info).toHaveBeenCalledWith(expect.stringContaining('[cache] purged:'));
    expect(require('../src/logger').info).toHaveBeenCalledWith(expect.stringContaining('expired at'));
  });

  it('should not throw when the cache directory does not exist', async () => {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    expect(() => albums.purgeDiskCache()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('findAlbumLive - disk cache hit/miss', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  });
  afterAll(() => { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); });
  /**
   * A req whose rawTocHex is NOT a seed key, so findAlbumLive falls through to the disk cache.
   * @param {string} tocHex - value to use as rawTocHex (the memory-cache key)
   * @returns {object} a parsed-request-shaped object suitable for findAlbumLive
   */
  function unseededReq(tocHex) {
    // [END, START, L_1, L_2]
    return { rawTocHex: tocHex, toc: { nTracks: 2, values: [16000, 150, 1000, 2000] } };
  }

  /**
   * Computes the same discId findAlbumLive would derive from `req`'s TOC, for
   * building/verifying its disk-cache filename.
   * @param {object} req - request built by unseededReq()
   * @returns {string} the disc id, as 8 lowercase hex digits
   */
  function discIdFor(req) {
    const { nTracks, values } = req.toc;
    // freedb counts from the lead-in: offsets start at START + 150
    const frameOffsets = [values[1] + 150];
    for (let i = 0; i < nTracks - 1; i++) {
      frameOffsets.push(frameOffsets[i] + values[2 + i]);
    }
    const leadoutSeconds = Math.floor((values[0] + 1 + 150) / 75);
    return getDiscId(frameOffsets, nTracks, leadoutSeconds).toString(16).padStart(8, '0');
  }

  it('should serve a fresh disk-cache entry without calling gnudb', async () => {
    const req = unseededReq('01020304');
    const discId = discIdFor(req);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${discId}-Cached-Artist.txt`), 'DTITLE=Cached Artist / Cached Title\n');
    parseAlbum.mockReturnValue({
      albumTitle: 'Cached Title', albumArtist: 'Cached Artist', albumGenre: 'Rock', albumYear: '1999', albumDisc: 0,
      tracks: [{ title: 'A' }, { title: 'B' }],
    });

    const album = await albums.findAlbumLive(req);
    expect(album.title).toBe('Cached Title');
    expect(album.artist).toBe('Cached Artist');
    expect(album.__fromCache).toBe(true);
    expect(queryCddbMatches).not.toHaveBeenCalled();
    expect(fetchCddbRecord).not.toHaveBeenCalled();
    expect(require('../src/logger').info).toHaveBeenCalledWith(expect.stringContaining('[cache] disk:'));
    expect(require('../src/logger').info).toHaveBeenCalledWith(expect.stringContaining('fresh until'));
  });

  it('should skip files with a mismatched discId prefix or non-.txt extension', async () => {
    // uses same toc as other unseededReq calls, so same discId - but a fresh rawTocHex key
    const req = unseededReq('eeff0011');
    const discId = discIdFor(req);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // wrong prefix → !startsWith branch (continue taken)
    fs.writeFileSync(path.join(CACHE_DIR, 'nomatch.txt'), 'noise');
    // right prefix, wrong ext → !endsWith('.txt') branch (continue taken)
    fs.writeFileSync(path.join(CACHE_DIR, `${discId}-data.json`), 'DTITLE=data');
    // no matching ${discId}-*.txt → readDiskCache returns null → gnudb fallback
    queryCddbMatches.mockResolvedValue([]);
    const album = await albums.findAlbumLive(req);
    expect(album).toBeNull();
    expect(queryCddbMatches).toHaveBeenCalledTimes(1);
  });

  it('should use empty string for year when the disk-cache record has no DYEAR', async () => {
    const req = unseededReq('ccddccdd');
    const discId = discIdFor(req);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${discId}-No-Year.txt`), 'DTITLE=No Year / No Year\n');
    parseAlbum.mockReturnValue({
      albumTitle: 'No Year', albumArtist: 'No Year', albumGenre: 'Unknown', albumDisc: 0,
      tracks: [{ title: 'A' }],
    });
    const album = await albums.findAlbumLive(req);
    expect(album.year).toBe('');
  });

  it('should reuse an expired disk-cache entry instead of hitting gnudb, and renew its freshness', async () => {
    const req = unseededReq('05060708');
    const discId = discIdFor(req);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = path.join(CACHE_DIR, `${discId}-Old.txt`);
    fs.writeFileSync(file, 'DTITLE=Old / Stale\n');
    const oldTime = new Date(Date.now() - 999_999_999);
    fs.utimesSync(file, oldTime, oldTime);

    parseAlbum.mockReturnValue({
      albumTitle: 'Old', albumArtist: 'Stale', albumGenre: '', albumDisc: 0,
      tracks: [{ title: 'A' }, { title: 'B' }],
    });

    const before = Date.now();
    const album = await albums.findAlbumLive(req);
    expect(album.title).toBe('Old');
    expect(album.__fromCache).toBe(true);
    expect(queryCddbMatches).not.toHaveBeenCalled();
    expect(fetchCddbRecord).not.toHaveBeenCalled();
    expect(require('../src/logger').info).toHaveBeenCalledWith(expect.stringContaining('[cache] renewed:'));
    // the file must no longer look expired - a concurrent purge sweep must not delete it
    // (rounded: Windows round-trips mtime through 100ns FILETIME units, which can leave
    // the ms-precision double a fraction below the exact value, e.g. ...417.999 vs ...418)
    expect(Math.round(fs.statSync(file).mtimeMs)).toBeGreaterThanOrEqual(before);
  });
});

describe('findAlbumLive - test mode (fixed record)', () => {
  const realParseAlbum = jest.requireActual('../src/cddb').parseAlbum;
  const os = require('node:os');
  // self-contained fixture - deliberately NOT api/samples/gnudb-sample.txt, so
  // editing that sample (which the server reloads live) cannot break these tests
  const FIXTURE = [
    'DISCID=deadbeef',
    'DTITLE=Fixture Artist / Fixture Album',
    'DYEAR=1999',
    'DGENRE=jazz',
    'TTITLE0=First Song',
    'TTITLE1=Second Song',
    '',
  ].join('\n');
  let tmpFile;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    // test mode parses the fixed record with the real parser (cddb is mocked here)
    parseAlbum.mockImplementation(realParseAlbum);
    tmpFile = path.join(os.tmpdir(), `ps3-cddb-test-${process.pid}-${Date.now()}.txt`);
    albums.setTestRecord(FIXTURE);
  });
  afterEach(() => {
    albums.setTestRecord(null);
    fs.rmSync(tmpFile, { force: true });
  });

  /**
   * Minimal req passing tocFromRequest (nTracks >= 1, leadout+track values).
   * @param {string} tocHex - value to use as rawTocHex (the memory-cache key)
   * @returns {object} a parsed-request-shaped object suitable for findAlbumLive
   */
  function liveReq(tocHex) {
    return { rawTocHex: tocHex, toc: { nTracks: 2, values: [16000, 0, 1000, 2000] } };
  }

  it('should serve the fixed record for every disc without touching gnudb', async () => {
    const album = await albums.findAlbumLive(liveReq('01020304'));
    expect(album.title).toBe('Fixture Album');
    expect(album.artist).toBe('Fixture Artist');
    expect(album.genre).toBe('jazz');
    expect(album.year).toBe('1999');
    expect(album.tracks).toHaveLength(2);
    expect(album.tracks[0].title).toBe('First Song');
    expect(album.__fromTest).toBe(true);
    expect(queryCddbMatches).not.toHaveBeenCalled();
    expect(fetchCddbRecord).not.toHaveBeenCalled();
  });

  it('should answer two different discs with the same fields (record is disc-independent)', async () => {
    const a = await albums.findAlbumLive(liveReq('aaaa0001'));
    const b = await albums.findAlbumLive(liveReq('bbbb0002'));
    expect(a.title).toBe(b.title);
    expect(a.tracks.map((t) => t.title)).toEqual(b.tracks.map((t) => t.title));
  });

  it('should rewrite DISCID with the disc id derived from the inserted disc', async () => {
    const req = liveReq('cccc0003');
    const album = await albums.findAlbumLive(req);
    // recompute the disc id exactly like findAlbumLive does
    const { getDiscId } = require('../src/cddb');
    const { nTracks, values } = req.toc;
    const frameOffsets = [values[1] + 150];
    for (let i = 0; i < nTracks - 1; i++) frameOffsets.push(frameOffsets[i] + values[2 + i]);
    const leadoutSeconds = Math.floor((values[0] + 1 + 150) / 75);
    const expected = getDiscId(frameOffsets, nTracks, leadoutSeconds).toString(16).padStart(8, '0');
    expect(album.discId).toBe(expected);
    expect(album.__gnudbRecord).toContain(`DISCID=${expected}`);
    // the fixture record's own disc id must be gone
    expect(album.__gnudbRecord).not.toContain('DISCID=deadbeef');
  });

  it('should keep the original DISCID when the request has no usable TOC', async () => {
    const album = await albums.findAlbumLive({ rawTocHex: 'dddd0004', toc: { nTracks: 0, values: [] } });
    expect(album.discId).toBeNull();
    expect(album.__gnudbRecord).toContain('DISCID=deadbeef');
  });

  it('should reload a file-backed record when the file changes (live edit, no restart)', async () => {
    fs.writeFileSync(tmpFile, FIXTURE);
    albums.setTestRecordFile(tmpFile);
    const first = await albums.findAlbumLive(liveReq('11110001'));
    expect(first.title).toBe('Fixture Album');

    // edit the file on disk, then insert another disc
    fs.writeFileSync(tmpFile, FIXTURE.replace('Fixture Album', 'Edited Album!!'));
    const second = await albums.findAlbumLive(liveReq('11110002'));
    expect(second.title).toBe('Edited Album!!');
    expect(require('../src/logger').info).toHaveBeenCalledWith(expect.stringContaining('[test] reloaded'));
  });

  it('should not re-read an unchanged file-backed record', async () => {
    fs.writeFileSync(tmpFile, FIXTURE);
    albums.setTestRecordFile(tmpFile);
    await albums.findAlbumLive(liveReq('22220001'));
    jest.clearAllMocks();
    await albums.findAlbumLive(liveReq('22220002'));
    expect(require('../src/logger').info).not.toHaveBeenCalledWith(expect.stringContaining('[test] reloaded'));
  });

  it('should keep the last good record and warn when a file-backed record becomes unreadable', async () => {
    fs.writeFileSync(tmpFile, FIXTURE);
    albums.setTestRecordFile(tmpFile);
    expect((await albums.findAlbumLive(liveReq('33330001'))).title).toBe('Fixture Album');

    fs.rmSync(tmpFile, { force: true });
    const album = await albums.findAlbumLive(liveReq('33330002'));
    expect(album.title).toBe('Fixture Album'); // last good content kept
    expect(require('../src/logger').warn).toHaveBeenCalledWith(expect.stringContaining('keeping last good record'));
  });

  it('should report test mode via isTestMode and clear it with setTestRecord(null)', () => {
    expect(albums.isTestMode()).toBe(true);
    albums.setTestRecord(null);
    expect(albums.isTestMode()).toBe(false);
  });

  it('should report test mode active for a file-backed record too', () => {
    albums.setTestRecord(null);
    albums.setTestRecordFile(tmpFile);
    expect(albums.isTestMode()).toBe(true);
    albums.setTestRecordFile(null);
    expect(albums.isTestMode()).toBe(false);
  });

  it('should load the bundled sample when GNUDB_TEST_RECORD is a truthy flag', () => {
    albums.setTestRecord(null);
    process.env.GNUDB_TEST_RECORD = '1';
    try {
      expect(albums.loadTestRecordFromEnv()).toBe(true);
      expect(albums.isTestMode()).toBe(true);
    } finally {
      delete process.env.GNUDB_TEST_RECORD;
      albums.setTestRecord(null);
    }
  });

  it('should load a record from an explicit path in GNUDB_TEST_RECORD', () => {
    albums.setTestRecord(null);
    fs.writeFileSync(tmpFile, FIXTURE);
    process.env.GNUDB_TEST_RECORD = tmpFile;
    try {
      expect(albums.loadTestRecordFromEnv()).toBe(true);
      expect(albums.isTestMode()).toBe(true);
    } finally {
      delete process.env.GNUDB_TEST_RECORD;
      albums.setTestRecord(null);
    }
  });

  it('should log an error and stay inactive when the test record file is unreadable', () => {
    albums.setTestRecord(null);
    process.env.GNUDB_TEST_RECORD = path.join(__dirname, 'does-not-exist.txt');
    try {
      expect(albums.loadTestRecordFromEnv()).toBe(false);
      expect(albums.isTestMode()).toBe(false);
      expect(require('../src/logger').error).toHaveBeenCalledWith(expect.stringContaining('cannot read'));
    } finally {
      delete process.env.GNUDB_TEST_RECORD;
    }
  });

  it('should do nothing when GNUDB_TEST_RECORD is unset', () => {
    albums.setTestRecord(null);
    delete process.env.GNUDB_TEST_RECORD;
    expect(albums.loadTestRecordFromEnv()).toBe(false);
    expect(albums.isTestMode()).toBe(false);
  });
});