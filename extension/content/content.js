// Runs on bilibili.com/video/* and bilibili.com/bangumi/play/*
// Responsible for: finding the <video> element, wiring playback listeners,
// applying incoming sync commands (gated on videoId+part match and isSynced),
// sending periodic heartbeats when host, reporting viewer status when viewer,
// detecting viewer-initiated desync, and re-attaching when the element is replaced.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let video               = null;
  let isHost              = false;
  let inRoom              = false;
  let heartbeatTimer      = null;
  let viewerStatusTimer   = null;
  let isBuffering         = false;
  let isSynced            = true;   // false = viewer is freerunning
  let pendingAutoResync   = false;  // true = waiting for first host state to auto-resync
  // Most recent known host state — merged from every incoming host message.
  // Persisted even while desynced so resync() can snap to correct state instantly.
  let lastHostState       = null;   // { currentTime, paused, rate }

  const DRIFT_THRESHOLD        = 2.0;   // heartbeat correction: snap if host/viewer differ by this much
  const DESYNC_THRESHOLD       = 0.5;   // desync detection: viewer must deviate by this much to be considered desynced
  const HEARTBEAT_INTERVAL     = 3000;
  const VIEWER_STATUS_INTERVAL = 3000;
  const POLL_INTERVAL          = 500;
  const POLL_MAX               = 40;
  let   pollCount              = 0;
  let   pollTimer              = null;
  let   observer               = null;

  // ---------------------------------------------------------------------------
  // Video identity
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
  // Boot
  // ---------------------------------------------------------------------------

  startPolling();
  listenToServiceWorker();

  // ---------------------------------------------------------------------------
  // Video element discovery
  // ---------------------------------------------------------------------------

  function startPolling() {
    pollTimer = setInterval(() => {
      const el = document.querySelector('video');
      if (el) {
        clearInterval(pollTimer);
        pollTimer = null;
        attachToVideo(el);
        watchForReplacement();
      } else if (++pollCount >= POLL_MAX) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, POLL_INTERVAL);
  }

  function watchForReplacement() {
    observer = new MutationObserver(() => {
      const el = document.querySelector('video');
      if (el && el !== video) attachToVideo(el);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------------
  // Attach / detach
  // ---------------------------------------------------------------------------

  function attachToVideo(el) {
    if (video) detachFromVideo();
    video = el;
    isBuffering = false;
    // On a new video element, the viewer is not yet in sync with the host.
    // Reset lastHostState so resync() has nothing stale to snap to, and mark
    // isSynced=false so applySync skips applyHostEvent until the viewer
    // explicitly resyncs. Without isSynced=false, the heartbeat snap inside
    // applyHostEvent fires seeked at the exact snapped position, making
    // isDeviatingFromHost() always read 0-drift and silencing desync detection.
    if (inRoom && !isHost) {
      lastHostState = null;
      if (isSynced) {
        isSynced = false;
        chrome.runtime.sendMessage({ type: 'VIEWER_DESYNCED' });
      }
      pendingAutoResync = true;
    }
    video.addEventListener('play',       onPlay);
    video.addEventListener('pause',      onPause);
    video.addEventListener('seeked',     onSeeked);
    video.addEventListener('ratechange', onRateChange);
    video.addEventListener('waiting',    onBufferStart);
    video.addEventListener('canplay',    onBufferEnd);
    if (inRoom && !isHost) announceVideo();
    if (inRoom && isHost)  startHeartbeat();
    if (inRoom && !isHost) startViewerStatus();
  }

  function detachFromVideo() {
    if (!video) return;
    video.removeEventListener('play',       onPlay);
    video.removeEventListener('pause',      onPause);
    video.removeEventListener('seeked',     onSeeked);
    video.removeEventListener('ratechange', onRateChange);
    video.removeEventListener('waiting',    onBufferStart);
    video.removeEventListener('canplay',    onBufferEnd);
    video = null;
  }

  // ---------------------------------------------------------------------------
  // Heartbeat (host only)
  // ---------------------------------------------------------------------------

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!video || !inRoom || !isHost) return;
      sendEvent({
        action:      'heartbeat',
        currentTime: video.currentTime,
        paused:      video.paused,
        rate:        video.playbackRate,
      });
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Viewer status reporting (viewer only)
  // ---------------------------------------------------------------------------

  function startViewerStatus() {
    stopViewerStatus();
    viewerStatusTimer = setInterval(() => {
      if (!video || !inRoom || isHost) return;
      sendViewerStatus();
    }, VIEWER_STATUS_INTERVAL);
  }

  function stopViewerStatus() {
    if (viewerStatusTimer) {
      clearInterval(viewerStatusTimer);
      viewerStatusTimer = null;
    }
  }

  function sendViewerStatus() {
    if (!video || !inRoom || isHost) return;
    chrome.runtime.sendMessage({
      type:   'VIEWER_STATUS',
      status: {
        currentTime: video.currentTime,
        paused:      video.paused,
        buffering:   isBuffering,
        videoId:     getVideoId(),
        videoPart:   getPart(),
        isSynced,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Desync / resync
  // ---------------------------------------------------------------------------

  function desync() {
    if (!isSynced) return;  // idempotent
    isSynced = false;
    pendingAutoResync = false;  // user-initiated desync cancels auto-resync
    chrome.runtime.sendMessage({ type: 'VIEWER_DESYNCED' });
  }

  // Snap viewer to the host's last known full state (time + paused + rate).
  // Called when viewer clicks Resync or when host sends set-sync after accepting
  // a jump request.
  function resync() {
    isSynced = true;
    pendingAutoResync = false;
    chrome.runtime.sendMessage({ type: 'VIEWER_RESYNCED' });
    if (!lastHostState || !video) return;
    video.currentTime = lastHostState.currentTime;
    if (lastHostState.rate != null) video.playbackRate = lastHostState.rate;
    if (lastHostState.paused) video.pause();
    else video.play().catch(() => {});
  }

  // Returns true if the viewer's current video state has diverged from the host's
  // last known state enough to be considered a genuine user-initiated deviation.
  // Used by onPlay/onPause/onSeeked to distinguish user gestures from Bilibili's
  // internal player events that fire after programmatic mutations.
  function isDeviatingFromHost() {
    if (!lastHostState) return true;
    const timeDiff    = Math.abs(video.currentTime - lastHostState.currentTime);
    const pausedMatch = video.paused === lastHostState.paused;
    return timeDiff > DESYNC_THRESHOLD || !pausedMatch;
  }

  // ---------------------------------------------------------------------------
  // Buffering detection
  // ---------------------------------------------------------------------------

  function onBufferStart() {
    isBuffering = true;
    if (!isHost) sendViewerStatus();
  }

  function onBufferEnd() {
    isBuffering = false;
    if (!isHost) sendViewerStatus();
  }

  // ---------------------------------------------------------------------------
  // Playback event handlers
  // ---------------------------------------------------------------------------

  function onPlay() {
    if (inRoom && !isHost) {
      if (isDeviatingFromHost()) desync();
      sendViewerStatus();
    }
    if (!inRoom || !isHost) return;
    sendEvent({ action: 'play', currentTime: video.currentTime, rate: video.playbackRate });
  }

  function onPause() {
    if (inRoom && !isHost) {
      if (isDeviatingFromHost()) desync();
      sendViewerStatus();
    }
    if (!inRoom || !isHost) return;
    sendEvent({ action: 'pause', currentTime: video.currentTime });
  }

  function onSeeked() {
    if (inRoom && !isHost) {
      if (isDeviatingFromHost()) desync();
    }
    if (!inRoom || !isHost) return;
    sendEvent({ action: 'seek', currentTime: video.currentTime });
  }

  function onRateChange() {
    if (!inRoom || !isHost) return;
    sendEvent({ action: 'speed', currentTime: video.currentTime, rate: video.playbackRate });
  }

  // Tell the service worker which video this tab is actively showing.
  // Called on video attach and on room join so the sw can route sync messages
  // to this tab and (for the host) know which video to push.
  function announceVideo() {
    chrome.runtime.sendMessage({
      type:      'ANNOUNCE_VIDEO',
      videoId:   getVideoId(),
      videoPart: getPart(),
    });
  }

  function sendEvent(event) {
    chrome.runtime.sendMessage({
      type:  'PLAYBACK_EVENT',
      event: { ...event, videoId: getVideoId(), videoPart: getPart(), ts: Date.now() },
    });
  }

  // ---------------------------------------------------------------------------
  // Apply incoming sync commands (viewer side)
  // ---------------------------------------------------------------------------

  // Merge fields from an incoming host event into lastHostState.
  // Called on every message regardless of isSynced, so resync() always has
  // the most recent complete picture of what the host is doing.
  function updateLastHostState(event) {
    if (!lastHostState) {
      lastHostState = { currentTime: null, paused: null, rate: null };
    }
    if (event.currentTime != null) lastHostState.currentTime = event.currentTime;
    if (event.rate        != null) lastHostState.rate        = event.rate;
    // Derive paused from explicit field (heartbeat) or from action (play/pause commands).
    if (event.paused != null) {
      lastHostState.paused = event.paused;
    } else if (event.action === 'play') {
      lastHostState.paused = false;
    } else if (event.action === 'pause') {
      lastHostState.paused = true;
    }
  }

  function applySync(event) {
    if (!video) return;

    // Drop command silently if viewer is not on the same video and part as host.
    // Fail-closed: missing identity fields are treated as mismatch, not pass-through.
    if (!event.videoId || event.videoId !== getVideoId()) return;
    if (!event.videoPart || event.videoPart !== getPart()) return;

    // Always update lastHostState — even while desynced — so resync() can snap
    // to the correct state instantly without waiting for the next heartbeat.
    updateLastHostState(event);

    // Auto-resync: fire once on the first host message after a video attach,
    // as long as the user hasn't manually desynced in the meantime.
    if (pendingAutoResync && lastHostState.currentTime != null && lastHostState.paused != null) {
      resync();
      return;
    }

    // Drop all commands while desynced — viewer is freerunning.
    if (!isSynced) return;

    applyHostEvent(event);
  }

  function applyHostEvent(event) {
    if (!video) return;

    switch (event.action) {
      case 'play':
        video.currentTime = event.currentTime;
        video.play().catch(() => {});
        break;

      case 'pause':
        video.currentTime = event.currentTime;
        video.pause();
        break;

      case 'seek':
        video.currentTime = event.currentTime;
        break;

      case 'speed':
        video.playbackRate = event.rate;
        break;

      case 'heartbeat': {
        const drift = Math.abs(video.currentTime - event.currentTime);
        if (drift > DRIFT_THRESHOLD) {
          video.currentTime = event.currentTime;
          // Programmatic currentTime assignment never auto-plays (verified):
          // video.paused stays correct after the seek, no extra pause() needed.
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Handle current-state request from sw (host sends state to new viewer)
  // ---------------------------------------------------------------------------

  function onRequestState() {
    if (!video || !isHost) return;
    sendEvent({
      action:      video.paused ? 'pause' : 'play',
      currentTime: video.currentTime,
      paused:      video.paused,
      rate:        video.playbackRate,
    });
  }

  // ---------------------------------------------------------------------------
  // Service worker messages
  // ---------------------------------------------------------------------------

  function listenToServiceWorker() {
    chrome.runtime.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'SYNC_COMMAND':
          if (!isHost) applySync(msg.event);
          break;

        case 'HOST_SEEK':
          // Explicit command to the host's own video (e.g. from Accept Request).
          // Bypasses the isHost guard intentionally.
          if (video) applyHostEvent(msg.event);
          break;

        case 'ROOM_STATE': {
          const wasHost   = isHost;
          const wasInRoom = inRoom;
          isHost = msg.state.isHost;
          inRoom = msg.state.inRoom;

          const nowHosting = inRoom && isHost;
          const wasHosting = wasInRoom && wasHost;
          const nowViewing = inRoom && !isHost;
          const wasViewing = wasInRoom && !wasHost;

          if (nowHosting && !wasHosting) {
            stopViewerStatus();
            isSynced = true;
            if (video) startHeartbeat();
          } else if (!nowHosting && wasHosting) {
            stopHeartbeat();
          }

          if (nowViewing && !wasViewing) {
            stopHeartbeat();
            isSynced = true;
            pendingAutoResync = false;
            lastHostState = null;
            if (video) { announceVideo(); startViewerStatus(); }
          } else if (!nowViewing && wasViewing) {
            stopViewerStatus();
            isSynced = true;
          }
          break;
        }

        case 'REQUEST_STATE':
          onRequestState();
          break;

        case 'SET_SYNC':
          if (msg.synced) {
            resync();
          } else {
            desync();
          }
          sendViewerStatus();
          break;
      }
    });
  }

})();
