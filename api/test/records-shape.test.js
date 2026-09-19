'use strict';

/**
 * Structural verification of the AMG response body. A small decoder walks the
 * output of buildResponse and asserts the invariants the PS3 firmware relies on
 * (record types, container sizes, mandatory 2-byte slots, hard-lock slots,
 * date format, compilation flag). See docs/dokumentacja.md for the firmware
 * facts referenced by the comments.
 */

const { TAGS, readRecords, readContainer } = require('../src/tlv');
const { buildResponse, albumRecord, trackRecord } = require('../src/records');

// Slots that are containers/lists: writing a raw string there locks the console
// (the parser reads the string's first byte as an element count).
const HARD_LOCK_SLOTS = [10, 13, 14, 16, 17, 18, 21, 24, 25];

/**
 * Decodes one ALBUM record payload into its parts.
 * @param {Buffer} payload - ALBUM record payload (a 30-slot container)
 * @returns {{slots: Buffer[], group: Buffer[], trackList: Buffer[], tracks: Buffer[][]}} decoded structure
 */
function decodeAlbum(payload) {
  const slots = readContainer(payload);
  const group = readContainer(readContainer(slots[15])[0]);
  const trackList = readContainer(group[0]);
  const tracks = trackList.map((t) => readContainer(t));
  return { slots, group, trackList, tracks };
}

/**
 * Asserts every structural invariant of an ALBUM record payload.
 * @param {Buffer} payload - ALBUM record payload
 * @returns {{slots: Buffer[], group: Buffer[], trackList: Buffer[], tracks: Buffer[][]}} the decoded album
 */
function assertAlbumShape(payload) {
  const { slots, group, trackList, tracks } = decodeAlbum(payload);

  expect(slots).toHaveLength(30); // album N = 30
  expect(group).toHaveLength(3);  // track group N = 3

  // mandatory exactly-2-byte slots
  expect(slots[28].length).toBe(2); // language code
  expect(slots[29].length).toBe(2); // acceptance threshold
  expect(slots[29].readUInt16LE(0)).toBeGreaterThanOrEqual(7);

  // hard-lock slots must be empty or a valid container (never a raw string)
  for (const s of HARD_LOCK_SLOTS) {
    const v = slots[s];
    if (v.length === 0) continue;
    expect(() => readContainer(v)).not.toThrow();
  }

  // slot 22 is either absent or "YYYY-MM-DD" (+ optional NUL)
  if (slots[22].length > 0) {
    expect(slots[22].toString('ascii')).toMatch(/^\d{4}-\d{2}-\d{2}\0?$/);
  }

  for (const track of tracks) {
    expect(track).toHaveLength(17);        // track N = 17
    expect(track[15].length).toBe(2);      // mandatory
    expect(track[16].length).toBe(2);      // mandatory
  }

  return { slots, group, trackList, tracks };
}

describe('records - response body invariants', () => {
  const album = {
    title: 'Sample Sounds', artist: 'Test Artist', genre: 'Pop', year: '2001',
    totalDuration: 2900, numDiscs: 1, discNumber: 1,
    tracks: [
      { title: 'Opening Track', duration: 273 },
      { title: 'Second Track', duration: 297 },
      { title: 'Closing Track', duration: 271 },
    ],
  };

  it('should emit only A records and keep album/group/track container sizes', () => {
    const recs = readRecords(buildResponse({ album }));
    expect(recs.every((r) => r.tag === TAGS.ALBUM)).toBe(true);
    assertAlbumShape(recs[0].payload);
  });

  it('should emit exactly one E record and no A records when there is no match', () => {
    const recs = readRecords(buildResponse({}));
    expect(recs.map((r) => r.tag)).toEqual([TAGS.ERROR]);
  });

  it('should never emit more than 10 A records', () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({ ...album, title: `Cand ${i}` }));
    const recs = readRecords(buildResponse({ album: { ...album, candidates } }));
    expect(recs.length).toBe(10);
    expect(recs.every((r) => r.tag === TAGS.ALBUM)).toBe(true);
  });

  it('should keep every slot valid across a range of album shapes', () => {
    const shapes = [
      { title: 'T', artist: 'A', genre: 'G', year: '1999', tracks: [{ title: 'x' }] },
      { title: 'No Year', artist: 'A', tracks: [{ title: 'x' }] },
      { artist: 'A', tracks: [] },
      { tracks: [{ title: 'only track' }] },
      { title: 'VA Album', artist: 'Various Artists', tracks: [{ title: 'a' }, { title: 'b', artist: 'Guest' }] },
    ];
    for (const shape of shapes) {
      assertAlbumShape(readRecords(buildResponse({ album: shape }))[0].payload);
    }
  });

  it('should set album slot 3 to "VA" exactly when the compilation rule applies', () => {
    const compilation = albumRecord({ title: 'C', artist: 'Various Artists', tracks: [{ title: 't' }] });
    expect(readContainer(compilation)[3].toString('utf8')).toBe('VA\0');

    const normal = albumRecord({ title: 'N', artist: 'Solo', tracks: [{ title: 't' }] });
    expect(readContainer(normal)[3].length).toBe(0);
  });

  it('should write "YYYY-MM-DD" into slot 22 when a year is known', () => {
    const rec = albumRecord({ ...album, year: '2001' });
    expect(readContainer(rec)[22].toString('ascii')).toBe('2001-01-01\0');
  });

  it('should leave slot 22 absent when the year is unknown', () => {
    const rec = albumRecord({ ...album, year: undefined });
    expect(readContainer(rec)[22].length).toBe(0);
  });

  it('should always produce exactly 2 bytes for the mandatory slots of a bare track', () => {
    const track = readContainer(trackRecord({ title: 'T' }));
    expect(track[15].length).toBe(2);
    expect(track[16].length).toBe(2);
  });

  it('should tolerate a track with no title or artist (empty strings, not a crash)', () => {
    const track = readContainer(trackRecord({}));
    expect(track[1].length).toBe(1); // lone NUL (empty title)
    const parts = readContainer(readContainer(track[6])[0]);
    expect(parts[0].length).toBe(1);
    expect(parts[1].length).toBe(1);
  });
});
