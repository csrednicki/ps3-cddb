'use strict';

/**
 * Emulator startup: logger → DNS :53 → HTTP :80.
 */

const log = require('./logger');
const { loadConfig } = require('./config');
const { startDnsServer } = require('./dns-server');
const { startHttpServer } = require('./http-server');

/**
 * Starts the emulator: logs the banner, then brings up the DNS and HTTP
 * servers. Either server's bind failure is logged and swallowed so the other
 * can still start (e.g. running without admin rights loses DNS but HTTP still works).
 * @returns {Promise<void>}
 */
async function main() {
  const cfg = loadConfig();
  log.info(`=== ${cfg.client.name} ${cfg.client.version} - CD audio metadata proxy ===`);
  log.info(`[config] answer IP: ${cfg.dns.answerIp} (set PS3 primary DNS to this address)`);

  try {
    // startDnsServer (dns2) already registers its own UDP socket internally
    // (setRawSocket(server.servers.udp)) - no extra registration needed here.
    await startDnsServer();
  } catch (e) {
    log.error(`[dns] cannot bind :${cfg.dns.port} (${e.code ?? e.message}) - run as administrator or change the port in config.json`);
  }
  try {
    await startHttpServer();
  } catch (e) {
    log.error(`[http] cannot bind :${cfg.http.port} (${e.code ?? e.message}) - change the port in config.json`);
  }

  log.info(`=== ready - the PS3 should point to ${cfg.dns.answerIp} as its DNS ===`);
}

process.on('uncaughtException', (e) => log.error(`uncaught: ${e.stack ?? e.message}`));
main();
