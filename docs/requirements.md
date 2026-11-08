# Product requirements

Consolidated specification for De Uitkijk. Each requirement has a phase:

- **P1** — first increment (this repository state). Implemented unless marked *partial*.
- **Later** — agreed scope for subsequent increments; not implemented.

"Must" means mandatory; "should" means preferred.

## 1. Context and constraints

| ID | Requirement | Phase |
| --- | --- | --- |
| CTX-1 | Self-hosted surveillance dashboard for a private homelab. | P1 |
| CTX-2 | Frigate 0.17.2 provides detections, alerts, review items, recordings and snapshots. | P1 |
| CTX-3 | Four ANNKE RTSP cameras feed Frigate and an independent hardware NVR. Camera and NVR configuration must remain unchanged. | P1 |
| CTX-4 | Camera streams: H.265 main 3840x2160 at 12.5 fps (`/Streaming/Channels/101`) and H.265 substream 640x360 at 6 fps (`/Streaming/Channels/102`). | P1 |
| CTX-5 | MQTT is disabled in Frigate and must not be required. | P1 |
| CTX-6 | Live viewing and the standalone streaming service must not depend on the Frigate host. | P1 (design), Later (deployment) |
| CTX-7 | Existing infrastructure to reuse: SWAG, AdGuard Home, Zabbix, Unraid, Proxmox Backup Server. No new infrastructure without a clear need. | Later |
| CTX-8 | Prefer the simplest architecture: no microservices, Redis, message brokers or separate Python services. The application backend must not decode or transcode media. | P1 |
| CTX-9 | Final hosting location is decided by benchmarks, not assumptions. | Later |

## 2. Cameras

| ID | Requirement | Phase |
| --- | --- | --- |
| CAM-1 | Camera abstraction with stable identifier, name, availability state, main-stream reference and substream reference. | P1 |
| CAM-2 | Up to nine cameras. | P1 |
| CAM-3 | Initial logical locations, in this order: Oprit / Pad; Voordeur; Achter het huis 1; Achter het huis 2 / Schuur. | P1 |
| CAM-4 | One shared, stable camera order for every client. | P1 |
| CAM-5 | Mock mode with simulated cameras and events; live mode using the existing Frigate installation. | P1 |
| CAM-6 | Discovery based on Frigate's actual API. Do not assume Frigate exposes reusable RTSP credentials or independent stream URLs. Stream sources are configured server-side. | P1 |
| CAM-7 | No private credentials or operational camera URLs in committed files. | P1 |

## 3. Live streaming

| ID | Requirement | Phase |
| --- | --- | --- |
| STR-1 | Independent go2rtc service, deployable separately from the Frigate host. | P1 (local), Later (deployment) |
| STR-2 | Use the existing H.265 streams without changing camera configuration. | P1 |
| STR-3 | Evaluate browser H.265, MSE, WebRTC, H.265→H.264 transcoding, hardware acceleration, main/substream selection and reconnection. | P1 (documented), measurements Later |
| STR-4 | Avoid unnecessary transcoding and duplicate camera connections. | P1 |
| STR-5 | Never expose the go2rtc management API or raw camera credentials publicly. | P1 |
| STR-6 | Target 1–2 s local end-to-end latency. | Target; measurement Later |
| STR-7 | Initial live integration only in an explicitly trusted development environment; not presented as production authentication. | P1 |

## 4. TV dashboard

| ID | Requirement | Phase |
| --- | --- | --- |
| TV-1 | Modern, minimalist dark dashboard, Full HD landscape 1920x1080. | P1 |
| TV-2 | Four cameras initially, scalable to nine; all configured cameras visible; one shared order. | P1 |
| TV-3 | Responsive automatic layout; subtle rounded corners; high-contrast overlays. | P1 |
| TV-4 | Camera names always visible. | P1 |
| TV-5 | Subtle active-alert indicator with optional object type. | P1 |
| TV-6 | Subtle system health indicator. | P1 |
| TV-7 | Dutch date and 24-hour clock in Europe/Amsterdam. | P1 |
| TV-8 | No interactive controls and no audio playback on the TV dashboard. | P1 |
| TV-9 | Individually configurable display profiles: shop TV (55", Full HD, 2–5 m) and bedroom TV (32", Full HD, 0.5–2 m). | P1 (profiles), Later (per-device configuration) |
| TV-10 | Continuous kiosk operation without manual interaction; TVs are switched on/off manually; wired Ethernet. | Later |

## 5. Dynamic focus

| ID | Requirement | Phase |
| --- | --- | --- |
| FOC-1 | Only Frigate alerts (review severity `alert`) activate focus. | P1 |
| FOC-2 | No active alerts → standard layout. One active camera → enlarged. Two → both enlarged. Three or more → prominence distributed among active cameras. Other cameras stay visible. | P1 |
| FOC-3 | Each camera has an independent 15 s focus hold after its last alert ends; a new alert cancels that camera's hold; standard layout returns after the final hold expires. | P1 |
| FOC-4 | Subtle 300–500 ms transitions. | P1 (400 ms) |
| FOC-5 | Moving or resizing a tile must not recreate its video connection. | P1 |
| FOC-6 | Deterministic simulated alert events. | P1 |
| FOC-7 | Accurate active-alert state from Frigate 0.17.2 via a verified event source or bounded polling; MQTT not required. | P1 |

## 6. Resilience

| ID | Requirement | Phase |
| --- | --- | --- |
| RES-1 | A failed camera stream remains visible as an unavailable tile; other cameras keep working. | P1 |
| RES-2 | Reconnect with bounded exponential backoff; no unbounded reconnect loops. | P1 |
| RES-3 | Never display stale frames as live. | P1 |
| RES-4 | Subtle status indicators for central service failures. | P1 |
| RES-5 | A loaded dashboard keeps streaming when the application backend fails. | P1 (design and behaviour) |
| RES-6 | Previously authorised TV clients can reconnect to the streaming service for up to four hours during a backend outage. | Done (2026-11-08: the edge caches successful video login checks and accepts them while the backend is down) |
| RES-7 | Live viewing survives a Frigate host failure; local operation survives internet failure. | P1 (design), Later (deployment) |

## 7. Development and testing

| ID | Requirement | Phase |
| --- | --- | --- |
| DEV-1 | Works without cameras or Frigate connectivity. | P1 |
| DEV-2 | Deterministic fixtures: four and nine cameras; one alert; multiple alerts; expiration and reactivation; camera disconnect/reconnect; Frigate unavailable; streaming service unavailable. | P1 |
| DEV-3 | Automated tests for focus state machine, 15 s hold, camera ordering and failure states. | P1 |
| DEV-4 | Straightforward Docker Compose development environment. | P1 |
| DEV-5 | Documented procedure to test real H.265 streams and measure compatibility, startup and end-to-end latency, CPU/RAM, upstream connections, quality effects and reconnection. Measured results kept separate from targets. | P1 (procedure), Later (measurements) |
| DEV-6 | No claim of validated nine-camera streaming without a reproducible test. | P1 |
| DEV-7 | No production infrastructure changes in the first increment. | P1 |

## 8. Highlights

| ID | Requirement | Phase |
| --- | --- | --- |
| HL-1 | Use Frigate alerts and relevant object detections as candidates. | Done (2026-11-08) |
| HL-2 | Group related events across cameras; select the best representative camera clip. | Done (2026-11-08) |
| HL-3 | Prefer unusual events while retaining useful daily variety. No fixed camera weighting. | Done (2026-11-08, rule-based) |
| HL-4 | Select 0–15 highlights from a rolling 24-hour window. Never add uninteresting filler. | Done (2026-11-08) |
| HL-5 | Variable clip length, generally 5–30 s. Aim for availability within five minutes of an event. | Done (2026-11-08) |
| HL-6 | Show camera, timestamp and a short Dutch AI description. | Partly (2026-11-08): rule-based Dutch description; AI description in phase 5 |
| HL-7 | Rotate highlights automatically, prioritising important/new events. Hide during active alerts; continue with the next highlight after the interruption. | Done (2026-11-08) |
| HL-8 | Without highlights, live cameras use all available space. | Done |
| HL-9 | Store metadata and one optimised thumbnail per selected highlight indefinitely. Never permanently duplicate Frigate recordings. | Done (2026-11-08) |
| HL-10 | Archive with date, camera and relevance filters. | Done (2026-11-08) |
| HL-11 | Administrators give positive/negative selection feedback and delete highlights; deletion tombstones prevent re-import. | Done (2026-11-08; feedback stored, not yet used for tuning) |
| HL-12 | Import no events from before initial activation. Catch up missed events after outages without duplicates. | Done (2026-11-08) |
| HL-13 | Authenticated users download short clips or full events, retaining original audio when available. | Done (2026-11-08) |

## 9. AI

| ID | Requirement | Phase |
| --- | --- | --- |
| AI-1 | Rule-based preselection before external vision analysis; selected original snapshots may be used as input. | Later |
| AI-2 | Same AI eligibility rules for all cameras. | Later |
| AI-3 | Prefer officially supported OpenAI "Sign in with ChatGPT" subscription usage. Claude subscription integration only through an officially permitted method. Otherwise rule-based selection only. | Later |
| AI-4 | Explicit owner authorisation required for background processing. | Later |
| AI-5 | Never use another application's session cookies or undocumented endpoints. | Later |
| AI-6 | No automatic paid API fallback or unapproved credit consumption. | Later |
| AI-7 | AI failure never stops live viewing. Provider integration isolated from core logic. | Later |

## 10. Users and security

| ID | Requirement | Phase |
| --- | --- | --- |
| SEC-1 | Public HTTPS access through the existing SWAG reverse proxy. Local access must work without internet; local DNS through AdGuard Home. | Done 2026-11-08 (one address; local DNS rewrite on both AdGuard Home instances) |
| SEC-2 | Own user accounts with administrator and viewer roles. No MFA (neither mandatory nor optional). | Done (2026-11-08; login everywhere, sessions without expiry) |
| SEC-3 | Accounts activated and passwords recovered through administrator-generated one-time links; emergency administrator recovery through a secured server CLI. | Done (2026-11-08) |
| SEC-4 | All authenticated users may access the full highlight archive; only administrators manage settings, feedback and deletion. | Later |
| SEC-5 | TV clients use one-time pairing and revocable device sessions. | Superseded (2026-11-08: TVs log in like other users; sessions do not expire) |
| SEC-6 | Production streaming access protected independently of backend availability. | Later (architecture in [security.md](security.md)) |
| SEC-7 | Never expose Frigate credentials or unrestricted go2rtc control endpoints to browsers. | P1 |
| SEC-8 | No smartphone push notifications. | All phases |

## 11. Operations

| ID | Requirement | Phase |
| --- | --- | --- |
| OPS-1 | Two TV clients initially; up to five concurrent viewers overall. | Later |
| OPS-2 | Zabbix health checks; critical alerts only after 30 minutes. | Later (`/api/health` exists) |
| OPS-3 | Consistent application backups to Unraid with 30 daily, 12 weekly and 12 monthly retention points. Existing PBS remains available. | Later |
| OPS-4 | Initial backend failure does not interrupt established video; independent stream reconnection for up to four hours. | P1 (established streams), Later (reconnect authorisation) |

## 12. Later-phase deliverables

Production authentication and TV pairing; external SWAG deployment; AI-provider integration; automated highlight production; historical archive and downloads; administrative UI; complete backup and monitoring integration; physical Intel NUC and shop TV deployment.
