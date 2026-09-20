'use strict';

/**
 * The point of the SQLite store: a disc added in one process is still there in
 * the next one. Points config at a throwaway file so it never touches the real db.
 */

jest.mock('../src/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
}));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mockDbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-')), 'ps3cddb.sqlite');

jest.mock('../src/config', () => ({
  loadConfig: () => ({ database: { dbFile: mockDbFile } }),
}));

it('should restore discs added by a previous process', () => {
  const first = require('../src/gallery');
  first.addAlbum(
    { title: 'Persisted', artist: 'Artist', tracks: [{ title: 'T1' }] },
    { discId: 'deadbeef', source: 'live' },
  );

  jest.resetModules();
  const second = require('../src/gallery');
  const cards = second.getAlbums();

  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ discId: 'deadbeef', title: 'Persisted', source: 'live' });
  expect(cards[0].tracks.map((t) => t.title)).toEqual(['T1']);
});
