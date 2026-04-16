# extension/popup/popup.js

Popup UI script. Rendered in `popup/popup.html` when the user clicks the extension
icon. Manages three views: idle (create/join), in-room, and settings.

All room state comes from the service worker via `GET_STATE` on load and `ROOM_STATE`
messages thereafter. The popup never holds its own room state. Settings state
comes from `chrome.storage.sync`.

## Views

**Idle view** (`#view-idle`): shown when `state.inRoom` is false.
- "Create Room" button → sends `CREATE_ROOM` to the service worker.
- Room code input + "Join" button → validates 6-char input, sends `JOIN_ROOM`.
- Gear icon button (top-right of header) → opens the settings view.
- Error message area for failures.

**Settings view** (`#view-settings`): shown when the user clicks the gear icon.
- Two text inputs: signaling server URL (`wss://`) and TURN server URL (`turn:`).
- Populated from `chrome.storage.sync` on open.
- "Save" → validates URL prefixes, writes to `chrome.storage.sync`. Takes effect
  on the next room join.
- "Reset to defaults" → removes both keys from storage; inputs clear to empty.
- "← Back" → returns to the idle view without saving.

**Room view** (`#view-room`): shown when `state.inRoom` is true.
- Displays room code, role (Host/Viewer), member count.
- Status badge: green "Connected" or red "Disconnected" based on `state.connected`.
- "Copy code" button → writes code to clipboard, shows "Copied!" for 1.5 s.
- "Push video to viewers" button (host only) → sends `PUSH_VIDEO` to sw; sw
  constructs a clean URL from `state.videoId` + `state.videoPart` and broadcasts
  it to all viewers via the data channel.
- Viewer status list (host only) → rendered by `renderViewerList()`; shows each
  connected viewer's playback state and drift. Hidden when no viewers.
- Pending jump requests list (host only) → rendered by `renderRequestList()`; each
  row shows which viewer wants to jump to which timestamp with Accept/Dismiss buttons.
  Hidden when no pending requests. Replaces previous request from same viewer
  (debounced by design).
- Sync toggle button (viewer only) → green "Synced with host" or orange "Desynced —
  click to resync". Clicking sends `SET_SYNC { synced: !current }` to the service
  worker.
- Push-video banner (viewer only) → shown when `state.pendingVideoUrl` is set;
  displays a clickable link to the host's current video. Banner clears automatically
  when the viewer navigates to that video.
- "Leave Room" button → sends `LEAVE_ROOM`.

## Key functions

| Function | Purpose |
|---|---|
| `applyState(state)` | Switches between views and populates all display fields |
| `renderViewerList(viewers)` | Builds viewer status rows inside `#viewer-list` |
| `renderRequestList(requests)` | Builds jump request rows inside `#request-list`; hides container if empty |
| `setError(msg)` | Shows or clears the error paragraph in the idle view |
| `setSettingsError(msg)` | Shows or clears the error paragraph in the settings view |
| `sendMessage(msg)` | Promise wrapper around `chrome.runtime.sendMessage` |

## Input sanitization

The room code input strips non-alphanumeric characters and forces uppercase on
every `input` event. The join handler also trims and uppercases before sending.
