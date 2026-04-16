# extension/content/overlay.js

Content script injected alongside `content.js`. Renders a floating status badge
in the top-right corner of the page while the user is in a room.

All code runs in an IIFE; nothing is exported.

## Behavior

- On load, sends `GET_STATE` to the service worker and renders the current state.
- Listens for `ROOM_STATE` messages and re-renders on each change.
- The overlay is hidden (`display: none`) when `state.inRoom` is false.
- While in a room, displays: app name, room code (monospaced), role, member count,
  and a colored connected/disconnected indicator.
- When viewer is desynced (`!state.isHost && state.isSynced === false`), shows a
  "⚠ Desynced" warning with two action buttons:
  - **Request** — reads `video.currentTime` at click time and sends `JUMP_REQUEST`
    to the service worker. The host sees this in the popup and can Accept or Dismiss.
  - **Resync** — sends `SET_SYNC { synced: true }` to the service worker, snapping
    the viewer back to the host's last known position.

## DOM

A single `<div id="yukibilisync-overlay">` is appended to `document.body` at
injection time. It uses inline styles only (no external CSS) to avoid conflicts
with Bilibili's stylesheet. When the desynced state is inactive `pointer-events`
is effectively none (no interactive elements); when desynced, the overlay contains
clickable buttons and pointer events are enabled via `innerHTML` re-render.
