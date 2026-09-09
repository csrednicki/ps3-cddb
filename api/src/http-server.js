'use strict';

/**
 * HTTP server :80 - POST /sdkrequest (HTTP/1.0, multipart boundary 265001916915724).
 * Receives the body (the "BIN " packet), parses it, matches the album and streams the TLV response.
 */

const http = require('node:http');
const { loadConfig } = require('./config');
const log = require('./logger');
const { parseRequest } = require('./request');
const { buildResponse } = require('./records');
const { findAlbumLive, writeDiskCache, purgeDiskCache } = require('./albums');
const { registerConsole } = require('./consoles');
const { saveGnudbRecord } = require('./cddb');
const { createIpLimiter } = require('./rate-limiter');

const cfg = loadConfig();

// Per-IP rate limiting + repeat-offender ban list, same mechanism as the DNS
// server (see dns-server.js) but with its own state and config
// (cfg.http.rateLimit/blacklist). This matters more here than for DNS: a
// request that misses the cache triggers an outbound gnudb lookup, so a
// flood from a single IP would not just cost us CPU - it would hammer gnudb
// on that IP's behalf. Capping and banning a single abusive source keeps
// that in check; it cannot stop a flood spread across many source IPs, which
// is why this is not a substitute for keeping the server off the public
// internet (see README "Security").
const httpLimiter = createIpLimiter({
  logTag: '[http]',
  getMaxPerSecondPerIp: () => cfg.http.rateLimit?.maxPerSecondPerIp,
  getBlacklistConfig: () => cfg.http.blacklist,
});

/**
 * Extracts the binary body from the PS3's multipart POST, or returns the
 * whole buffer unchanged when the request isn't multipart.
 * @param {Buffer} raw - full raw HTTP request (as received)
 * @param {string} boundary - multipart boundary string (without leading "--")
 * @returns {Buffer} the extracted "BIN " packet body
 */
function extractMultipartBody(raw, boundary) {
  // We look for the end of the PART headers (after "Content-Type: application/octet-stream"),
  // not the end of the HTTP headers - "\r\n\r\n" occurs earlier in the request.
  const partMarker = Buffer.from('Content-Type: application/octet-stream\r\n\r\n');
  const idx = raw.indexOf(partMarker);
  if (idx === -1) {
    // fallback: no multipart - the whole thing is the body (raw 'B' mode)
    return raw;
  }
  let body = raw.subarray(idx + partMarker.length);
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
  const end = body.indexOf(closing);
  if (end !== -1) body = body.subarray(0, end);
  return body;
}

/**
 * Starts the HTTP server: serves a test page on GET /, and on POST to the
 * configured SDK path, parses the PS3's "BIN " request, resolves the album
 * via gnudb (or cache), and streams back the TLV response.
 * @returns {Promise<import('node:http').Server>} the listening HTTP server
 */
function startHttpServer() {
  const server = http.createServer((req, res) => {
    const ip = req.socket.remoteAddress;

    // Banned IPs are dropped immediately, before any other work - no reason
    // to buffer/parse a body from an address already known to be abusive.
    if (httpLimiter.isBlacklisted(ip)) {
      req.socket.destroy();
      return;
    }

    if (httpLimiter.isRateLimited(ip)) {
      httpLimiter.recordViolation(ip);
      log.debug(`[http] rate-limited ${ip} (${req.method} ${req.url})`);
      const sock = res.socket;
      sock.setNoDelay(true);
      sock.write('HTTP/1.0 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n', () => {
        sock.end();
        setImmediate(() => { try { sock.destroy(); } catch { /* ignore */ } });
      });
      return;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      log.info(`[http] ${req.method} ${req.url} from ${req.socket.remoteAddress} (${raw.length} B)`);

      // GET / - test page (confirmation that the emulator is alive and reachable)
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        const now = new Date();
        const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>PS3 CDDB API emulator</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
main{text-align:center}h1{color:#7fd4ff}code{background:#222;padding:2px 6px;border-radius:4px}</style></head>
<body><main>
<h1>API test</h1>
<p>${now.toLocaleString('en-US')}<br><small>${now.toISOString()}</small></p>
<p>SDK endpoint: <code>POST ${cfg.http.path}</code></p>
</main></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end(html);
        return;
      }

      // Any other GET (a browser navigating to /sdkrequest, a favicon probe, etc.) -
      // send it to the test page instead of a bodyless response, which some
      // browsers (e.g. Chrome) misinterpret as a file download.
      if (req.method === 'GET') {
        res.writeHead(302, { Location: '/', Connection: 'close' });
        res.end();
        return;
      }

      // POST /sdkrequest - the only source of the MAC: the `secret` field of the "BIN " header.
      // The PS3 uses an absolute-form request-target: "POST http://dmr.allmusic.com/sdkrequest",
      // so req.url is the full URL, not just "/sdkrequest" - we extract the pathname.
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname !== cfg.http.path || req.method !== 'POST') {
        const sock = res.socket;
        sock.setNoDelay(true);
        sock.write('HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n', () => {
          sock.end();
          setImmediate(() => { try { sock.destroy(); } catch { /* ignore */ } });
        });
        return;
      }

      try {
        const body = extractMultipartBody(raw, cfg.http.boundary);
        if (cfg.dumps.logRequests) log.dumpBinary(`req_${Date.now()}`, body);

        const parsed = parseRequest(body);
        const mac = parsed.header.secret.subarray(0, 12).toString('latin1');
        const entry = registerConsole(mac, { source: 'post', url: req.url, userAgent: req.headers['user-agent'] });
        log.info(`[console] MAC captured from POST: ${entry.mac} (requests: ${entry.requests})`);
        log.info(`[sdk] type=${parsed.type} mac=${entry.mac} user="${parsed.header.user.toString('latin1').replace(/\0.*$/, '')}" selectors=${parsed.header.integritySelector}/${parsed.header.transformSelector}`);

        findAlbumLive(parsed).then((album) => {
          const response = album
            ? buildResponse({ album })
            : buildResponse({ error: { code: 0x23, message: 'album not found' } });
          const candidateInfo = album?.candidates?.length > 1 ? `, +${album.candidates.length - 1} more candidate(s)` : '';
          const matchInfo = album ? `MATCH: "${album.title}" - ${album.artist} (${album.tracks?.length ?? 0} tracks), year: ${album.year || 'unknown'}${candidateInfo}` : 'NO MATCH → error 0x23 (TOC view)';

          log.info(`[sdk] rawToc=${parsed.rawTocHex.slice(0, 24)}… → ${matchInfo} [fmt=${process.env.RESPONSE_FORMAT ?? 'A'}]`);
          const ts = Date.now();
          if (cfg.dumps.logResponses) log.dumpBinary(`resp_${ts}`, response);
          // pair the raw gnudb record with the response dump (same timestamp):
          // resp_<ts>.bin = what we sent to the PS3, resp_<ts>-gnudb.txt = what gnudb sent us
          if (album?.__gnudbRecord) { saveGnudbRecord(ts, album.__gnudbRecord); delete album.__gnudbRecord; }
          // purge expired disk-cache entries - deferred so the response is never delayed
          purgeDiskCache();

        // Response delay (cfg.http.replyDelayMs, default 3000 ms): the plugin reads with a
        // 500 ms RCVTIMEO - the console finishes sending the request and only then waits for
        // the response. An immediate response + FIN could truncate its reception.
        // Override per-run with env REPLY_DELAY (ms); set to 0 to reply immediately.
        const replyDelay = Math.max(0, parseInt(process.env.REPLY_DELAY ?? String(cfg.http.replyDelayMs), 10) || 0);

        const sendReply = () => {
          const sock = res.socket;
          sock.setNoDelay(true);
          const frame = Buffer.concat([
            Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${response.length}\r\n\r\n`),
            response,
          ]);
          sock.write(frame, () => {
            sock.end();
            // the response has been sent - now it is safe to write the disk cache;
            // delete __cacheWrite so subsequent in-memory cache hits don't re-trigger the write
            if (album?.__cacheWrite) {
              const w = album.__cacheWrite;
              delete album.__cacheWrite;
              writeDiskCache(w.discId, w.artist, w.title, w.record);
            }
            setImmediate(() => { try { sock.destroy(); } catch { /* ignore */ } });
          });
        };
        if (replyDelay > 0) setTimeout(sendReply, replyDelay);
        else sendReply();
        }).catch((e) => {
          log.error(`[sdk] lookup error: ${e.message}`);
          const err = buildResponse({ error: { code: 0x23, message: 'album not found' } });
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': err.length, Connection: 'close' });
          res.end(err);
        });
      } catch (e) {
        log.error(`[sdk] parse error: ${e.message}`);
        log.debug(log.hexdump(raw));
        const err = buildResponse({ error: { code: 0x1f, message: e.message } });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': err.length, Connection: 'close' });
        res.end(err);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(cfg.http.port, () => {
      log.info(`[http] listening on :${cfg.http.port}${cfg.http.path}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

module.exports = { startHttpServer, extractMultipartBody };
