// Renders two floating action bars injected into Bilibili pages:
//   - Bottom-center: viewer desync bar (shown when viewer is out of sync)
//   - Bottom-left:   host request bar (shown when host has pending jump requests)
// Exposes window.__yukiFab = { render(state) }.
// Each bar has its own Shadow DOM host — no shared state.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Shadow DOM helpers
  // ---------------------------------------------------------------------------

  function makeHost(cssText) {
    const h = document.createElement('div');
    h.style.cssText = cssText;
    document.body.appendChild(h);
    const s = h.attachShadow({ mode: 'open' });
    return { host: h, shadow: s };
  }

  // Shared FAB stylesheet injected into each shadow root.
  const FAB_BASE_STYLE = `
    :host { display: block; }

    .fab {
      display: flex;
      align-items: center;
      background: rgba(18,18,20,0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 32px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.48);
      color: #fff;
      font: 13px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
      user-select: none;
      padding: 0 6px;
      gap: 0;
      animation: slideUp 200ms ease-out;
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .fab-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .fab-stack .fab {
      border-radius: 20px;
    }

    /* label section */
    .fab-label {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 14px 0 16px;
      font-size: 12px;
      font-weight: 600;
      color: rgba(255,255,255,0.88);
      white-space: nowrap;
    }

    .warn-icon {
      font-size: 13px;
      color: #ffb300;
    }

    /* vertical divider */
    .sep {
      width: 1px;
      height: 28px;
      background: rgba(255,255,255,0.12);
      flex-shrink: 0;
    }

    /* buttons */
    .fab-btn {
      background: transparent;
      border: none;
      cursor: pointer;
      font: 600 12px/1 "Helvetica Neue", Helvetica, Arial, sans-serif;
      white-space: nowrap;
      padding: 10px 14px;
      border-radius: 26px;
      transition: background 0.15s;
      color: #fff;
    }

    .fab-btn:hover   { background: rgba(255,255,255,0.10); }
    .fab-btn:active  { background: rgba(255,255,255,0.18); }

    .fab-btn.primary   { color: #fb7299; }
    .fab-btn.accept    { color: #4caf50; }
    .fab-btn.dismiss   { color: rgba(255,255,255,0.50); }

    /* viewer label in host bar */
    .viewer-name {
      font-size: 12px;
      font-weight: 600;
      color: rgba(255,255,255,0.88);
      padding: 0 14px 0 16px;
      white-space: nowrap;
    }

    .viewer-time {
      font-size: 11px;
      font-weight: 400;
      color: rgba(255,255,255,0.45);
      margin-left: 4px;
    }

    .overflow-label {
      font-size: 11px;
      color: rgba(255,255,255,0.40);
      padding: 6px 16px;
      text-align: center;
    }
  `;

  // ---------------------------------------------------------------------------
  // Viewer desync FAB (bottom-center)
  // ---------------------------------------------------------------------------

  const { host: desyncHost, shadow: desyncShadow } = makeHost([
    'position:fixed',
    'bottom:24px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:2147483647',
    'pointer-events:auto',
    'display:none',
  ].join(';'));

  const desyncStyle = document.createElement('style');
  desyncStyle.textContent = FAB_BASE_STYLE;
  const desyncContainer = document.createElement('div');
  desyncShadow.appendChild(desyncStyle);
  desyncShadow.appendChild(desyncContainer);

  function renderDesyncFab(state) {
    const show = !state.isHost && state.isSynced === false;
    if (!show) {
      desyncHost.style.display = 'none';
      return;
    }

    desyncHost.style.display = 'block';
    desyncContainer.innerHTML = `
      <div class="fab">
        <span class="fab-label">
          <span class="warn-icon">&#9888;</span>
          Out of sync
        </span>
        <div class="sep"></div>
        <button class="fab-btn primary" id="btn-request">Request sync</button>
        <button class="fab-btn" id="btn-resync">Resync</button>
      </div>
    `;

    desyncShadow.getElementById('btn-request').addEventListener('click', (e) => {
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

    desyncShadow.getElementById('btn-resync').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'SET_SYNC', synced: true });
    });
  }

  // ---------------------------------------------------------------------------
  // Host request FAB (bottom-left)
  // ---------------------------------------------------------------------------

  const { host: requestHost, shadow: requestShadow } = makeHost([
    'position:fixed',
    'bottom:24px',
    'left:24px',
    'z-index:2147483647',
    'pointer-events:auto',
    'display:none',
  ].join(';'));

  const requestStyle = document.createElement('style');
  requestStyle.textContent = FAB_BASE_STYLE;
  const requestContainer = document.createElement('div');
  requestShadow.appendChild(requestStyle);
  requestShadow.appendChild(requestContainer);

  const MAX_VISIBLE = 3;

  function renderRequestFab(state) {
    const reqs = state.pendingRequests || [];
    if (!state.isHost || reqs.length === 0) {
      requestHost.style.display = 'none';
      return;
    }

    requestHost.style.display = 'block';

    const visible  = reqs.slice(0, MAX_VISIBLE);
    const overflow = reqs.length - visible.length;

    const rows = visible.map((r) => {
      const mm    = String(Math.floor(r.currentTime / 60)).padStart(2, '0');
      const ss    = String(Math.floor(r.currentTime % 60)).padStart(2, '0');
      const label = r.index ? `Viewer ${r.index}` : 'A viewer';
      return `
        <div class="fab" data-peer="${r.peerId}">
          <span class="viewer-name">
            ${label}
            <span class="viewer-time">→ ${mm}:${ss}</span>
          </span>
          <div class="sep"></div>
          <button class="fab-btn accept" data-action="accept" data-peer="${r.peerId}">Accept</button>
          <button class="fab-btn dismiss" data-action="dismiss" data-peer="${r.peerId}">Dismiss</button>
        </div>
      `;
    }).join('');

    const overflowRow = overflow > 0
      ? `<div class="overflow-label">+${overflow} more in popup</div>`
      : '';

    requestContainer.innerHTML = `
      <div class="fab-stack">
        ${rows}
        ${overflowRow}
      </div>
    `;

    requestShadow.querySelectorAll('[data-action="accept"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'ACCEPT_REQUEST', peerId: btn.dataset.peer });
      });
    });

    requestShadow.querySelectorAll('[data-action="dismiss"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'DISMISS_REQUEST', peerId: btn.dataset.peer });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Video identity helpers (mirror of content.js)
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
  // Export
  // ---------------------------------------------------------------------------

  window.__yukiFab = {
    render(state) {
      renderDesyncFab(state);
      renderRequestFab(state);
    },
  };
})();
