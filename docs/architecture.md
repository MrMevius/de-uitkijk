# Technical architecture

## Overview

```text
                 ┌──────────────────────── trusted LAN ────────────────────────┐
 ANNKE cameras ──RTSP (H.265)──► go2rtc ──fMP4/MSE over WebSocket──┐            │
       │                         (no transcoding by default)        │            │
       │                                                            ▼            │
       └──RTSP──► Frigate (separate host) ──review API──► backend ──SSE──► edge ──► TV browser
                                                 (poll, read-only)  (Fastify)  (nginx: static,
                                                                               /api, /stream/ws)
```

| Component | Responsibility | Not responsible for |
| --- | --- | --- |
| **go2rtc** (`alexxit/go2rtc:1.9.15`) | One upstream RTSP session per watched stream, shared by all viewers; remuxes H.265/H.264 into fragmented MP4 for MSE. | Authentication, alerts, layout. |
| **Edge proxy** (nginx; later SWAG) | Serves the static dashboard; forwards `/api/` to the backend; exposes only go2rtc's MSE WebSocket at `/stream/ws` for names matching `^[a-z0-9_]{1,64}$`. | Business logic. |
| **Backend** (`apps/server`, Node.js 24 + Fastify) | Camera configuration and order; alert source (mock or Frigate); focus state machine with hold timers; health; pushes state over server-sent events. | Media. It never touches video. |
| **Dashboard** (`apps/web`, React + Vite) | Layout from focus state; one MSE player per tile with reconnection; overlays, clock and health. | Talking to Frigate or cameras directly. |
| **Shared** (`packages/shared`) | Types, camera config validation, focus state machine, layout algorithm, backoff, Dutch formatting, display profiles. | I/O. |

The streaming path (camera → go2rtc → edge → browser) contains neither the backend nor Frigate. A loaded dashboard keeps playing when either fails.

## Data flow

1. The backend loads `config/<file>.json` (array order = shared camera order) and validates it (1–9 cameras, unique ids, safe stream names, unique Frigate mappings).
2. An alert source produces the complete set of active alerts:
   - **mock**: deterministic scenario timelines (`apps/server/src/mock/scenarios.ts`);
   - **live**: bounded polling of Frigate's review API, see [frigate-integration.md](frigate-integration.md).
3. `StateHub` reconciles alerts through the pure focus reducer (`packages/shared/src/focus.ts`), keeps one timer for the earliest hold expiry, and emits a `DashboardState` only when something meaningful changed.
4. Clients receive state through `GET /api/events` (SSE) and render `computeLayout(cameraIds, focusedIds, viewport)`.
5. Each tile owns a `<video>` and an `MsePlayer` keyed by stream name. Layout changes only update absolute position and size (CSS transition, 400 ms), so video connections survive focus changes.

## Focus state machine

Per camera: `alertIds`, `labels`, `holdUntil`.

- Active alert(s) → focused (`reason: alert`), `holdUntil = null`.
- Last alert disappears → `holdUntil = now + 15 s` (independent per camera).
- New alert during hold → hold cancelled.
- `holdUntil <= now` → camera leaves focus.
- Alert source unavailable → treated as "no active alerts", so focus ends through the same hold rather than sticking.

The reducer is pure and clock-free; the hub provides `Date.now()` and a single `setTimeout`. Tests drive it with explicit timestamps and fake timers.

## Layout

`computeLayout` keeps every tile at 16:9 and searches deterministic candidates:

- No focus, or every camera focused: one uniform grid maximising tile size (2x2 for four, 3x3 for nine).
- Otherwise focused cameras share a primary region and the other cameras a strip to the right or bottom. Split ratios from 50 % to 85 % are tried; the candidate with the largest focused tiles wins, provided other tiles stay at least 18 % of the screen width (profile setting) and focused tiles are at least 1.5x wider. The minimum is relaxed stepwise (100 → 75 → 50 %) before falling back to the plain grid.
- Within each region tiles follow the shared order in reading order.

An exhaustive test checks every camera count 1–9 and every focus subset for visibility, bounds, overlap, prominence and order.

## Resilience behaviour

| Failure | Behaviour |
| --- | --- |
| One camera stream fails | Tile hides the video, clears the decoded frame (`removeAttribute('src')` + `load()`), shows "Geen beeld", retries after 1, 2, 4, 8, 16, then every 30 s (±20 % jitter). Backoff resets after 30 s of stable playback. |
| Stream stalls | Watchdog: no `currentTime` progress for 6 s → treated as failure. No first frame within 15 s → failure. |
| Latency drift | If more than 2 s is buffered ahead, the player jumps to the live edge. Old buffer is trimmed to stay under SourceBuffer quotas. |
| Browser cannot decode codec | go2rtc returns an error (`codecs not matched`); the tile shows "Geen beeld" and retries with backoff. No MSE support at all → "Video niet ondersteund", no retry loop. |
| Backend down | Video continues (direct to go2rtc). Health shows "Server niet bereikbaar". Focus is released after 15 s. `EventSource` reconnects; if it is closed by an HTTP error, a bounded backoff reopens it. The last camera list is cached in `localStorage`, so a reload during a backend outage still renders all tiles. |
| Frigate down | After three failed polls: health "Frigate niet bereikbaar", active alerts released through the normal hold, camera availability "unknown". Polling backs off up to 30 s. |
| go2rtc down | Backend probe (`GET /api` every 15 s) reports "Streamingdienst niet bereikbaar"; tiles show "Geen beeld" and retry. |

## Decisions

Short records; full rationale where it matters.

1. **TypeScript monorepo with npm workspaces** (`packages/shared`, `apps/server`, `apps/web`). One language, shared types and pure logic tested once.
2. **Node.js 24 runs the server's TypeScript directly** (type stripping, `erasableSyntaxOnly`). No server build step; only the web app is bundled by Vite.
3. **Fastify** for a small HTTP API. **Server-sent events** for state push: one-directional, proxy-friendly, automatic browser reconnect, no extra dependency.
4. **The backend owns the focus state machine.** One Frigate poller instead of one per TV; identical focus on every client; Frigate never exposed to browsers. Clients only release focus on their own when the backend is unreachable.
5. **Bounded polling of `/api/review` instead of the Frigate WebSocket.** The review API's overlap semantics were verified in the 0.17.2 source and against the live instance. The `/ws` WebSocket does work without MQTT (verified: it delivers `…/status/…` topics), and its `reviews` topic is a candidate for lower latency later; polling at 2 s is simpler to make robust and needs no reconnection protocol.
6. **MSE over WebSocket as the only playback transport in P1.** TCP through the same edge proxy as the page, no ICE/UDP configuration, H.265 passthrough when the browser supports it. WebRTC is deferred; see [streaming.md](streaming.md).
7. **Own minimal MSE player** (`apps/web/src/player/mse-player.ts`) instead of go2rtc's `video-rtc.js`. The requirements on stale frames, bounded backoff and status reporting are specific; the go2rtc protocol for MSE is small.
8. **Stream quality is fixed per display profile.** Switching main/sub on focus would recreate connections (FOC-5) and double upstream sessions. Revisit after measurements.
9. **nginx edge in front of go2rtc** with a path allowlist plus go2rtc's own `allow_paths`. The same rules can later be expressed in SWAG.
10. **SQLite through Node's built-in `node:sqlite`** (no native dependency) for accounts, sessions and highlights, in one file in the `data` volume.
11. **Mock video from go2rtc itself** (`exec` + ffmpeg test pattern with camera id and wall clock). The full streaming path, including the edge proxy, is exercised without cameras.

## Repository layout

```text
apps/server        Fastify backend, mock scenarios, Frigate source
apps/web           React dashboard, MSE player, /dev scenario panel
packages/shared    Pure logic and types used by both
config/            Camera configurations (4 locations; 9-camera mock fixture)
go2rtc/            go2rtc mock config, mock camera script, live config example
deploy/nginx/      Edge proxy template
docs/              Requirements, architecture, streaming, Frigate, security, development, testing
```

## Edge upstreams

nginx resolves the backend and go2rtc through Docker's DNS every 10 seconds (`upstream … resolve`, nginx ≥ 1.27.3). A recreated container can get a new address; before 0.12.0 the edge kept the address it saw at start-up and answered "Server niet bereikbaar" until it was restarted too. Verified on 2026-11-09 by forcing a new server address (172.18.0.2 → .5) while the edge kept running.
