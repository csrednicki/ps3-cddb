'use strict';

/**
 * Coverage of missing sdk branches - records.js (buildResponse with formats),
 * tlv.js (readRecords/readContainer - errors), toc.js (tocFieldSize, encodeValue
 * edge), checksum.js (integritySize, appendIntegrity default).
 */

const { TAGS, writeRecord, readRecords, writeContainer, readContainer, writeStr, writeI16, writeI32 } = require('../src/tlv');
const { buildResponse, trackRecord, errorRecord, albumRecord } = require('../src/records');
const { tocFieldSize, encodedSize, encodeValue, decodeTocField } = require('../src/toc');

describe('records.buildResponse - RESPONSE_FORMAT formats', () => {
  const album = {
    title: 'Sample Sounds', artist: 'Test Artist', genre: 'Pop',
    tracks: [{ title: 'Sample Sounds' }, { title: 'Closing Track' }],
  };

  /**
   * Runs `fn` with RESPONSE_FORMAT set to `fmt`, restoring the previous value afterward.
   * @param {string} fmt - value to set RESPONSE_FORMAT to for the duration of `fn`
   * @param {() => *} fn - callback to run under that format
   * @returns {*} fn()'s return value
   */
  const withFormat = (fmt, fn) => {
    const prev = process.env.RESPONSE_FORMAT;
    process.env.RESPONSE_FORMAT = fmt;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.RESPONSE_FORMAT;
      else process.env.RESPONSE_FORMAT = prev;
    }
  };

  it('should emit D,T,T,G,A records in RESPONSE_FORMAT order for a 2-track album', () => {
    withFormat('D,T,G,A', () => {
      const tags = readRecords(buildResponse({ album })).map((r) => r.tag);
      // the album has 2 tracks → 2 T records
      expect(tags).toEqual([TAGS.DISC, TAGS.TRACK, TAGS.TRACK, TAGS.GENRE, TAGS.ALBUM]);
    });
  });

  it('should fall back to record A when RESPONSE_FORMAT is empty', () => {
    withFormat('', () => {
      const tags = readRecords(buildResponse({ album })).map((r) => r.tag);
      expect(tags).toEqual([TAGS.ALBUM]);
    });
  });

  it('should ignore unknown tags in RESPONSE_FORMAT and fall back to A', () => {
    withFormat('XYZ', () => {
      const tags = readRecords(buildResponse({ album })).map((r) => r.tag);
      expect(tags).toEqual([TAGS.ALBUM]);
    });
  });

  it('should not emit T records when the album has no tracks', () => {
    withFormat('A,T', () => {
      const tags = readRecords(buildResponse({ album: { title: 'Empty', tracks: [] } })).map((r) => r.tag);
      expect(tags).toEqual([TAGS.ALBUM]);
    });
  });

  it('should return an empty buffer when neither error nor album is given', () => {
    expect(buildResponse({}).length).toBe(0);
  });

  it('should emit one ALBUM record per candidate when album.candidates has several matches', () => {
    const candidates = [
      { title: 'Sample Sounds', artist: 'Test Artist', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }] },
      { title: 'Sample Sounds (Special Edition)', artist: 'Test Artist', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }] },
      { title: 'Sample Sounds (Remastered)', artist: 'Test Artist', genre: 'Pop', tracks: [{ title: 'Sample Sounds' }] },
    ];
    withFormat('A', () => {
      const resp = buildResponse({ album: { ...candidates[0], candidates } });
      const recs = readRecords(resp);
      expect(recs.map((r) => r.tag)).toEqual([TAGS.ALBUM, TAGS.ALBUM, TAGS.ALBUM]);
      const titles = recs.map((r) => readContainer(r.payload)[1].toString('utf8').replace(/\0$/, ''));
      expect(titles).toEqual(candidates.map((c) => c.title));
    });
  });

  it('should emit a single ALBUM record when album.candidates is absent or has only one entry', () => {
    withFormat('A', () => {
      expect(readRecords(buildResponse({ album: { ...album, candidates: [album] } })).map((r) => r.tag))
        .toEqual([TAGS.ALBUM]);
    });
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

  it('should default a missing track artist to an empty string in the album track-group', () => {
    // covers the `album.tracks[i].artist ?? ''` branch in albumRecord
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', tracks: [{ title: 'T1', artist: 'A' }, { title: 'T2' }] });
    const slots = readContainer(rec);
    const group = readContainer(readContainer(slots[15])[0]);
    const trackList = readContainer(group[0]);
    const t1 = readContainer(trackList[1]);
    const parts = readContainer(readContainer(t1[6])[0]);
    expect(parts[1].toString('utf8').replace(/\0/g, '')).toBe('');
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
    // leadout 3 B, 3 offsets 2B+2B+2B, +1 (nTracks)
    const size = tocFieldSize(3, 100, [1, 2, 3]);
    expect(size).toBe(1 + 3 + 2 * 3);
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
    // we read it back from the {nTracks:0} base via decode
    const full = Buffer.concat([Buffer.from([0x21 /* nTracks 0 */]), buf]);
    const dec = decodeTocField(full);
    expect(dec.values[0]).toBe(v);
  });

  it('should throw when the TOC buffer is too short to decode', () => {
    expect(() => decodeTocField(Buffer.alloc(0))).toThrow(/too short/);
  });
});

describe('records.albumRecord - fallback branches', () => {
  it('should leave artist/title/genre slots as empty strings when they are missing', () => {
    const rec = albumRecord({ tracks: [{ title: 'T' }] });
    const slots = readContainer(rec);
    expect(slots[1].toString('utf8').replace(/\0/g, '')).toBe('');
    expect(slots[4].toString('utf8').replace(/\0/g, '')).toBe('');
    expect(slots[9].toString('utf8').replace(/\0/g, '')).toBe('');
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
    expect(group[2].readUInt16LE(0)).toBe(99);
  });

  it('should produce trackCount=0 without crashing when album.tracks is undefined', () => {
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z' });
    const slots = readContainer(rec);
    expect(slots[6].readUInt16LE(0)).toBe(0);
  });
});

describe('records.buildResponse - D and G formats (genre fallback)', () => {
  it('should emit a D record with the title and an empty G record for an album without genre', () => {
    const prev = process.env.RESPONSE_FORMAT;
    process.env.RESPONSE_FORMAT = 'D,G';
    try {
      const recs = readRecords(buildResponse({ album: { title: 'X', tracks: [] } }));
      expect(recs.map((r) => r.tag)).toEqual([TAGS.DISC, TAGS.GENRE]);
      const gFields = readContainer(recs[1].payload);
      expect(gFields[0].length).toBe(1); // single NUL (empty genre)
    } finally {
      if (prev === undefined) delete process.env.RESPONSE_FORMAT;
      else process.env.RESPONSE_FORMAT = prev;
    }
  });

  it('should emit an empty D record when the album has no title', () => {
    const prev = process.env.RESPONSE_FORMAT;
    process.env.RESPONSE_FORMAT = 'D';
    try {
      const recs = readRecords(buildResponse({ album: { tracks: [] } }));
      const dFields = readContainer(recs[0].payload);
      expect(dFields[0].length).toBe(1); // single NUL (empty title)
    } finally {
      if (prev === undefined) delete process.env.RESPONSE_FORMAT;
      else process.env.RESPONSE_FORMAT = prev;
    }
  });

  it('should fall back to genres[0].main in the G record when album.genre is missing', () => {
    const prev = process.env.RESPONSE_FORMAT;
    process.env.RESPONSE_FORMAT = 'G';
    try {
      const recs = readRecords(buildResponse({ album: { title: 'X', genres: [{ main: 'Pop' }] } }));
      const gFields = readContainer(recs[0].payload);
      expect(gFields[0].toString('utf8').replace(/\0/g, '')).toBe('Pop');
    } finally {
      if (prev === undefined) delete process.env.RESPONSE_FORMAT;
      else process.env.RESPONSE_FORMAT = prev;
    }
  });

  it('should not emit any records for format T when the album has no tracks', () => {
    const prev = process.env.RESPONSE_FORMAT;
    process.env.RESPONSE_FORMAT = 'T';
    try {
      const recs = readRecords(buildResponse({ album: { title: 'X' } }));
      expect(recs).toHaveLength(0); // no tracks → 0 T records (and no others)
    } finally {
      if (prev === undefined) delete process.env.RESPONSE_FORMAT;
      else process.env.RESPONSE_FORMAT = prev;
    }
  });

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

  it('should produce an empty genre when album.genre is an empty string and genres is undefined', () => {
    const prev = process.env.RESPONSE_FORMAT;
    process.env.RESPONSE_FORMAT = 'G';
    try {
      const recs = readRecords(buildResponse({ album: { title: 'X', genre: '', genres: undefined } }));
      const gFields = readContainer(recs[0].payload);
      expect(gFields[0].length).toBe(1);
      expect(gFields[0][0]).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.RESPONSE_FORMAT;
      else process.env.RESPONSE_FORMAT = prev;
    }
  });

  it('should produce an empty genre when genres is an empty array', () => {
    const prev = process.env.RESPONSE_FORMAT;
    process.env.RESPONSE_FORMAT = 'G';
    try {
      const recs = readRecords(buildResponse({ album: { title: 'X', genre: undefined, genres: [] } }));
      const gFields = readContainer(recs[0].payload);
      expect(gFields[0].length).toBe(1);
      expect(gFields[0][0]).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.RESPONSE_FORMAT;
      else process.env.RESPONSE_FORMAT = prev;
    }
  });

  it('should return an empty buffer when called without arguments', () => {
    expect(buildResponse().length).toBe(0);
  });

  it('should produce an empty genre when a genres entry has no main field', () => {
    const prev = process.env.RESPONSE_FORMAT;
    process.env.RESPONSE_FORMAT = 'G';
    try {
      const recs = readRecords(buildResponse({ album: { title: 'X', genre: undefined, genres: [{}] } }));
      const gFields = readContainer(recs[0].payload);
      expect(gFields[0].length).toBe(1);
      expect(gFields[0][0]).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.RESPONSE_FORMAT;
      else process.env.RESPONSE_FORMAT = prev;
    }
  });

  it('should fall back to record A when RESPONSE_FORMAT is not set', () => {
    const prev = process.env.RESPONSE_FORMAT;
    delete process.env.RESPONSE_FORMAT;
    try {
      const tags = readRecords(buildResponse({ album: { title: 'X', tracks: [] } })).map((r) => r.tag);
      expect(tags).toEqual([TAGS.ALBUM]);
    } finally {
      if (prev === undefined) delete process.env.RESPONSE_FORMAT;
      else process.env.RESPONSE_FORMAT = prev;
    }
  });

  it('should encode the year in slot 22 as plain ASCII YYYY (no NUL) matching PS3 ground truth', () => {
    const rec = albumRecord({ title: 'X', artist: 'Y', genre: 'Z', year: '1987', tracks: [{ title: 'T' }] });
    const slots = readContainer(rec);
    // ground truth from PS3 'Send disc info' request: slot 22 = 4-byte plain ASCII year, no NUL
    expect(slots[22].length).toBe(4);
 });
});