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
    const tocBytes = encodeTocField(2, 16000, [1000, 2000]);
    const album = await albums.findAlbumLive({ rawTocHex: '00112233', tocBytes });
    expect(album.title).toBe('Sample Sounds');
    // tocFromRequest: values=[16000(leadout), 1000, 2000] → skips d1, offset = 150 + Σ(d2..)
    expect(queryCddbMatches).toHaveBeenCalledWith([150, 2150], 2, 213);
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
    return { rawTocHex: tocHex, toc: { nTracks: 2, values: [16000, 0, 1000, 2000] } };
  }

  /**
   * Computes the same discId findAlbumLive would derive from `req`'s TOC, for
   * building/verifying its disk-cache filename.
   * @param {object} req - request built by unseededReq()
   * @returns {string} the disc id, as 8 lowercase hex digits
   */
  function discIdFor(req) {
    const { nTracks, values } = req.toc;
    const frameOffsets = [150];
    for (let i = 2; i < values.length; i++) frameOffsets.push(frameOffsets[frameOffsets.length - 1] + values[i]);
    return getDiscId(frameOffsets, nTracks, Math.floor(values[0] / 75)).toString(16).padStart(8, '0');
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