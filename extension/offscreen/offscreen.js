import { DEFAULT_CONFIG } from '../config.js';

async function loadConfig() {
  const stored = await chrome.storage.sync.get(['signalingUrl', 'turnUrl']);
  return {
    signalingUrl: stored.signalingUrl || DEFAULT_CONFIG.signalingUrl,
    turnUrl:      stored.turnUrl      || DEFAULT_CONFIG.turnUrl,
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  ws:       null,         // WebSocket to signaling server
  peers:    new Map(),    // peerId → RTCPeerConnection
  channels: new Map(),    // peerId → RTCDataChannel
  peerId:   null,
  roomCode: null,
  isHost:   false,
  iceConfig: null,
};

const pendingTurnResolvers = new Set();

// ---------------------------------------------------------------------------
// Messages from service worker
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'OFFSCREEN_JOIN': {
      handleJoin(msg).then(sendResponse);
      return true;
    }

    case 'OFFSCREEN_LEAVE': {
      handleLeave();
      sendResponse({});
      break;
    }

    case 'OFFSCREEN_PLAYBACK_EVENT': {
      broadcastToPeers(msg.event);
      break;
    }

    case 'OFFSCREEN_BROADCAST': {
      broadcastToPeers(msg.payload);
      break;
    }

    case 'OFFSCREEN_VIEWER_STATUS': {
      broadcastToPeers({ type: 'viewer-status', ...msg.status });
      break;
    }

    case 'OFFSCREEN_SEND_PEER': {
      const ch = state.channels.get(msg.peerId);
      if (ch && ch.readyState === 'open') {
        ch.send(JSON.stringify(msg.payload));
      }
      break;
    }
  }
});

// ---------------------------------------------------------------------------
// Join / leave
// ---------------------------------------------------------------------------

async function handleJoin({ roomCode, peerId, isHost }) {
  state.peerId   = peerId;
  state.roomCode = roomCode;
  state.isHost   = isHost;

  const config = await loadConfig();
  if (!config.signalingUrl) {
    resetState();
    return { ok: false, error: 'No signaling server configured. Open the extension settings and enter your server URL.' };
  }

  try {
    await connectSignaling(config.signalingUrl);
    await fetchTurnCredentials();
    sigSend({ type: 'join', roomCode, peerId });
  } catch (err) {
    resetState();
    return { ok: false, error: err.message };
  }

  return { ok: true };
}

function handleLeave() {
  if (state.roomCode) sigSend({ type: 'leave', roomCode: state.roomCode });
  closeAllPeers();
  if (state.ws) { state.ws.close(); state.ws = null; }
  resetState();
}

function resetState() {
  state.peerId   = null;
  state.roomCode = null;
  state.isHost   = false;
  state.iceConfig = null;
}

// ---------------------------------------------------------------------------
// Signaling WebSocket
// ---------------------------------------------------------------------------

function connectSignaling(signalingUrl) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(signalingUrl);

    ws.onopen = () => {
      state.ws = ws;
      settled = true;
      resolve();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleSignalingMessage(msg);
    };

    ws.onerror = () => {
      if (!settled) { settled = true; reject(new Error('Signaling connection failed')); }
    };

    ws.onclose = () => {
      state.ws = null;
      if (!settled) { settled = true; reject(new Error('Signaling connection closed')); }
    };
  });
}

function sigSend(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

async function fetchTurnCredentials() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTurnResolvers.delete(handler);
      reject(new Error('Timed out waiting for TURN credentials'));
    }, 5000);

    const handler = (msg) => {
      if (msg.type !== 'turn-credentials') return;
      clearTimeout(timer);
      state.iceConfig = {
        iceTransportPolicy: 'relay',
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls:       `turn:${msg.host}`,
            username:   msg.username,
            credential: msg.credential,
          },
        ],
      };
      pendingTurnResolvers.delete(handler);
      resolve();
    };
    pendingTurnResolvers.add(handler);
    sigSend({ type: 'turn-credentials' });
  });
}

// ---------------------------------------------------------------------------
// Signaling message dispatch
// ---------------------------------------------------------------------------

async function handleSignalingMessage(msg) {
  for (const handler of pendingTurnResolvers) handler(msg);

  switch (msg.type) {
    case 'peer-joined':
      if (state.isHost) {
        createOffer(msg.peerId).catch((err) =>
          console.error('[offscreen] createOffer failed:', err)
        );
      }
      break;

    case 'peer-left':
      closePeer(msg.peerId);
      notifySW({ type: 'PEER_DISCONNECTED', peerId: msg.peerId, count: state.peers.size });
      break;

    case 'signal':
      handleRemoteSignal(msg.from, msg.payload).catch((err) =>
        console.error('[offscreen] handleRemoteSignal failed:', err)
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// WebRTC peer management
// ---------------------------------------------------------------------------

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(state.iceConfig);
  state.peers.set(peerId, pc);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      sigSend({
        type: 'signal',
        roomCode: state.roomCode,
        to: peerId,
        payload: { ice: candidate },
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closePeer(peerId);
      notifySW({ type: 'PEER_DISCONNECTED', peerId, count: state.peers.size });
    }
  };

  pc.ondatachannel = ({ channel }) => {
    setupDataChannel(peerId, channel);
  };

  return pc;
}

async function createOffer(peerId) {
  const pc      = createPeerConnection(peerId);
  const channel = pc.createDataChannel('sync', { ordered: true });
  setupDataChannel(peerId, channel);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  sigSend({
    type: 'signal',
    roomCode: state.roomCode,
    to: peerId,
    payload: { sdp: pc.localDescription },
  });
}

async function handleRemoteSignal(fromId, payload) {
  let pc = state.peers.get(fromId);

  if (payload.sdp) {
    if (payload.sdp.type === 'offer') {
      if (!pc) pc = createPeerConnection(fromId);
      await pc.setRemoteDescription(payload.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sigSend({
        type: 'signal',
        roomCode: state.roomCode,
        to: fromId,
        payload: { sdp: pc.localDescription },
      });
    } else if (payload.sdp.type === 'answer' && pc) {
      await pc.setRemoteDescription(payload.sdp);
    }
  }

  if (payload.ice && pc) {
    await pc.addIceCandidate(payload.ice).catch(() => {});
  }
}

function setupDataChannel(peerId, channel) {
  state.channels.set(peerId, channel);

  channel.onopen = () => {
    notifySW({ type: 'PEER_COUNT_CHANGED', count: state.peers.size });
    if (state.isHost) {
      notifySW({ type: 'REQUEST_STATE' });
    }
  };

  channel.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'push-video') {
      notifySW({ type: 'RECEIVED_PUSH_VIDEO', videoId: msg.videoId, url: msg.url });
    } else if (msg.type === 'viewer-status') {
      const { type: _t, ...status } = msg;
      notifySW({ type: 'VIEWER_STATUS_UPDATE', peerId, status });
    } else if (msg.type === 'jump-request') {
      const { type: _t, ...req } = msg;
      notifySW({ type: 'JUMP_REQUEST_RECEIVED', peerId, ...req });
    } else if (msg.type === 'set-sync') {
      notifySW({ type: 'SET_SYNC', synced: msg.synced });
    } else {
      notifySW({ type: 'SYNC_COMMAND', event: msg });
    }
  };

  channel.onclose = () => {
    state.channels.delete(peerId);
    notifySW({ type: 'PEER_COUNT_CHANGED', count: state.peers.size });
  };
}

function broadcastToPeers(event) {
  const payload = JSON.stringify(event);
  for (const [, channel] of state.channels) {
    if (channel.readyState === 'open') channel.send(payload);
  }
}

function closePeer(peerId) {
  state.channels.get(peerId)?.close();
  state.peers.get(peerId)?.close();
  state.channels.delete(peerId);
  state.peers.delete(peerId);
}

function closeAllPeers() {
  for (const [peerId] of state.peers) closePeer(peerId);
}

// ---------------------------------------------------------------------------
// Send message to service worker
// ---------------------------------------------------------------------------

function notifySW(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
