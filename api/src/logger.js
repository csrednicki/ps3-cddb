'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');

const cfg = loadConfig();
const LOGS_DIR = path.resolve(__dirname, "..", "..", cfg.logs.dir);
const DUMPS_DIR = path.resolve(__dirname, "..", "..", cfg.dumps.dir);

fs.mkdirSync(LOGS_DIR, { recursive: true });

const LEVELS = {
  debug: 10,
   info: 20,
   warn: 30,
   error: 40
};

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';
const useColor = cfg.log.color && process.stdout.isTTY;

/**
 * Path of today's log file, rolling over at midnight (UTC date in the filename).
 * @returns {string} absolute path to the current day's log file
 */
function logFilePath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `log-${date}.txt`);
}

/**
 * Current timestamp for a log line.
 * @returns {string} ISO-8601 timestamp
 */
function ts() {
  return new Date().toISOString();
}

/**
 * Escapes control and format characters in a log message. Messages carry data
 * taken straight off the wire (a DNS label may contain any octet), so an
 * embedded newline would let a remote client forge whole log lines - and
 * anything that later bans IPs by parsing this file would act on the forgery.
 * Escaping rather than dropping keeps the original bytes visible.
 * @param {*} msg - raw message (coerced to string)
 * @returns {string} the message with control/format characters replaced by \xHH escapes
 */
function sanitize(msg) {
  return String(msg).replace(
    /[\p{Cc}\p{Cf}]/gu,
    (ch) => `\\x${ch.codePointAt(0).toString(16).padStart(2, '0')}`,
  );
}

// Appending write stream, reopened when the date (and therefore the file name)
// rolls over. Deliberately async: appendFileSync blocked the event loop on
// every line, which a flood of queries could turn into a denial of service.
let stream = null;
let streamPath = null;

/**
 * Returns the open write stream for today's log file, rolling it over
 * (closing the old stream, opening a new one) when the date has changed.
 * @returns {import('node:fs').WriteStream} the current append stream
 */
function logStream() {
  const file = logFilePath();
  if (stream && streamPath === file) return stream;
  if (stream) stream.end();
  streamPath = file;
  stream = fs.createWriteStream(file, { flags: 'a' });
  // Never let a logging failure take the server down with it.
  stream.on('error', (e) => console.error(`[logger] cannot write ${file}: ${e.message}`));
  return stream;
}

/**
 * Formats and emits one log line, to stdout (optionally colored) and to today's log file.
 * Below-threshold levels (per cfg.log.level) are dropped without formatting or writing.
 * @param {'debug'|'info'|'warn'|'error'} level - severity level
 * @param {*} msg - message to log (sanitized before writing)
 * @returns {void}
 */
function write(level, msg) {
  if (LEVELS[level] < LEVELS[cfg.log.level]) return;
  // The message is sanitized before the colour codes are added, so our own
  // escapes survive while anything the client supplied cannot inject its own.
  const line = `[${ts()}] [${level.toUpperCase().padEnd(5)}] ${sanitize(msg)}`;
  const colored = useColor ? `${COLORS[level]}${line}${RESET}` : line;
  console.log(colored);
  logStream().write(line + '\n');
}

/**
 * Renders a buffer as a classic hex+ASCII dump (16 bytes per row), for debug logging.
 * @param {Buffer} buf - buffer to dump
 * @param {number} [limit=512] - maximum number of bytes to render
 * @returns {string} the multi-line dump, with a trailing "... (N more bytes)" note if truncated
 */
function hexdump(buf, limit = 512) {
  const b = Buffer.from(buf.subarray(0, limit));
  const lines = [];
  for (let i = 0; i < b.length; i += 16) {
    const row = b.subarray(i, i + 16);
    const hex = [...row].map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    lines.push(`${i.toString(16).padStart(4, '0')}  ${hex}  ${ascii}`);
  }
  if (buf.length > limit) lines.push(`... (${buf.length - limit} more bytes)`);
  return lines.join('\n');
}

/**
 * Writes a binary dump to dumps/. No-op unless ENABLE_DUMPS=1.
 * @param {string} name - base filename (sanitized), without extension
 * @param {Buffer} buf - raw bytes to save
 * @returns {string|null} the saved file's path, or null when dumps are disabled
 */
function dumpBinary(name, buf) {
  if (process.env.ENABLE_DUMPS !== '1') return null;
  fs.mkdirSync(DUMPS_DIR, { recursive: true });
  const safe = name.replace(/[^\w.-]/g, '_');
  const file = path.join(DUMPS_DIR, `${safe}.bin`);
  fs.writeFileSync(file, buf);
  write('info', `dump saved: ${file} (${buf.length} bytes)`);
  return file;
}

/** debug/info/warn/error: log a message at that level (see write()). */
module.exports = {
  debug: (m) => write('debug', m),
  info: (m) => write('info', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),
  hexdump,
  dumpBinary,
  DUMPS_DIR,
};
