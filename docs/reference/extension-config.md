# extension/config.js

Defines the fallback server configuration used when the user has not saved any
URLs via the settings panel. All runtime server config is read from
`chrome.storage.sync` at join time; these values are the last resort if storage
returns nothing.

## Exports

### `DEFAULT_CONFIG`

```js
DEFAULT_CONFIG.signalingUrl  // string — WSS endpoint for signaling and TURN credential vending
DEFAULT_CONFIG.turnUrl       // string — TURN server address, e.g. "turn:your-server.com:3478"
```

Imported only by `offscreen/offscreen.js`. Not used by content scripts, popup,
or the service worker directly.

Both values are empty strings in the OSS release. If either is empty and no
value has been saved in storage, joining a room returns an error prompting the
user to open settings.

## Runtime configuration

Users configure their server in the popup's Settings panel (gear icon). Values
are stored in `chrome.storage.sync` under the keys `signalingUrl` and `turnUrl`.
`offscreen.js` reads storage on every join and falls back to `DEFAULT_CONFIG`
only if a key is absent.

## Self-hosting

To deploy your own server, see `server/`. Fill in your URLs in the Settings
panel:

| Field | Format | Example |
|---|---|---|
| Signaling server | `wss://` | `wss://your-server.com:8444/signal` |
| TURN server | `turn:` | `turn:your-server.com:3478` |

### TLS requirement

The signaling server uses TLS (`wss://`). Browsers enforce certificate trust for
WebSocket connections from extensions — a self-signed certificate will be
rejected unless added to the browser's trusted roots manually. In practice this
means:

- **With a domain**: use Let's Encrypt (`certbot`) for a free, browser-trusted
  certificate. Recommended.
- **With a raw IP only**: the signaling server connection will fail in most
  browsers unless you go through the manual trust step. The TURN server
  (`turn:`) works fine with a raw IP — WebRTC's ICE stack does not enforce
  certificate trust for TURN.
