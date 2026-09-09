# PS3 CDDB Proxy

This project is a local proxy that **brings back online album metadata for audio CDs** played on the PS3 gaming console. It works by intercepting the PS3's metadata requests and answering them with data from [gnudb](https://gnudb.org/). The original metadata service was discontinued in early 2019, so without this proxy the console can no longer fetch CD information on its own.  **No jailbreak needed**. This works the same on retail firmware as it does on modded consoles, since it uses just a network setting.

## Overview

When the PS3 plays an audio CD, it is trying to contact already disabled servers to fetch album metadata. This project provides proxy written in nodejs that spoofs DNS and serves metadata from gnudb.

## How it works

1. The **DNS server** (port 53) intercepts the PS3's DNS queries for the console's original metadata servers and answers with your local IP address.
2. The **HTTP server** (port 80) receives the PS3's binary `BIN ` TLV requests on `/sdkrequest`, translates the disc TOC into a gnudb (FreeDB) CDDB query, fetches matching album metadata, and replies with a binary response in the format the PS3 expects.
3. Responses are cached on disk (`cache/`) to avoid hammering gnudb, and raw request/response dumps can be saved to `dumps/` for debugging.

## Requirements

- [Node.js](https://nodejs.org/) >= 22
- Windows / Linux / macOS machine on the same network as the PS3
- Ports 53 (DNS) and 80 (HTTP) must be free
- A PS3 you own, set up to use a custom primary DNS server

## Installation

```bash
git clone https://github.com/csrednicki/ps3-cddb.git
cd ps3-cddb
npm install
```

## Configuration

Edit `api/config.json` before the first run:

| Key | Description |
| --- | --- |
| `dns.answerIp` | IP address of the machine running this proxy - the PS3 will be pointed here as its DNS server. Set it manually to your LAN IP or set `0.0.0.0` to autodetect lan ip. |
| `dns.port` / `http.port` | Listening ports (53 / 80 by default). |
| `gnudb.email` | Email used in the gnudb CDDB handshake (see gnudb usage policy). |
| `gnudbCache.ttlSeconds` | How long fetched albums stay cached on disk. |
| `dumps.logRequests` / `dumps.logResponses` | Save raw binary dumps of PS3 requests and emulator responses to `dumps/`. |
| `dns.rateLimit.maxPerSecondPerIp` / `http.rateLimit.maxPerSecondPerIp` | Per-source-IP request cap; unset disables rate limiting for that server. See [Security](#security). |
| `dns.blacklist` / `http.blacklist` | `{ violationWindowMs, violationsToBan, banDurationMs }` - auto-ban settings for IPs that keep exceeding the rate limit. See [Security](#security). |

## Running

```bash
npm start
```

On Windows, run the terminal **as Administrator** (ports 53/80 are privileged on some setups); on Linux use `sudo` or `setcap`.

## Docker

```bash
# build and start (replace 192.168.1.10 with the LAN IP of the Docker host)
HOST_IP=192.168.1.10 docker compose up -d --build

# check the logs
docker compose logs -f
```

Notes:

- `HOST_IP` **must** be set to the Docker host's LAN IP - inside the container the auto-detected address would be the container-internal one, which the PS3 cannot reach.
- Ports 53 (UDP+TCP) and 80 are published on the host, so nothing else may already use them (e.g. `dnsmasq`, `systemd-resolved`, IIS). On Windows, disable the DNS Client service / anything bound to :53 if the bind fails.
- `cache/`, `dumps/` and `logs/` are bind-mounted from the repo directory, so data survives container restarts.
- Optional env overrides: `GNUDB_EMAIL`, `LOG_LEVEL`, `LOG_COLOR`, `DNS_PORT`, `HTTP_PORT`.
- If `HOST_IP` is a WAN-reachable address rather than a LAN one, read [Security](#security) below first.

# Setup on PS3

1. Set the primary DNS server to the emulator machine's IP using network settings.
2. Make sure the CDDB EULA is accepted (it shows up on first cd metadata fetch).
3. Insert an audio CD - the PS3 will fetch artist, album, track titles metadata from gnudb.

## Security

**Run this on a trusted LAN, not on the public internet.** The proxy reimplements the PS3's original plaintext CDDB protocol, which has no authentication and no encryption - anyone who can reach ports 53 (DNS) and 80 (HTTP) can query it, and it was never designed to withstand hostile traffic from strangers. Set `dns.answerIp` / `HOST_IP` to a private LAN address (e.g. `192.168.x.x`), not a public IP.

Both the **DNS server** and the **HTTP server** apply the same per-source-IP rate limiting and auto-ban mechanism (`dns.rateLimit`/`dns.blacklist` and `http.rateLimit`/`http.blacklist` in `config.json`), each with its own independent budget and ban list: an IP that keeps sending more than `maxPerSecondPerIp` requests/queries a second gets throttled (DNS: dropped silently; HTTP: `429 Too Many Requests`), and one that keeps tripping the limit is banned outright for `banDurationMs` once it crosses `violationsToBan` violations within `violationWindowMs` (DNS: dropped silently; HTTP: connection reset with no response).

The DNS server has a couple of protocol-specific mitigations on top of that:

- Dropping CHAOS-class queries (`version.bind`/`hostname.bind`-style fingerprinting probes) instead of answering or forwarding them.
- Validating that a forwarded upstream reply actually answers the query that was sent (transaction ID, name, type, class, over a connected UDP socket) before relaying it back, guarding the forwarding path against off-path spoofing.

The HTTP server has no such protocol-level checks - `/sdkrequest` accepts any POST body from anyone who can reach port 80 and get past the rate limiter, with no authentication (the protocol it imitates has none). It fails safely on malformed input (it replies with an error record rather than crashing).

In short: these mitigations reduce casual/automated abuse, they do **not** turn this into a hardened public-facing service - there is still no encryption, and a slow/low-rate attacker or one spreading requests across many IPs is not stopped by a per-IP limiter. If you need to reach a PS3 that isn't on your LAN, put it behind a VPN (e.g. Tailscale/WireGuard) back into the LAN instead of exposing ports 53/80 directly to the internet.

## Tests

```bash
npm test
```

## Project layout

```
api/          Node.js emulator (DNS + HTTP + gnudb client)
  src/        Source code
  test/       Jest tests
  config.json Configuration
cache/        On-disk gnudb album cache
dumps/        Raw request/response captures from a real PS3
logs/         Daily log files
```

## Credits

- Protocol details determined by the author and community through interoperability research on their own hardware.
- Metadata provided by [gnudb](https://gnudb.org/) - please respect their usage policy.

## Disclaimer

- **Not affiliated with Sony.** "PS3" and "PlayStation" are trademarks of Sony Interactive Entertainment Inc. This is an independent, unofficial project with no association, sponsorship, or endorsement from Sony.
- **Not affiliated with gnudb.** This project is an independent client of the gnudb service; see [gnudb's usage policy](https://gnudb.org/) for the terms that apply to using their database, and use your own gnudb-registered email in `config.json`.
- **Independent interoperability research.** The message formats implemented here were determined by the author and community through their own interoperability testing on hardware they own, without use of or reference to any confidential Sony source code, tools, or documentation.
- **No warranty.** This software is provided "as is", without warranty of any kind, express or implied, as stated in the [LICENSE](LICENSE) (MIT).
- **No liability.** To the extent permitted by law, the author is not liable for any damage, data loss, network disruption, console malfunction, account/service consequences, or other loss arising from downloading, configuring, or running this software, or from how you configure your own network, DNS, or console.
- **Your responsibility.** You are solely responsible for complying with the laws and third-party terms applicable in your jurisdiction, and for only running this against hardware and networks you own or are authorized to use.

## License

This project is licensed under the [MIT License](LICENSE).
