# extension/background/sw.js

Service worker. Owns room state and routes messages between popup, content
scripts, and the offscreen document. Does not touch WebSocket or RTCPeerConnection
directly — all network work is delegated to `offscreen/offscreen.js`.

## Message API (inbound from popup / content script)

| `msg.type`       | Payload fields         | Response                                         |
|------------------|------------------------|--------------------------------------------------|
| `CREATE_ROOM`    | —                      | `{ roomCode: string }`                           |
| `JOIN_ROOM`      | `roomCode: string`     | `{ ok: true }` or `{ ok: false, error: string }` |
| `LEAVE_ROOM`     | —                      | `{}`                                             |
| `PLAYBACK_EVENT` | `event: PlaybackEvent` | none (host only; ignored if viewer)              |
| `PUSH_VIDEO`     | —                      | none; host only — broadcasts clean video URL to viewers via offscreen |
| `VIEWER_STATUS`  | `status: ViewerStatus` | none; viewer only — forwarded to offscreen for data channel broadcast to host |
| `VIEWER_DESYNCED`| —                      | none; viewer only — sets `state.isSynced = false`, broadcasts state |
| `JUMP_REQUEST`   | `currentTime, videoId, videoPart` | none; viewer only — broadcasts `jump-request` to host via data channel |
| `SET_SYNC`       | `synced: boolean`      | none; viewer only — updates `isSynced`, forwards to content script |
| `ACCEPT_REQUEST` | `peerId: string`       | none; host only — broadcasts seek to all peers + seeks host's own tab |
| `DISMISS_REQUEST`| `peerId: string`       | none; host only — removes request from `pendingRequests`, broadcasts state |
| `GET_STATE`      | —                      | `RoomState`                                      |

## Message API (inbound from offscreen document)

| `msg.type`           | Payload fields              | Effect                                      |
|----------------------|-----------------------------|---------------------------------------------|
| `PEER_COUNT_CHANGED`  | `count: number`                      | Updates `state.peerCount`, broadcasts state |
| `PEER_DISCONNECTED`   | `peerId: string, count: number`      | Removes viewer entry by peerId, updates count, broadcasts state |
| `VIEWER_STATUS_UPDATE`  | `peerId: string, status: ViewerStatus` | Stores/updates viewer entry, broadcasts state |
| `JUMP_REQUEST_RECEIVED` | `peerId: string, currentTime, videoId, videoPart` | Stores/replaces pending request for this peerId, broadcasts state |
| `SYNC_COMMAND`          | `event: PlaybackEvent`               | Forwards to content script on tracked tab   |
| `REQUEST_STATE`         | —                                    | Asks content script for current video state |
| `RECEIVED_PUSH_VIDEO`   | `videoId: string, url: string`       | Stores pending video, broadcasts state      |

## Messages emitted (outbound to offscreen)

| `msg.type`                  | Payload                                        |
|-----------------------------|------------------------------------------------|
| `OFFSCREEN_JOIN`            | `{ roomCode, peerId, isHost }`                 |
| `OFFSCREEN_LEAVE`           | —                                              |
| `OFFSCREEN_PLAYBACK_EVENT`  | `{ event: PlaybackEvent }`                     |
| `OFFSCREEN_BROADCAST`       | `{ payload: object }` — sent to all data channels |
| `OFFSCREEN_SEND_PEER`       | `{ peerId: string, payload: object }` — sent to one peer's data channel only |

## Messages emitted (outbound to popup / content script)

| `msg.type`     | Sent to                   | Payload     |
|----------------|---------------------------|-------------|
| `ROOM_STATE`   | `chrome.runtime` (popup)  | `RoomState` |
| `ROOM_STATE`   | `chrome.tabs` (content)   | `RoomState` |
| `SYNC_COMMAND` | `chrome.tabs` (content)   | `{ event: PlaybackEvent }` |
| `REQUEST_STATE`| `chrome.tabs` (content)   | —           |

## Types

```ts
RoomState {
  inRoom:          boolean
  isHost:          boolean
  roomCode:        string | null
  memberCount:     number          // includes self
  connected:       boolean         // WebSocket is open (reported by offscreen)
  isSynced:        boolean         // viewer only: false = freerunning
  pendingVideoUrl: string | null   // viewer: set when host pushes a video
  pendingVideoId:  string | null   // viewer: BV id of pushed video
  viewers:         ViewerEntry[]   // host only: sorted by index
  pendingRequests: RequestEntry[]  // host only: sorted by index
}

ViewerEntry {
  index:          number   // stable 1-based display index
  drift:          number | null  // abs(hostCurrentTime - viewer.currentTime); null if host has no time yet
  paused:         boolean
  buffering:      boolean
  onCorrectVideo: boolean  // viewer's videoId+videoPart match host's
  isSynced:       boolean  // viewer's own sync state (forwarded from ViewerStatus)
}

RequestEntry {
  peerId:      string
  index:       number    // viewer display index (0 if unknown)
  currentTime: number    // seconds the viewer wants to jump to
  paused:      boolean   // viewer's playback state at request time
  videoId:     string
  videoPart:   number
}

ViewerStatus {
  currentTime: number
  paused:      boolean
  buffering:   boolean
  videoId:     string
  videoPart:   number
  isSynced:    boolean
}

PlaybackEvent {
  action:      'play' | 'pause' | 'seek' | 'speed' | 'heartbeat'
  currentTime: number    // seconds
  rate?:       number    // playbackRate; present on 'play' and 'speed'
  videoId:     string    // BV id extracted from host's tab URL
  videoPart:   number    // ?p= value; 1 if absent
  ts:          number    // Date.now() at emission
}
```

## Internal state

| Field          | Type            | Purpose |
|----------------|-----------------|---------|
| `peerId`       | `string\|null`  | This peer's UUID |
| `roomCode`     | `string\|null`  | Active room code |
| `isHost`       | `boolean`       | Whether this peer created the room |
| `tabId`        | `number\|null`  | Tab ID of the tracked Bilibili video tab |
| `peerCount`    | `number`        | Open data channels (reported by offscreen) |
| `wsConnected`  | `boolean`       | WebSocket open status |
| `videoId`      | `string\|null`  | BV id of host's current video |
| `videoPart`    | `number`        | `?p=` value from tab URL; defaults to 1 |
| `hostCurrentTime` | `number\|null`  | Host's last reported video position (seconds) |
| `isSynced`        | `boolean`       | Viewer only: false = viewer is freerunning |
| `pendingVideoUrl` | `string\|null`  | Clean pushed URL for viewer popup banner |
| `pendingVideoId`  | `string\|null`  | BV id of pending push |
| `viewers`         | `Map`           | peerId → viewer status entry (host only) |
| `nextViewerIndex` | `number`        | Monotonically increasing display index counter |
| `pendingRequests` | `Map`           | peerId → jump request entry (host only); debounced (last wins) |

## Internal functions

| Function | Purpose |
|---|---|
| `handleCreateRoom()` | Generates room code and peer ID, creates offscreen doc, joins room |
| `handleJoinRoom(code)` | Creates offscreen doc, joins room via offscreen |
| `handleLeaveRoom()` | Sends leave to offscreen, closes offscreen doc, resets state |
| `ensureOffscreen()` | Creates offscreen document if not already present |
| `closeOffscreen()` | Closes offscreen document if present |
| `getRoomState()` | Returns current `RoomState` snapshot |
| `broadcastState()` | Pushes `RoomState` to popup and content script |
| `extractPart(url)` | Extracts `?p=N` from a Bilibili URL; returns 1 if absent |
| `generateId()` | Returns `crypto.randomUUID()` |
| `generateRoomCode()` | Returns a 6-char alphanumeric code (no O/0/I/1) |
