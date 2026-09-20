'use strict';

/**
 * Coverage of gallery.js - the in-memory disc store, the SSE stream and the
 * page renderer. No network and no real HTTP server: handleEvents is driven
 * with a minimal fake request/response pair.
 */

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const { EventEmitter } = require('node:events');
const gallery = require('../src/gallery');

/**
 * Minimal ServerResponse stand-in: records writes, is an EventEmitter (so the
 * 'close' handler can be driven by the test) and lets the test emit 'close'.
 * @returns {{res: object, req: object, writes: string[]}} the fake pair
 */
function fakePair() {
  const writes = [];
  const res = new EventEmitter();
  res.writeHead = jest.fn();
  res.write = jest.fn((s) => { writes.push(s); return true; });
  res.end = jest.fn();
  const req = new EventEmitter();
  return { res, req, writes };
}

beforeEach(() => gallery.reset());

describe('gallery.addAlbum / getAlbums', () => {
  it('should store a single album as one card', () => {
    gallery.addAlbum(
      { title: 'Album', artist: 'Artist', genre: 'Rock', year: '2000', cover: 'http://c/1.jpg', tracks: [{ title: 'T1' }] },
      { discId: 'abc12345', source: 'live' },
    );
    const cards = gallery.getAlbums();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: 'abc12345', discId: 'abc12345', title: 'Album', artist: 'Artist', source: 'live' });
  });

  it('should ignore a null album or a missing disc id', () => {
    expect(gallery.addAlbum(null, { discId: 'abc' })).toBeNull();
    expect(gallery.addAlbum({ title: 'x' }, {})).toBeNull();
    expect(gallery.getAlbums()).toHaveLength(0);
  });

  it('should replace the previous entry for the same disc id', () => {
    gallery.addAlbum({ title: 'First', tracks: [] }, { discId: 'abc12345' });
    gallery.addAlbum({ title: 'Second', tracks: [] }, { discId: 'abc12345' });
    const cards = gallery.getAlbums();
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Second');
  });

  it('should keep every candidate as a separate card under the same disc id', () => {
    gallery.addAlbum(
      {
        title: 'Primary',
        tracks: [],
        candidates: [{ title: 'Primary', tracks: [] }, { title: 'Alt', tracks: [] }],
      },
      { discId: 'abc12345' },
    );
    const cards = gallery.getAlbums();
    expect(cards.map((c) => c.title)).toEqual(['Primary', 'Alt']);
    expect(cards.map((c) => c.key)).toEqual(['abc12345', 'abc12345:1']);
  });

  it('should promote the candidate that carries a cover to the first position', () => {
    gallery.addAlbum(
      {
        title: 'No Cover',
        tracks: [],
        candidates: [
          { title: 'No Cover', tracks: [] },
          { title: 'Alt', tracks: [], cover: 'https://x/2.jpg' },
        ],
      },
      { discId: 'abc12345' },
    );
    const cards = gallery.getAlbums();
    expect(cards[0].title).toBe('Alt');
    expect(cards[0].cover).toBe('https://x/2.jpg');
    expect(cards[0].key).toBe('abc12345');
    expect(cards[1].title).toBe('No Cover');
  });

  it('should keep the first candidate when none of them has a cover', () => {
    gallery.addAlbum(
      {
        title: 'First',
        tracks: [],
        candidates: [{ title: 'First', tracks: [] }, { title: 'Second', tracks: [] }],
      },
      { discId: 'abc12345' },
    );
    expect(gallery.getAlbums()[0].title).toBe('First');
  });

  it('should expose the stored groups with all candidates in display order', () => {
    gallery.addAlbum(
      {
        title: 'No Cover',
        tracks: [],
        candidates: [{ title: 'No Cover', tracks: [] }, { title: 'With Cover', tracks: [], cover: 'https://x/1.jpg' }],
      },
      { discId: 'abc12345' },
    );
    const groups = gallery.getGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].discId).toBe('abc12345');
    expect(groups[0].albums.map((a) => a.title)).toEqual(['With Cover', 'No Cover']);
  });

  it('should derive per-track durations from frame offsets and leadout', () => {
    gallery.addAlbum(
      { title: 'A', tracks: [{ title: 'T1' }, { title: 'T2' }], frameOffsets: [0, 750], leadout: 2250 },
      { discId: 'abc12345' },
    );
    const [card] = gallery.getAlbums();
    expect(card.tracks.map((t) => t.duration)).toEqual([10, 20]);
  });

  it('should leave durations null when the record has no usable offsets', () => {
    gallery.addAlbum({ title: 'A', tracks: [{ title: 'T1' }] }, { discId: 'abc12345' });
    const [card] = gallery.getAlbums();
    expect(card.tracks[0].duration).toBeNull();
  });

  it('should default the source to live and normalize missing fields', () => {
    gallery.addAlbum({ tracks: [] }, { discId: 'abc12345' });
    const [card] = gallery.getAlbums();
    expect(card.source).toBe('live');
    expect(card.title).toBe('');
    expect(card.artist).toBe('');
    expect(card.cover).toBe('');
    expect(card.numDiscs).toBe(1);
  });
});

describe('gallery.handleEvents (SSE)', () => {
  it('should send the snapshot immediately and register the client', () => {
    gallery.addAlbum({ title: 'Album', tracks: [] }, { discId: 'abc12345' });
    const { res, req, writes } = fakePair();
    gallery.handleEvents(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': expect.stringContaining('text/event-stream') }));
    const snapshot = writes.find((w) => w.includes('"type":"snapshot"'));
    expect(snapshot).toBeDefined();
    expect(snapshot).toContain('"title":"Album"');
    res.emit('close');
  });

  it('should keep the client registered after the request itself closes', () => {
    // Node >= 16 fires 'close' on the IncomingMessage as soon as the request
    // body is read - a GET is immediate, so that event must not unregister the
    // client or live updates would never arrive.
    const { res, req, writes } = fakePair();
    gallery.handleEvents(req, res);
    req.emit('close');
    gallery.addAlbum({ title: 'New', tracks: [] }, { discId: 'deadbeef' });
    expect(writes.some((w) => w.includes('"type":"update"'))).toBe(true);
    res.emit('close');
  });

  it('should push an update to a connected client when a disc is added', () => {
    const { res, req, writes } = fakePair();
    gallery.handleEvents(req, res);
    gallery.addAlbum({ title: 'New', tracks: [] }, { discId: 'deadbeef' });
    const update = writes.find((w) => w.includes('"type":"update"'));
    expect(update).toBeDefined();
    expect(update).toContain('"title":"New"');
    res.emit('close');
  });

  it('should stop sending updates after the client disconnects', () => {
    const { res, req, writes } = fakePair();
    gallery.handleEvents(req, res);
    res.emit('close');
    const before = writes.length;
    gallery.addAlbum({ title: 'After', tracks: [] }, { discId: 'deadbeef' });
    expect(writes.length).toBe(before);
  });

  it('should survive a write failure on a stale client', () => {
    const { res, req } = fakePair();
    gallery.handleEvents(req, res);
    res.write.mockImplementation(() => { throw new Error('gone'); });
    expect(() => gallery.addAlbum({ title: 'X', tracks: [] }, { discId: 'deadbeef' })).not.toThrow();
    res.emit('close');
  });
});

describe('gallery.renderPage', () => {
  it('should render the header, version and SSE wiring', () => {
    const html = gallery.renderPage('1.1.0');
    expect(html).toContain('PS3 CDDB proxy');
    expect(html).toContain('version 1.1.0');
    expect(html).toContain("new EventSource('/events')");
    expect(html).toContain('background:#000');
  });
});

describe('gallery.reset', () => {
  it('should clear the store and close connected clients', () => {
    const { res, req } = fakePair();
    gallery.handleEvents(req, res);
    gallery.addAlbum({ title: 'Album', tracks: [] }, { discId: 'abc12345' });
    gallery.reset();
    expect(gallery.getAlbums()).toHaveLength(0);
    expect(res.end).toHaveBeenCalled();
  });
});