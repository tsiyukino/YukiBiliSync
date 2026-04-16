// Injects a small status overlay into Bilibili video pages.
// Shows: room code, member count, host/viewer role, connection status, and
// desynced state with Request / Resync action buttons.
//
// Uses a Shadow DOM so Bilibili's page stylesheet cannot affect overlay elements.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Build the overlay host + shadow root
  // ---------------------------------------------------------------------------

  const host = document.createElement('div');
  host.style.cssText = [
    'position:fixed',
    'top:12px',
    'right:12px',
    'z-index:2147483647',
    'pointer-events:auto',
    'display:none',
  ].join(';');
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  // All styling lives inside the shadow — fully isolated from Bilibili's CSS.
  const style = document.createElement('style');
  style.textContent = `
    :host { display: block; }
    #overlay {
      background: rgba(0,0,0,0.72);
      color: #fff;
      font: 13px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
      padding: 8px 12px;
      border-radius: 8px;
      min-width: 160px;
      user-select: none;
    }
    .row { margin-bottom: 2px; }
    .title { font-weight: 600; letter-spacing: .5px; margin-bottom: 4px; }
    .mono  { font-family: monospace; letter-spacing: 1px; }
    .ok    { color: #4caf50; margin-top: 4px; }
    .err   { color: #f44336; margin-top: 4px; }
    .desynced { color: #ffb300; margin-top: 6px; font-weight: 600; }
    .btn-row { margin-top: 4px; display: flex; gap: 6px; }
    button {
      padding: 3px 10px;
      border-radius: 5px;
      border: none;
      font: 600 12px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
      cursor: pointer;
      color: #fff;
    }
    #btn-request { background: #fb7299; }
    #btn-resync  { background: #444; }
    button:active { opacity: 0.8; }
  `;

  const inner = document.createElement('div');
  inner.id = 'overlay';

  shadow.appendChild(style);
  shadow.appendChild(inner);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function render(state) {
    if (!state.inRoom) {
      host.style.display = 'none';
      return;
    }

    host.style.display = 'block';

    const connected = state.connected
      ? `<div class="ok row">&#x25cf; Connected</div>`
      : `<div class="err row">&#x25cf; Disconnected</div>`;

    const desynced = (!state.isHost && state.isSynced === false) ? `
      <div class="desynced row">&#x26A0; Desynced</div>
      <div class="btn-row">
        <button id="btn-request">Request</button>
        <button id="btn-resync">Resync</button>
      </div>` : '';

    inner.innerHTML = `
      <div class="title row">YukiBiliSync</div>
      <div class="row">Room: <span class="mono">${state.roomCode}</span></div>
      <div class="row">Role: ${state.isHost ? 'Host' : 'Viewer'}</div>
      <div class="row">Members: ${state.memberCount}</div>
      ${connected}
      ${desynced}
    `;

    const btnRequest = shadow.getElementById('btn-request');
    const btnResync  = shadow.getElementById('btn-resync');

    if (btnRequest) {
      btnRequest.addEventListener('click', (e) => {
        e.stopPropagation();
        const video = document.querySelector('video');
        if (!video) return;
        chrome.runtime.sendMessage({
          type:        'JUMP_REQUEST',
          currentTime: video.currentTime,
          paused:      video.paused,
          videoId:     getVideoId(),
          videoPart:   getPart(),
        });
      });
    }

    if (btnResync) {
      btnResync.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'SET_SYNC', synced: true });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Video identity helpers (mirror of content.js — overlay runs in same context)
  // ---------------------------------------------------------------------------

  function getVideoId() {
    const m = window.location.pathname.match(/\/video\/(BV[A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  function getPart() {
    const m = window.location.search.match(/[?&]p=(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }

  // ---------------------------------------------------------------------------
  // Listen for state updates from the service worker
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ROOM_STATE') render(msg.state);
  });

  // Ask for current state on load (tab may already be in a room)
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (state) render(state);
  });

})();
