// Overlay entry point. Owns the preference store (minimized / immersive) and
// dispatches every ROOM_STATE update to the two UI modules that run alongside it:
//   window.__yukiStatus  — top-right status pill  (overlay-status.js)
//   window.__yukiFab     — bottom floating action bars (overlay-fab.js)
//
// Execution order guaranteed by manifest injection: content.js → overlay.js →
// overlay-status.js → overlay-fab.js. By the time the message listener fires
// the other modules are already attached.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Preference store — persisted to localStorage
  // ---------------------------------------------------------------------------

  const PREF_KEY = 'yuki-prefs';

  const DEFAULT_PREFS = {
    minimized: false,
    immersive: false,
  };

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      const fromLocal = raw ? Object.assign({}, DEFAULT_PREFS, JSON.parse(raw)) : Object.assign({}, DEFAULT_PREFS);
      // chrome.storage.local is the authoritative source for immersive (set via popup).
      // Merge it on top; async, so we re-render once it resolves.
      chrome.storage.local.get(['yukiImmersive'], (res) => {
        if (chrome.runtime.lastError) return;
        if (typeof res.yukiImmersive === 'boolean') {
          window.__yukiPrefs._prefs.immersive = res.yukiImmersive;
          savePrefs(window.__yukiPrefs._prefs);
          if (window.__lastYukiState) dispatch(window.__lastYukiState);
        }
      });
      return fromLocal;
    } catch (_) {
      return Object.assign({}, DEFAULT_PREFS);
    }
  }

  function savePrefs(prefs) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  // Exposed so UI modules can trigger pref changes without touching storage directly.
  window.__yukiPrefs = {
    _prefs: loadPrefs(),

    get() {
      return Object.assign({}, this._prefs);
    },

    set(key, value) {
      this._prefs[key] = value;
      savePrefs(this._prefs);
      // Re-render with the last known state.
      if (window.__lastYukiState) dispatch(window.__lastYukiState);
    },
  };

  // ---------------------------------------------------------------------------
  // Dispatch to UI modules
  // ---------------------------------------------------------------------------

  function dispatch(state) {
    window.__lastYukiState = state;
    const prefs = window.__yukiPrefs.get();
    if (window.__yukiStatus) window.__yukiStatus.render(state, prefs);
    if (window.__yukiFab)    window.__yukiFab.render(state);
  }

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ROOM_STATE') {
      dispatch(msg.state);
    } else if (msg.type === 'SET_IMMERSIVE') {
      window.__yukiPrefs.set('immersive', !!msg.immersive);
    }
  });

  // Request current state on load — tab may already be in a room.
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (state) dispatch(state);
  });

})();
