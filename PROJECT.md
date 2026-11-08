# De Uitkijk — project overview

## Purpose

A self-hosted camera dashboard for a private homelab. TVs show all live cameras, enlarge cameras with an active Frigate alert, and later rotate AI-described highlights of the day. Live viewing must keep working when Frigate, the application backend or the internet is unavailable.

The complete agreed scope is in [docs/requirements.md](docs/requirements.md).

## Status

**Increment 1 — foundation and live dashboard prototype: implemented (2026-11-08).**

- TypeScript monorepo (shared logic, Fastify backend, React/Vite dashboard), Docker Compose stack, CI.
- Camera model with stable ids and one shared order (1–9 cameras); four logical locations configured.
- Mock mode (deterministic scenarios, go2rtc test-pattern video) and live mode (Frigate review API, read-only).
- Standalone go2rtc with MSE playback, H.265 passthrough, no transcoding by default, management API blocked.
- Automatic TV dashboard: Dutch date/clock, health indicator, alert indicator with object type, display profiles.
- Focus state machine with an independent 15 s hold per camera; deterministic layout for every focus combination.
- Resilient players: unavailable tiles, bounded exponential backoff, stall detection, no stale frames, backend-independent streaming.
- 61 automated tests.

Not production-ready: there is **no authentication**. Run it only on a trusted network ([docs/security.md](docs/security.md)).

**Deployed (2026-11-08):** live mode on `503-web-ubuntu` at `http://10.0.0.171:8088`, delivered by deployctl from `main`. Only allowlisted client addresses are served ([docs/deployment.md](docs/deployment.md)).

## Documentation

| Document | Content |
| --- | --- |
| [docs/requirements.md](docs/requirements.md) | Consolidated product requirements with phases |
| [docs/architecture.md](docs/architecture.md) | Components, data flow, state machine, layout, resilience, decisions |
| [docs/frigate-integration.md](docs/frigate-integration.md) | Verified Frigate 0.17.2 API behaviour and alert derivation |
| [docs/streaming.md](docs/streaming.md) | Streaming evaluation, measurements, real-camera test procedure |
| [docs/security.md](docs/security.md) | Current boundary; production auth, TV pairing, 4-hour outage design |
| [docs/development.md](docs/development.md) | Running mock and live mode, configuration |
| [docs/deployment.md](docs/deployment.md) | Placement on `503-web-ubuntu`, deployctl, interim client allowlist |
| [docs/testing.md](docs/testing.md) | Automated tests, fixtures, manual checks |

## Roadmap

| Phase | Scope |
| --- | --- |
| 1 (done) | Foundation, mock/live alert integration, streaming proof of concept, automatic dashboard, focus, resilience, tests. |
| 2 | Real-camera streaming measurements; hosting benchmark and placement decision (independent of the Frigate host); kiosk client (Intel NUC) with HEVC verification; display profiles per device. |
| 3 | SQLite persistence; user accounts and roles; TV pairing and device sessions; stream tickets that survive a 4-hour backend outage; SWAG/HTTPS and local DNS; Zabbix health checks; backups. |
| 4 | Highlights: candidate selection, grouping across cameras, clip selection, thumbnails, rotation on the dashboard, archive, feedback/deletion with tombstones, catch-up after outages. |
| 5 | AI descriptions via an officially permitted subscription method, with owner authorisation; administrative UI; downloads. |

## Open technical dependencies

| Topic | Why it matters | Next step |
| --- | --- | --- |
| HEVC decoding on the TV client | Determines whether H.265 can be passed through or must be transcoded. Real H.265 passthrough already plays in WebKit GTK; headless Chromium cannot. Operator decision (2026-11-08): Windows 11 with a Chromium browser on the Intel NUC. | Run the acceptance tests on a Windows 11 machine with Chrome: `MediaSource.isTypeSupported`, four-tile playback, stopwatch latency ([docs/streaming.md](docs/streaming.md#tv-client-recommendation)). |
| Achter het huis 1 network link | 160 ms average RTT (others 1–2 ms) and a 7 s main-stream start. | Investigate the camera's link (outside this project). |
| Camera clocks | Resolved 2026-11-08 (operator-approved): the hardware NVR and all four cameras now use NTP on the LAN gateway with CET/CEST and matched real time to the second. | Re-check after a day (homelab backlog). |
| Camera RTSP session limit | go2rtc adds one session per camera per watched stream type, next to Frigate and the NVR (measured). | Check the ANNKE maximum. |
| Real latency and resources | Startup, bitrate, sessions and go2rtc resources were measured on 2026-11-08; end-to-end latency was not. | Stopwatch latency test on the TV client. |
| Hosting location for go2rtc + edge | Decided 2026-11-08: `503-web-ubuntu`, deployed with deployctl, LAN access limited to an address allowlist until phase 3 ([docs/deployment.md](docs/deployment.md)). | Add the NUC's reserved address to the allowlist once it is installed. |
| Camera account | Operator decision (2026-11-08): go2rtc uses the existing camera administrator account. Accepted trade-off: the credential stays server-side (`.env`, mode 600, go2rtc only). | None. |
| Frigate alert timing | Frigate keeps alerts open for `cutoff_time` (40 s) after activity; focus lasts about 40 s + 15 s. | Decide whether that is acceptable or adjust Frigate (production change). |
| Frigate API authentication | Development uses the unauthenticated internal API. | Choose authenticated API or network restriction for production. |
| Stream authorisation at the edge | Required for the 4-hour outage requirement. | Choose `secure_link` or a stateless verifier ([docs/security.md](docs/security.md)). |
| Frigate push events | Could lower alert latency below the 2 s poll. | Verify the `/ws` `reviews` topic with a real alert. |
| Highlight semantics | Grouping, clip extraction and catch-up depend on Frigate event/recording APIs. | Verify against 0.17.2 before design. |
| AI provider | Must use an officially permitted subscription method without paid fallback. | Re-evaluate availability when phase 5 starts. |
