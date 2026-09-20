'use strict';

/**
 * Cover art storage: the image is downloaded once and served from the gallery
 * database, so the page keeps working when coverartarchive.org is unreachable.
 * fetch is stubbed - no network in tests.
 */

jest.mock('../src/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
}));

const gallery = require('../src/gallery');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

beforeEach(() => {
  gallery.reset();
  global.fetch = jest.fn(async () => ({
    ok: true,
    headers: new Map([['content-type', 'image/jpeg']]),
    arrayBuffer: async () => JPEG,
  }));
});

afterEach(() => { delete global.fetch; });

/** Adds a disc and waits for the fire-and-forget cover download to settle. */
async function addWithCover(discId = 'abc12345') {
  gallery.addAlbum(
    { title: 'Album', cover: 'https://coverartarchive.org/release/x/front.jpg', tracks: [] },
    { discId },
  );
  await new Promise((r) => setImmediate(r));
}

it('should download the cover and serve it from the local URL', async () => {
  await addWithCover();
  expect(global.fetch).toHaveBeenCalledWith(
    'https://coverartarchive.org/release/x/front.jpg',
    expect.anything(),
  );
  expect(gallery.getAlbums()[0].cover).toBe('/cover/abc12345');
  expect(gallery.getCover('abc12345')).toEqual({ type: 'image/jpeg', blob: JPEG });
});

it('should keep the remote URL when the download fails', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
  await addWithCover('bad00001');
  expect(gallery.getAlbums()[0].cover).toBe('https://coverartarchive.org/release/x/front.jpg');
  expect(gallery.getCover('bad00001')).toBeNull();
});

it('should not fetch when the album has no cover URL', async () => {
  gallery.addAlbum({ title: 'No art', tracks: [] }, { discId: 'noart001' });
  await new Promise((r) => setImmediate(r));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(gallery.getCover('noart001')).toBeNull();
});
