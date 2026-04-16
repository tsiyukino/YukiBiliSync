# Viewer→host request signaling (Module 4)

**Date:** 2026-04-15

## Context

YukiBiliSync's original host-authoritative model stated: "Viewers receive commands
and apply them; they never push state back to the host." Module 4 introduces jump
requests — a mechanism where a viewer can ask the host to seek everyone to the
viewer's current position.

## Decision

We extend the model with a single, host-gated request channel. Viewers may send a
`jump-request` message over the data channel; the host sees it in the popup and
chooses to Accept or Dismiss. No viewer action ever changes playback state without
explicit host approval.

## Why this is safe

- The host remains authoritative. Accept triggers a seek broadcast from the host
  (via `OFFSCREEN_PLAYBACK_EVENT`), identical to a host-initiated seek. Dismiss
  discards the request silently. The viewer cannot force an outcome.
- Requests are debounced per viewer (last position wins). A viewer who seeks
  multiple times produces at most one pending entry in the host's popup.
- The data channel is already viewer→host for `viewer-status` messages (Module 3).
  Jump requests use the same transport; no new channel or trust boundary is opened.

## What is out of scope for v1

- Viewer-initiated pause/play requests (viewers can desync and freerun; they cannot
  ask the host to pause for everyone).
- Any other viewer→host signal beyond `viewer-status` and `jump-request`.
- Host migration or shared authority models.

## Consequences

The architecture doc's statement that viewers "never push state back to the host"
is now imprecise. The accurate statement is: viewers may send requests, but the
host decides whether to act on them. The reference docs for `sw.js`, `overlay.js`,
and `popup.js` reflect the new message types and UI.
