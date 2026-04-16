# YukiBiliSync

A reference document describing what this project is, why it exists, and the decisions shaping it. This is context for anyone (or any tool) picking up the project — not a design spec or implementation plan.

## What it is

YukiBiliSync is a browser extension that lets two or more people on different computers watch the same Bilibili video in perfect sync. One person creates a room, shares a short code, and others join. Everyone's Bilibili player stays aligned: play, pause, seek, and playback speed all stay in sync across viewers.

Each user streams the video from Bilibili the normal way, using their own browser and their own account. The extension does not touch the video data itself — it only syncs the *control state* (current time, play/pause, speed). This keeps the project simple, legal, and bandwidth-light, because there's no video being re-broadcast anywhere.

The target site is specifically Bilibili (`bilibili.com`). Other streaming sites are out of scope for v1.

## The problem it solves

Watch-party tools exist for Western streaming sites (Teleparty, Scener, Metastream), but the Bilibili ecosystem — which serves a huge Chinese-speaking audience and a growing international anime/ACG community — doesn't have a polished, privacy-respecting equivalent. Long-distance friends, study groups, fan communities, and language learners all benefit from being able to watch Bilibili content together in real time.

## High-level concept

Three pieces work together:

1. **A browser extension** that runs on Bilibili video pages. It hooks into the page's HTML5 video element, listens for the local user's playback actions, and applies remote actions from other viewers. It also provides a small UI for creating and joining rooms.

2. **A signaling server** (running on the project owner's existing server) that helps browsers find each other. Its only job is to relay the initial WebRTC handshake messages between peers. Once peers are connected, the server is not involved in the sync traffic itself.

3. **WebRTC peer connections** between the users themselves, carrying the actual sync messages (play/pause/seek/speed events, heartbeats, clock-sync pings). This is what keeps per-room server cost near zero regardless of how many rooms are active.

The person who creates a room is the "host," and the host's player is the source of truth. Viewers mirror the host. This host-authoritative model is the simplest to reason about and avoids conflict resolution headaches in v1.

## Key design decisions and why

### Browser extension, not a standalone app

Bilibili is a website with its own player and its own content library. The lowest-friction way to sync playback on a website is to run inside the browser alongside that website. A standalone app would have to re-implement or embed a browser to play Bilibili content, which is far more work and a worse user experience. Extension wins cleanly for this use case.

### WebRTC peer-to-peer, not client-server relay

The project owner has a server but doesn't want it to become a bottleneck as the user base grows. WebRTC lets the users' browsers talk directly to each other, so the server only handles the brief initial handshake. Per-room ongoing cost is effectively zero. One small VPS can signal for an enormous number of rooms because signaling messages are tiny and infrequent.

### Host-as-server topology

Instead of a central server maintaining room state, the room's *host* acts as the authority. Their browser holds the canonical playback state and pushes updates to viewers. If the host leaves, the room ends (host migration is a v2+ concern). This is the simplest possible model and keeps the signaling server stateless beyond "which peers are in which room."

### Sync control state only, never video data

The extension does not intercept, re-broadcast, or download Bilibili's video streams. Each viewer plays the video from Bilibili directly, the same way they would without the extension. This keeps the project out of any gray area around content redistribution and means bandwidth costs scale with message count (trivial), not video bitrate (huge).

### Relay through TURN by default for privacy

WebRTC peer-to-peer connections normally expose each participant's public IP address to the others during the ICE handshake. This is the same exposure that Discord voice chat, FaceTime, and every other WebRTC app creates, and for most users it's harmless — but for a watch-party app where people may join rooms with online friends they haven't met in person, it's a real concern worth addressing.

The mitigation is to route WebRTC traffic through a TURN server (`coturn` is the standard). With a TURN relay, neither side learns the other's IP — they only see the TURN server. The usual reason to avoid TURN is bandwidth cost, but YukiBiliSync's sync traffic is only control messages (hundreds of bytes per second per room, not video), so the cost is negligible even at scale.

The plan is to make TURN-relay the **default** mode with IP privacy as a built-in feature, and optionally expose a "direct mode" for users who want slightly lower latency and don't mind the IP exposure. This inverts the usual WebRTC assumption, but it fits this project's specific profile: low-bandwidth traffic, privacy-sensitive users, self-hosted infrastructure.

### Manifest V3, Chrome + Firefox target

Modern extension API, covers the overwhelming majority of desktop browser users, and keeps the codebase portable between Chromium browsers and Firefox with minimal divergence.

### Simple plain-JS extension, no framework for v1

The popup UI is small (create room, join room, room status). A framework would be overkill and would bloat the extension's install size. Plain JavaScript keeps things fast to load and easy to reason about. A framework can be introduced later if the UI grows.

## What makes Bilibili-specific integration non-trivial

A few quirks worth being aware of going in:

- **The player loads asynchronously.** The `<video>` element isn't in the DOM when the page first loads; the extension has to wait for it (via polling or `MutationObserver`).
- **The video element gets re-created** when the user switches video quality or changes parts in a multi-part video. The extension must notice and re-attach its listeners.
- **Two URL patterns** need support eventually: regular UGC videos (`/video/BV...`) and bangumi/anime (`/bangumi/play/...`). Multi-part videos add a `?p=N` parameter that is part of the "same video" identity.
- **Ads vary by account.** Premium accounts skip pre-rolls; free accounts see them. If the host has no ad and a viewer does, they'll fall out of sync during the ad. Sync should pause until both sides are on the main video.
- **Region and login state** can block some content entirely for some viewers. The extension should detect this and show a clear message rather than silently desyncing.
- **Danmaku (bullet comments)** are rendered locally by each viewer against the current playback time, so they should stay aligned for free once playback is aligned. No special handling needed, but worth verifying.

## What's in scope for v1

- Create and join rooms via short codes
- Sync play, pause, seek, and playback speed
- Host-authoritative model (host's state wins)
- Small overlay showing room status and member list
- Support for regular `/video/BV...` pages
- Handling the video element being re-created
- TURN-relay by default for IP privacy
- Signaling server deployed on the project owner's existing infrastructure

## What's out of scope for v1

These are deliberate omissions to keep v1 shippable:

- Text chat (easy to add later over the same data channel)
- Voice chat (WebRTC audio track, later)
- Bangumi/anime page support (add once regular videos are solid)
- Democratic control mode (anyone can pause/seek)
- Host migration when the host leaves
- Sophisticated reconnect-on-drop logic
- Late-joiner catch-up edge cases beyond what heartbeats give for free
- Mobile browser support

## Infrastructure

- **Signaling server:** runs on the project owner's existing server. Lightweight WebSocket service. Deployed behind TLS as `wss://`.
- **STUN:** Google's public STUN servers are fine.
- **TURN:** `coturn` self-hosted on the same (or a separate) server. This is what enables the privacy-by-default mode, and it's the main new piece of infrastructure the project needs.

## Naming

The project is called **YukiBiliSync**. "Yuki" (雪, snow) pairs naturally with the Bilibili brand aesthetic and the ACG audience the project is aimed at, and "BiliSync" makes the purpose immediately clear to anyone searching for it. The name works equally well as a repo name, extension listing name, and casual verbal reference.
