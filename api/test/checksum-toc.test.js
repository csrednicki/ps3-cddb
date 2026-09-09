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

  it('should produce a 44-byte field that roundtrips for the MJ Bad disc (11 tracks)', () => {
    const leadOut = 217172;
    const offs = [18587, 40952, 59005, 76550, 95105, 112697, 136650, 155622, 176720, 196225, 217172];
    const buf = encodeTocField(11, leadOut, offs);
    expect(buf.length).toBe(44); // size matching the real PS3 dump!
    const dec = decodeTocField(buf);
    expect(dec.nTracks).toBe(11);
    expect(dec.values.map(Number)).toEqual([leadOut, ...offs]);
  });

  it('should roundtrip every boundary value (0, base-1, base, 2-digit max, large)', () => {
    const cases = [0, 1, 222, 223, 49569, 49570, 49696, 49697, 100000, 360000];
    for (const v of cases) {
      const lead = Math.min(v, 360000);
      const buf = encodeTocField(1, lead, [v]);
      const dec = decodeTocField(buf);
      expect(dec.values.map(Number)).toEqual([lead, v]);
    }
  });

  it('should offset encoded digits by +0x21 (zero encodes as "!")', () => {
    const buf = encodeTocField(0, 0, []);
    expect(buf[1]).toBe(DIGIT_OFFSET); // lead-out d2 = 0 → 0x21
  });

  it('should build a stable dash-joined tocKey from nTracks and values', () => {
    expect(tocKey(3, [100n, 200n, 300n, 400n])).toBe('3-100-200-300-400');
  });
});
