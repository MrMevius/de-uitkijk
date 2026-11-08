# Security

## Access model (operator decision, 2026-11-08)

There is one address for everybody, at home and away: `https://uitkijk.mrmevius.nl` through SWAG. Every viewer logs in, TVs included, and sessions do not expire. At home the name resolves to the public address and the router hairpins it back to SWAG; viewing at home therefore needs a working internet connection (see deployment.md).

## How the boundary is enforced

- **The backend requires a session in live mode.** Every `/api/` route except health, login, logout and the one-time-link routes needs one; `/api/admin/*` also needs the `admin` role. Mock mode (development) has no login unless `UITKIJK_LOGIN=on`.
- **Video.** Before the edge proxies a stream to go2rtc it asks the backend (`auth_request` → `/api/auth/check`). It caches a successful answer per session cookie for one minute. While the backend is unreachable, the cached answer keeps being accepted for as long as it is used at least every four hours. TVs can therefore reconnect during a backend outage (RES-6), but unknown sessions are still refused.
- **Edge listeners.** `8081` is reached only by SWAG over the shared Docker network (`swag_default`). `8080` is published on the host address for deployctl's health check. Both apply the same rules.
- **go2rtc.** Only the MSE WebSocket is exposed, for stream names matching `^[a-z0-9_]{1,64}$`. go2rtc itself serves only `/api` and `/api/ws` (`allow_paths`). RTSP listens on container localhost; WebRTC is disabled.
- **Secrets.** Camera credentials exist only in the go2rtc configuration file, outside the repository and outside the shared runtime environment. No API response contains a source URL. Browsers never talk to Frigate. `FRIGATE_URL` with embedded credentials is rejected.
- **Frigate.** The backend uses Frigate's authenticated API (port 8971) with a dedicated `viewer` account (`uitkijk`, created 2026-11-08), so it can read but not change Frigate. Frigate's self-signed certificate is pinned: only that exact certificate is trusted. If Frigate gets a new certificate, update `certificate` in `/etc/de-uitkijk/frigate-auth.json`. The password and certificate live in that file (mode 600) and are mounted into the backend only. Frigate's unauthenticated internal port 5000 still exists for other homelab consumers (monitoring); closing it is a separate decision.
- **Development.** The mock-scenario API (`/api/dev/*`) exists only in mock mode.

## Accounts

- **Roles.** Own accounts with `admin` and `viewer` roles. No MFA (product decision).
- **Passwords.** Hashed with scrypt (N=2^15, r=8, p=1, 16-byte salt) from `node:crypto`; at least 10 characters.
- **One-time links.** Activation and password-reset links are created by an administrator in `/beheer`. Each link is random (256 bits), valid for 72 hours and works once. Only its SHA-256 hash is stored, and a new link for a user invalidates the previous one. Setting a password ends all other sessions of that user. The token sits in the URL fragment (`/activeer#…`), so it never reaches server logs or `Referer` headers.
- **Sessions.** Server-side records in SQLite (`/data/uitkijk.db` in the `data` volume), stored as hashes. They never expire (operator decision). A session ends on logout, on a password reset through a one-time link, or when the account is deleted. The cookie is `HttpOnly; Secure; SameSite=Strict` with the longest lifetime browsers allow (400 days). The dashboard renews it on load and daily.
- **Brute force.** After 5 failed logins for a username, or 10 from one client address, logins from there are blocked for 15 minutes. The counters are in memory, so a restart resets them. Unknown users take as long to check as known ones.
- **Cross-site requests.** Besides `SameSite=Strict`, any write from a foreign `Origin` is rejected.
- **Recovery and the first administrator.** Run `docker compose exec server node apps/server/src/cli.ts admin-link <name>` on the server. It creates or promotes the administrator and prints a one-time link. `... cli.ts users` lists the accounts.

## Superseded

TV pairing with device sessions and signed four-hour stream tickets (SEC-5) are not needed. TVs log in like any other user and keep their session indefinitely. Reconnecting during a backend outage is covered by the edge's cached login check.
