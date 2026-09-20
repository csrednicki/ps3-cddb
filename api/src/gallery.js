'use strict';

/**
 * In-memory gallery of the discs inserted into the PS3 since the server
 * started, plus the web page that shows them.
 *
 * There is deliberately no database: the store lives only in this process and
 * is lost on restart (see README). Every disc the PS3 asks about is added here
 * by http-server.js right after the gnudb lookup, and the page is updated live
 * over Server-Sent Events (SSE) - no polling, no extra dependencies.
 *
 * Deduplication is by disc id: re-inserting the same disc replaces its entry
 * instead of adding a second one. A disc whose TOC is ambiguous can resolve to
 * several gnudb candidates; all of them are kept (as separate cards) under the
 * same disc id, so the group is replaced as a whole on re-insert.
 *
 * The page markup itself lives in gallery.html, loaded once and cached.
 */

const fs = require('node:fs');
const path = require('node:path');
const log = require('./logger');

// discId -> { discId, insertedAt, source, albums: card[] }
const discs = new Map();
// open SSE responses (one per connected browser tab)
const clients = new Set();
// keep-alive timers, one per connected client (cleared on disconnect/reset)
const pings = new Set();

const TEMPLATE_PATH = path.join(__dirname, 'gallery.html');

let template = null;

/**
 * Normalizes one track into the shape the page renders.
 * @param {{title?: string, artist?: string, duration?: number}} t - raw track
 * @returns {{title: string, artist: string, duration: number|null}} normalized track
 */
function normalizeTrack(t) {
  const duration = Number(t?.duration);
  return {
    title: String(t?.title ?? ''),
    artist: String(t?.artist ?? ''),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

/**
 * Per-track durations in seconds derived from gnudb's frame offsets and
 * leadout (each length is the gap to the next offset; the last is
 * leadout - last offset). Returns null when the record carries no usable
 * offsets, in which case the page simply omits durations.
 * @param {number[]} [frameOffsets] - gnudb track frame offsets (frames)
 * @param {number|null} [leadout] - gnudb leadout (frames)
 * @returns {number[]|null} per-track durations in seconds, or null
 */
function trackDurations(frameOffsets, leadout) {
  if (!Array.isArray(frameOffsets) || frameOffsets.length === 0) return null;
  if (!Number.isFinite(leadout) || leadout <= frameOffsets[frameOffsets.length - 1]) return null;
  const lens = [];
  for (let i = 0; i < frameOffsets.length - 1; i++) lens.push(frameOffsets[i + 1] - frameOffsets[i]);
  lens.push(leadout - frameOffsets[frameOffsets.length - 1]);
  return lens.map((f) => Math.round(f / 75));
}

/**
 * Builds one card (the JSON the page renders) from an album object.
 * @param {object} album - album as returned by findAlbumLive
 * @param {string} discId - CDDB disc id (8 hex digits)
 * @param {string} source - where the album came from ('live' | 'cache' | 'test')
 * @param {string} insertedAt - ISO timestamp of the insertion
 * @returns {object} the card (its `key` is assigned by addAlbum after ordering)
 */
function toCard(album, discId, source, insertedAt) {
  const durations = trackDurations(album?.frameOffsets, album?.leadout);
  const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
  return {
    key: discId,
    discId,
    title: String(album?.title ?? ''),
    artist: String(album?.artist ?? ''),
    genre: String(album?.genre ?? ''),
    year: String(album?.year ?? ''),
    cover: String(album?.cover ?? ''),
    artid: String(album?.artid ?? ''),
    numDiscs: Number(album?.numDiscs) || 1,
    discNumber: Number(album?.discNumber) || 1,
    tracks: tracks.map((t, i) => normalizeTrack({ ...t, duration: durations?.[i] })),
    source,
    insertedAt,
  };
}

/**
 * Picks which candidate to show on the gallery card. The PS3 chooses a
 * candidate itself and we never see that choice, so the most identifiable one
 * is shown: the first candidate that carries cover art, falling back to the
 * first candidate when none has any. Every candidate stays available in the
 * modal, one tab each.
 * @param {object[]} list - the candidates for one disc
 * @returns {number} index of the chosen candidate
 */
function choosePrimaryIndex(list) {
  const i = list.findIndex((a) => String(a?.cover ?? '').trim());
  return i === -1 ? 0 : i;
}

/**
 * Adds (or replaces) a disc in the gallery and pushes the change to every
 * connected page. A disc with several gnudb candidates keeps them all in
 * `albums`, ordered so the cover-bearing one comes first (the card shown on
 * the page).
 * @param {object} album - album as returned by findAlbumLive (may carry `candidates`)
 * @param {{discId: string, source?: string}} meta - disc id and lookup source
 * @returns {object|null} the stored group, or null when there is nothing to store
 */
function addAlbum(album, { discId, source = 'live' } = {}) {
  if (!album || !discId) return null;
  const insertedAt = new Date().toISOString();
  const list = Array.isArray(album.candidates) && album.candidates.length ? album.candidates : [album];
  const cards = list.map((a) => toCard(a, discId, source, insertedAt));
  const primary = choosePrimaryIndex(list);
  if (primary > 0) cards.unshift(cards.splice(primary, 1)[0]);
  cards.forEach((c, i) => { c.key = i === 0 ? discId : `${discId}:${i}`; });
  const group = { discId, insertedAt, source, albums: cards };
  discs.set(discId, group);
  const chosen = cards[0].cover ? ' (chosen: has cover)' : '';
  log.info(`[gallery] + ${discId} "${cards[0].title}" - ${cards[0].artist} (${cards.length} candidate(s), ${cards[0].tracks.length} tracks)${chosen}`);
  broadcast({ type: 'update', group });
  return group;
}

/**
 * Returns the stored groups (one per disc id, candidates in display order).
 * @returns {object[]} every group, in insertion order
 */
function getGroups() {
  return [...discs.values()];
}

/**
 * Flattens the store into the list of cards the page renders.
 * @returns {object[]} every card, in insertion order
 */
function getAlbums() {
  const out = [];
  for (const group of discs.values()) out.push(...group.albums);
  return out;
}

/**
 * Sends one SSE payload to every connected page.
 * @param {object} payload - JSON-serializable event payload
 * @returns {void}
 */
function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch (e) {
      log.debug(`[gallery] SSE write failed: ${e.message}`);
    }
  }
}

/**
 * Serves the SSE stream: sends the current snapshot immediately, then every
 * subsequent change as it happens. A periodic comment keeps proxies from
 * closing an idle connection.
 * @param {import('node:http').IncomingMessage} req - the request
 * @param {import('node:http').ServerResponse} res - the response
 * @returns {void}
 */
function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'snapshot', groups: getGroups() })}\n\n`);
  clients.add(res);
  log.debug(`[gallery] SSE client connected (${clients.size} total)`);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch { /* the close handler will clean up */ }
  }, 25000);
  pings.add(ping);

  // NB: on IncomingMessage, 'close' fires as soon as the request body has been
  // read (Node >= 16), which is immediate for a GET - listening there would
  // drop every client the moment it connected. The response's 'close' is the
  // one that fires when the browser actually goes away.
  res.on('close', () => {
    clearInterval(ping);
    pings.delete(ping);
    clients.delete(res);
    log.debug(`[gallery] SSE client disconnected (${clients.size} left)`);
  });
}
/**
 * Renders the gallery page (markup lives in gallery.html).
 * @param {string} version - version string shown under the title
 * @returns {string} the full HTML document
 */
function renderPage(version) {

  // split/join instead of replace() so a "$" in the version cannot be treated
  // as a replacement pattern
  const tpl = loadTemplate();
  const html = tpl.replace('{{version}}', String(version ?? ''));

  return html;
}

/**
 * Reads and caches the template file.
 * @returns {string} the raw template with the {{version}} placeholder intact
 */
function loadTemplate() {
  if (template === null) template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template;
}

/**
 * Clears the store and drops every SSE client. Test-only helper.
 * @returns {void}
 */
function reset() {
  discs.clear();
  for (const ping of pings) clearInterval(ping);
  pings.clear();
  for (const res of clients) {
    try { res.end(); } catch { /* ignore */ }
  }
  clients.clear();
}

module.exports = { addAlbum, getAlbums, getGroups, handleEvents, renderPage, reset };