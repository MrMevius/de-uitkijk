# Streaming: evaluation, measurements and test procedure

The sections below keep three kinds of statements apart: **measured** (observed in this repository's environment), **design target**, and **to verify**.

## Evaluation

| Option | Assessment | Decision for P1 |
| --- | --- | --- |
| **Browser-native H.265** | Depends on browser, OS and GPU. Chromium-based browsers decode HEVC only with platform or hardware support; plain Chromium builds and Firefox on Linux usually cannot. Safari can. Test the real client with `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"')`. | Use H.265 passthrough where supported; do not transcode by default. |
| **MSE (fMP4 over WebSocket)** | go2rtc remuxes RTSP into fragmented MP4 without decoding. Plain TCP over the same origin as the page, so it works through the edge proxy and later SWAG. Latency is typically under 1 s with live-edge correction. | **Chosen transport.** |
| **WebRTC** | Lowest latency, but needs ICE: a published UDP/TCP port (go2rtc `:8555`), candidate configuration and, outside the LAN, a TURN path. H.265 over WebRTC has limited browser support. | Deferred. Revisit if measured MSE latency misses the 1–2 s target. |
| **H.265 → H.264 transcoding** | Needed only for clients without HEVC. Decode plus encode per stream; at 4K main-stream resolution it is expensive without a GPU. On the 640x360 substream it is cheap. go2rtc does it on demand: `ffmpeg:<stream>#video=h264`. | Not enabled. Example in `go2rtc/live.example.yaml`. Enable per stream only after a measurement shows a target client needs it. |
| **Hardware acceleration** | The go2rtc image's ffmpeg has VAAPI, QSV and Vulkan encoders/decoders (`h264_vaapi`, `hevc_qsv`, …). This needs `/dev/dri` passed through to the go2rtc host. The only iGPU currently passed through in the homelab belongs to the Frigate/Plex host, which live streaming must not depend on. | Avoid needing it: prefer clients that decode HEVC natively (the planned Intel NUC should, to be verified). |
| **Main/substream selection** | Substream (640x360, 6 fps) is about 1/36 of the main stream's pixels and decodes easily on any client; it looks soft on a large tile. Main (3840x2160, 12.5 fps) H.265 4K decoding in four to nine tiles at once needs hardware decoding on the client. | Stream per profile, default `sub`. No switching on focus, which would reconnect and double upstream sessions. Quality for the focused tile is a measurement question for P2. |
| **Reconnection** | go2rtc reconnects upstream sources itself. The browser player retries with bounded backoff, see [architecture.md](architecture.md#resilience-behaviour). | Implemented. |
| **Upstream camera connections** | go2rtc opens one upstream session per stream name only while somebody watches it and shares it between viewers. Each watched stream type adds one RTSP session per camera **in addition to** Frigate's go2rtc (main + sub) and the NVR. | Default profile: one extra session per camera (substream). The camera's maximum concurrent RTSP sessions is not documented here (**to verify** on the camera). |
| **Audio** | Cameras send AAC. The dashboard offers video codecs only, so go2rtc sends no audio to the dashboard. | No audio, as required. |

## Measured in this repository (2026-11-08)

Environment: development VM, Docker, go2rtc 1.9.15, mock streams (ffmpeg test pattern, H.264 640x360 at 6 fps for `*_sub`, H.265 1280x720 for `*_main`), Playwright Chromium build 1248 (headless) at 1920x1080. **These are not camera measurements.**

| Observation | Result |
| --- | --- |
| go2rtc MSE negotiation for H.265 when the client lists `hvc1` | Passthrough: `video/mp4; codecs="hvc1.1.6.L153.B0"`. |
| go2rtc when the client lists only H.264 for an H.265 source | Error `codecs not matched: video:H265 => video:H264`. go2rtc does **not** transcode automatically. |
| First fMP4 data after WebSocket open (includes ffmpeg start of the mock source) | ~85–125 ms (direct and through the nginx edge). |
| Page navigation → all four tiles playing (mock, headless Chromium) | 1.26 s. |
| Media buffered ahead of playback position | ~0.5 s per tile. |
| HEVC MSE support in the headless Chromium build | `false`; H.264 `true`. |
| Video elements after focus changes | Same four elements (identity preserved). |
| Nine mock streams (`cameras-9.mock.json`) | See [testing.md](testing.md#nine-camera-playback). |
| Backend stopped (`docker compose stop server`) | All four tiles kept playing; status "Server niet bereikbaar" within 4 s; a page reload during the outage again showed four live tiles. |
| go2rtc stopped | All tiles "Geen beeld" (checked after 8 s), status red ("Streamingdienst niet bereikbaar") within 20 s; all tiles live again 1.4 s after go2rtc restarted. |
| go2rtc `allow_paths: [/api, /api/ws]` | `/api/streams`, `/api/config`, `/stream.html` → 404. |
| Edge stream-name validation | `src=../api/config` → 400. |

## Measured with the real cameras (2026-11-08)

Environment: development VM on the LAN; go2rtc 1.9.15 in Docker connecting directly to the four ANNKE cameras (`/Streaming/Channels/101` and `102`, RTSP over TCP); nginx edge on localhost. Frigate kept running unchanged. Measurement clients: a Node.js MSE WebSocket client (`ftyp`/`moof` timing) and Playwright WebKit (GTK build 2370) at 1920x1080. The camera account is the existing administrator account (operator decision).

| Measurement | Result |
| --- | --- |
| Codec negotiation | All eight streams passed through as H.265 (`hvc1.1.6.L153.B0`). No transcoding. |
| Substreams (640x360) | ~6.0 fragments/s (one per frame), 0.30–0.49 Mbit/s per camera. |
| Main streams (3840x2160) | ~12.4 fragments/s, 3.7–4.7 Mbit/s per camera (excluding Achter het huis 1, below). |
| Startup: WebSocket open → first media fragment | Substreams 0.11–0.50 s; main streams 0.26–0.36 s. **Achter het huis 1** is consistently slower: substream 1.0–2.4 s, main stream 6.6–7.7 s. |
| Achter het huis 1 network path | Ping from the development VM: average 160 ms RTT, maximum 566 ms, while the other cameras answer in 1–2 ms. This camera's network link explains its slow start; the cause (wireless/cabling/switch port) is not yet investigated. |
| Browser playback (WebKit GTK, HEVC via GStreamer) | Page navigation → all four substreams playing in 2.2 s. After ~12 s: 69–74 decoded frames per tile, 0–1 dropped. |
| Buffer ahead of playback position | 0.54–0.72 s per tile. |
| End-to-end latency | **Not measured.** The camera OSD clocks were ~51 minutes ahead of real time at the time (set by the hardware NVR; corrected later that day), and the test browsers could not provide a comparable display clock. Use the stopwatch method in the procedure below. |
| Upstream camera connections | One RTSP session per camera per watched stream type, with 1 or 2 consumers per stream (8 consumers on 4 substreams → 4 sessions). Zero sessions when nobody watches; sessions close immediately when the last viewer leaves. |
| go2rtc resources | 4 substreams with 8 consumers: ~1 % CPU, 24 MiB RAM. 4 main streams: ~5.5 % CPU, 27 MiB RAM (development VM). Backend 38 MiB, edge 4 MiB. |
| Effect on Frigate | Frigate camera FPS 5.0/5.0/5.0/5.0 during the test, identical to the baseline before it. |
| Frigate alert integration (live mode) | Backend health `alerts: ok` against the production Frigate. No alert occurred during the test, so alert-to-focus latency is still unmeasured. |
| Headless Chromium (Playwright build 1248) | No HEVC through MSE; the real-camera dashboard cannot play there without transcoding. |

Still open: end-to-end latency, HEVC support on the actual TV client (Intel NUC + browser), camera disconnect/reconnect with real cameras, and the camera's maximum number of RTSP sessions.

## TV client recommendation

Browser HEVC support decides whether the default path (no transcoding) works. Sources disagree on stock Chrome on Linux: HEVC through MSE depends on VAAPI and the build, and recent reports show `isTypeSupported('…hvc1…')` failing. Chrome on Windows with a GPU that decodes HEVC in hardware is the most widely reported working path. go2rtc and Frigate both describe browser HEVC as dependent on browser, OS and hardware decoder.

Decision (operator, 2026-11-08): the existing Intel NUC gets Windows 11 with a Chromium browser; acceptance tests run on a Windows 11 machine with Chrome. To be verified on the device:

1. **Hardware:** a mini PC with a recent Intel iGPU (hardware HEVC decode) and wired Ethernet.
2. **OS and browser:** Windows 11 with Google Chrome in kiosk mode, for example `chrome.exe --kiosk --autoplay-policy=no-user-gesture-required http://<dashboard>/?profile=shop`. Use automatic sign-in to a local account, disable sleep/screen-off, and schedule Windows updates outside viewing hours. Prefer Chrome over Edge: Edge's HEVC support has historically depended on the separate HEVC Video Extensions package.
3. **Acceptance before buying a second unit:** `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"')` returns `true`; four substreams play without dropped frames; stopwatch latency is recorded; main-stream decoding in a focused tile is tested.
4. **Fallback** if HEVC fails: a Linux kiosk with WebKit and GStreamer, which played the real H.265 streams in this repository's test, or per-stream H.264 transcoding of the substream in go2rtc.

### Windows 11 + Chrome result (2026-11-08)

Operator's Windows 11 PC (remote, not in front of the cameras), Chrome, live dashboard against the four real cameras (substreams, H.265 passthrough):

- `chrome://gpu` reports hardware decoding for `hevc main` and `hevc main 10` up to 8192x8192.
- All four tiles played live with smooth motion; go2rtc held exactly one RTSP session per camera. go2rtc does not transcode, so Chrome decoded H.265 itself.
- Not yet measured on this client: end-to-end latency (needs the operator on site), exact dropped-frame counts and main-stream playback in a focused tile. These remain acceptance steps on the NUC itself.

### iPhone result (2026-11-08)

The operator's iPhone (Brave browser, WebKit) played all four real H.265 substreams live through `https://uitkijk.mrmevius.nl` after login, using the player's `ManagedMediaSource` path.

## Design targets (not yet measured with cameras)

- Local end-to-end latency 1–2 s.
- Startup to first frame under 2 s per tile.
- No transcoding in the default path; go2rtc CPU close to idle with four substreams.
- Reconnection of a camera after an outage within the backoff interval (≤ 30 s).

## Procedure: testing the real ANNKE H.265 streams

Run this only on a trusted network. Nothing on the cameras, the NVR or Frigate is changed. Every De Uitkijk viewer adds one RTSP session per watched stream on the camera.

1. **Configure.** `cp .env.example .env` and `cp go2rtc/live.example.yaml go2rtc/live.yaml`. In `.env` set `UITKIJK_MODE=live`, `GO2RTC_CONFIG_PATH=./go2rtc/live.yaml`, `FRIGATE_URL`, `CAMERA_USER`, `CAMERA_PASSWORD` and the `CAM_*_HOST` values. Keep `UITKIJK_BIND=127.0.0.1`, or a LAN address only on a trusted network.
2. **Start.** `docker compose up --build`. Open `http://127.0.0.1:8080`.
3. **Compatibility.** In the target browser's console:
   ```js
   ['avc1.640029', 'hvc1.1.6.L153.B0'].map(c => [c, MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)])
   ```
   Record browser, version, OS and GPU. Repeat with `?profile=` variants. To test the main stream, temporarily set a profile's `streamQuality` to `main`.
4. **Startup latency.** DevTools → Network → WS: time from the `/stream/ws` request to the first binary frame, and to the tile showing video (status changes to live).
5. **End-to-end latency.** Hold a running phone stopwatch in front of the camera; since 2026-11-08 the camera OSD clocks are NTP-synced, so comparing the OSD time with a synced clock next to the TV is a quick first check. Photograph the TV and the clock together and compare. Take at least five samples per stream and record the median. Alternatively use the mock stream's burned-in time against a synced screen clock.
6. **CPU and RAM.** `docker stats` for `go2rtc`, `server` and `web` with 0, 1 and 2 dashboards open; browser task manager on the client. Record the values with substream and with main stream.
7. **Upstream connections.** `docker compose exec go2rtc sh -c 'netstat -tn | grep :554'` (count per camera address) with one and with two dashboards open. Expect one session per watched stream per camera, regardless of the number of dashboards.
8. **Quality changes.** Compare sub and main on the shop and bedroom TVs at their viewing distances. Record client CPU/GPU, dropped frames (`video.getVideoPlaybackQuality()`) and latency.
9. **Reconnection.** Disconnect one camera (unplug, or block it temporarily at a switch port you control) for 60 s. Expect that tile to show "Geen beeld" within about 6 s, the other tiles unaffected, and recovery within one backoff interval after the camera returns. Then `docker compose restart go2rtc`: every tile should recover. Then `docker compose stop server`: video should continue and the status show "Server niet bereikbaar".
10. **Record** results in a new section of this document with date, versions and environment. Keep them separate from the targets above.

## Nine cameras

Only four physical cameras exist. Nine-camera **layout** behaviour is covered by automated tests. Nine-stream **playback** has been exercised with nine mock streams only. That shows the client can play nine MSE streams; it does not validate nine real H.265 cameras. A reproducible real test would point go2rtc at multiple streams (for example five extra names re-using existing cameras' substreams, which also raises upstream sessions per camera) and must be labelled as such.
