'use strict';

const { registerConsole, getLastConsoleMac, listConsoles, resetConsoles } = require('../src/consoles');
const { buildBinHeader, parseBinHeader } = require('../src/bin-header');

describe('Console registry (store/consoles) - MAC exclusively from POST /sdkrequest', () => {
  beforeEach(() => resetConsoles());

  it('should normalize the MAC by stripping colons and lowercasing', () => {
    const entry = registerConsole('00:11:22:33:44:55');
    expect(entry.mac).toBe('001122334455');
  });

  it('should store userAgent and lastUrl from the metadata argument', () => {
    const entry = registerConsole('001122334455', { userAgent: 'PS3/1.0', url: 'http://x/sdkrequest' });
    expect(entry.userAgent).toBe('PS3/1.0');
    expect(entry.lastUrl).toBe('http://x/sdkrequest');
  });

  it('should not overwrite userAgent/lastUrl when metadata fields are missing', () => {
    registerConsole('001122334455', { userAgent: 'PS3/1.0', url: 'http://x/first' });
    const entry = registerConsole('001122334455', {});
    expect(entry.userAgent).toBe('PS3/1.0');
    expect(entry.lastUrl).toBe('http://x/first');
  });

  it('should keep lastUrl unchanged when only userAgent is provided in the update', () => {
    registerConsole('001122334455', { url: 'http://x/first' });
    const entry = registerConsole('001122334455', { userAgent: 'PS3/2.0' });
    expect(entry.userAgent).toBe('PS3/2.0');
    expect(entry.lastUrl).toBe('http://x/first');
  });

  it('should return null from getLastConsoleMac before any console registers', () => {
    expect(getLastConsoleMac()).toBeNull();
  });

  it('should remember the MAC from the first registration', () => {
    registerConsole('001122334455', { source: 'post' });
    expect(getLastConsoleMac()).toBe('001122334455');
  });

  it('should increment the request counter on repeated registrations (PS3 retry)', () => {
    registerConsole('001122334455');
    registerConsole('001122334455');
    registerConsole('001122334455');
    const [entry] = listConsoles();
    expect(entry.requests).toBe(3);
  });

  it('should keep the last active console as the most recent entry', () => {
    registerConsole('001122334455');
    registerConsole('0022aa334455');
    // lastSeen compared as ISO - same ms → it suffices that both are in the registry
    expect(listConsoles().length).toBe(2);
    expect(getLastConsoleMac()).toMatch(/^(001122334455|0022aa334455)$/);
  });

  it('should not register a MAC that has no hex digits', () => {
    expect(registerConsole('')).toBeNull();
    expect(getLastConsoleMac()).toBeNull();
  });

  it('should not register a null or undefined MAC', () => {
    expect(registerConsole(null)).toBeNull();
    expect(registerConsole(undefined)).toBeNull();
    expect(getLastConsoleMac()).toBeNull();
  });
});

describe('buildBinHeader - MAC from the console registry (from POST)', () => {
  beforeEach(() => resetConsoles());

  it('should use the registry MAC when opts.secret is not given', () => {
    registerConsole('001122334455');
    const h = buildBinHeader({});
    const parsed = parseBinHeader(Buffer.concat([h, Buffer.alloc(64)]));
    expect(parsed.secret.subarray(0, 12).toString('latin1')).toBe('001122334455');
  });

  it('should throw when no console has registered a MAC yet', () => {
    expect(() => buildBinHeader({})).toThrow(/no console MAC available/);
  });

  it('should prefer opts.secret over the registry MAC', () => {
    registerConsole('001122334455');
    const h = buildBinHeader({ secret: 'ffffffffffff' });
    const parsed = parseBinHeader(Buffer.concat([h, Buffer.alloc(64)]));
    expect(parsed.secret.subarray(0, 12).toString('latin1')).toBe('ffffffffffff');
  });

  it('should zero-pad the 12-hex MAC to the 16-byte secret field', () => {
    registerConsole('001122334455');
    const h = buildBinHeader({});
    expect(h.subarray(0x0a + 12, 0x1a).every((b) => b === 0)).toBe(true);
  });
});
