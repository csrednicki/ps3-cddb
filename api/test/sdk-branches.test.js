'use strict';

/**
 * Coverage of missing sdk branches - records.js (buildResponse with candidates),
 * tlv.js (readRecords/readContainer - errors), toc.js (tocFieldSize, encodeValue
 * edge), checksum.js (integritySize, appendIntegrity default).
 */
const { TAGS, writeRecord, readRecords, writeContainer, readContainer, writeStr, writeI16, writeI32 } = require('../src/tlv');
const { buildResponse, trackRecord, errorRecord, albumRecord } = require('../src/records');
const { tocFieldSize, encodedSize, encodeValue, decodeTocField } = require('../src/toc');

describe('records.buildResponse - ALBUM records', () => {
  const album = {
    title: 'Sample Sounds', artist: 'Test Artist', genre: 'Pop',
    tracks: [{ title: 'Sample Sounds' }, { title: 'Closing Track' }],
  };

  it('should emit exactly one ALBUM record for a single album', () => {
    const tags = readRecords(buildResponse({ album })).map((r) => r.tag);
    expect(tags).toEqual([TAGS.ALBUM]);
  });

  it('should emit one ALBUM record per candidate when album.candidates has several matches', () => {
    const candidates = [
      { title: 'Sample Sounds', artist: 'Test Artist', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }] },
      { title: 'Sample Sounds (Special Edition)', artist: 'Test Artist', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }] },
      { title: 'Sample Sounds (Remastered)', artist: 'Test Artist', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }] },
    ];
    const resp = buildResponse({ album: { ...candidates[0], candidates } });
    const recs = readRecords(resp);
    expect(recs.map((r) => r.tag)).toEqual([TAGS.ALBUM, TAGS.ALBUM, TAGS.ALBUM]);
    const titles = recs.map((r) => readContainer(r.payload)[1].toString('utf8').replace(/\0$/, ''));
    expect(titles).toEqual(candidates.map((c) => c.title));
  });

  it('should cap candidates at 10 ALBUM records', () => {
    const candidates = Array.from({ length: 25 }, (_, i) => ({
      title: `Cand ${i}`, artist: 'A', genre: 'G', tracks: [{ title: 'T' }],
    }));
    const recs = readRecords(buildResponse({ album: { ...candidates[0], candidates } }));
    expect(recs).toHaveLength(10);
    expect(recs.every((r) => r.tag === TAGS.ALBUM)).toBe(true);
  });

  it('should emit a single ALBUM record when album.candidates has only one entry', () => {
    expect(readRecords(buildResponse({ album: { ...album, candidates: [album] } })).map((r) => r.tag))
      .toEqual([TAGS.ALBUM]);
  });

  it('should emit a single E record (not an empty body) when there is no album', () => {
    const resp = buildResponse({});
    const recs = readRecords(resp);
    expect(recs.map((r) => r.tag)).toEqual([TAGS.ERROR]);
    expect(readContainer(recs[0].payload)[0].readUInt32LE(0)).toBe(0);
  });

  it('should build the error record as a 2-field container [i32 code, string message]', () => {
    const payload = errorRecord(0x23, 'msg');
    const fields = readContainer(payload);
    expect(fields.length).toBe(2);
    expect(fields[0].readUInt32LE(0)).toBe(0x23);
  });

  it('should build the track as a 17-field container with a 4-string partsList in field 6', () => {
    const r = trackRecord({ title: 'T', artist: 'A' });
    const fields = readContainer(r);
    expect(fields.length).toBe(17);
    // field 6 = CONTAINER(partsObject) => CONTAINER(CONTAINER([...4 str]))
    const partsList = readContainer(fields[6]);
    expect(partsList.length).toBe(1);
    const parts = readContainer(partsList[0]);
    expect(parts.length).toBe(4);
    expect(parts[0].toString('utf8').replace(/\0/g, '')).toBe('T');
    expect(parts[1].toString('utf8').replace(/\0/g, '')).toBe('A');
  });

  it('should fall back to the album artist for a track without its own artist in the track-group', () => {
    // covers the `album.tracks[i].artist || albumArtist` branch in albumRecord
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', tracks: [{ title: 'T1', artist: 'A' }, { title: 'T2' }] });
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    const trackList = readContainer(group[0]);
    const t1 = readContainer(trackList[1]);
    const parts = readContainer(readContainer(t1[6])[0]);
    expect(parts[1].toString('utf8').replace(/\0/g, '')).toBe('Y'); // album artist fallback
  });
});

describe('tlv - readers (errors and edges)', () => {
  it('should throw when a record buffer is truncated mid-record', () => {
    const good = writeRecord(TAGS.ALBUM, writeStr('x'));
    const truncated = good.subarray(0, good.length - 2);
    expect(() => readRecords(truncated)).toThrow(/truncated record/);
  });

  it('should throw when there is trailing garbage after the records', () => {
    const good = writeRecord(TAGS.ALBUM, writeStr('x'));
    expect(() => readRecords(Buffer.concat([good, Buffer.from([1, 2])]))).toThrow(/trailing garbage/);
  });

  it('should read back exactly the records written', () => {
    const rec = writeRecord(TAGS.DISC, writeContainer([writeStr('')]));
    const out = readRecords(rec);
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe(TAGS.DISC);
  });

  it('should return an empty array when the container buffer is empty', () => {
    expect(readContainer(Buffer.alloc(0)).length).toBe(0);
  });

  it('should treat 0-byte values as absent fields in the container', () => {
    const c = writeContainer([Buffer.alloc(0), writeStr('a'), Buffer.alloc(0)]);
    const vals = readContainer(c);
    expect(vals).toHaveLength(3);
    expect(vals[0].length).toBe(0); // absent
    expect(vals[2].length).toBe(0); // absent separator
  });

  it('should encode null/undefined strings as a single NUL byte', () => {
    expect(writeStr(null)).toEqual(Buffer.from([0]));
    expect(writeStr(undefined)).toEqual(Buffer.from([0]));
    expect(writeStr('')).toEqual(Buffer.from([0]));
    expect(writeStr('x')).toEqual(Buffer.from([0x78, 0]));
  });

  it('should return empty buffers for fields whose offsets exceed the container length', () => {
    // hand-made container: count=2, offsets pointing past the buffer end
    const bad = Buffer.alloc(1 + 3 * 4 + 2);
    bad[0] = 2;
    bad.writeUInt32LE(1 + 3 * 4, 1);      // offset[0] = start of data
    bad.writeUInt32LE(1 + 3 * 4 + 1, 5);  // offset[1] - ok
    bad.writeUInt32LE(9999, 9);           // offset[2] - beyond buffer end
    const vals = readContainer(bad);
    expect(vals).toHaveLength(2);
    expect(vals[0].length).toBe(1);
    expect(vals[1].length).toBe(0); // out-of-range → empty (absent)
  });

  it('should return empty buffers when a field end offset is smaller than its start offset', () => {
    const bad = Buffer.alloc(1 + 3 * 4 + 2);
    bad[0] = 1;
    bad.writeUInt32LE(1 + 3 * 4, 1);      // offset[0]
    bad.writeUInt32LE(1 + 3 * 4 - 2, 5);  // offset[1] < offset[0] - invalid range
    const vals = readContainer(bad);
    expect(vals).toHaveLength(1);
    expect(vals[0].length).toBe(0); // e < s → empty (absent)
  });
});

describe('toc - tocFieldSize, encodedSize, encodeValue', () => {
  it('should sum the sizes of all encoded TOC elements plus the count byte', () => {
    // 1 (nTracks) + 3 (END) + START 2B + 3 lengths 2B each
    const size = tocFieldSize(3, 100, [1, 2, 3]);
    expect(size).toBe(1 + 3 + 2 * 4);
  });

  it('should report 4 bytes for track values above TWO_DIGIT_MAX', () => {
    const { TWO_DIGIT_MAX } = require('../src/toc');
    expect(encodedSize(TWO_DIGIT_MAX + 1, 0)).toBe(4);
  });

  it('should encode a 3-digit leadout that roundtrips through decodeTocField', () => {
    const v = 49697;
    // standalone leadout (3 digits)
    const buf = Buffer.alloc(encodedSize(v, 1));
    const used = encodeValue(buf, 0, v, 1);
    expect(used).toBe(3);
    // we read it back from the {nTracks:0} base via decode (no START/lengths follow)
    const full = Buffer.concat([Buffer.from([0x21 /* nTracks 0 */]), buf]);
    const dec = decodeTocField(full);
    expect(dec.values[0]).toBe(v);
  });

  it('should throw when the TOC buffer is too short to decode', () => {
    expect(() => decodeTocField(Buffer.alloc(0))).toThrow(/too short/);
  });
});

describe('records.albumRecord - fallback branches', () => {
  it('should leave title/artist/genre slots ABSENT (0 bytes) when they are missing', () => {
    const rec = albumRecord({ tracks: [{ title: 'T' }] });
    const slots = readContainer(rec);
    // absent (length 0) rather than a lone NUL: an absent artist makes the
    // firmware fall back to "various artist", a NUL would be an empty artist
    expect(slots[1].length).toBe(0);
    expect(slots[4].length).toBe(0);
    expect(slots[9].length).toBe(0);
  });

  it('should fall back to genres[0].main for the genre slot when album.genre is missing', () => {
    const rec = albumRecord({ title: 'X', artist: 'Y', genres: [{ main: 'Pop' }], tracks: [] });
    const slots = readContainer(rec);
    expect(slots[9].toString('utf8').replace(/\0/g, '')).toBe('Pop');
  });

  it('should clamp the track count to 99 when the album has more tracks', () => {
    const tracks = Array.from({ length: 150 }, (_, i) => ({ title: `T${i}` }));
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', tracks });
    const slots = readContainer(rec);
    expect(slots[6].readUInt16LE(0)).toBe(99);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(readContainer(group[0]).length).toBe(99); // track list clipped too
  });

  it('should produce trackCount=0 without crashing when album.tracks is undefined', () => {
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z' });
    const slots = readContainer(rec);
    expect(slots[6].readUInt16LE(0)).toBe(0);
  });

  it('should put the disc length in group element 2 (0 when unknown) and leave track slot 3 absent', () => {
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', tracks: [{ title: 'T' }] });
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(group[2].length).toBe(2);           // always a 2-byte number
    expect(group[2].readUInt16LE(0)).toBe(0);  // unknown disc length -> 0
    expect(slots[23].length).toBe(0);          // unknown album length -> absent
    const track = readContainer(readContainer(group[0])[0]);
    expect(track[3].length).toBe(0);           // unknown track length -> absent
  });

  it('should fill the duration slots when the album carries track lengths', () => {
    const rec = albumRecord({
      title: 'X', artist: 'Y', genre: 'Z',
      tracks: [{ title: 'T1', duration: 100 }, { title: 'T2', duration: 200 }],
    });
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(group[2].readUInt16LE(0)).toBe(300); // summed disc length
    expect(slots[23].readUInt16LE(0)).toBe(300); // album length
    const track = readContainer(readContainer(group[0])[0]);
    expect(track[3].readUInt16LE(0)).toBe(100);
  });

  it('should prefer album.totalDuration over the summed track lengths', () => {
    const rec = albumRecord({
      title: 'X', artist: 'Y', genre: 'Z', totalDuration: 999,
      tracks: [{ title: 'T1', duration: 100 }],
    });
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(group[2].readUInt16LE(0)).toBe(999);
    expect(slots[23].readUInt16LE(0)).toBe(999);
  });

  it('should clamp duration slots to 65535', () => {
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', tracks: [{ title: 'T', duration: 999999 }] });
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(group[2].readUInt16LE(0)).toBe(65535);
  });
});

describe('records.albumRecord - compilation flag (slot 3 = "VA")', () => {
  it('should set slot 3 to "VA" when the album artist is "various ..."', () => {
    const rec = albumRecord({ title: 'X', artist: 'Various Artists', genre: 'Z', tracks: [{ title: 'T' }] });
    const slots = readContainer(rec);
    expect(slots[3].toString('utf8')).toBe('VA\0');
  });

  it('should set slot 3 to "VA" when at least half of ALL tracks credit a different artist', () => {
    const rec = albumRecord({
      title: 'X', artist: 'Album Artist', genre: 'Z',
      tracks: [
        { title: 'T1', artist: 'Guest One' },
        { title: 'T2', artist: 'Guest Two' },
        { title: 'T3' },
        { title: 'T4' },
      ],
    });
    const slots = readContainer(rec);
    expect(slots[3].toString('utf8')).toBe('VA\0');
  });

  it('should NOT flag an album with a single duet track (Queen & David Bowie case)', () => {
    const rec = albumRecord({
      title: 'X', artist: 'Queen', genre: 'Z',
      tracks: [
        { title: 'T1', artist: 'Queen & David Bowie' },
        { title: 'T2' },
        { title: 'T3' },
        { title: 'T4' },
      ],
    });
    const slots = readContainer(rec);
    expect(slots[3].length).toBe(0);
  });

  it('should compare artists case- and whitespace-insensitively', () => {
    const rec = albumRecord({
      title: 'X', artist: 'The  Beatles', genre: 'Z',
      tracks: [
        { title: 'T1', artist: 'the beatles' },
        { title: 'T2', artist: 'THE BEATLES' },
      ],
    });
    const slots = readContainer(rec);
    expect(slots[3].length).toBe(0); // same artist, different casing -> not a compilation
  });

  it('should leave slot 3 absent when no track credits an artist', () => {
    const rec = albumRecord({ title: 'X', artist: 'Album Artist', genre: 'Z', tracks: [{ title: 'T1' }, { title: 'T2' }] });
    const slots = readContainer(rec);
    expect(slots[3].length).toBe(0);
  });

  it('should leave slot 3 absent when every track credits the album artist', () => {
    const rec = albumRecord({
      title: 'X', artist: 'Album Artist', genre: 'Z',
      tracks: [{ title: 'T1', artist: 'Album Artist' }, { title: 'T2', artist: 'Album Artist' }],
    });
    const slots = readContainer(rec);
    expect(slots[3].length).toBe(0);
  });
});

describe('records.albumRecord - TOC alignment and durations', () => {
  const mk = (n, len) => Array.from({ length: n }, (_, i) => ({ title: `T${i}`, frames: len }));

  it('should truncate the track list to the audio track count when a TOC is given', () => {
    const tracks = Array.from({ length: 15 }, (_, i) => ({ title: `T${i}` }));
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', tracks }, { audioTrackCount: 11 });
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(readContainer(group[0])).toHaveLength(11);
    expect(slots[6].readUInt16LE(0)).toBe(11);
  });

  it('should drop a leading data track when the lengths match one position in', () => {
    // gnudb lists a 3-frame data track first, then the two audio tracks
    const rec = albumRecord(
      { title: 'X', artist: 'Y', genre: 'Z', frameOffsets: [0, 3, 3003, 6003], leadout: 9003, tracks: [{ title: 'Data' }, { title: 'A' }, { title: 'B' }] },
      { audioTrackCount: 2, trackLengths: [3000, 3000] },
    );
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    const list = readContainer(group[0]);
    expect(list).toHaveLength(2);
    expect(readContainer(list[0])[1].toString('utf8').replace(/\0/g, '')).toBe('A'); // "Data" dropped
  });

  it('should not drop a track when the lengths already align at 0', () => {
    const rec = albumRecord(
      { title: 'X', artist: 'Y', genre: 'Z', frameOffsets: [150, 3150, 6150], leadout: 9150, tracks: [{ title: 'A' }, { title: 'B' }] },
      { audioTrackCount: 2, trackLengths: [3000, 3000] },
    );
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    const list = readContainer(group[0]);
    expect(readContainer(list[0])[1].toString('utf8').replace(/\0/g, '')).toBe('A');
  });

  it('should fill duration slots from the gnudb track lengths (frames / 75)', () => {
    const rec = albumRecord(
      { title: 'X', artist: 'Y', genre: 'Z', frameOffsets: [150, 7650, 15150], leadout: 22650, tracks: [{ title: 'A' }, { title: 'B' }] },
    );
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    // 7500/75 = 100 and 7500/75 = 100
    expect(readContainer(readContainer(group[0])[0])[3].readUInt16LE(0)).toBe(100);
    expect(group[2].readUInt16LE(0)).toBe(200);
    expect(slots[23].readUInt16LE(0)).toBe(200);
  });

  it('should fall back to the TOC lengths when gnudb has no offsets', () => {
    const rec = albumRecord(
      { title: 'X', artist: 'Y', genre: 'Z', tracks: [{ title: 'A' }, { title: 'B' }] },
      { audioTrackCount: 2, trackLengths: [1500, 3000] },
    );
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(readContainer(readContainer(group[0])[0])[3].readUInt16LE(0)).toBe(20); // 1500/75
    expect(group[2].readUInt16LE(0)).toBe(60); // 20 + 40
  });

  it('should prefer the TOC length over the gnudb length (TOC describes the inserted disc)', () => {
    const rec = albumRecord(
      { title: 'X', artist: 'Y', genre: 'Z', frameOffsets: [150, 7650, 15150], leadout: 22650, tracks: [{ title: 'A' }, { title: 'B' }] },
      { audioTrackCount: 2, trackLengths: [750, 3000] },
    );
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(readContainer(readContainer(group[0])[0])[3].readUInt16LE(0)).toBe(10); // 750/75 from the TOC
    expect(group[2].readUInt16LE(0)).toBe(50); // 10 + 40
  });

  it('should leave durations absent when neither gnudb nor the TOC provide lengths', () => {
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', tracks: [{ title: 'A' }] });
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(readContainer(readContainer(group[0])[0])[3].length).toBe(0);
    expect(group[2].readUInt16LE(0)).toBe(0);
    expect(slots[23].length).toBe(0);
  });

  it('should ignore gnudb offsets with no usable leadout', () => {
    const rec = albumRecord({
      title: 'X', artist: 'Y', genre: 'Z', frameOffsets: [150, 3150], leadout: null,
      tracks: [{ title: 'A' }],
    });
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(readContainer(readContainer(group[0])[0])[3].length).toBe(0);
  });

  it('should ignore a TOC with no usable audio track count', () => {
    const rec = albumRecord(
      { title: 'X', artist: 'Y', genre: 'Z', tracks: [{ title: 'A' }, { title: 'B' }] },
      { audioTrackCount: 0 },
    );
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(readContainer(group[0])).toHaveLength(2);
  });

  it('should ignore an empty TOC trackLengths array', () => {
    const rec = albumRecord(
      { title: 'X', artist: 'Y', genre: 'Z', tracks: [{ title: 'A' }] },
      { audioTrackCount: 1, trackLengths: [] },
    );
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    expect(readContainer(readContainer(group[0])[0])[3].length).toBe(0);
  });

  it('should return 0 from the alignment search when no window matches', () => {
    // gnudb lengths [3, 3000] vs a disc whose first track is 5000 frames: no match
    const rec = albumRecord(
      { title: 'X', artist: 'Y', genre: 'Z', frameOffsets: [0, 3, 3003], leadout: 6003, tracks: [{ title: 'Data' }, { title: 'A' }] },
      { audioTrackCount: 1, trackLengths: [5000] },
    );
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    const list = readContainer(group[0]);
    expect(readContainer(list[0])[1].toString('utf8').replace(/\0/g, '')).toBe('Data'); // k = 0
  });

  it('should not shift a single-audio-track disc (nothing to compare)', () => {
    const rec = albumRecord(
      { title: 'X', artist: 'Y', genre: 'Z', frameOffsets: [0, 3, 3003], leadout: 6003, tracks: [{ title: 'Data' }, { title: 'Only' }] },
      { audioTrackCount: 1, trackLengths: [3000] },
    );
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    const list = readContainer(group[0]);
    expect(readContainer(list[0])[1].toString('utf8').replace(/\0/g, '')).toBe('Data');
  });
});

describe('records.buildResponse - error records and slot 22 date', () => {
  it('should emit an E record when an error is given', () => {
    const recs = readRecords(buildResponse({ error: { code: 0x23, message: 'x' } }));
    expect(recs.map((r) => r.tag)).toEqual([TAGS.ERROR]);
  });

  it('should fall back to an empty message string when errorRecord gets no message', () => {
    const payload = errorRecord(0x1f, undefined);
    const fields = readContainer(payload);
    expect(fields[0].readUInt32LE(0)).toBe(0x1f);
    expect(fields[1].length).toBe(1); // sam NUL
    expect(fields[1][0]).toBe(0);
  });

  it('should emit an E record with code 0 when called without arguments', () => {
    const recs = readRecords(buildResponse());
    expect(recs.map((r) => r.tag)).toEqual([TAGS.ERROR]);
    expect(readContainer(recs[0].payload)[0].readUInt32LE(0)).toBe(0);
  });

  it('should encode slot 22 as a NUL-terminated ASCII YYYY-MM-DD date (year only → YYYY-01-01)', () => {
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', year: '1987', tracks: [{ title: 'T' }] });
    const slots = readContainer(rec);
    // firmware reads year/month/day from offsets 0/5/8, so a bare year would
    // produce a garbage month/day - gnudb only gives us the year, so we pad it
    expect(slots[22].toString('ascii')).toBe('1987-01-01\0');
  });

  it('should preserve an explicit month/day when the album already carries a full date', () => {
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', year: '1987-05-12', tracks: [{ title: 'T' }] });
    const slots = readContainer(rec);
    expect(slots[22].toString('ascii')).toBe('1987-05-12\0');
  });

  it('should leave slot 22 absent when there is no usable year', () => {
    for (const year of [undefined, '', 'unknown', 0]) {
      const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', year, tracks: [{ title: 'T' }] });
      expect(readContainer(rec)[22].length).toBe(0);
    }
  });
});