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
 */

const log = require('./logger');

// discId -> { discId, insertedAt, source, albums: card[] }
const discs = new Map();
// open SSE responses (one per connected browser tab)
const clients = new Set();

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

  // NB: on IncomingMessage, 'close' fires as soon as the request body has been
  // read (Node >= 16), which is immediate for a GET - listening there would
  // drop every client the moment it connected. The response's 'close' is the
  // one that fires when the browser actually goes away.
  res.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    log.debug(`[gallery] SSE client disconnected (${clients.size} left)`);
  });
}
/**
 * Renders the gallery page. The markup is static; all album data arrives over
 * SSE and is inserted with textContent, so record contents can never inject
 * markup into the page.
 * @param {string} version - version string shown under the title
 * @returns {string} the full HTML document
 */
function renderPage(version) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PS3 CDDB proxy</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#000;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh}
header{position:fixed;top:0;left:0;padding:16px 20px;z-index:10}
header h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.5px}
header .ver{font-size:13px;color:#9aa;margin-top:2px}
main{padding:104px 24px 48px;display:flex;flex-wrap:wrap;gap:28px;justify-content:center;align-items:flex-start}
.card{width:200px;cursor:pointer;text-align:center}
.cover{width:200px;height:200px;object-fit:cover;display:block;background:#555;border-radius:6px}
.cover.ph{display:flex;align-items:center;justify-content:center;color:#ddd;font-size:13px;padding:8px;text-align:center;overflow:hidden}
.meta{margin-top:8px;font-size:13px;line-height:1.35}
.meta .artist{color:#bbb}
.meta .title{color:#fff;font-weight:600}
.meta .count{color:#7fd4ff;font-size:11px;margin-top:2px}
.empty{color:#888;font-size:15px;margin-top:40px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.8);display:none;align-items:center;justify-content:center;padding:24px;z-index:20}
.overlay.open{display:flex}
.modal{background:#111;border:1px solid #333;border-radius:10px;max-width:760px;width:100%;max-height:85vh;overflow:auto;padding:24px;position:relative}
.modal h2{margin:0 0 4px;font-size:20px}
.modal h3{margin:18px 0 6px;font-size:15px;color:#ccc}
.modal .sub{color:#bbb;margin-bottom:16px}
.modal .close{position:absolute;top:10px;right:14px;background:none;border:0;color:#fff;font-size:26px;cursor:pointer;line-height:1}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px;padding-right:36px}
.tabs button{background:#1c1c1c;border:1px solid #333;color:#bbb;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tabs button:hover{background:#262626;color:#fff}
.tabs button[aria-selected="true"]{background:#2b2b2b;border-color:#777;color:#fff}
.pane::after{content:'';display:block;clear:both}
.pane .cover-lg{width:200px;height:200px;object-fit:cover;border-radius:6px;background:#555;float:right;margin:0 0 12px 16px}
.pane .cover-lg.ph{display:flex;align-items:center;justify-content:center;color:#ddd;font-size:13px;padding:8px;text-align:center;overflow:hidden}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 8px}
dt{color:#888}
dd{margin:0}
ol.tracks{margin:0;padding-left:22px}
ol.tracks li{margin:2px 0}
ol.tracks .dim{color:#999}
</style>
</head>
<body>
<header><h1>PS3 CDDB proxy</h1><div class="ver">version ${version}</div></header>
<main id="grid"><div class="empty" id="empty">Waiting for a disc&hellip;</div></main>
<div class="overlay" id="overlay"><div class="modal" id="modal"></div></div>
<script>
(function () {
  var grid = document.getElementById('grid');
  var empty = document.getElementById('empty');
  var overlay = document.getElementById('overlay');
  var modal = document.getElementById('modal');
  var groups = new Map(); // discId -> group {albums:[...]}

  function placeholder(a) {
    var d = document.createElement('div');
    d.className = 'cover ph';
    d.textContent = a.title || 'No cover';
    return d;
  }

  function coverNode(a, cls) {
    if (!a.cover) {
      var ph = placeholder(a);
      ph.className = cls + ' ph';
      return ph;
    }
    var img = document.createElement('img');
    img.className = cls;
    img.src = a.cover;
    img.alt = a.title || 'cover';
    img.onerror = function () {
      var ph = placeholder(a);
      ph.className = cls + ' ph';
      img.replaceWith(ph);
    };
    return img;
  }

  function makeCard(group) {
    var a = group.albums[0];
    var el = document.createElement('div');
    el.className = 'card';
    var cover = coverNode(a, 'cover');
    if (cover.tagName === 'IMG') cover.loading = 'lazy';
    el.appendChild(cover);

    var meta = document.createElement('div');
    meta.className = 'meta';
    var ar = document.createElement('div');
    ar.className = 'artist';
    ar.textContent = a.artist || 'Unknown artist';
    var ti = document.createElement('div');
    ti.className = 'title';
    ti.textContent = a.title || 'Unknown album';
    meta.appendChild(ar);
    meta.appendChild(ti);
    if (group.albums.length > 1) {
      var cnt = document.createElement('div');
      cnt.className = 'count';
      cnt.textContent = group.albums.length + ' versions';
      meta.appendChild(cnt);
    }
    el.appendChild(meta);
    el.addEventListener('click', function () { openModal(group); });
    return el;
  }

  function upsert(group) {
    var old = groups.get(group.discId);
    if (old) old.el.remove();
    var el = makeCard(group);
    group.el = el;
    groups.set(group.discId, group);
    grid.appendChild(el);
    empty.style.display = 'none';
  }

  function applySnapshot(list) {
    groups.forEach(function (g) { if (g.el) g.el.remove(); });
    groups.clear();
    list.forEach(upsert);
    empty.style.display = list.length ? 'none' : 'block';
  }

  function fmt(s) {
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  function buildPane(a) {
    var pane = document.createElement('div');
    pane.className = 'pane';
    pane.appendChild(coverNode(a, 'cover-lg'));

    var h = document.createElement('h2');
    h.textContent = a.title || 'Unknown album';
    pane.appendChild(h);
    var sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = a.artist || 'Unknown artist';
    pane.appendChild(sub);

    var rows = [
      ['Genre', a.genre],
      ['Year', a.year],
      ['Disc ID', a.discId],
      ['Disc', a.numDiscs > 1 ? a.discNumber + ' of ' + a.numDiscs : ''],
      ['Source', a.source],
      ['Added', a.insertedAt ? new Date(a.insertedAt).toLocaleString() : ''],
    ];
    var dl = document.createElement('dl');
    rows.forEach(function (row) {
      if (!row[1]) return;
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    pane.appendChild(dl);

    if (a.tracks && a.tracks.length) {
      var h3 = document.createElement('h3');
      h3.textContent = 'Tracks (' + a.tracks.length + ')';
      pane.appendChild(h3);
      var ol = document.createElement('ol');
      ol.className = 'tracks';
      a.tracks.forEach(function (t) {
        var li = document.createElement('li');
        li.textContent = t.title || '(untitled)';
        if (t.artist) {
          var s = document.createElement('span');
          s.className = 'dim';
          s.textContent = ' \u2014 ' + t.artist;
          li.appendChild(s);
        }
        if (t.duration) {
          var d = document.createElement('span');
          d.className = 'dim';
          d.textContent = ' (' + fmt(t.duration) + ')';
          li.appendChild(d);
        }
        ol.appendChild(li);
      });
      pane.appendChild(ol);
    }
    return pane;
  }

  function openModal(group) {
    modal.innerHTML = '';
    var close = document.createElement('button');
    close.className = 'close';
    close.textContent = '\u00d7';
    close.onclick = closeModal;
    modal.appendChild(close);

    var list = group.albums;
    var panes = [];
    if (list.length > 1) {
      var tabs = document.createElement('div');
      tabs.className = 'tabs';
      tabs.setAttribute('role', 'tablist');
      list.forEach(function (a, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = (a.title || 'Unknown album') + (a.cover ? ' \u2713' : '');
        b.title = a.title || 'Unknown album';
        b.addEventListener('click', function () { select(i); });
        tabs.appendChild(b);
      });
      modal.appendChild(tabs);
    }
    list.forEach(function (a) {
      var pane = buildPane(a);
      pane.style.display = 'none';
      modal.appendChild(pane);
      panes.push(pane);
    });

    function select(i) {
      panes.forEach(function (p, j) { p.style.display = j === i ? 'block' : 'none'; });
      var btns = modal.querySelectorAll('.tabs button');
      btns.forEach(function (b, j) { b.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
    }
    select(0);
    overlay.classList.add('open');
  }

  function closeModal() { overlay.classList.remove('open'); }
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  var es = new EventSource('/events');
  es.onmessage = function (e) {
    var msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.type === 'snapshot') applySnapshot(msg.groups || []);
    else if (msg.type === 'update' && msg.group) upsert(msg.group);
  };
})();
</script>
</body>
</html>`;
}

/**
 * Clears the store and drops every SSE client. Test-only helper.
 * @returns {void}
 */
function reset() {
  discs.clear();
  for (const res of clients) {
    try { res.end(); } catch { /* ignore */ }
  }
  clients.clear();
}

module.exports = { addAlbum, getAlbums, getGroups, handleEvents, renderPage, reset };