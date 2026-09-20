'use strict';

/**
 * Emulator startup: logger → DNS :53 → HTTP :80.
 */

const log = require('./logger');
const { loadConfig } = require('./config');
const { startDnsServer } = require('./dns-server');
const { startHttpServer } = require('./http-server');
const { loadTestRecordFromEnv } = require('./albums');

/**
 * Starts the emulator: logs the banner, then brings up the DNS and HTTP
 * servers. Either server's bind failure is logged and swallowed so the other
 * can still start (e.g. running without admin rights loses DNS but HTTP still works).
 * @returns {Promise<void>}
 */
async function main() {
  const cfg = loadConfig();

  // banner
  log.info(` ___  ___ ____   ___ ___  ___  ___                         `);
  log.info(`| _ \\/ __|__ /  / __|   \\|   \\| _ )  _ __ _ _ _____ ___  _ `);
  log.info(`|  _/\\__ \\|_ \\ | (__| |) | |) | _ \\ | '_ \\ '_/ _ \\ \\ / || |`);
  log.info(`|_|  |___/___/  \\___|___/|___/|___/ | .__/_| \\___/_\\_\\\\_, |`);
  log.info(`                                    |_|               |__/ `);

  log.info(`Server starting version ${cfg.client.version}`);
  log.info(`[config] answer IP: ${cfg.dns.answerIp} (set PS3 primary DNS to this address)`);
  loadTestRecordFromEnv();

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

  log.info(`[ready] PS3 should point to ${cfg.dns.answerIp} as its main DNS server`);
}

process.on('uncaughtException', (e) => log.error(`uncaught: ${e.stack ?? e.message}`));
main();
