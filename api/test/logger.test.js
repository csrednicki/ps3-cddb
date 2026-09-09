'use strict';

/**
 * Coverage of logger.js - write (level filtering), hexdump, dumpBinary.
 * fs mocked (writes to dumps/), config mocked (level=debug, no colors).
 */

const fs = require('node:fs');
const path = require('node:path');

jest.mock('../src/config', () => ({
  loadConfig: () => ({
    dumps: { dir: 'dumps' },
    logs: { dir: 'logs' },
    log: { level: 'debug', color: false },
  }),
}));

// Shared across every stream the logger opens, so assertions do not have to
// track which stream instance received a given line ("mock" prefix required:
// jest.mock factories are hoisted above these declarations).
const mockStreamWrite = jest.fn();
const mockStreamEnd = jest.fn();

jest.mock('node:fs', () => {
  const real = jest.requireActual('node:fs');
  return {
    ...real,
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
    createWriteStream: jest.fn(() => ({
      write: mockStreamWrite,
      end: mockStreamEnd,
      on: jest.fn(),
    })),
  };
});

const log = require('../src/logger');

describe('logger.write - level filtering', () => {
  let origLog;
  beforeEach(() => {
    origLog = console.log;
    console.log = jest.fn();
    mockStreamWrite.mockClear();
  });
  afterAll(() => { console.log = origLog; });

  it('should write to the console and the log file at level=debug', () => {
    log.debug('hello debug');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(mockStreamWrite).toHaveBeenCalledTimes(1);
    expect(mockStreamWrite.mock.calls[0][0]).toContain('[DEBUG] hello debug');
  });

  it('should always pass warn and error through regardless of the level threshold', () => {
    // force a higher threshold - the mocked config returns level=debug, so we keep it
    // simple via modules: warn and error always pass (level "debug" is the lowest)
    log.warn('a warn');
    log.error('an error');
    expect(console.log).toHaveBeenCalledTimes(2);
  });

  it('should convert buffers and non-string messages to strings', () => {
    log.info(Buffer.from('bin'));
    expect(mockStreamWrite.mock.calls[0][0]).toContain('[INFO ] bin');
  });

  it('should escape a newline so a crafted message cannot forge an extra log line', () => {
    // A DNS label may carry any octet, so this is what a hostile query name
    // trying to fake a "blacklisted" entry for someone else would look like.
    log.info('evil.example\n[2026-01-01T00:00:00.000Z] [WARN ] [dns] blacklisted 8.8.8.8');
    const written = mockStreamWrite.mock.calls[0][0];
    expect(written.split('\n').filter(Boolean)).toHaveLength(1); // still a single line
    expect(written).toContain('\\x0a');
    expect(written).not.toContain('\n[2026-01-01');
  });

  it('should escape carriage returns and ANSI escape sequences', () => {
    log.info('name\r\x1b[31mred');
    const written = mockStreamWrite.mock.calls[0][0];
    expect(written).toContain('\\x0d'); // CR
    expect(written).toContain('\\x1b'); // ESC - no terminal escape injection
  });
});

describe('logger.hexdump', () => {
  it('should render 16 bytes as one hex+ascii line', () => {
    const dump = log.hexdump(Buffer.from([0x41, 0x42, 0x43, 0xff, 0x00, 0x1a, 0x7f, 0x80, 1, 2, 3, 4, 5, 6, 7, 8]));
    const lines = dump.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('41 42 43 ff');
    expect(lines[0]).toContain('ABC'); // 0x41..0x43
    // 0x00 and 0x1a → dots
    expect(lines[0]).toContain('..');
  });

  it('should report the number of bytes omitted by the limit', () => {
    const buf = Buffer.alloc(40, 0x41);
    const dump = log.hexdump(buf, 16);
    expect(dump).toContain('... (24 more bytes)');
  });

  it('should not modify the input buffer', () => {
    const buf = Buffer.alloc(5, 0x42);
    const orig = Buffer.from(buf);
    log.hexdump(buf, 8);
    expect(buf.equals(orig)).toBe(true);
  });
});

describe('logger.write - level threshold filters lower-priority messages', () => {
  let log2;
  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      loadConfig: () => ({
        dumps: { dir: '../dumps' },
        logs: { dir: '../logs' },
        log: { level: 'warn', color: false },
      }),
    }));
    log2 = require('../src/logger');
  });
  afterAll(() => { jest.dontMock('../src/config'); jest.resetModules(); });

  it('should not write to the console or the log file for a level below the threshold', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    spy.mockClear(); // discard call history from any earlier test's console.log mock
    mockStreamWrite.mockClear();
    try {
      log2.debug('should be filtered out');
      log2.info('also filtered');
      expect(spy).not.toHaveBeenCalled();
      expect(mockStreamWrite).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('should still write warn/error at a higher threshold', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    spy.mockClear();
    try {
      log2.warn('gets through');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
});

describe('logger - color and log-file-fallback branches', () => {
  afterEach(() => { jest.dontMock('../src/config'); jest.resetModules(); });

  it('should colorize the console line when cfg.log.color is true and stdout is a TTY', () => {
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      loadConfig: () => ({
        dumps: { dir: '../dumps' },
        logs: { dir: '../logs' },
        log: { level: 'debug', color: true },
      }),
    }));
    const prevIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    const log3 = require('../src/logger');
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    spy.mockClear();
    try {
      log3.info('colored line');
      const [line] = spy.mock.calls[0];
      expect(line).toContain('\x1b['); // ANSI color escape present
    } finally { spy.mockRestore(); process.stdout.isTTY = prevIsTTY; }
  });

  it('should write to a dated log-YYYY-MM-DD.txt file in the logs directory', () => {
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      loadConfig: () => ({
        dumps: { dir: '../dumps' },
        logs: { dir: '../logs' },
        log: { level: 'debug', color: false },
      }),
    }));
    const freshFs = require('node:fs');
    const log4 = require('../src/logger');
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      log4.info('x');
      const today = new Date().toISOString().slice(0, 10);
      const call = freshFs.createWriteStream.mock.calls.find((c) => c[0].includes(`log-${today}.txt`));
      expect(call).toBeDefined();
      expect(call[1]).toEqual({ flags: 'a' }); // appends, never truncates
    } finally { spy.mockRestore(); }
  });
});

describe('logger.dumpBinary', () => {
  beforeEach(() => { fs.writeFileSync.mockClear(); process.env.ENABLE_DUMPS = '1'; });
  afterEach(() => { delete process.env.ENABLE_DUMPS; });

  it('should write the dump file with the given content and log its path', () => {
    log.info('x'); // restore state
    fs.writeFileSync.mockReset();
    const file = log.dumpBinary('my.dump', Buffer.from([1, 2, 3]));
    expect(path.basename(file)).toBe('my.dump.bin'); // returns the full path
    expect(fs.writeFileSync).toHaveBeenCalled();
    const bufArg = fs.writeFileSync.mock.calls[0][1];
    expect(Buffer.from(bufArg).toString('hex')).toBe('010203');
  });

  it('should sanitize invalid characters out of the dump file name', () => {
    const file = log.dumpBinary('req/::x', Buffer.alloc(1));
    expect(path.basename(file)).toBe('req___x.bin');
  });
});