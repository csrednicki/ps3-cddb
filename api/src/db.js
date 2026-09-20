'use strict';

/**
 * The single SQLite connection shared by the gallery and the gnudb record
 * cache (node:sqlite, built into Node >= 22.5). One connection rather than one
 * per module: two writers on the same file would hit SQLITE_BUSY.
 *
 * Under Jest the store is in-memory (JEST_WORKER_ID is set by the runner) so
 * tests never touch the real database; a test that needs a real file mocks
 * config.database.dbFile (see gallery-persistence.test.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const log = require('./logger');
const cfg = require('./config').loadConfig();

// db/ is bind-mounted in docker-compose.yml, so the data survives a restart.
// Under Jest the store is in-memory so tests never touch the real database -
// unless config names an absolute path, which is a deliberate override (see
// gallery-persistence.test.js, which needs a real file to survive a reload).
const configured = cfg.database?.dbFile;
const DB_PATH = process.env.JEST_WORKER_ID && !path.isAbsolute(configured ?? '')
  ? ':memory:'
  : path.resolve(__dirname, '..', '..', configured);

let db = null;

/**
 * Opens (once) and migrates the SQLite store. Returns null when SQLite is
 * unavailable, in which case callers degrade gracefully (memory-only gallery,
 * no gnudb record cache).
 * @returns {import('node:sqlite').DatabaseSync|null} the open database, or null
 */
function openDb() {
  if (db) return db;
  try {
    if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`CREATE TABLE IF NOT EXISTS discs (
      disc_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      card_key TEXT NOT NULL,
      title TEXT, artist TEXT, genre TEXT, year TEXT, cover TEXT, artid TEXT,
      num_discs INTEGER, disc_number INTEGER,
      tracks TEXT NOT NULL,
      source TEXT, inserted_at TEXT NOT NULL,
      PRIMARY KEY (disc_id, idx)
    )`);
    // Cover art lives in its own table so re-inserting a disc (which deletes and
    // re-inserts its `discs` rows) cannot wipe the downloaded image.
    db.exec(`CREATE TABLE IF NOT EXISTS covers (
      disc_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      blob BLOB NOT NULL
    )`);
    // Raw gnudb records, keyed by CDDB disc id (rawTocHex varies between PS3
    // reads, so it is not a stable key). fetched_at is the TTL clock.
    db.exec(`CREATE TABLE IF NOT EXISTS gnudb_cache (
      disc_id TEXT PRIMARY KEY,
      record TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )`);
  } catch (e) {
    log.warn(`[db] sqlite unavailable (${DB_PATH}): ${e.message} - running without persistence`);
    db = null;
  }
  return db;
}

module.exports = { openDb, DB_PATH };
