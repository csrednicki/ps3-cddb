'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Picks the first non-internal IPv4 LAN address across all network
 * interfaces, for use as the DNS answer IP when config.json leaves it unset.
 * @returns {string} the detected LAN IPv4 address, or '127.0.0.1' if none is found
 */
function detectLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Loads api/config.json and applies environment-variable overrides (used by
 * Docker, where auto-detecting the LAN IP would otherwise pick up the
 * container-internal address instead of the host's).
 * @returns {object} the resolved configuration
 */
function loadConfig() {
  const p = path.join(__dirname, "..", 'config.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!cfg.dns?.answerIp || cfg.dns.answerIp === '0.0.0.0') cfg.dns.answerIp = detectLanIp();

  // Environment overrides (useful for Docker, where detectLanIp() would
  // return the container-internal address instead of the host's LAN IP).
  if (process.env.HOST_IP) cfg.dns.answerIp = process.env.HOST_IP;
  if (process.env.DNS_PORT) cfg.dns.port = Number(process.env.DNS_PORT);
  if (process.env.HTTP_PORT) cfg.http.port = Number(process.env.HTTP_PORT);
  if (process.env.GNUDB_EMAIL) cfg.gnudb.email = process.env.GNUDB_EMAIL;
  if (process.env.LOG_LEVEL) cfg.log.level = process.env.LOG_LEVEL;
  if (process.env.LOG_COLOR) cfg.log.color = /^(1|true|yes)$/i.test(process.env.LOG_COLOR);

  return cfg;
}

module.exports = { loadConfig };
