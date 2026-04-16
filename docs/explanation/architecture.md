# Architecture

YukiBiliSync keeps multiple people's Bilibili players in sync. Each viewer streams
video from Bilibili directly; the extension synchronizes only control state (play,
pause, seek, speed). No video data passes through any YukiBiliSync infrastructure.

## Three pieces

**Browser extension** — runs on `bilibili.com/video/*` and `bilibili.com/bangumi/play/*`.
Split into four execution contexts:

- *Service worker* (`background/sw.js`): the hub. Owns room state (roomCode,
  peerId, isHost, videoId, videoPart, peer count). Routes messages between all
  other contexts. Creates and destroys the offscreen document on join/leave.
- *Offscreen document* (`offscreen/offscreen.js`): owns the WebSocket connection
  to the signaling server and all RTCPeerConnection/RTCDataChannel objects.
  Chrome MV3 service workers do not have access to WebRTC APIs; the offscreen
  document provides the required page context. Created on join, closed on leave.
- *Content script* (`content/content.js` + `content/overlay.js`): injected into
  every matching Bilibili tab. `content.js` finds the `<video>` element, wires
  playback event listeners (host side), and applies incoming sync commands (viewer
  side), gated on video identity match. `overlay.js` renders the floating status badge.
- *Popup* (`popup/popup.js`): the extension toolbar UI. Three views: idle
  (create/join), in-room (code, role, member count, host/viewer controls), and
  settings (server URL configuration). Server URLs are persisted to
  `chrome.storage.sync` and read by the offscreen document at join time.

All four contexts communicate exclusively through `chrome.runtime.sendMessage` /
`chrome.tabs.sendMessage`. The service worker is the single source of truth for
room state; popup and content scripts poll or listen for `ROOM_STATE` messages.

**Signaling server** (`server/src/server.js`) — a lightweight HTTPS/WebSocket
service. Its only jobs are:

1. Maintain a room registry (`roomCode → Map<peerId, ws>`).
2. Relay SDP offers/answers and ICE candidates between peers during WebRTC setup.
3. Vend short-lived TURN credentials on request (HMAC-SHA1 over a shared secret).

Once two peers have established a data channel, the server carries no more traffic
for that pair. It is intentionally stateless beyond the in-memory room map.

**WebRTC data channels** — the actual sync channel between the host's browser and
each viewer's browser. Carries JSON messages: `play`, `pause`, `seek`, `speed`,
`heartbeat`. The host sends; viewers receive and apply.

## Data flow

```
Host browser                          Signaling server         Viewer browser
────────────                          ────────────────         ──────────────
popup → CREATE_ROOM → sw.js
sw.js → OFFSCREEN_JOIN → offscreen.js
offscreen.js → WS "join"         →    rooms[code].set(hostId)
                                            ...
                                                         ←    WS "join" (viewer)
offscreen.js ← "peer-joined"     ←    broadcast              → "peer-joined"
offscreen.js → "signal" (offer)  →    relay to viewer
                                                         ←    "signal" (answer)
offscreen.js ← "signal" (answer) ←    relay to host

  [RTCDataChannel established — server no longer in the path]

video "play" event
content.js → PLAYBACK_EVENT → sw.js → OFFSCREEN_PLAYBACK_EVENT
offscreen.js → DataChannel.send() ──────────────────────────→  DataChannel msg
                                                               offscreen.js → SYNC_COMMAND → sw.js
                                                               sw.js → SYNC_COMMAND → content.js
                                                               content.js → video.play()
```

## Dependency direction

```
popup.js    →  (chrome.runtime)  →  sw.js
content.js  →  (chrome.runtime)  →  sw.js
overlay.js  →  (chrome.runtime)  →  sw.js
sw.js       →  (chrome.runtime)  →  offscreen.js
offscreen.js →  config.js        (DEFAULT_CONFIG fallback only)
offscreen.js →  chrome.storage.sync  (runtime server URLs)
offscreen.js →  WebSocket (signaling server)
offscreen.js →  RTCPeerConnection (TURN/STUN)
popup.js    →  chrome.storage.sync  (settings read/write)
```

No content script or popup file imports another; all coordination is message-based.
`config.js` is the only shared import; it provides empty-string fallbacks used
only when the user has not saved server URLs via the settings panel.
The offscreen document is the only context that touches network resources.

## Host-authoritative model

The room creator is the host. The host's `<video>` element is the source of truth.
Viewers receive commands and apply them. Viewers may send *requests* (jump requests,
viewer status) back to the host, but the host decides whether to act on them —
no viewer action changes playback state without explicit host approval. If the host
leaves, the room ends. Host migration is out of scope for v1.

## TURN by default

WebRTC normally exposes each participant's public IP during ICE negotiation.
YukiBiliSync routes all traffic through a self-hosted `coturn` TURN server
(`iceTransportPolicy: 'relay'`), so peers see only the TURN server's IP, not each
other's. Sync messages are small (control state only), so TURN relay bandwidth is
negligible.

## Bilibili-specific quirks

The `<video>` element loads asynchronously and gets re-created on quality changes
and part switches. `content.js` handles this with an initial polling loop
(`setInterval`, 500 ms, up to 20 s) followed by a `MutationObserver` that watches
for element replacement. Listeners are detached from the old element and re-attached
to the new one.
