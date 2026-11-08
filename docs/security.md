# Security

## Increment 1: trusted development environment only

The first increment has **no authentication**. It is a development prototype and must not be exposed beyond a trusted network.

What it does enforce:

- Only the edge proxy is published, on `127.0.0.1:8080` by default (`UITKIJK_BIND`). go2rtc and the backend have no host ports.
- The edge exposes go2rtc's MSE WebSocket only, for stream names matching `^[a-z0-9_]{1,64}$`. go2rtc itself also serves only `/api` and `/api/ws` (`allow_paths`). go2rtc's RTSP server listens on container localhost only; WebRTC is disabled.
- Camera credentials live in `.env` and are passed only to the go2rtc container. The backend never receives them, and no API response contains a source URL. `FRIGATE_URL` with embedded credentials is rejected.
- Browsers never talk to Frigate.
- The mock-scenario API (`/api/dev/*`) exists only in mock mode.

Do not port-forward, add the dashboard to SWAG, or bind it to a non-trusted interface until the production design below is implemented.

### Interim LAN deployment

On `503-web-ubuntu` the dashboard is open to the whole home LAN, phones included (operator decision, 2026-11-08). Anyone on the LAN or Wi-Fi can watch the live cameras; nobody outside it can. Camera credentials sit only in the go2rtc configuration file outside the repository, not in the shared runtime environment, and the go2rtc API stays limited to the MSE endpoint. An optional client allowlist (`UITKIJK_ALLOW_FROM`) exists but is not used. See [deployment.md](deployment.md).

## Production design (later phases)

### Users

Own accounts with `admin` and `viewer` roles; activation and password reset through administrator-generated one-time links; emergency admin recovery through a server CLI; no MFA (product decision). Passwords hashed with a memory-hard KDF (argon2id or scrypt from `node:crypto`). Sessions as server-side records in SQLite with an HTTP-only, `Secure`, `SameSite=Strict` cookie.

### TV clients

1. An administrator creates a one-time pairing code, short-lived and single-use.
2. The TV kiosk opens `/pair`, enters or scans the code, and receives a **device session**: a long random identifier stored server-side and revocable per device.
3. The device session authorises dashboard API access, including the event stream.

### Streaming that survives a backend outage of up to four hours

Requirement: a TV that was authorised before the backend went down must be able to (re)connect to video for up to four hours without the backend.

The streaming path (edge → go2rtc) must therefore verify access **without calling the backend**. Proposed design:

- While the backend is up, a paired device periodically (for example every 30 minutes) obtains a **stream ticket**: `{deviceId, expires = now + 4 h, allowed streams}`, signed with a key shared between backend and edge only.
- The dashboard sends the ticket with every WebSocket connection (query parameter, since browsers cannot set headers on WebSockets). The edge verifies signature and expiry locally before proxying to go2rtc. The dashboard stores the ticket in `localStorage`, so a page reload during an outage still works. The static page itself comes from the edge, not the backend.
- Expiry bounds the outage window to four hours after the last successful refresh.
- **Revocation**: removing a device stops refreshes immediately, so its ticket dies within four hours at the latest. For immediate revocation the backend also writes a small deny-list (device ids) that the edge reads, or rotates the signing key and thereby invalidates all tickets.

Edge verification options, to be decided when implemented:

| Option | Pros | Cons |
| --- | --- | --- |
| nginx `secure_link` (built into nginx, available in SWAG) | No extra process; verifies expiry and a hash over URI + secret. | MD5-based; a shared secret on the edge. |
| `auth_request` to a tiny stateless verifier (HMAC/Ed25519) in the edge container | Modern cryptography; device deny-list support. | One more small process, which must not depend on the backend. |

Either way: never expose go2rtc's API beyond the MSE endpoint, never give browsers camera or Frigate credentials, and keep the edge independent of the backend. Public access via SWAG adds TLS. Local access must keep working without internet, which requires local DNS (AdGuard Home) and a certificate that validates offline.

### Frigate access

Read-only, server-side only. Production should use either the authenticated Frigate API with a dedicated user, or network restriction of the unauthenticated port. See [frigate-integration.md](frigate-integration.md#access).

### Secrets

Never commit `.env` or `go2rtc/live.yaml` (both git-ignored). go2rtc uses the existing camera administrator account (operator decision, 2026-11-08), so `.env` must stay mode 600 on the server and its contents must never reach logs, the backend or browsers.
