'use strict';

const {
  encodeTocField,
  decodeTocField,
  encodedSize,
  tocKey,
  DIGIT_BASE,
  DIGIT_OFFSET,
  TWO_DIGIT_MAX,
} = require('../src/toc');

describe('TOC (FUN_000085f4/8730 - base 0xDF, offset +0x21)', () => {
  it('should encode a small value as 2 bytes [d1][d2] in base 0xDF', () => {
    const buf = Buffer.alloc(2);
    const used = require('../src/toc').encodeValue(buf, 0, 100, 0);
    expect(used).toBe(2);
    expect(buf[0]).toBe(Math.floor(100 / DIGIT_BASE) + DIGIT_OFFSET);
    expect(buf[1]).toBe((100 % DIGIT_BASE) + DIGIT_OFFSET);
  });

  it('should encode a value above 0xC161 as 4 bytes prefixed with 0xFF', () => {
    const v = TWO_DIGIT_MAX + 1;
    const buf = Buffer.alloc(4);
    const used = require('../src/toc').encodeValue(buf, 0, v, 0);
    expect(used).toBe(4);
    expect(buf[0]).toBe(0xff);
  });

  it('should always use 3 digits for the lead-out regardless of magnitude', () => {
    expect(encodedSize(100, 1)).toBe(3);
    expect(encodedSize(TWO_DIGIT_MAX + 5, 1)).toBe(3);
  });

  it('should produce a field whose used size is 1 + 3 + (nTracks+1) 2-byte values', () => {
    // [N][END:3][START][L_1..L_11] with END = START + ΣDL − 1
    const lens = [22365, 18053, 17545, 18555, 17592, 23953, 18972, 21098, 19505, 20947, 21709];
    const start = 150;
    const leadOut = start + lens.reduce((a, b) => a + b, 0) - 1;
    const buf = encodeTocField(11, leadOut, lens, start);
    expect(buf.length).toBe(1 + 3 + 2 * 12); // 28 bytes (the real request pads to 44)
    const dec = decodeTocField(buf);
    expect(dec.nTracks).toBe(11);
    expect(dec.values.map(Number)).toEqual([leadOut, start, ...lens]);
  });

  it('should roundtrip every boundary value (0, base-1, base, 2-digit max, large)', () => {
    const cases = [0, 1, 222, 223, 49569, 49570, 49696, 49697, 100000, 360000];
    for (const v of cases) {
      const lead = Math.min(v, 360000);
      const buf = encodeTocField(1, lead, [v]);
      const dec = decodeTocField(buf);
      expect(dec.values.map(Number)).toEqual([lead, 0, v]);
    }
  });

  it('should offset encoded digits by +0x21 (zero encodes as "!")', () => {
    const buf = encodeTocField(0, 0, []);
    expect(buf[1]).toBe(DIGIT_OFFSET); // lead-out d2 = 0 → 0x21
  });

  it('should always read END as exactly 3 digits, whatever the track count', () => {
    for (const n of [0, 1, 5, 40]) {
      const lens = new Array(n).fill(3000);
      const start = 0;
      const leadOut = n ? start + 3000 * n - 1 : 0;
      const dec = decodeTocField(encodeTocField(n, leadOut, lens, start));
      expect(dec.values[0]).toBe(leadOut);
      expect(dec.values).toHaveLength(n + 2);
    }
  });

  it('should throw when the field is too short for the 3-digit END', () => {
    expect(() => decodeTocField(Buffer.from([0x21, 0x21]))).toThrow(/too short/);
  });

  it('should throw on an invalid (negative) track count byte', () => {
    expect(() => decodeTocField(Buffer.from([0x10]))).toThrow(/invalid track count/);
  });

  it('should stop cleanly when the field is truncated mid-track (no throw)', () => {
    // nTracks = 3 but only 2 lengths present
    const full = encodeTocField(3, 9000, [3000, 3000, 3000], 0);
    const dec = decodeTocField(full.subarray(0, full.length - 2));
    expect(dec.nTracks).toBe(3);
    expect(dec.values.length).toBeLessThan(5);
  });

  it('should stop cleanly when a 4-byte 0xFF value is truncated', () => {
    // nTracks = 1 with a single huge (> TWO_DIGIT_MAX) value → 0xFF-prefixed
    const buf = Buffer.concat([Buffer.from([0x22]), Buffer.from([0x21, 0x21, 0x21]), Buffer.from([0xff, 0x21])]);
    const dec = decodeTocField(buf);
    expect(dec.nTracks).toBe(1);
    expect(dec.values).toHaveLength(1); // the truncated 0xFF value is dropped
  });

  it('should build a stable dash-joined tocKey from nTracks and values', () => {
    expect(tocKey(3, [100n, 200n, 300n, 400n])).toBe('3-100-200-300-400');
  });
});
