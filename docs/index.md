# YukiBiliSync docs

## Explanation

- [Architecture](explanation/architecture.md) — how the pieces fit together and why

## Reference

- [extension/config.js](reference/extension-config.md) — default server URL fallbacks; runtime config lives in chrome.storage.sync
- [extension/background/sw.js](reference/extension-sw.md) — service worker: signaling, WebRTC, room lifecycle
- [extension/content/content.js](reference/extension-content.md) — video element hooks, playback sync logic
- [extension/content/overlay.js](reference/extension-overlay.md) — in-page status overlay
- [extension/popup/popup.js](reference/extension-popup.md) — popup UI logic
- [server/src/server.js](reference/server.md) — signaling server: WebSocket rooms, TURN credential vending

## Decisions

Dated decision records live in [decisions/](decisions/). See the README there for the naming convention.
