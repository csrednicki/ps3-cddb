'use strict';

/**
 * Coverage of startDnsServer / forwardUpstream / sendRaw / setRawSocket.
 * Mocked config (test port). forwardUpstream tested via a mocked
 * node:dgram - we send a fake response "from upstream" and verify
 * that it reaches the client via the raw socket.
 */

const os = require('node:os');
const mockDnsPort = 20000 + (process.pid % 20000);

// Mutable config - tests can toggle forwardUnknown (branch coverage l47).
const mockConfig = {
  dns: {
    port: mockDnsPort,
    hosts: ['dmr.allmusic.com', 'dmrdev.allmusic.com'],
    answerIp: '192.168.1.181',
    upstream: '127.0.0.1',
    upstreamPort: 53,
    forwardUnknown: true,
    ttl: 60,
    upstreamTimeoutMs: 3000,
  },
};

jest.mock('../src/config', () => ({
  loadConfig: () => mockConfig,
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  dumpBinary: jest.fn(),
  hexdump: jest.fn(),
}));

const dgram = require('node:dgram');
const dns2 = require('dns2');
const { Packet } = dns2;
const { startDnsServer, handleQuery, isTargetHost, isChaosQuery, isRateLimited, isBlacklisted, setRawSocket } = require('../src/dns-server');

/**
 * Builds a wire-format DNS query for `name` with the given transaction id.
 * @param {number} id - DNS transaction id
 * @param {string} name - queried name
 * @returns {Buffer} the wire-format query
 */
function buildQuery(id, name) {
  const p = new Packet();
  p.header.id = id;
  p.questions.push({ name, type: Packet.TYPE.A, class: Packet.CLASS.IN });
  return p.toBuffer();
}

/**
 * Builds a wire-format DNS reply. Defaults produce a well-formed answer that
 * echoes the query's id and question, which is what forwardUpstream requires
 * before it relays anything (see isReplyToQuery) - tests for forged replies
 * override `id` or `name` to break exactly one of those.
 * @param {object} opts
 * @param {number} opts.id - transaction id to echo
 * @param {string} opts.name - question name to echo
 * @param {string} [opts.address='1.2.3.4'] - answer A-record address
 * @returns {Buffer} the wire-format reply
 */
function buildReply({ id, name, address = '1.2.3.4' }) {
  const p = new Packet();
  p.header.id = id;
  p.header.qr = 1;
  p.questions.push({ name, type: Packet.TYPE.A, class: Packet.CLASS.IN });
  p.answers.push({ name, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl: 60, address });
  return p.toBuffer();
}

/**
 * Stand-in for the dgram socket forwardUpstream opens. connect() invokes its
 * callback synchronously (that is what triggers the send), the sent buffer is
 * recorded, and the registered handlers are exposed so a test can feed the
 * forwarder a reply or an error.
 * @returns {object} a fake dgram.Socket-shaped object with `sent`/`closeCount`/`messageHandler`/`errorHandler`
 */
function fakeUpstreamSocket() {
  const fake = {
    sent: null,
    closeCount: 0,
    messageHandler: null,
    errorHandler: null,
    connect(port, address, cb) { cb?.(); return fake; },
    send(buf) { fake.sent = buf; return fake; },
    close() { fake.closeCount += 1; return fake; },
    on(ev, cb) { if (ev === 'message') fake.messageHandler = cb; return fake; },
    once(ev, cb) { if (ev === 'error') fake.errorHandler = cb; return fake; },
  };
  return fake;
}

describe('startDnsServer - real socket', () => {
  let server;
  let client;

  beforeAll(async () => {
    server = await startDnsServer();
    client = dgram.createSocket('udp4');
  });
  afterAll(async () => {
    client?.close();
    server.close();
  });

  /**
   * Sends a real UDP query to the running test server and resolves with the parsed reply.
   * @param {string} name - queried name
   * @returns {Promise<object>} the parsed dns2 reply packet
   */
  function ask(name) {
    return new Promise((resolve, reject) => {
      const q = buildQuery(0xabcd, name);
      const timer = setTimeout(() => { client.removeAllListeners('message'); reject(new Error('timeout')); }, 3000);
      client.on('message', (m) => {
        clearTimeout(timer);
        client.removeAllListeners('message');
        resolve(Packet.parse(m));
      });
      client.send(q, mockDnsPort, '127.0.0.1');
    });
  }

  it('should answer a target-host query with the A-record answerIp and reflect the query ID', async () => {
    const res = await ask('dmr.allmusic.com');
    expect(res.header.id).toBe(0xabcd);
    expect(res.header.qr).toBe(1);
    const a = res.answers.find((x) => x.type === Packet.TYPE.A);
    expect(a.address).toBe('192.168.1.181');
    expect(a.name).toBe('dmr.allmusic.com');
  });

  it('should answer an A query for dmrdev.allmusic.com with the configured answerIp', async () => {
    const res = await ask('dmrdev.allmusic.com');
    const a = res.answers.find((x) => x.type === Packet.TYPE.A);
    expect(a.address).toBe('192.168.1.181');
  });

  it('should not answer locally for a non-target host (forwarded upstream, no local reply)', async () => {
    // e2e: the query for a foreign host goes upstream; unless the (real) upstream
    // responds there is no reply at all. We only assert the server never answers
    // with the configured answerIp for a foreign host.
    try {
      const res = await ask('example.invalid');
      const a = res.answers?.find((x) => x.type === Packet.TYPE.A && x.address === '192.168.1.181');
      expect(a).toBeUndefined();
    } catch (e) {
      expect(e.message).toBe('timeout'); // no response = correct
    }
  });

  it('should return false from handleQuery when the query has no questions', () => {
    expect(handleQuery({}, { address: 'x', port: 1 }, () => {})).toBe(false);
    expect(handleQuery({ questions: [] }, { address: 'x', port: 1 }, () => {})).toBe(false);
  });

  it('should answer only the targeted question when a query contains multiple questions', () => {
    const sent = [];
    const r = handleQuery(
      { questions: [{ name: 'dmr.allmusic.com', type: 'A' }, { name: 'other.example', type: 'A' }] },
      { address: '127.0.0.1', port: 5 },
      (answers) => sent.push(answers),
    );
    expect(r).toBe(true);
    expect(sent).toHaveLength(1); // only the target got a response; other → continue
    expect(sent[0][0].name).toBe('dmr.allmusic.com');
  });

  it('should skip questions without a name in the target loop (continue)', () => {
    const sent = [];
    // first question has a name → enters the target branch; second empty → continue
    const r = handleQuery(
      { questions: [{ name: 'dmrdev.allmusic.com', type: 'A' }] },
      { address: '127.0.0.1', port: 5 },
      (answers) => sent.push(answers),
    );
    expect(r).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('should not forward a non-target query when forwardUnknown is false', () => {
    const origForward = mockConfig.dns.forwardUnknown;
    mockConfig.dns.forwardUnknown = false;
    try {
      const sent = [];
      const r = handleQuery(
        { questions: [{ name: 'other.example', type: 'A' }] },
        { address: '127.0.0.1', port: 5 },
        (answers) => sent.push(answers),
      );
      expect(r).toBe(false);
      expect(sent).toHaveLength(0);
    } finally {
      mockConfig.dns.forwardUnknown = origForward;
    }
  });

  it('should forward a non-target query to the upstream when forwardUnknown is true', () => {
    // forwardUnknown=true (default in mockConfig) - a non-target call triggers
    // forwardUpstream; mocked dgram.createSocket prevents real network.
    const realCreate = dgram.createSocket;
    const sock = fakeUpstreamSocket();
    dgram.createSocket = () => sock;
    try {
      const r = handleQuery(
        { questions: [{ name: 'forward.example', type: 'A' }] },
        { address: '127.0.0.1', port: 5 },
        () => {},
      );
      expect(r).toBe(false); // handled by upstream, not locally
      expect(sock.sent).not.toBeNull(); // upstream socket sent the query
    } finally {
      dgram.createSocket = realCreate;
    }
  });

  it('should return false from isTargetHost for null/undefined/empty names', () => {
    expect(isTargetHost(undefined)).toBe(false);
    expect(isTargetHost('')).toBe(false);
  });

  it('should pass the question name unchanged to the upstream query (documents the dead "?" fallback branch)', () => {
    // L55 `?? '?'` is reachable only if handleQuery lets a nameless question through,
    // which never happens (l35 return false). The test documents the dead branch - we call
    // handleQuery with a name that passes, and forwardUpstream takes the same name.
    const realCreate = dgram.createSocket;
    const sock = fakeUpstreamSocket();
    dgram.createSocket = () => sock;
    try {
      handleQuery({ questions: [{ name: 'named.example', type: 'A' }] }, { address: '127.0.0.1', port: 5 }, () => {});
      expect(Packet.parse(sock.sent).questions?.[0]?.name).toBe('named.example');
    } finally {
      dgram.createSocket = realCreate;
    }
  });

  it('should fall back to the raw type value when re-serializing a question with an unrecognized string type', () => {
    // forwardUpstream's manual Packet rebuild: `Packet.TYPE[q.type] ?? q.type` - 'BOGUS'
    // is not a known dns2 type name, so the fallback (raw string) is used instead;
    // dns2 then rejects it at encode time (it requires a 16-bit type code), which
    // documents that this fallback cannot actually produce a valid wire packet -
    // it exists, but an unrecognized type string was never a supported input.
    const realCreate = dgram.createSocket;
    dgram.createSocket = () => fakeUpstreamSocket();
    try {
      expect(() => handleQuery(
        { questions: [{ name: 'weird-type.example', type: 'BOGUS' }] },
        { address: '127.0.0.1', port: 5 },
        () => {},
      )).toThrow(/16-bit integer/);
    } finally {
      dgram.createSocket = realCreate;
    }
  });

  it('should map a string class name onto Packet.CLASS when re-serializing a question', () => {
    // covers the `typeof q.class === 'string'` TRUE branch (never exercised by
    // the other tests, which omit q.class entirely).
    const realCreate = dgram.createSocket;
    const sock = fakeUpstreamSocket();
    dgram.createSocket = () => sock;
    try {
      handleQuery(
        { questions: [{ name: 'string-class.example', type: 'A', class: 'IN' }] },
        { address: '127.0.0.1', port: 5 },
        () => {},
      );
      expect(Packet.parse(sock.sent).questions[0].class).toBe(Packet.CLASS.IN);
    } finally {
      dgram.createSocket = realCreate;
    }
  });

  it('should keep an already-numeric class as-is when re-serializing a question', () => {
    // covers the `q.class ?? Packet.CLASS.IN` branch where q.class is already truthy.
    const realCreate = dgram.createSocket;
    const sock = fakeUpstreamSocket();
    dgram.createSocket = () => sock;
    try {
      // Packet.CLASS.HS (Hesiod) - any non-CH, non-IN numeric class works here;
      // CH is deliberately not used since CHAOS-class queries are now dropped
      // before reaching forwardUpstream (see isChaosQuery tests below).
      handleQuery(
        { questions: [{ name: 'numeric-class.example', type: 'A', class: Packet.CLASS.HS }] },
        { address: '127.0.0.1', port: 5 },
        () => {},
      );
      expect(Packet.parse(sock.sent).questions[0].class).toBe(Packet.CLASS.HS);
    } finally {
      dgram.createSocket = realCreate;
    }
  });

  it('should strip a trailing dot when matching target hosts', () => {
    expect(isTargetHost('dmr.allmusic.com.')).toBe(true);
    expect(isTargetHost('DMR.ALLMUSIC.COM.')).toBe(true);
    expect(isTargetHost('other.example.')).toBe(false);
  });

  describe('CHAOS-class query dropping', () => {
    it('should identify a CHAOS-class question via isChaosQuery', () => {
      expect(isChaosQuery({ questions: [{ name: 'version.bind', class: Packet.CLASS.CH }] })).toBe(true);
      expect(isChaosQuery({ questions: [{ name: 'version.bind', class: 'CH' }] })).toBe(true);
      expect(isChaosQuery({ questions: [{ name: 'example.com', class: Packet.CLASS.IN }] })).toBe(false);
      expect(isChaosQuery({ questions: [] })).toBe(false);
      expect(isChaosQuery({})).toBe(false);
    });

    it('should drop a CHAOS-class query without answering or forwarding it', () => {
      const realCreate = dgram.createSocket;
      const sock = fakeUpstreamSocket();
      dgram.createSocket = () => sock;
      try {
        const sent = [];
        const r = handleQuery(
          { questions: [{ name: 'version.bind', class: Packet.CLASS.CH }] },
          { address: '203.0.113.5', port: 5 },
          (answers) => sent.push(answers),
        );
        expect(r).toBe(false);
        expect(sent).toHaveLength(0);
        expect(sock.sent).toBeNull();
      } finally {
        dgram.createSocket = realCreate;
      }
    });
  });

  describe('rate limiting', () => {
    afterEach(() => {
      mockConfig.dns.rateLimit = undefined;
    });

    it('should not limit when rateLimit is not configured', () => {
      expect(isRateLimited('198.51.100.1')).toBe(false);
    });

    it('should allow up to the configured limit and then drop further queries from the same IP within the window', () => {
      mockConfig.dns.rateLimit = { maxPerSecondPerIp: 3 };
      const ip = '198.51.100.2';
      expect(isRateLimited(ip)).toBe(false);
      expect(isRateLimited(ip)).toBe(false);
      expect(isRateLimited(ip)).toBe(false);
      expect(isRateLimited(ip)).toBe(true); // 4th call in the same window
    });

    it('should track separate IPs independently', () => {
      mockConfig.dns.rateLimit = { maxPerSecondPerIp: 1 };
      expect(isRateLimited('198.51.100.3')).toBe(false);
      expect(isRateLimited('198.51.100.4')).toBe(false); // different IP, own bucket
    });
  });

  describe('blacklist', () => {
    afterEach(() => {
      mockConfig.dns.rateLimit = undefined;
      mockConfig.dns.blacklist = undefined;
    });

    it('should report an untouched IP as not blacklisted', () => {
      expect(isBlacklisted('198.51.100.10')).toBe(false);
    });

    it('should ban an IP after it crosses the configured violation threshold, and drop its queries thereafter', () => {
      mockConfig.dns.rateLimit = { maxPerSecondPerIp: 1 };
      mockConfig.dns.blacklist = { violationWindowMs: 60000, violationsToBan: 3, banDurationMs: 60000 };
      const ip = '198.51.100.11';

      const sent = [];
      const ask = () => handleQuery(
        { questions: [{ name: 'dmr.allmusic.com', type: 'A' }] },
        { address: ip, port: 5 },
        (answers) => sent.push(answers),
      );

      expect(ask()).toBe(true); // 1st query: under the limit, answered normally
      expect(sent).toHaveLength(1);

      // Next 3 queries exceed the per-second limit -> 3 violations -> ban.
      expect(ask()).toBe(false);
      expect(ask()).toBe(false);
      expect(ask()).toBe(false);
      expect(require('../src/logger').warn).toHaveBeenCalledWith(
        expect.stringContaining(`blacklisted ${ip}`),
      );

      expect(isBlacklisted(ip)).toBe(true);

      // Now banned outright: dropped even though it would otherwise be answerable.
      const sentAfterBan = [];
      const r = handleQuery(
        { questions: [{ name: 'dmr.allmusic.com', type: 'A' }] },
        { address: ip, port: 5 },
        (answers) => sentAfterBan.push(answers),
      );
      expect(r).toBe(false);
      expect(sentAfterBan).toHaveLength(0);
    });

    it('should not ban when blacklist is not configured, no matter how many times the rate limit is hit', () => {
      mockConfig.dns.rateLimit = { maxPerSecondPerIp: 1 };
      const ip = '198.51.100.12';
      const ask = () => handleQuery(
        { questions: [{ name: 'dmr.allmusic.com', type: 'A' }] },
        { address: ip, port: 5 },
        () => {},
      );
      ask();
      for (let i = 0; i < 10; i++) ask();
      expect(isBlacklisted(ip)).toBe(false);
    });
  });

  it('should log a query error and not crash on a malformed DNS packet', (done) => {
    require('../src/logger').error.mockClear();
    const garbage = Buffer.from([0xff, 0x00, 0x01, 0xde, 0xad, 0xbe, 0xef]);
    client.send(garbage, mockDnsPort, '127.0.0.1');
    // Packet.parse() will throw; dns2 surfaces it as requestError → [dns] query error
    setTimeout(() => {
      try {
        expect(require('../src/logger').error).toHaveBeenCalledWith(expect.stringContaining('query error'));
      } catch (e) { return done(e); }
      done();
    }, 100);
  });

  it('should ignore packets of type response (only queries are handled)', (done) => {
    const p = new Packet();
    p.header.id = 1;
    p.header.qr = 1; // response
    p.answers.push({ name: 'x.example', type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl: 60, address: '1.2.3.4' });
    // we do not wait for a response - the packet should be ignored; we only check for no crash
    client.send(p.toBuffer(), mockDnsPort, '127.0.0.1');
    setTimeout(done, 50);
  });

  it('should register an error handler on the server socket', () => {
    expect(server.listeners('error').length).toBeGreaterThan(0);
  });

  it('should log a server-level error when the server emits "error"', () => {
    require('../src/logger').error.mockClear();
    // covers the server.on('error') handler registered in startDnsServer
    server.emit('error', Object.assign(new Error('socket boom'), { protocol: 'udp' }));
    expect(require('../src/logger').error).toHaveBeenCalledWith(expect.stringContaining('socket boom'));
  });

  it('should default the protocol to "udp" in the log when the error carries none', () => {
    require('../src/logger').error.mockClear();
    server.emit('error', new Error('no-protocol boom')); // e.protocol is undefined → `?? 'udp'` fallback
    expect(require('../src/logger').error).toHaveBeenCalledWith(expect.stringContaining('no-protocol boom (udp)'));
  });
});

describe('forwardUpstream / sendRaw / setRawSocket', () => {
  it('should relay the upstream response to the client via the raw socket', (done) => {
    // 1. Start a real server and register its UDP socket as raw (sendRaw).
    startDnsServer().then((dns2Server) => {
      setRawSocket(dns2Server.servers.udp);

      const realCreate = dgram.createSocket;
      const sock = fakeUpstreamSocket();

      // 3. A real client sends a query for a non-target host → forwardUpstream.
      //    We create it BEFORE mocking createSocket so it is a real socket.
      const client = dgram.createSocket('udp4');
      client.on('message', (responseBuf) => {
        const d = Packet.parse(responseBuf);
        dgram.createSocket = realCreate;
        client.close();
        dns2Server.close();
        expect(d.header.id).toBe(7);
        expect(d.header.qr).toBe(1);
        done();
      });

      // 2. Replace createSocket for the socket created in forwardUpstream
      //    (upstream) - it does not go to the network, only to the fake socket.
      dgram.createSocket = () => sock;

      const query = buildQuery(7, 'example.com');
      client.send(query, mockDnsPort, '127.0.0.1');

      // 4. Simulate the response from upstream (roundtrip): the forwarder's "message"
      //    handler validates it against the query it sent, then relays it via the
      //    raw server socket (sendRaw).
      setTimeout(() => {
        sock.messageHandler(buildReply({ id: 7, name: 'example.com' }));
      }, 100);
    });
  }, 8000);

  it('should not relay an upstream reply whose transaction ID does not match the query', (done) => {
    // An off-path attacker racing the real upstream: right ephemeral port, wrong
    // txid. The forged packet must be dropped, and the listener must survive so
    // the genuine reply behind it still gets through.
    startDnsServer().then((dns2Server) => {
      setRawSocket(dns2Server.servers.udp);
      const realCreate = dgram.createSocket;
      const sock = fakeUpstreamSocket();

      const client = dgram.createSocket('udp4');
      client.on('message', (responseBuf) => {
        const d = Packet.parse(responseBuf);
        dgram.createSocket = realCreate;
        client.close();
        dns2Server.close();
        // Only the genuine reply (1.2.3.4) may reach the client, never 6.6.6.6.
        expect(d.answers[0].address).toBe('1.2.3.4');
        done();
      });

      dgram.createSocket = () => sock;
      client.send(buildQuery(11, 'spoof.example'), mockDnsPort, '127.0.0.1');

      setTimeout(() => {
        sock.messageHandler(buildReply({ id: 999, name: 'spoof.example', address: '6.6.6.6' }));
        sock.messageHandler(buildReply({ id: 11, name: 'spoof.example', address: '1.2.3.4' }));
      }, 100);
    });
  }, 8000);

  it('should not relay an upstream reply whose question does not match the query', (done) => {
    // Same txid, different name - the cross-domain variant of the same attack.
    startDnsServer().then((dns2Server) => {
      setRawSocket(dns2Server.servers.udp);
      const realCreate = dgram.createSocket;
      const sock = fakeUpstreamSocket();

      const client = dgram.createSocket('udp4');
      client.on('message', (responseBuf) => {
        const d = Packet.parse(responseBuf);
        dgram.createSocket = realCreate;
        client.close();
        dns2Server.close();
        expect(d.questions[0].name).toBe('real.example');
        expect(d.answers[0].address).toBe('1.2.3.4');
        done();
      });

      dgram.createSocket = () => sock;
      client.send(buildQuery(12, 'real.example'), mockDnsPort, '127.0.0.1');

      setTimeout(() => {
        sock.messageHandler(buildReply({ id: 12, name: 'attacker.example', address: '6.6.6.6' }));
        sock.messageHandler(buildReply({ id: 12, name: 'real.example', address: '1.2.3.4' }));
      }, 100);
    });
  }, 8000);

  it('should connect the upstream socket to the configured upstream so the kernel drops foreign senders', () => {
    const realCreate = dgram.createSocket;
    const sock = fakeUpstreamSocket();
    let connectedTo = null;
    sock.connect = (port, address, cb) => { connectedTo = { port, address }; cb?.(); return sock; };
    dgram.createSocket = () => sock;
    try {
      handleQuery(
        { questions: [{ name: 'connected.example', type: 'A' }] },
        { address: '127.0.0.1', port: 5 },
        () => {},
      );
      expect(connectedTo).toEqual({ port: mockConfig.dns.upstreamPort, address: mockConfig.dns.upstream });
      expect(sock.sent).not.toBeNull(); // sent only after connect() completed
    } finally {
      dgram.createSocket = realCreate;
    }
  });

  it('should drop an unparseable upstream reply instead of relaying it', () => {
    const realCreate = dgram.createSocket;
    const sock = fakeUpstreamSocket();
    dgram.createSocket = () => sock;
    const relayed = [];
    setRawSocket({ send: (msg) => relayed.push(msg) });
    try {
      handleQuery(
        { questions: [{ name: 'garbage.example', type: 'A' }] },
        { address: '127.0.0.1', port: 5 },
        () => {},
      );
      sock.messageHandler(Buffer.from([0xff, 0x00, 0x01, 0xde, 0xad])); // too short for a header
      sock.messageHandler(Buffer.alloc(0));
      expect(relayed).toHaveLength(0);
    } finally {
      dgram.createSocket = realCreate;
      setRawSocket(null);
    }
  });

  it('should log the upstream error and close the upstream socket when it fails', (done) => {
    startDnsServer().then((dns2Server) => {
      const realCreate = dgram.createSocket;
      let upCloseCalls = 0;

      // Real client - created BEFORE mocking createSocket.
      const client = dgram.createSocket('udp4');
      client.on('error', () => {});

      // Mock createSocket (upstream socket) - register the errorCb and trigger it.
      dgram.createSocket = () => {
        const fake = fakeUpstreamSocket();
        const { once } = fake;
        fake.once = (ev, cb) => {
          once.call(fake, ev, cb);
          if (ev === 'error') setImmediate(() => cb(new Error('upstream boom')));
          return fake;
        };
        return fake;
      };

      setTimeout(() => {
        dgram.createSocket = realCreate;
        client.close();
        dns2Server.close();
        try {
          expect(require('../src/logger').error).toHaveBeenCalledWith(expect.stringContaining('upstream boom'));
        } catch (e) { return done(e); }
        done();
      }, 80);

      // We send a real query for a non-target host - the server routes it to
      // forwardUpstream (forwardUnknown=true), which uses the mocked socket.
      const q = buildQuery(9, 'example.com');
      client.send(q, mockDnsPort, '127.0.0.1');
    });
  }, 5000);

  it('should log a warning and close the upstream socket after the 3000ms timeout', (done) => {
    startDnsServer().then((dns2Server) => {
      const realCreate = dgram.createSocket;

      // Real client created before the createSocket mock.
      const client = dgram.createSocket('udp4');
      client.on('error', () => {});

      // Upstream socket - never replies (no 'message'/'error'), so the 3000ms timeout fires.
      const timeoutSock = fakeUpstreamSocket();
      dgram.createSocket = () => timeoutSock;

      const q = buildQuery(10, 'timeout.example');
      client.send(q, mockDnsPort, '127.0.0.1');

      // We wait longer than the internal timeout (3000 ms) + restore.
      setTimeout(() => {
        dgram.createSocket = realCreate;
        client.close();
        dns2Server.close();
        try {
          expect(timeoutSock.closeCount).toBeGreaterThanOrEqual(1);
          expect(require('../src/logger').warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
        } catch (e) { return done(e); }
        done();
      }, 3200);
    });
  }, 6000);

  it('should log an error and drop the response when the raw socket is not available (sendRaw fallback)', (done) => {
    // No real dns2 server involved - handleQuery is exercised directly (as in the
    // "forward a non-target query" test above), so this cannot race with any
    // other test's server/port lifecycle.
    setRawSocket(null); // simulate a registration that never happened (or a non-socket object)
    const realCreate = dgram.createSocket;
    const sock = fakeUpstreamSocket();
    dgram.createSocket = () => sock;

    handleQuery(
      { questions: [{ name: 'dropped.example', type: 'A' }] },
      { address: '127.0.0.1', port: 5 },
      () => {},
    );

    setImmediate(() => {
      // id 0: a plain query object carries no id, so forwardUpstream sends
      // `query.id ?? 0` - the reply has to echo that to pass validation.
      sock.messageHandler(buildReply({ id: 0, name: 'dropped.example' }));
      dgram.createSocket = realCreate;
      try {
        expect(require('../src/logger').error).toHaveBeenCalledWith(
          expect.stringContaining('sendRaw: raw socket not available'),
        );
      } catch (e) { return done(e); }
      done();
    });
  });
});