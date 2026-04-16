# extension/offscreen/offscreen.js

Offscreen document. Owns the WebSocket connection to the signaling server and all
RTCPeerConnection/RTCDataChannel objects. Chrome MV3 service workers do not have
access to WebRTC APIs; this document provides the required page context.

Created by `sw.js` via `chrome.offscreen.createDocument` when the user joins or
creates a room. Closed via `chrome.offscreen.closeDocument` when the user leaves.

## Message API (inbound from service worker)

| `msg.type`                 | Payload                        | Effect |
|----------------------------|--------------------------------|--------|
| `OFFSCREEN_JOIN`           | `{ roomCode, peerId, isHost }` | Connects WebSocket, fetches TURN credentials, sends `join` to signaling server |
| `OFFSCREEN_LEAVE`          | —                              | Sends `leave`, closes all peers, closes WebSocket |
| `OFFSCREEN_PLAYBACK_EVENT` | `{ event: PlaybackEvent }`     | Broadcasts event JSON to all open data channels |
| `OFFSCREEN_BROADCAST`      | `{ payload: object }`          | Broadcasts arbitrary payload JSON to all open data channels |
| `OFFSCREEN_VIEWER_STATUS`  | `{ status: ViewerStatus }`     | Broadcasts viewer status to all open data channels (viewer → host) |

## Notifications emitted (outbound to service worker)

| `msg.type`            | Payload                         | When |
|-----------------------|---------------------------------|------|
| `PEER_COUNT_CHANGED`  | `{ count: number }`             | Data channel opens |
| `PEER_DISCONNECTED`   | `{ peerId: string, count: number }` | Peer left cleanly or connection failed/closed |
| `SYNC_COMMAND`        | `{ event: object }`             | Data channel message received (non-push-video) |
| `REQUEST_STATE`       | —                               | Data channel opens and this peer is host |
| `RECEIVED_PUSH_VIDEO` | `{ videoId: string, url: string }` | Data channel message of type `push-video` received |

## Data channel message schema

All messages sent over RTCDataChannel are JSON. Three categories:

**Playback sync** (host → viewer):
```js
{ action: 'play' | 'pause' | 'seek' | 'speed' | 'heartbeat', currentTime, rate?, videoId, ts }
```

**Video push** (host → viewer):
```js
{ type: 'push-video', videoId: string, url: string }
```
`url` is always a clean Bilibili canonical URL: `https://www.bilibili.com/video/BVxxx`
or `https://www.bilibili.com/video/BVxxx?p=N`. No tracking parameters.

## Internal functions

| Function | Purpose |
|---|---|
| `handleJoin({ roomCode, peerId, isHost })` | Full join sequence: connect WS, fetch TURN, send join |
| `handleLeave()` | Tear down: leave message, close peers, close WS |
| `connectSignaling()` | Opens WebSocket; resolves when open, rejects on failure |
| `fetchTurnCredentials()` | Sends `turn-credentials`, waits for reply, stores `iceConfig` |
| `handleSignalingMessage(msg)` | Dispatches `peer-joined`, `peer-left`, `signal` |
| `createOffer(peerId)` | Creates RTCPeerConnection + DataChannel, sends SDP offer (host only) |
| `handleRemoteSignal(fromId, payload)` | Processes incoming SDP offer/answer or ICE candidate |
| `setupDataChannel(peerId, channel)` | Wires `onopen`, `onmessage`, `onclose` for a data channel |
| `broadcastToPeers(payload)` | Sends a JSON-serialized object to all open data channels |
| `closePeer(peerId)` | Closes and removes a single peer's connection and channel |
