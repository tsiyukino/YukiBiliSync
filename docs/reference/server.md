# server/src/server.js

Signaling server. HTTPS/WebSocket service that relays WebRTC handshake messages
between peers and vends short-lived TURN credentials. Carries no ongoing sync
traffic once peers are connected.

## Runtime requirements

| Env var       | Required | Description |
|---------------|----------|-------------|
| `TURN_SECRET` | yes      | Shared secret configured in `coturn` |
| `TURN_HOST`   | yes      | TURN server address, e.g. `your-server.com:3478` |
| `TLS_CERT`    | yes      | Path to TLS certificate (fullchain.pem) |
| `TLS_KEY`     | yes      | Path to TLS private key (privkey.pem) |
| `PORT`        | no       | Listening port; defaults to `8444` |

## TLS requirement

The server uses HTTPS/WSS. A valid TLS certificate is required — browsers reject
self-signed certificates for WebSocket connections made from extensions.

- **With a domain**: obtain a certificate from Let's Encrypt (`certbot --standalone`
  or via your reverse proxy). Pass the paths as `TLS_CERT` and `TLS_KEY`.
- **With a raw IP only**: the signaling WebSocket connection will fail in most
  browsers. The TURN server (a separate `coturn` process) works fine with a raw
  IP. A domain is strongly recommended for any deployment intended to be used by
  others.

## Room model

```
rooms: Map<roomCode, Map<peerId, ws>>
```

In-memory only. Rooms are created on first join, deleted when the last peer
leaves. There is no persistence and no room expiry beyond connection close.

## WebSocket message protocol

### Client → server

| `type`             | Fields                          | Effect |
|--------------------|----------------------------------|--------|
| `join`             | `roomCode`, `peerId`            | Enter room; receive `peer-joined` for existing members; notify existing members |
| `signal`           | `roomCode`, `to`, `payload`     | Relay `payload` to `to` as a `signal` message |
| `leave`            | —                               | Leave room; notify remaining members |
| `turn-credentials` | —                               | Request short-lived TURN credentials |

### Server → client

| `type`             | Fields                          | When sent |
|--------------------|----------------------------------|-----------|
| `peer-joined`      | `peerId`                        | To newcomer (for each existing member) and to existing members (for newcomer) |
| `peer-left`        | `peerId`                        | To remaining members when someone disconnects or leaves |
| `signal`           | `from`, `payload`               | Forwarded SDP or ICE candidate |
| `turn-credentials` | `username`, `credential`, `ttl`, `host` | Response to `turn-credentials` request |

## Key functions

| Function | Purpose |
|---|---|
| `handleMessage(ws, msg)` | Dispatches incoming messages to join/signal/leave/turn handlers |
| `cleanup(ws)` | Removes a peer from its room, notifies remaining peers, deletes empty rooms |
| `send(ws, msg)` | JSON-serializes and sends to one WebSocket if open |
| `broadcast(room, msg, except?)` | Sends to all peers in a room, optionally skipping one |
| `makeTurnCredentials()` | Generates HMAC-SHA1 time-limited TURN credentials (24 h TTL) |

## TURN credential format

Uses the TURN REST API convention. `username` is `<expiry-timestamp>:yukibilisync`;
`credential` is `HMAC-SHA1(TURN_SECRET, username)` base64-encoded. Compatible with
`coturn`'s `use-auth-secret` mode.
