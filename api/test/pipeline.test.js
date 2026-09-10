'use strict';

const { extractMultipartBody } = require('../src/http-server');
const { buildBinHeader } = require('../src/bin-header');
const { writeRecord, TAGS, readRecords, readContainer } = require('../src/tlv');
const { buildResponse, albumRecord } = require('../src/records');
const { encodeTocField } = require('../src/toc');

const BOUNDARY = '---------------------------265001916915724';

describe('HTTP multipart (extractMultipartBody)', () => {
  it('should extract the body after the part headers from a full multipart request', () => {
    const inner = Buffer.from('BIN-payload-here');
    const raw = Buffer.concat([
      Buffer.from(
        `POST http://dmr.allmusic.com/sdkrequest HTTP/1.0\r\nHost: dmr.allmusic.com\r\n` +
        `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\nContent-Length: 999\r\n\r\n` +
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="data"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      inner,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
    expect(extractMultipartBody(raw, BOUNDARY).equals(inner)).toBe(true);
  });

  it('should treat the whole input as the body when there is no multipart envelope', () => {
    const inner = Buffer.from('raw-body');
    expect(extractMultipartBody(inner, BOUNDARY).equals(inner)).toBe(true);
  });
});

describe('BIN header (buildBinHeader)', () => {
  beforeEach(() => {
    // The MAC must be captured from a request (GET/POST) - we register the console
    require('../src/consoles').registerConsole('001122334455', { source: 'get' });
  });

  it('should build a 52-byte header matching the layout with LE selectors', () => {
    const h = buildBinHeader({});
    expect(h.length).toBe(0x34);
    expect(h.subarray(0, 4).toString('latin1')).toBe('BIN ');
    expect(h.readUInt16LE(0x2a)).toBe(3);
    expect(h.readUInt16LE(0x2c)).toBe(3);
    expect(String.fromCharCode(h[0x2e])).toBe('H');
  });
});

describe('Synthetic request → response (roundtrip)', () => {
  it('should roundtrip the TOC field through encodeTocField/decodeTocField', () => {
    const nTracks = 3;
    const leadOut = 20000;
    const offsets = [1000, 5000, 9000];
    const field = encodeTocField(nTracks, leadOut, offsets);
    const dec = require('../src/toc').decodeTocField(field);
    expect(dec.nTracks).toBe(nTracks);
    expect(dec.values.map(Number)).toEqual([leadOut, ...offsets]);
  });

  it('should emit a single ALBUM record readable by the TLV reader', () => {
    const album = {
      title: 'T', artist: 'A', year: 2000,
      genres: [{ main: 'Pop' }],
      tracks: [{ title: 'X', artist: 'A', trackNumber: 1, duration: 100 }],
    };
    const resp = buildResponse({ album });
    const records = readRecords(resp);
    expect(records.map((r) => r.tag)).toEqual([TAGS.ALBUM]);
  });

  it('should place album fields in slots matching the ground-truth map', () => {
    const album = {
      title: 'Sample Sounds', artist: 'Test Artist',
      genres: [{ main: 'Pop' }],
      tracks: [
        { title: 'Sample Sounds', artist: 'Test Artist' },
        { title: 'Second Track' },
      ],
    };
    const buf = albumRecord(album);
    expect(buf[0]).toBe(30); // 30 slots
    const slots = readContainer(buf);
    const txt = (n) => slots[n].toString('utf8').replace(/\0/g, '');
    expect(txt(1)).toBe('Sample Sounds');       // Album
    expect(txt(4)).toBe('Test Artist');         // Artist
    expect(txt(9)).toBe('Pop');                 // Genre
    expect(slots[6].readUInt16LE(0)).toBe(2);   // track count
    expect(slots[7].readUInt16LE(0)).toBe(1);
    expect(slots[11].readUInt16LE(0)).toBe(1);  // Disc Number (2nd half)
    expect(slots[28].readUInt16LE(0)).toBe(0);
    expect(slots[29].readUInt16LE(0)).toBe(7);  // track view (>6)
    // hard-lock slots: must be ABSENT (0 bytes)
    for (const s of [10, 13, 14, 16, 17, 18, 21, 24, 25]) {
      expect(slots[s].length).toBe(0);
    }
    // empty-string slots: exactly 1 NUL byte
    for (const s of [0, 2, 3, 5, 8, 12, 19, 20, 26, 27]) {
      expect(slots[s].length).toBe(1);
      expect(slots[s][0]).toBe(0);
    }
    // track-group in slot 15: CONTAINER(group) → [trackList, i16(1), i16(N)]
    const group = readContainer(readContainer(buf)[15])[0];
    const g = readContainer(group);
    expect(g.length).toBe(3);
    expect(g[1].readUInt16LE(0)).toBe(1);
    expect(g[2].readUInt16LE(0)).toBe(2);
    const trackList = readContainer(g[0]);
    expect(trackList.length).toBe(2);
    const t0 = readContainer(trackList[0]);
    expect(t0.length).toBe(17); // track = 17 fields
    expect(t0[1].toString('utf8').replace(/\0/g, '')).toBe('Sample Sounds');
    expect(t0[15].readUInt16LE(0)).toBe(0); // mandatory i16
    expect(t0[16].readUInt16LE(0)).toBe(0);
    // track field 6 = parts(4 strings): [title, artist, '', '']
    const parts = readContainer(readContainer(t0[6])[0]);
    expect(parts.length).toBe(4);
    expect(parts[0].toString('utf8').replace(/\0/g, '')).toBe('Sample Sounds');
  });
});
