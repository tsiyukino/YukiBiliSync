// Service worker: room state, offscreen lifecycle, message routing.
// All WebSocket and WebRTC work runs in extension/offscreen/offscreen.js.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  peerId:           null,
  roomCode:         null,
  isHost:           false,
  activeTabId:      null,   // tab that announced itself as the room's active video
  peerCount:        0,
  wsConnected:      false,
  videoId:          null,   // BV id of the room's active video (host only, from ANNOUNCE_VIDEO)
  videoPart:        1,      // ?p= part of the room's active video (from ANNOUNCE_VIDEO)
  hostCurrentTime:  null,   // host's last known video position (seconds)
  isSynced:         true,   // viewer only: whether viewer is following the host
  pendingVideoUrl:  null,   // viewer: set when host pushes a video
  pendingVideoId:   null,
  // peerId → { index, currentTime, paused, buffering, videoId, videoPart, isSynced }
  viewers:          new Map(),
  nextViewerIndex:  1,
  // peerId → { index, currentTime, videoId, videoPart }
  pendingRequests:  new Map(),
};

// ---------------------------------------------------------------------------
// Message handling (from popup, content script, and offscreen document)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'CREATE_ROOM':
      handleCreateRoom().then(sendResponse);
      return true;

    case 'JOIN_ROOM':
      handleJoinRoom(msg.roomCode).then(sendResponse);
      return true;

    case 'LEAVE_ROOM':
      handleLeaveRoom().then(() => sendResponse({}));
      return true;

    case 'SET_ACTIVE_VIDEO':
      // Host explicitly sets the current page as the room's active video.
      // Sent from the popup after querying the current tab.
      if (!state.isHost || !state.roomCode) break;
      state.activeTabId = msg.tabId;
      state.videoId     = msg.videoId;
      state.videoPart   = msg.videoPart;
      broadcastState();
      break;

    case 'ANNOUNCE_VIDEO':
      // Sent by a viewer's content script when it attaches to a video element
      // or joins a room. Establishes this tab as the routing target for SYNC_COMMANDs.
      // Host never sends this — host routing is set via SET_ACTIVE_VIDEO.
      if (!state.roomCode || state.isHost) break;
      state.activeTabId = sender.tab?.id ?? state.activeTabId;
      // Clear push-video banner when viewer navigates to the pushed video.
      if (state.pendingVideoId && msg.videoId === state.pendingVideoId) {
        state.pendingVideoUrl = null;
        state.pendingVideoId  = null;
      }
      broadcastState();
      break;

    case 'PLAYBACK_EVENT':
      if (state.isHost) {
        if (msg.event.currentTime != null) state.hostCurrentTime = msg.event.currentTime;
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_PLAYBACK_EVENT', event: msg.event })
          .catch(() => {});
      }
      break;

    case 'VIEWER_STATUS':
      if (state.isHost) break;
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_VIEWER_STATUS', status: msg.status })
        .catch(() => {});
      break;

    case 'VIEWER_DESYNCED':
      if (state.isHost) break;
      state.isSynced = false;
      broadcastState();
      break;

    case 'VIEWER_RESYNCED':
      if (state.isHost) break;
      state.isSynced = true;
      broadcastState();
      break;

    case 'JUMP_REQUEST':
      // Viewer requests host to seek everyone to their position.
      // Replaces any previous pending request from this viewer (debounced by design).
      if (state.isHost) break;
      chrome.runtime.sendMessage({
        type:    'OFFSCREEN_BROADCAST',
        payload: {
          type:        'jump-request',
          currentTime: msg.currentTime,
          videoId:     msg.videoId,
          videoPart:   msg.videoPart,
          paused:      msg.paused,
        },
      }).catch(() => {});
      break;

    case 'SET_SYNC':
      if (state.isHost) break;
      // When resyncing, require an active tab — if there's no tab to receive the
      // command, the video can't actually snap, so don't report synced.
      if (msg.synced && !state.activeTabId) break;
      state.isSynced = msg.synced;
      // Forward to content script so it can apply lastHostEvent on resync
      if (state.activeTabId) {
        chrome.tabs.sendMessage(state.activeTabId, { type: 'SET_SYNC', synced: msg.synced })
          .catch(() => {});
      }
      broadcastState();
      break;

    case 'PUSH_VIDEO': {
      if (!state.isHost || !state.videoId) break;
      const pushUrl = state.videoPart > 1
        ? `https://www.bilibili.com/video/${state.videoId}?p=${state.videoPart}`
        : `https://www.bilibili.com/video/${state.videoId}`;
      chrome.runtime.sendMessage({
        type:    'OFFSCREEN_BROADCAST',
        payload: { type: 'push-video', videoId: state.videoId, url: pushUrl },
      }).catch(() => {});
      break;
    }

    case 'ACCEPT_REQUEST': {
      if (!state.isHost) break;
      const req = state.pendingRequests.get(msg.peerId);
      if (!req) break;

      const action = req.paused ? 'pause' : 'play';
      const event  = {
        action,
        currentTime: req.currentTime,
        videoId:     req.videoId,
        videoPart:   req.videoPart,
        ts:          Date.now(),
      };

      // 1. Apply the requester's state to the host's own video first.
      // Uses HOST_SEEK (not SYNC_COMMAND) because the host's content script
      // ignores SYNC_COMMAND when isHost is true.
      if (state.activeTabId) {
        chrome.tabs.sendMessage(state.activeTabId, {
          type:  'HOST_SEEK',
          event: { ...event, rate: 1 },
        }).catch(() => {});
      }

      // 2. Broadcast play/pause to all peers — synced viewers apply immediately;
      // this also updates lastHostState on the requester before set-sync arrives.
      chrome.runtime.sendMessage({
        type:  'OFFSCREEN_PLAYBACK_EVENT',
        event,
      }).catch(() => {});

      // 3. Send set-sync to requester last — by the time it arrives, the
      // broadcast in step 2 has already updated the requester's lastHostState
      // to the new position, so resync() snaps to the correct state.
      chrome.runtime.sendMessage({
        type:    'OFFSCREEN_SEND_PEER',
        peerId:  msg.peerId,
        payload: { type: 'set-sync', synced: true },
      }).catch(() => {});

      state.pendingRequests.delete(msg.peerId);
      broadcastState();
      break;
    }

    case 'DISMISS_REQUEST':
      if (!state.isHost) break;
      state.pendingRequests.delete(msg.peerId);
      broadcastState();
      break;

    case 'GET_STATE':
      sendResponse(getRoomState());
      break;

    // --- from offscreen ---

    case 'PEER_COUNT_CHANGED':
      state.peerCount = msg.count;
      broadcastState();
      break;

    case 'PEER_DISCONNECTED':
      state.peerCount = msg.count;
      state.viewers.delete(msg.peerId);
      state.pendingRequests.delete(msg.peerId);
      broadcastState();
      break;

    case 'VIEWER_STATUS_UPDATE': {
      if (!state.isHost) break;
      const existing = state.viewers.get(msg.peerId);
      state.viewers.set(msg.peerId, {
        index: existing ? existing.index : state.nextViewerIndex++,
        ...msg.status,
      });
      broadcastState();
      break;
    }

    case 'JUMP_REQUEST_RECEIVED': {
      if (!state.isHost) break;
      const existingViewer = state.viewers.get(msg.peerId);
      state.pendingRequests.set(msg.peerId, {
        index:       existingViewer ? existingViewer.index : 0,
        currentTime: msg.currentTime,
        videoId:     msg.videoId,
        videoPart:   msg.videoPart,
        paused:      msg.paused,
      });
      broadcastState();
      break;
    }

    case 'SYNC_COMMAND':
      if (state.activeTabId) {
        chrome.tabs.sendMessage(state.activeTabId, { type: 'SYNC_COMMAND', event: msg.event })
          .catch(() => {});
      }
      break;

    case 'REQUEST_STATE':
      if (state.activeTabId) {
        chrome.tabs.sendMessage(state.activeTabId, { type: 'REQUEST_STATE' }).catch(() => {});
      }
      break;

    case 'RECEIVED_PUSH_VIDEO':
      state.pendingVideoUrl = msg.url;
      state.pendingVideoId  = msg.videoId;
      broadcastState();
      break;
  }
});

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

async function handleCreateRoom() {
  state.isHost          = true;
  state.peerId          = generateId();
  state.roomCode        = generateRoomCode();
  state.peerCount       = 0;
  state.isSynced        = true;
  state.viewers         = new Map();
  state.nextViewerIndex = 1;
  state.pendingRequests = new Map();

  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({
    type:     'OFFSCREEN_JOIN',
    roomCode: state.roomCode,
    peerId:   state.peerId,
    isHost:   true,
  });

  if (!result?.ok) {
    resetState();
    return { ok: false, error: result?.error || 'Could not reach the sync server.' };
  }

  state.wsConnected = true;
  broadcastState();
  return { roomCode: state.roomCode };
}

async function handleJoinRoom(roomCode) {
  state.isHost          = false;
  state.peerId          = generateId();
  state.roomCode        = roomCode;
  state.peerCount       = 0;
  state.isSynced        = true;
  state.pendingRequests = new Map();

  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({
    type:     'OFFSCREEN_JOIN',
    roomCode: state.roomCode,
    peerId:   state.peerId,
    isHost:   false,
  });

  if (!result?.ok) {
    resetState();
    return { ok: false, error: result?.error || 'Could not reach the sync server.' };
  }

  state.wsConnected = true;
  broadcastState();
  return { ok: true };
}

async function handleLeaveRoom() {
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_LEAVE' }).catch(() => {});
  await closeOffscreen();
  resetState();
  broadcastState();
}

function resetState() {
  state.peerId          = null;
  state.roomCode        = null;
  state.isHost          = false;
  state.activeTabId     = null;
  state.peerCount       = 0;
  state.wsConnected     = false;
  state.videoId         = null;
  state.videoPart       = 1;
  state.hostCurrentTime = null;
  state.isSynced        = true;
  state.pendingVideoUrl = null;
  state.pendingVideoId  = null;
  state.viewers         = new Map();
  state.nextViewerIndex = 1;
  state.pendingRequests = new Map();
}

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url:     'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'RTCPeerConnection (data channel only) requires a document context in MV3; USER_MEDIA is the appropriate reason for WebRTC APIs',
    });
  }
}

async function closeOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) await chrome.offscreen.closeDocument();
}

// ---------------------------------------------------------------------------
// State broadcasting
// ---------------------------------------------------------------------------

function getRoomState() {
  const viewers = [];
  for (const [, v] of state.viewers) {
    const drift = state.hostCurrentTime != null
      ? Math.abs(state.hostCurrentTime - v.currentTime)
      : null;
    const onCorrectVideo = v.videoId === state.videoId && v.videoPart === state.videoPart;
    viewers.push({
      index: v.index, drift, paused: v.paused,
      buffering: v.buffering, onCorrectVideo, isSynced: v.isSynced,
    });
  }
  viewers.sort((a, b) => a.index - b.index);

  const pendingRequests = [];
  for (const [peerId, req] of state.pendingRequests) {
    pendingRequests.push({ peerId, ...req });
  }
  pendingRequests.sort((a, b) => a.index - b.index);

  return {
    inRoom:          !!state.roomCode,
    isHost:          state.isHost,
    roomCode:        state.roomCode,
    memberCount:     state.peerCount + (state.roomCode ? 1 : 0),
    connected:       state.wsConnected,
    isSynced:        state.isSynced,
    videoId:         state.videoId,
    videoPart:       state.videoPart,
    pendingVideoUrl: state.pendingVideoUrl,
    pendingVideoId:  state.pendingVideoId,
    viewers,
    pendingRequests,
  };
}

function broadcastState() {
  const roomState = getRoomState();
  chrome.runtime.sendMessage({ type: 'ROOM_STATE', state: roomState }).catch(() => {});
  if (state.activeTabId) {
    chrome.tabs.sendMessage(state.activeTabId, { type: 'ROOM_STATE', state: roomState }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tab tracking (viewer routing only)
// Updates activeTabId when the viewer navigates between Bilibili tabs so that
// SYNC_COMMANDs always reach the right content script. Host routing is set
// explicitly via SET_ACTIVE_VIDEO and is never overwritten by tab events.
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (state.isHost || !state.roomCode) return;
  chrome.tabs.get(tabId, (tab) => {
    if (tab.url && isBilibiliVideoTab(tab.url)) {
      state.activeTabId = tabId;
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (state.isHost || !state.roomCode) return;
  if (changeInfo.status === 'complete' && tab.url && isBilibiliVideoTab(tab.url)) {
    state.activeTabId = tabId;
    // Push room state to the freshly-loaded content script so inRoom becomes
    // true before the video starts playing. Without this, the content script
    // starts with inRoom=false and all onPlay/onSeeked desync guards are
    // skipped until the next incidental broadcastState() call.
    broadcastState();
  }
});

function isBilibiliVideoTab(url) {
  return url.includes('bilibili.com/video/') || url.includes('bilibili.com/bangumi/play/');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function generateId() {
  return crypto.randomUUID();
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (const byte of arr) code += chars[byte % chars.length];
  return code;
}
