'use strict';

// ── Elements ──────────────────────────────────────────────────────────────────

const viewIdle        = document.getElementById('view-idle');
const viewRoom        = document.getElementById('view-room');
const viewSettings    = document.getElementById('view-settings');
const btnCreate       = document.getElementById('btn-create');
const btnJoin         = document.getElementById('btn-join');
const btnLeave        = document.getElementById('btn-leave');
const btnCopy         = document.getElementById('btn-copy');
const btnSetActive    = document.getElementById('btn-set-active');
const activeVideoLabel = document.getElementById('active-video-label');
const btnPushVideo    = document.getElementById('btn-push-video');
const inputCode       = document.getElementById('input-code');
const errorMsg        = document.getElementById('error-msg');
const elCode          = document.getElementById('room-code');
const elRole          = document.getElementById('room-role');
const elMembers       = document.getElementById('room-members');
const elBadge         = document.getElementById('status-badge');
const pushVideoBanner = document.getElementById('push-video-banner');
const pushVideoLink   = document.getElementById('push-video-link');
const viewerList      = document.getElementById('viewer-list');
const requestList     = document.getElementById('request-list');
const btnSyncToggle      = document.getElementById('btn-sync-toggle');
const btnSettings        = document.getElementById('btn-settings');
const btnBack            = document.getElementById('btn-back');
const btnSaveSettings    = document.getElementById('btn-save-settings');
const btnResetSettings   = document.getElementById('btn-reset-settings');
const inputSignaling     = document.getElementById('input-signaling');
const inputTurn          = document.getElementById('input-turn');
const settingsError      = document.getElementById('settings-error');
const settingsSaved      = document.getElementById('settings-saved');
const btnToggleImmersive     = document.getElementById('btn-toggle-immersive');
const btnToggleImmersiveRoom = document.getElementById('btn-toggle-immersive-room');

// ── Boot ──────────────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
  if (state) applyState(state);
});

// Sync immersive toggle state on popup open (applies to both room and settings views).
syncImmersiveToggle();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ROOM_STATE') applyState(msg.state);
});

// ── Settings view ─────────────────────────────────────────────────────────────

btnSettings.addEventListener('click', () => {
  chrome.storage.sync.get(['signalingUrl', 'turnUrl'], (stored) => {
    inputSignaling.value = stored.signalingUrl || '';
    inputTurn.value      = stored.turnUrl      || '';
    setSettingsError('');
    settingsSaved.hidden = true;
    viewIdle.hidden      = true;
    viewSettings.hidden  = false;
    syncImmersiveToggle();
  });
});

// Immersive mode toggle — reads/writes the same localStorage key as the overlay.
// The popup and the content script share the page's localStorage only when the
// popup is opened on a Bilibili tab; for cross-tab persistence we also mirror
// the value into chrome.storage.local so the overlay can pick it up on load.

function getImmersivePrefs() {
  try {
    const raw = localStorage.getItem('yuki-prefs');
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function syncImmersiveToggle() {
  chrome.storage.local.get(['yukiImmersive'], (res) => {
    const on = !!res.yukiImmersive;
    setImmersiveUI(on);
  });
}

function setImmersiveUI(on) {
  [btnToggleImmersive, btnToggleImmersiveRoom].forEach((btn) => {
    btn.setAttribute('aria-checked', String(on));
    btn.classList.toggle('on', on);
  });
}

function applyImmersive(next) {
  setImmersiveUI(next);
  chrome.storage.local.set({ yukiImmersive: next });
  chrome.tabs.query({ url: '*://*.bilibili.com/video/*' }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: 'SET_IMMERSIVE', immersive: next }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
}

btnToggleImmersive.addEventListener('click', () => {
  applyImmersive(btnToggleImmersive.getAttribute('aria-checked') !== 'true');
});

btnToggleImmersiveRoom.addEventListener('click', () => {
  applyImmersive(btnToggleImmersiveRoom.getAttribute('aria-checked') !== 'true');
});

btnBack.addEventListener('click', () => {
  viewSettings.hidden = true;
  viewIdle.hidden     = false;
});

btnSaveSettings.addEventListener('click', () => {
  const signalingUrl = inputSignaling.value.trim();
  const turnUrl      = inputTurn.value.trim();

  if (!signalingUrl.startsWith('wss://')) {
    setSettingsError('Signaling URL must start with wss://');
    return;
  }
  if (!turnUrl.startsWith('turn:')) {
    setSettingsError('TURN URL must start with turn:');
    return;
  }

  setSettingsError('');
  chrome.storage.sync.set({ signalingUrl, turnUrl }, () => {
    settingsSaved.hidden = false;
    setTimeout(() => { settingsSaved.hidden = true; }, 2000);
  });
});

btnResetSettings.addEventListener('click', () => {
  chrome.storage.sync.remove(['signalingUrl', 'turnUrl'], () => {
    inputSignaling.value = '';
    inputTurn.value      = '';
    setSettingsError('');
    settingsSaved.hidden = false;
    settingsSaved.textContent = 'Reset to defaults.';
    setTimeout(() => {
      settingsSaved.hidden = true;
      settingsSaved.textContent = 'Saved.';
    }, 2000);
  });
});

function setSettingsError(msg) {
  settingsError.textContent = msg;
  settingsError.hidden      = !msg;
}

// ── Button handlers ───────────────────────────────────────────────────────────

btnCreate.addEventListener('click', async () => {
  setError('');
  btnCreate.disabled = true;
  btnCreate.textContent = 'Creating…';
  try {
    const res = await sendMessage({ type: 'CREATE_ROOM' });
    if (res.roomCode) {
      applyState(await sendMessage({ type: 'GET_STATE' }));
    } else {
      setError('Could not create room.');
    }
  } catch (err) {
    setError(err.message || 'Failed to create room.');
  } finally {
    btnCreate.disabled = false;
    btnCreate.textContent = 'Create Room';
  }
});

btnJoin.addEventListener('click', async () => {
  const code = inputCode.value.trim().toUpperCase();
  if (code.length !== 6) { setError('Enter a 6-character room code.'); return; }
  setError('');
  btnJoin.disabled = true;
  btnJoin.textContent = '…';
  try {
    const res = await sendMessage({ type: 'JOIN_ROOM', roomCode: code });
    if (!res.ok) setError(res.error || 'Could not join room.');
    else applyState(await sendMessage({ type: 'GET_STATE' }));
  } catch (err) {
    setError(err.message || 'Failed to join room.');
  } finally {
    btnJoin.disabled = false;
    btnJoin.textContent = 'Join';
  }
});

btnLeave.addEventListener('click', () => {
  sendMessage({ type: 'LEAVE_ROOM' });
});

btnCopy.addEventListener('click', () => {
  const code = elCode.textContent.trim();
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy code'; }, 1500);
  });
});

btnSetActive.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  const videoMatch = tab.url.match(/\/video\/(BV[A-Za-z0-9]+)/);
  if (!videoMatch) {
    btnSetActive.textContent = 'Not a video page!';
    setTimeout(() => { btnSetActive.textContent = 'Set current page as active video'; }, 1500);
    return;
  }
  const videoId   = videoMatch[1];
  const partMatch = tab.url.match(/[?&]p=(\d+)/);
  const videoPart = partMatch ? parseInt(partMatch[1], 10) : 1;
  sendMessage({ type: 'SET_ACTIVE_VIDEO', tabId: tab.id, videoId, videoPart }).catch(() => {});
  btnSetActive.textContent = 'Set!';
  setTimeout(() => { btnSetActive.textContent = 'Set current page as active video'; }, 1500);
});

btnPushVideo.addEventListener('click', () => {
  sendMessage({ type: 'PUSH_VIDEO' }).catch(() => {});
  btnPushVideo.textContent = 'Pushed!';
  setTimeout(() => { btnPushVideo.textContent = 'Push video to viewers'; }, 1500);
});

btnSyncToggle.addEventListener('click', () => {
  const synced = btnSyncToggle.dataset.synced !== 'false';
  sendMessage({ type: 'SET_SYNC', synced: !synced }).catch(() => {});
});

inputCode.addEventListener('input', () => {
  inputCode.value = inputCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (errorMsg && !errorMsg.hidden) setError('');
});

// ── UI helpers ────────────────────────────────────────────────────────────────

function applyState(state) {
  if (state.inRoom) {
    viewIdle.hidden = true;
    viewRoom.hidden = false;

    elCode.textContent    = state.roomCode;
    elRole.textContent    = state.isHost ? 'Host' : 'Viewer';
    elMembers.textContent = state.memberCount;

    elBadge.className   = 'badge ' + (state.connected ? 'ok' : 'error');
    elBadge.textContent = state.connected ? 'Connected' : 'Disconnected';

    // Host: viewer status list + pending jump requests
    if (state.isHost) {
      renderViewerList(state.viewers || []);
      viewerList.hidden = false;
      renderRequestList(state.pendingRequests || []);
      requestList.hidden = false;
    } else {
      viewerList.hidden  = true;
      requestList.hidden = true;
    }

    // Host: set active video + push video buttons
    btnSetActive.hidden    = !state.isHost;
    btnPushVideo.hidden    = !state.isHost;
    activeVideoLabel.hidden = !state.isHost;
    if (state.isHost) {
      activeVideoLabel.textContent = state.videoId
        ? `Active: ${state.videoId}${state.videoPart > 1 ? ` p${state.videoPart}` : ''}`
        : 'No active video set';
    }

    // Viewer: sync toggle button
    if (!state.isHost) {
      btnSyncToggle.hidden = false;
      if (state.isSynced) {
        btnSyncToggle.textContent = 'Synced with host';
        btnSyncToggle.dataset.synced = 'true';
        btnSyncToggle.classList.remove('btn-desynced');
      } else {
        btnSyncToggle.textContent = 'Desynced — click to resync';
        btnSyncToggle.dataset.synced = 'false';
        btnSyncToggle.classList.add('btn-desynced');
      }
    } else {
      btnSyncToggle.hidden = true;
    }

    // Viewer: show banner when host pushed a video
    if (!state.isHost && state.pendingVideoUrl) {
      pushVideoBanner.hidden  = false;
      pushVideoLink.href      = state.pendingVideoUrl;
      pushVideoLink.textContent = state.pendingVideoId || state.pendingVideoUrl;
    } else {
      pushVideoBanner.hidden = true;
    }
  } else {
    viewIdle.hidden         = false;
    viewRoom.hidden         = true;
    pushVideoBanner.hidden  = true;
    btnSetActive.hidden     = true;
    activeVideoLabel.hidden = true;
    btnPushVideo.hidden     = true;
    viewerList.hidden       = true;
    requestList.hidden      = true;
    btnSyncToggle.hidden    = true;
  }
}

function renderViewerList(viewers) {
  if (viewers.length === 0) {
    viewerList.innerHTML = '<div class="viewer-empty">No viewers connected</div>';
    return;
  }
  viewerList.innerHTML = viewers.map((v) => {
    let statusText;
    if (!v.onCorrectVideo) {
      statusText = '<span class="vs-wrong">Wrong video</span>';
    } else if (v.buffering) {
      statusText = '<span class="vs-buffering">Buffering</span>';
    } else if (v.paused) {
      statusText = '<span class="vs-paused">Paused</span>';
    } else {
      statusText = '<span class="vs-playing">Playing</span>';
    }

    const driftText = (v.onCorrectVideo && v.drift != null)
      ? `<span class="vs-drift">${v.drift.toFixed(1)}s</span>`
      : '';

    return `<div class="viewer-row">
      <span class="viewer-label">Viewer ${v.index}</span>
      ${driftText}
      ${statusText}
    </div>`;
  }).join('');
}

function renderRequestList(requests) {
  if (requests.length === 0) {
    requestList.innerHTML = '';
    requestList.hidden    = true;
    return;
  }
  requestList.hidden    = false;
  requestList.innerHTML = requests.map((r) => {
    const mm  = String(Math.floor(r.currentTime / 60)).padStart(2, '0');
    const ss  = String(Math.floor(r.currentTime % 60)).padStart(2, '0');
    const label = r.index ? `Viewer ${r.index}` : 'A viewer';
    return `<div class="request-row" data-peer="${r.peerId}">
      <span class="request-label">${label} wants to jump to ${mm}:${ss}</span>
      <div class="request-actions">
        <button class="btn-accept" data-peer="${r.peerId}">Accept</button>
        <button class="btn-dismiss" data-peer="${r.peerId}">Dismiss</button>
      </div>
    </div>`;
  }).join('');

  requestList.querySelectorAll('.btn-accept').forEach((btn) => {
    btn.addEventListener('click', () => {
      sendMessage({ type: 'ACCEPT_REQUEST', peerId: btn.dataset.peer }).catch(() => {});
    });
  });
  requestList.querySelectorAll('.btn-dismiss').forEach((btn) => {
    btn.addEventListener('click', () => {
      sendMessage({ type: 'DISMISS_REQUEST', peerId: btn.dataset.peer }).catch(() => {});
    });
  });
}

function setError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden      = !msg;
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(res);
      }
    });
  });
}
