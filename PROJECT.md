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

**Deployed (2026-11-08):** live mode on `503-web-ubuntu`, delivered by deployctl from `main` ([docs/deployment.md](docs/deployment.md)).

- One address for everybody, at home and away: `https://uitkijk.mrmevius.nl` through SWAG (at home via the router, so it needs internet).
- Login everywhere with own accounts (administrator and viewer roles, one-time activation links); sessions do not expire ([docs/security.md](docs/security.md)).

## Documentation

| Document | Content |
| --- | --- |
| [docs/requirements.md](docs/requirements.md) | Consolidated product requirements with phases |
| [docs/architecture.md](docs/architecture.md) | Components, data flow, state machine, layout, resilience, decisions |
| [docs/frigate-integration.md](docs/frigate-integration.md) | Verified Frigate 0.17.2 API behaviour and alert derivation |
| [docs/streaming.md](docs/streaming.md) | Streaming evaluation, measurements, real-camera test procedure |
| [docs/highlights.md](docs/highlights.md) | Highlight selection, rotation, archive, storage |
| [docs/ai.md](docs/ai.md) | AI descriptions: provider, confinement, operations |
| [docs/security.md](docs/security.md) | Current boundary; production auth, TV pairing, 4-hour outage design |
| [docs/development.md](docs/development.md) | Running mock and live mode, configuration |
| [docs/deployment.md](docs/deployment.md) | Placement on `503-web-ubuntu`, deployctl, LAN and public access, administration |
| [docs/testing.md](docs/testing.md) | Automated tests, fixtures, manual checks |

## Roadmap

| Phase | Scope |
| --- | --- |
| 1 (done) | Foundation, mock/live alert integration, streaming proof of concept, automatic dashboard, focus, resilience, tests. |
| 2 | Real-camera streaming measurements; hosting benchmark and placement decision (independent of the Frigate host); kiosk client (Intel NUC) with HEVC verification; display profiles per device. |
| 3 | Done 2026-11-08: SQLite accounts and roles, one-time links, one public address with login everywhere, video reconnects during backend outages through a cached login check. TV pairing and stream tickets are superseded. Zabbix watches the three containers (503-web required-running list). |
| 4 | Done 2026-11-08: rule-based highlights from Frigate alerts, grouping across cameras, clips, thumbnails, rotation in an extra dashboard tile, archive (`/archief`) with feedback, deletion and downloads ([docs/highlights.md](docs/highlights.md)). |
| 5 | Done 2026-11-08: AI descriptions and noise filtering via the Codex CLI with the owner's ChatGPT sign-in ([docs/ai.md](docs/ai.md)); administrative pages `/beheer` and `/archief`; downloads. Later: Claude route when the plan allows. |

## Open technical dependencies

| Topic | Why it matters | Next step |
| --- | --- | --- |
| HEVC decoding on the TV client | Determines whether H.265 can be passed through or must be transcoded. Real H.265 passthrough already plays in WebKit GTK; headless Chromium cannot. Operator decision (2026-11-08): Windows 11 with a Chromium browser on the Intel NUC. | Run the acceptance tests on a Windows 11 machine with Chrome: `MediaSource.isTypeSupported`, four-tile playback, stopwatch latency ([docs/streaming.md](docs/streaming.md#tv-client-recommendation)). |
| Achter het huis 1 network link | 160 ms average RTT (others 1–2 ms) and a 7 s main-stream start. | Investigate the camera's link (outside this project). |
| Camera clocks | Resolved 2026-11-08 (operator-approved): the hardware NVR and all four cameras now use NTP on the LAN gateway with CET/CEST and matched real time to the second. | Re-check after a day (homelab backlog). |
| Camera RTSP session limit | Checked 2026-11-08: 5 of a reported maximum of 6 sessions in use per camera (NVR 2, Frigate 2, De Uitkijk 1) ([docs/streaming.md](docs/streaming.md#camera-stream-sessions-2026-11-08)). | Keep De Uitkijk on substreams; free a session elsewhere before using main streams. |
| Real latency and resources | Startup, bitrate, sessions and go2rtc resources were measured on 2026-11-08; end-to-end latency was not. | Stopwatch latency test on the TV client. |
| Hosting location for go2rtc + edge | Decided 2026-11-08: `503-web-ubuntu`, deployed with deployctl; one address `https://uitkijk.mrmevius.nl` with login ([docs/deployment.md](docs/deployment.md)). | Install the NUC kiosk (own viewer account). |
| Camera account | Operator decision (2026-11-08): go2rtc uses the existing camera administrator account. Accepted trade-off: the credential stays server-side (`.env`, mode 600, go2rtc only). | None. |
| Frigate alert timing | Frigate keeps alerts open for `cutoff_time` (40 s) after activity; focus lasts about 40 s + 15 s. | Decide whether that is acceptable or adjust Frigate (production change). |
| Frigate API authentication | Done 2026-11-08: authenticated API with a dedicated viewer account and a pinned certificate. Port 5000 stays open for other consumers. | Optionally close port 5000 once monitoring uses authentication too. |
| Frigate push events | Could lower alert latency below the 2 s poll. | Verify the `/ws` `reviews` topic with a real alert. |
| Highlight tuning | Since 0.7.0 feedback adjusts scores per camera and time-of-day period ([docs/highlights.md](docs/highlights.md#learning-from-feedback-since-070)). | Review the effect after a few weeks of feedback. |
| AI provider | Codex with ChatGPT sign-in is in use; Claude needs Max/Ultra/Team for the permitted API-credit route. | Revisit Claude when the plan changes. |
