'use strict';

const MAGIC = Buffer.from('BIN ');
const HEADER_SIZE = 0x34;
const { getLastConsoleMac } = require('./consoles');
const { loadConfig } = require('./config');
const config = loadConfig();

/**
 * Parses the fixed 0x34-byte "BIN " header off the front of a PS3 request body.
 * @param {Buffer} body - full request body
 * @returns {object} decoded header fields (version, secret, user, selectors, variant, flags, ...)
 * @throws {Error} when the body is too short or does not start with the "BIN " magic
 */
function parseBinHeader(body) {
  if (body.length < HEADER_SIZE || !body.subarray(0, 4).equals(MAGIC)) {
    throw new Error('not a "BIN " packet');
  }
  return {
    version: [body[4], body[5]],
    sessionField: body.readUInt32BE(6),
    secret: body.subarray(0x0a, 0x1a),
    user: body.subarray(0x1a, 0x2a),
    transformSelector: body.readUInt16LE(0x2a),
    integritySelector: body.readUInt16LE(0x2c),
    variant: String.fromCharCode(body[0x2e]),
    paramA: body.readUInt16LE(0x2f),
    paramB: body.readUInt16LE(0x31),
    flag: String.fromCharCode(body[0x33]),
    plainPrefixLen: HEADER_SIZE, // the plaintext packet prefix starts here in the body
  };
}

/**
 * Builds a "BIN " request header (mirrors parseBinHeader) - used by test/tool
 * code to construct a synthetic PS3 request.
 * @param {object} [opts] - header field overrides
 * @param {[number, number]} [opts.version] - protocol version bytes
 * @param {number} [opts.sessionField] - session field (u32 BE)
 * @param {string|Buffer} [opts.secret] - console MAC/secret; defaults to the last captured console's MAC
 * @param {string} [opts.user] - username; defaults to config.client.userName
 * @param {number} [opts.transformSelector] - transform selector (u16 LE)
 * @param {number} [opts.integritySelector] - integrity selector (u16 LE)
 * @param {string} [opts.variant] - single-character protocol variant
 * @param {number} [opts.paramA] - paramA (u16 LE)
 * @param {number} [opts.paramB] - paramB (u16 LE)
 * @param {string} [opts.flag] - single-character flag byte
 * @returns {Buffer} the encoded header, HEADER_SIZE bytes long
 * @throws {Error} when no secret is given and no console MAC has been captured yet
 */
function buildBinHeader(opts) {
  const b = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(b, 0);
  b[4] = opts.version?.[0] ?? 0x02;
  b[5] = opts.version?.[1] ?? 0x03;
  b.writeUInt32BE(opts.sessionField ?? 0, 6);
  const secretValue = opts.secret ?? getLastConsoleMac();
  if (!secretValue) {
    throw new Error(
      'no console MAC available - send a request from the PS3 (GET or POST) so the emulator can capture the MAC, or provide opts.secret',
    );
  }
  const secret = Buffer.alloc(16);
  Buffer.from(secretValue).copy(secret);
  secret.copy(b, 0x0a);
  const user = Buffer.alloc(16);
  Buffer.from(opts.user ?? config?.client?.userName).copy(user);
  user.copy(b, 0x1a);
  b.writeUInt16LE(opts.transformSelector ?? 3, 0x2a);
  b.writeUInt16LE(opts.integritySelector ?? 3, 0x2c);
  b[0x2e] = (opts.variant ?? 'H').charCodeAt(0);
  b.writeUInt16LE(opts.paramA ?? 0x656e, 0x2f);
  b.writeUInt16LE(opts.paramB ?? 0x0009, 0x31);
  b[0x33] = (opts.flag ?? 'S').charCodeAt(0);
  return b;
}

module.exports = { parseBinHeader, buildBinHeader, HEADER_SIZE, MAGIC };
