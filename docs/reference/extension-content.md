# extension/content/content.js

Content script injected into Bilibili video pages. Finds the `<video>` element,
wires playback event listeners for the host, and applies incoming sync commands
for viewers. Handles the element being replaced on quality changes or part switches.

All code runs in an IIFE; nothing is exported.

## Boot sequence

1. `startPolling()` — polls for `document.querySelector('video')` every 500 ms,
   up to 40 attempts (20 s). Stops as soon as an element is found.
2. `watchForReplacement()` — installs a `MutationObserver` on `document.body` to
   detect when the `<video>` element is replaced. Re-attaches listeners to the new
   element.
3. `listenToServiceWorker()` — registers `chrome.runtime.onMessage` for
   `SYNC_COMMAND`, `ROOM_STATE`, and `REQUEST_STATE`.
4. `getVideoId()` — extracts the `BVxxxxxxxx` identifier from `window.location.pathname`.

## Constants

| Name                    | Value   | Purpose |
|-------------------------|---------|---------|
| `DRIFT_THRESHOLD`       | 2.0 s   | Heartbeat snaps viewer if drift exceeds this |
| `HEARTBEAT_INTERVAL`    | 3000 ms | How often the host emits a heartbeat |
| `VIEWER_STATUS_INTERVAL`| 3000 ms | How often the viewer reports its status to the host |
| `POLL_INTERVAL`         | 500 ms  | How often to check for the video element |
| `POLL_MAX`              | 40      | Give up after 40 × 500 ms = 20 s |

## Key logic

**Host path**: `play`, `pause`, `seeked`, `ratechange` events on the video element
call `sendEvent()`, which posts a `PLAYBACK_EVENT` message to the service worker.
Events are suppressed when the content script itself caused the seek (via
`suppressNext` flag) to avoid echo loops.

**Viewer path**: incoming `SYNC_COMMAND` messages call `applySync(event)`, which
first checks that `event.videoId` matches the current page's BV id and that
`event.videoPart` matches the current `?p=` value — commands for a different
video or a different part of the same series are silently dropped. If `isSynced`
is false (viewer is freerunning), commands are silently dropped. If matched and
synced, calls `applyHostEvent()` which sets `video.currentTime`, calls
`video.play()` or `video.pause()`, or adjusts `video.playbackRate`. The
`suppressNext` flag is set before each seek to block the resulting `seeked` event
from being re-broadcast.

**Heartbeat**: host emits `{ action: 'heartbeat', currentTime, rate }` every
3 seconds via `sendEvent`. On the viewer side, if drift between the viewer's
`currentTime` and the event's `currentTime` exceeds `DRIFT_THRESHOLD`, the viewer
snaps. Below the threshold, playback continues uninterrupted. The heartbeat timer
starts when the host enters a room with a video element present, restarts when the
video element is replaced, and stops when the host leaves the room.

**Desync/resync**: when a viewer manually plays, pauses, or seeks the video
(i.e. any playback event not caused by a sync command), `desync()` is called.
This sets `isSynced = false` and sends `VIEWER_DESYNCED` to the service worker
(guarded to send only once per desync episode). While desynced, all incoming
`SYNC_COMMAND` messages are dropped. `resync(hostEvent)` sets `isSynced = true`
and immediately applies the last known host event for an instant snap. The overlay
shows "Desynced" with Request/Resync buttons; the popup shows the sync toggle.

**Jump request**: sent from `overlay.js` via `JUMP_REQUEST` message (not from
content.js). Content.js has no direct role in jump requests beyond auto-desyncing
on seek.

## Inbound messages handled

| `msg.type`      | Handler |
|-----------------|---------|
| `SYNC_COMMAND`  | `applySync(msg.event)` — viewer only; dropped if videoId/part mismatch or `!isSynced` |
| `ROOM_STATE`    | Updates local `isHost` and `inRoom` flags; starts/stops heartbeat and viewer status timers |
| `REQUEST_STATE` | `onRequestState()` — host sends current video state to service worker |
| `SET_SYNC`      | Calls `resync(lastHostEvent)` or `desync()`, then sends viewer status |
