// Default server configuration.
//
// This project is self-hosted. You must deploy the signaling server from
// server/ and fill in your own URLs here, or configure them at runtime
// via the extension's Settings panel (gear icon in the popup).
//
// signalingUrl: WebSocket endpoint for room signaling and TURN credential vending
//               e.g. 'wss://your-server.com:8444/signal'
// turnUrl:      TURN server address passed to WebRTC ICE config
//               e.g. 'turn:your-server.com:3478'
//
// See server/README or the project docs for deployment instructions.

export const DEFAULT_CONFIG = {
  signalingUrl: '',
  turnUrl:      '',
};
