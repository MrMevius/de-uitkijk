# Frigate integration

Findings from read-only inspection of the production Frigate instance (version string `0.17.2-3d4dd3a`) on 2026-11-08 and from the Frigate v0.17.2 source code. Nothing in Frigate was changed.

## What Frigate exposes

| Question | Finding | Evidence |
| --- | --- | --- |
| Camera list | `GET /api/config` → `cameras` keys. Four cameras: `Vriezenveen_oprit`, `Vriezenveen_voordeur`, `Vriezenveen_achter_thuis_1`, `Vriezenveen_achter_thuis_2`. | Live API |
| Reusable RTSP credentials? | **No.** Passwords in `go2rtc.streams` of `/api/config` and in `/api/go2rtc/streams` are masked (`*`). Camera inputs reference Frigate's internal restream (`rtsp://127.0.0.1:8554/<name>`), not the cameras. | Live API, checked without printing values |
| Independent stream URLs | Frigate's go2rtc defines `<camera>` (main, channel 101) and `<camera>_sub` (channel 102) streams. Using Frigate's restream would make live viewing depend on the Frigate host, so De Uitkijk configures its own camera sources. | Live API |
| Codecs | Main and sub both **H.265 video + AAC audio (16 kHz)**. | `/api/go2rtc/streams` producer media |
| Detection | Detect role on the substream at 640x360, 5 fps. | `/api/config` |
| Alert rules | `review.alerts.labels = [person, car]`, per-camera `required_zones`, `cutoff_time = 40` s. | `/api/config` |
| MQTT | Disabled. | `/api/config` |
| WebSocket `/ws` | Works without MQTT; delivered `<camera>/status/detect` and `/status/record` messages in a 25 s sample (no `reviews` messages occurred during the sample). On 2026-11-09 a 90 s sample also delivered `events` (every tracked-object change, with `before`/`after`), `<camera>/<label>/active` and `stats`, as text frames `{"topic", "payload"}`. | Live probe |
| Camera health | `GET /api/stats` → `cameras.<name>.camera_fps`. | Live API |

## Deriving active alerts

Source: `frigate/api/review.py` and `frigate/review/maintainer.py` at tag `v0.17.2`.

- `GET /api/review` filters on `start_time < before AND (end_time IS NULL OR end_time > after)`, i.e. all segments **overlapping** `[after, before]`, including segments still in progress (`end_time = null`). Default `before` is now. Results are ordered by severity, then newest first.
- A segment's severity can be upgraded from `detection` to `alert` while it is open.
- An alert segment stays open until `cutoff_time` (40 s here) after the last alert-qualifying activity. When it closes, `end_time` is set **retroactively to that last activity**, not to the closing moment.

De Uitkijk therefore polls

```text
GET /api/review?severity=alert&cameras=<configured>&after=<now-120s>&limit=100
```

every 2 s (configurable, minimum 1 s) and treats every returned item with `end_time = null` as an active alert. Since 0.20.0 the backend also keeps Frigate's websocket `/ws` open (same session cookie and pinned certificate as the API) and polls at once on every `events` or `reviews` message, at most every 500 ms: the push is only a wake-up signal, polling stays the source of truth, and without the websocket (reconnecting with backoff up to 60 s; logged after three failures) everything works as before. The 15 s focus hold starts when De Uitkijk **observes** the segment closing. Using Frigate's retroactive `end_time` would end the hold almost immediately, because that timestamp is already about 40 s in the past.

Consequence: after the last person or car leaves a zone, focus lasts roughly `cutoff_time` (40 s, Frigate setting) + poll delay (≤ 2 s) + hold (15 s). Shortening this means lowering Frigate's `review.alerts.cutoff_time`. That is a production change outside this increment.

Safeguards:

- An open alert older than `FRIGATE_MAX_ALERT_AGE_S` (default 1800 s) is ignored, in case a segment never closes (for example after a Frigate crash). This is a defensive limit, not Frigate semantics.
- After three consecutive failed polls Frigate is reported down and all alerts are released through the normal hold. Polling then backs off exponentially up to 30 s.
- Every 150 polls (about 5 minutes) `/api/config` is read to log configured cameras that Frigate does not know and Frigate cameras not shown on the dashboard. Only camera names are read.

## Access

Since 2026-11-08, production uses the authenticated API on port 8971 with the dedicated viewer account `uitkijk` and the pinned Frigate certificate (`FRIGATE_AUTH_FILE`, see [security.md](security.md)). The client logs in through `POST /api/login`, sends the `frigate_token` cookie and logs in again after a 401. Development and tests may still use the unauthenticated port 5000 (no auth file).

## Open points

- Measure real alert-to-focus latency (Frigate detection delay + poll interval).
- Highlights (later) will need `/api/review` with `detection` severity, `/api/events`, snapshots and clip export. Their semantics must be verified the same way before use.
