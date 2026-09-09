'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Read the real config.json as a base fixture
const cfgPath = path.join(__dirname, '..', 'config.json');
const baseCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

/**
 * Loads config.js with a fresh module registry, mocking config.json to the
 * base fixture merged with `overrides`, so each test gets an isolated config.
 * @param {object} overrides - fields to merge on top of the real config.json fixture
 * @returns {object} the resolved configuration
 */
function loadFreshConfig(overrides) {
  jest.resetModules();
  jest.doMock('node:fs', () => ({
    ...jest.requireActual('node:fs'),
    readFileSync: (p) => {
      if (String(p).endsWith('config.json')) return JSON.stringify({ ...baseCfg, ...overrides });
      return jest.requireActual('node:fs').readFileSync(p);
    },
  }));
  return require('../src/config').loadConfig();
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('loadConfig - answerIp auto-detection', () => {
  it('should keep a non-empty answerIp from config as-is', () => {
    const cfg = loadFreshConfig({ dns: { ...baseCfg.dns, answerIp: '10.0.0.1' } });
    expect(cfg.dns.answerIp).toBe('10.0.0.1');
  });

  it('should auto-detect the LAN IP when answerIp is 0.0.0.0', () => {
    const spy = jest.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [{ family: 'IPv4', internal: false, address: '192.168.0.99' }],
    });
    const cfg = loadFreshConfig({ dns: { ...baseCfg.dns, answerIp: '0.0.0.0' } });
    expect(cfg.dns.answerIp).toBe('192.168.0.99');
    spy.mockRestore();
  });

  it('should auto-detect the LAN IP when answerIp is empty', () => {
    const spy = jest.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [{ family: 'IPv4', internal: false, address: '192.168.0.42' }],
    });
    const cfg = loadFreshConfig({ dns: { ...baseCfg.dns, answerIp: '' } });
    expect(cfg.dns.answerIp).toBe('192.168.0.42');
    spy.mockRestore();
  });

  it('should skip loopback and link-local interfaces during auto-detection', () => {
    const spy = jest.spyOn(os, 'networkInterfaces').mockReturnValue({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      ll: [{ family: 'IPv4', internal: false, address: '169.254.1.1' }],
      eth0: [{ family: 'IPv4', internal: false, address: '10.1.2.3' }],
    });
    const cfg = loadFreshConfig({ dns: { ...baseCfg.dns, answerIp: '' } });
    expect(cfg.dns.answerIp).toBe('10.1.2.3');
    spy.mockRestore();
  });

  it('should fall back to 127.0.0.1 when no usable interface exists', () => {
    const spy = jest.spyOn(os, 'networkInterfaces').mockReturnValue({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    });
    const cfg = loadFreshConfig({ dns: { ...baseCfg.dns, answerIp: '' } });
    expect(cfg.dns.answerIp).toBe('127.0.0.1');
    spy.mockRestore();
  });
});
