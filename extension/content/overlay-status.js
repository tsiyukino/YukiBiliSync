// Renders the top-right status pill: expanded panel or minimized dot.
// Exposes window.__yukiStatus = { render(state, prefs) }.
// Manages its own Shadow DOM host — isolated from Bilibili's stylesheet.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Shadow DOM host
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

  const style = document.createElement('style');
  style.textContent = `
    :host { display: block; }

    /* ── Expanded pill ── */
    #pill {
      background: rgba(18,18,20,0.82);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.48);
      color: #fff;
      font: 13px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
      min-width: 192px;
      user-select: none;
      overflow: hidden;
      animation: fadeIn 180ms ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-6px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* pill top bar */
    .pill-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px 6px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }

    .pill-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .6px;
      color: #fb7299;
    }

    .pill-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* icon buttons inside pill */
    .icon-btn {
      background: transparent;
      border: none;
      padding: 3px 5px;
      border-radius: 6px;
      cursor: pointer;
      color: rgba(255,255,255,0.45);
      font-size: 15px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background 0.15s;
    }

    .icon-btn:hover {
      color: #fff;
      background: rgba(255,255,255,0.10);
    }

    .icon-btn.active {
      color: #4caf50;
    }

    /* pill body rows */
    .pill-body {
      padding: 8px 12px 10px;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 3px;
      font-size: 12px;
      color: rgba(255,255,255,0.70);
    }

    .row:last-child { margin-bottom: 0; }

    .row-label {
      color: rgba(255,255,255,0.38);
      font-size: 11px;
      width: 52px;
      flex-shrink: 0;
    }

    .row-value {
      font-weight: 600;
      color: rgba(255,255,255,0.88);
      font-family: monospace;
      letter-spacing: .8px;
    }

    .row-value.plain {
      font-family: inherit;
      letter-spacing: 0;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .dot.ok  { background: #4caf50; box-shadow: 0 0 5px #4caf5099; }
    .dot.err { background: #f44336; box-shadow: 0 0 5px #f4433699; animation: pulse 1.4s ease-in-out infinite; }

    @keyframes pulse {
      0%,100% { opacity: 1; }
      50%      { opacity: 0.4; }
    }

    .status-text.ok  { color: #4caf50; font-weight: 600; }
    .status-text.err { color: #f44336; font-weight: 600; }

    /* ── Minimized dot ── */
    #dot-minimized {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid rgba(255,255,255,0.18);
      transition: transform 0.15s;
    }

    #dot-minimized:hover { transform: scale(1.3); }

    #dot-minimized.ok  { background: #4caf50; box-shadow: 0 0 6px #4caf5099; }
    #dot-minimized.err { background: #f44336; box-shadow: 0 0 6px #f4433699; animation: pulse 1.4s ease-in-out infinite; }
  `;

  const container = document.createElement('div');

  shadow.appendChild(style);
  shadow.appendChild(container);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function render(state, prefs) {
    if (!state.inRoom) {
      host.style.display = 'none';
      return;
    }

    // Immersive: hide everything while connected; show only on disconnect.
    if (prefs.immersive && state.connected) {
      host.style.display = 'none';
      return;
    }

    host.style.display = 'block';

    if (prefs.minimized && !prefs.immersive) {
      renderDot(state);
    } else {
      renderPill(state, prefs);
    }
  }

  function renderDot(state) {
    const cls = state.connected ? 'ok' : 'err';
    container.innerHTML = `<div id="dot-minimized" class="${cls}" title="YukiBiliSync — click to expand"></div>`;
    shadow.getElementById('dot-minimized').addEventListener('click', () => {
      window.__yukiPrefs.set('minimized', false);
    });
  }

  function renderPill(state, prefs) {
    const connCls  = state.connected ? 'ok' : 'err';
    const connText = state.connected ? 'Connected' : 'Disconnected';

    // Immersive toggle button — eye icon (open = immersive off, closed = immersive on)
    const immersiveSvg = prefs.immersive
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
           <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
           <line x1="1" y1="1" x2="23" y2="23"/>
         </svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
           <circle cx="12" cy="12" r="3"/>
         </svg>`;

    container.innerHTML = `
      <div id="pill">
        <div class="pill-header">
          <span class="pill-title">YukiBiliSync</span>
          <div class="pill-actions">
            <button class="icon-btn${prefs.immersive ? ' active' : ''}" id="btn-immersive"
              title="${prefs.immersive ? 'Immersive mode on — click to disable' : 'Enable immersive mode'}">
              ${immersiveSvg}
            </button>
            <button class="icon-btn" id="btn-minimize" title="Minimize">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="pill-body">
          <div class="row">
            <span class="row-label">Room</span>
            <span class="row-value">${state.roomCode}</span>
          </div>
          <div class="row">
            <span class="row-label">Role</span>
            <span class="row-value plain">${state.isHost ? 'Host' : 'Viewer'}</span>
          </div>
          <div class="row">
            <span class="row-label">Members</span>
            <span class="row-value plain">${state.memberCount}</span>
          </div>
          <div class="row">
            <span class="dot ${connCls}"></span>
            <span class="status-text ${connCls}">${connText}</span>
          </div>
        </div>
      </div>
    `;

    shadow.getElementById('btn-minimize').addEventListener('click', () => {
      window.__yukiPrefs.set('minimized', true);
    });

    shadow.getElementById('btn-immersive').addEventListener('click', () => {
      window.__yukiPrefs.set('immersive', !prefs.immersive);
    });
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  window.__yukiStatus = { render };
})();
