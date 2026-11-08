# Security

## Access model (operator decisions, 2026-11-08)

| Where | Access |
| --- | --- |
| Home LAN, including phones on Wi-Fi (`http://10.0.0.171:8088`) | Open, no login. Login and administration are refused here. |
| Outside the home (`https://uitkijk.mrmevius.nl`, through SWAG) | Login required for every API call and every video stream. |

TVs stand on the LAN, so they need no login, pairing or tickets. Anyone on the LAN or Wi-Fi can watch the live cameras; that is intended.

## How the boundary is enforced

- **Two edge listeners.** `8080` is the LAN listener, published on the LAN address. `8081` is the public listener. It is reachable only from SWAG over the shared Docker network, plus a loopback port on the host for testing. Each listener sets `X-Uitkijk-Access` (`local` or `public`) towards the backend and overwrites any value the client sent. The backend has no host port, so the header cannot be forged from outside the edge.
- **The backend fails closed.** A request without `X-Uitkijk-Access: local` is treated as public. On the public side every `/api/` route except health, login, logout and the one-time-link routes requires a valid session. `/api/admin/*` additionally requires the `admin` role.
- **Video.** On the public listener the edge calls the backend (`auth_request` → `/api/auth/check`) before it proxies a stream to go2rtc. Remote viewing therefore needs the backend; LAN viewing does not.
- **go2rtc.** Only the MSE WebSocket is exposed, for stream names matching `^[a-z0-9_]{1,64}$`. go2rtc itself serves only `/api` and `/api/ws` (`allow_paths`). RTSP listens on container localhost; WebRTC is disabled.
- **Secrets.** Camera credentials exist only in the go2rtc configuration file, outside the repository and outside the shared runtime environment. No API response contains a source URL. Browsers never talk to Frigate. `FRIGATE_URL` with embedded credentials is rejected.
- **Development.** The mock-scenario API (`/api/dev/*`) exists only in mock mode.

## Accounts

- **Roles.** Own accounts with `admin` and `viewer` roles. No MFA (product decision).
- **Passwords.** Hashed with scrypt (N=2^15, r=8, p=1, 16-byte salt) from `node:crypto`; at least 10 characters.
- **One-time links.** Activation and password-reset links are created by an administrator in `/beheer`. Each link is random (256 bits), valid for 72 hours and works once. Only its SHA-256 hash is stored, and a new link for a user invalidates the previous one. Setting a password ends all other sessions of that user. The token sits in the URL fragment (`/activeer#…`), so it never reaches server logs or `Referer` headers.
- **Sessions.** Server-side records in SQLite (`/data/uitkijk.db` in the `data` volume), stored as hashes. The cookie is `HttpOnly; Secure; SameSite=Strict` with a 30-day sliding expiry, and logout deletes the record.
- **Brute force.** After 5 failed logins for a username, or 10 from one client address, logins from there are blocked for 15 minutes. The counters are in memory, so a restart resets them. Unknown users take as long to check as known ones.
- **Cross-site requests.** Besides `SameSite=Strict`, any write from a foreign `Origin` is rejected.
- **Recovery and the first administrator.** Run `docker compose exec server node apps/server/src/cli.ts admin-link <name>` on the server. It creates or promotes the administrator and prints a one-time link. `... cli.ts users` lists the accounts.

## Superseded

The earlier design for TV pairing, device sessions and signed four-hour stream tickets (requirements SEC-5, RES-6) is no longer needed: TVs are on the LAN, where viewing needs no login, and the LAN path does not depend on the backend. If TVs ever need to work outside the LAN, revisit it.
