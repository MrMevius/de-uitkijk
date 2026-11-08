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

## Design targets (not yet measured with cameras)

- Local end-to-end latency 1–2 s.
- Startup to first frame under 2 s per tile.
- No transcoding in the default path; go2rtc CPU close to idle with four substreams.
- Reconnection of a camera after an outage within the backoff interval (≤ 30 s).

## Procedure: testing the real ANNKE H.265 streams

Run this only on a trusted network, with a dedicated read-only camera account. Nothing on the cameras, the NVR or Frigate is changed. Every De Uitkijk viewer adds one RTSP session per watched stream on the camera.

1. **Configure.** `cp .env.example .env` and `cp go2rtc/live.example.yaml go2rtc/live.yaml`. In `.env` set `UITKIJK_MODE=live`, `GO2RTC_CONFIG=live.yaml`, `FRIGATE_URL`, `CAMERA_USER`, `CAMERA_PASSWORD` and the `CAM_*_HOST` values. Keep `UITKIJK_BIND=127.0.0.1`, or a LAN address only on a trusted network.
2. **Start.** `docker compose up --build`. Open `http://127.0.0.1:8080`.
3. **Compatibility.** In the target browser's console:
   ```js
   ['avc1.640029', 'hvc1.1.6.L153.B0'].map(c => [c, MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)])
   ```
   Record browser, version, OS and GPU. Repeat with `?profile=` variants. To test the main stream, temporarily set a profile's `streamQuality` to `main`.
4. **Startup latency.** DevTools → Network → WS: time from the `/stream/ws` request to the first binary frame, and to the tile showing video (status changes to live).
5. **End-to-end latency.** Put a clock with seconds (phone stopwatch, or the camera's OSD clock synced via NTP) in front of the camera. Photograph the TV and the clock together and compare. Take at least five samples per stream and record the median. Alternatively use the mock stream's burned-in time against a synced screen clock.
6. **CPU and RAM.** `docker stats` for `go2rtc`, `server` and `web` with 0, 1 and 2 dashboards open; browser task manager on the client. Record the values with substream and with main stream.
7. **Upstream connections.** `docker compose exec go2rtc sh -c 'netstat -tn | grep :554'` (count per camera address) with one and with two dashboards open. Expect one session per watched stream per camera, regardless of the number of dashboards.
8. **Quality changes.** Compare sub and main on the shop and bedroom TVs at their viewing distances. Record client CPU/GPU, dropped frames (`video.getVideoPlaybackQuality()`) and latency.
9. **Reconnection.** Disconnect one camera (unplug, or block it temporarily at a switch port you control) for 60 s. Expect that tile to show "Geen beeld" within about 6 s, the other tiles unaffected, and recovery within one backoff interval after the camera returns. Then `docker compose restart go2rtc`: every tile should recover. Then `docker compose stop server`: video should continue and the status show "Server niet bereikbaar".
10. **Record** results in a new section of this document with date, versions and environment. Keep them separate from the targets above.

## Nine cameras

Only four physical cameras exist. Nine-camera **layout** behaviour is covered by automated tests. Nine-stream **playback** has been exercised with nine mock streams only. That shows the client can play nine MSE streams; it does not validate nine real H.265 cameras. A reproducible real test would point go2rtc at multiple streams (for example five extra names re-using existing cameras' substreams, which also raises upstream sessions per camera) and must be labelled as such.
