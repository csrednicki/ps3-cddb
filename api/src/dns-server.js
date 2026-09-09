'use strict';

/**
 * DNS server :53 - answers with an A record for dmr(.dev).allmusic.com at answerIp,
 * forwards other queries to the upstream (keeps the PS3's networking working).
 *
 * Built on the `dns2` library - one handler serving UDP **and** TCP:
 *  - TCP support (RFC 7766) for free - resolvers retry over TCP when a response
 *    carries the TC bit, which dns2 sets automatically above the UDP limit
 *    (512 B or the negotiated EDNS size). The previous dgram-only implementation
 *    could not handle TCP at all.
 *  - Wire parsing/serialization, EDNS payload negotiation and TC-bit truncation
 *    are handled by dns2 (Packet.parse/build).
 *
 * Unicast semantics are preserved: dns2 always echoes the query ID and question
 * section (the PS3 rejects mDNS-style packets with ID=0/QDCOUNT=0).
 *
 * Forwarding to the upstream is still implemented manually via dgram - the
 * client's raw query is relayed to the upstream and the raw upstream response
 * is sent back through the server socket (setRawSocket), preserving the
 * client's transaction ID without any re-serialization.
 */

const dgram = require('node:dgram');
const dns2 = require('dns2');
const { Packet } = dns2;
const { loadConfig } = require('./config');
const log = require('./logger');
const { createIpLimiter } = require('./rate-limiter');

const cfg = loadConfig();

// Per-IP rate limiting + repeat-offender ban list. This is the actual defense
// against using this resolver as a DNS amplification/reflection vector
// against a third party: it bounds how much traffic can be driven at any
// single destination address regardless of how many (possibly spoofed) query
// packets arrive claiming to be from it. Config is read live via the getters
// (cfg.dns.rateLimit/blacklist), so changes apply without a restart.
const { isRateLimited, isBlacklisted, recordViolation } = createIpLimiter({
  logTag: '[dns]',
  getMaxPerSecondPerIp: () => cfg.dns.rateLimit?.maxPerSecondPerIp,
  getBlacklistConfig: () => cfg.dns.blacklist,
});

/**
 * True when any question in `query` is class CHAOS (version.bind/hostname.bind/
 * id.server-style fingerprinting recon - no PS3 ever sends one).
 * @param {object} query - dns2 parsed request (or a plain object with a `questions` array)
 * @returns {boolean} true when the query carries a CHAOS-class question
 */
function isChaosQuery(query) {
  return (query.questions ?? []).some((q) => q.class === Packet.CLASS.CH || q.class === 'CH');
}

/**
 * True when `name` is one of the configured target hosts (the spoofed AllMusic domains).
 * @param {string} name - queried DNS name
 * @returns {boolean} true when `name` matches a configured host, case-insensitively
 */
function isTargetHost(name) {
  if (!name) return false;
  const n = String(name).toLowerCase().replace(/\.$/, '');
  return cfg.dns.hosts.some((h) => n === h.toLowerCase());
}

/**
 * Handles a single DNS query: drops banned/CHAOS/rate-limited queries,
 * answers target-host questions locally, and forwards everything else
 * upstream when configured to.
 * @param {object} query - dns2 parsed request (or a plain object with `questions`)
 * @param {{address: string, port: number}} rinfo - source address/port of the query
 * @param {(answers: Array<{name: string, type?: string, ttl?: number, data: string}>, rinfo: object, query: object) => void} sendFn - callback that assembles and sends the response
 * @returns {boolean} true when the query was handled locally (target host)
 */
function handleQuery(query, rinfo, sendFn) {
  const name = query.questions?.[0]?.name;
  if (!name) return false;

  // Banned IPs are dropped immediately, before any other check - no reason
  // to spend cycles on CHAOS/rate-limit accounting for an address already
  // known to be abusive.
  if (isBlacklisted(rinfo.address)) return false;

  // CHAOS-class queries (version.bind/hostname.bind/id.server) are pure
  // fingerprinting recon - no PS3 ever sends one - so they're dropped instead
  // of relayed upstream.
  if (isChaosQuery(query)) {
    log.debug(`[dns] dropped CHAOS-class query from ${rinfo.address} (${name})`);
    return false;
  }

  if (isRateLimited(rinfo.address)) {
    log.debug(`[dns] rate-limited ${rinfo.address} (${name})`);
    recordViolation(rinfo.address);
    return false;
  }

  if (isTargetHost(name)) {
    for (const q of query.questions) {
      if (!isTargetHost(q.name)) continue;
      // sendFn assembles the full response (duplicating ID + echoing the question) and sends it
      sendFn([{ name: q.name, type: 'A', ttl: cfg.dns.ttl, data: cfg.dns.answerIp }], rinfo, query);
      log.info(`[dns] ${rinfo.address} → ${q.name} → ${cfg.dns.answerIp}`);
    }
    return true;
  }

  if (cfg.dns.forwardUnknown) {
    forwardUpstream(query, rinfo, sendFn);
  }
  return false;
}

/**
 * Serializes the client's query for the upstream.
 *
 * The query arrives as a dns2 Packet (parsed request), which is re-serialized
 * as-is; plain query objects (tests, legacy callers) are rebuilt into a Packet
 * question-by-question - dns2 needs numeric type/class codes, so string forms
 * like 'A' are mapped through Packet.TYPE.
 * @param {object} query - dns2 parsed request, or a plain query object
 * @returns {Buffer} the wire-format query to send upstream
 */
function buildUpstreamQuery(query) {
  if (typeof query.toBuffer === 'function') return query.toBuffer();
  const p = new Packet();
  p.header.id = query.id ?? 0;
  for (const q of query.questions ?? []) {
    p.questions.push({
      name: q.name,
      type: typeof q.type === 'string' ? (Packet.TYPE[q.type] ?? q.type) : q.type,
      class: typeof q.class === 'string' ? (Packet.CLASS[q.class] ?? q.class) : (q.class ?? Packet.CLASS.IN),
    });
  }
  return p.toBuffer();
}

/**
 * Transaction ID and question that a genuine reply to `wire` has to echo back.
 * @param {Buffer} wire - the query that was sent upstream
 * @returns {{id: number, name: string|null, type: *, class: *}} what a genuine reply must match
 */
function expectedReplyFor(wire) {
  const sent = Packet.parse(wire);
  const q = sent.questions?.[0];
  return {
    id: sent.header.id,
    name: q ? String(q.name).toLowerCase() : null,
    type: q?.type,
    class: q?.class,
  };
}

/**
 * True when `upMsg` actually answers the query we sent. The upstream response
 * is relayed to the client byte-for-byte, so this is the only place a forged
 * packet can be caught: without it, whatever reaches the ephemeral port first -
 * including an off-path attacker racing the real upstream - would be handed
 * straight to the client, who uses us as its resolver for every domain.
 * @param {Buffer} upMsg - raw datagram received from the upstream socket
 * @param {{id: number, name: string|null, type: *, class: *}} expected - from expectedReplyFor()
 * @returns {boolean} true when `upMsg` is a well-formed reply matching `expected`
 */
function isReplyToQuery(upMsg, expected) {
  if (!Buffer.isBuffer(upMsg) || upMsg.length < 12) return false;
  if (upMsg.readUInt16BE(0) !== expected.id) return false;
  if (!expected.name) return false;
  try {
    const q = Packet.parse(upMsg).questions?.[0];
    return !!q
      && String(q.name).toLowerCase() === expected.name
      && q.type === expected.type
      && q.class === expected.class;
  } catch {
    return false; // unparseable - never relay it
  }
}

/**
 * Closes a socket that may already be closed (timeout and reply can race).
 * @param {import('node:dgram').Socket} sock - socket to close
 * @returns {void}
 */
function closeQuietly(sock) {
  try { sock.close(); } catch { /* already closed */ }
}

/**
 * Sends the query to the upstream and relays the response back to the client (raw packet).
 * @param {object} query - dns2 parsed request (or a plain query object) to forward
 * @param {{address: string, port: number}} rinfo - the original client's address/port
 * @param {Function} sendFn - unused here (kept for signature symmetry with handleQuery's callers)
 * @returns {void}
 */
function forwardUpstream(query, rinfo, sendFn) {
  const name = query.questions?.[0]?.name ?? '?';
  const wire = buildUpstreamQuery(query);

  let expected;
  try {
    expected = expectedReplyFor(wire);
  } catch (e) {
    log.error(`[dns] cannot read back the query for ${name}: ${e.message}`);
    return;
  }

  const up = dgram.createSocket('udp4');
  const timer = setTimeout(() => {
    log.warn(`[dns] upstream timeout for ${name}`);
    closeQuietly(up);
  }, cfg.dns.upstreamTimeoutMs);

  // 'on', not 'once': a rejected packet must not consume the listener, or a
  // single forged datagram would silence the genuine reply behind it.
  up.on('message', (upMsg) => {
    if (!isReplyToQuery(upMsg, expected)) {
      log.warn(`[dns] dropped an upstream reply that does not answer ${name}`);
      return;
    }
    clearTimeout(timer);
    try {
      sendRaw(upMsg, rinfo);
      log.debug(`[dns] forwarded ${name} → ${cfg.dns.upstream}`);
    } finally {
      closeQuietly(up);
    }
  });

  up.once('error', (e) => {
    clearTimeout(timer);
    log.error(`[dns] upstream: ${e.message}`);
    closeQuietly(up);
  });

  // A connected UDP socket only receives datagrams from the peer it is
  // connected to, so the kernel drops anything aimed at this ephemeral port by
  // someone other than the upstream - an off-path attacker never even reaches
  // the handler above, and does not have to spoof the upstream's address to try.
  up.connect(cfg.dns.upstreamPort, cfg.dns.upstream, () => {
    try {
      up.send(wire);
    } catch (e) {
      log.error(`[dns] upstream send failed for ${name}: ${e.message}`);
      closeQuietly(up);
    }
  });
}

/**
 * Builds a dns2 response for a parsed request from a list of answer records.
 * @param {object} request - dns2 parsed request being answered
 * @param {Array<{name: string, ttl?: number, data: string}>} answers - A-record answers to attach
 * @returns {object} the dns2 response packet, ready to send
 */
function buildDns2Response(request, answers) {
  const response = Packet.createResponseFromRequest(request);
  // Authoritative answer + recursion available (QR=1 is implied by createResponse).
  response.header.aa = 1;
  response.header.ra = 1;
  for (const a of answers) {
    response.answers.push({
      name: a.name,
      type: Packet.TYPE.A,
      class: Packet.CLASS.IN,
      ttl: a.ttl ?? cfg.dns.ttl,
      address: a.data,
    });
  }
  return response;
}

/**
 * Starts the DNS server (UDP + TCP on the same port) using dns2.
 * @returns {Promise<object>} the dns2 server (has .close(), .addresses(), .servers.udp)
 */
function startDnsServer() {
  const server = dns2.createServer({
    udp: true,
    tcp: true,
    handle: (request, send, client) => {
      handleQuery(request, client, (answers) => {
        send(buildDns2Response(request, answers));
      });
    },
  });

  server.on('requestError', (e) => {
    log.error(`[dns] query error: ${e.message}`);
  });
  server.on('error', (e) => {
    log.error(`[dns] socket: ${e.message} (${e.protocol ?? 'udp'})`);
  });

  return server.listen({ udp: cfg.dns.port, tcp: cfg.dns.port }).then(() => {
    log.info(
      `[dns] listening on :${cfg.dns.port} (udp+tcp) (hosts: ${cfg.dns.hosts.join(', ')} → ${cfg.dns.answerIp})`,
    );
    // Expose the UDP socket for raw upstream-response relaying (sendRaw).
    // dns2's UDPServer extends dgram.Socket, so it is send-compatible.
    setRawSocket(server.servers.udp);
    return server;
  });
}

let rawSocketRef = null;

/**
 * Sends a raw buffer (used by the forwarder to relay the response to the client).
 * @param {Buffer} msg - raw wire-format DNS message
 * @param {{address: string, port: number}} rinfo - destination address/port
 * @returns {void}
 */
function sendRaw(msg, rinfo) {
  // Guard against a non-socket registration (e.g. a dns2 DNSServer wrapper
  // passed by mistake) - relaying is best-effort, never crash the emulator.
  if (rawSocketRef && typeof rawSocketRef.send === 'function') {
    rawSocketRef.send(msg, rinfo.port, rinfo.address);
  } else {
    log.error('[dns] sendRaw: raw socket not available - upstream response dropped');
  }
}

/**
 * Registers the socket for raw sending (invoked after the server starts).
 * @param {import('node:dgram').Socket} sock - the dns2 server's underlying UDP socket
 * @returns {void}
 */
function setRawSocket(sock) {
  rawSocketRef = sock;
}

module.exports = {
  startDnsServer,
  handleQuery,
  isTargetHost,
  isChaosQuery,
  isRateLimited,
  isBlacklisted,
  setRawSocket,
};
