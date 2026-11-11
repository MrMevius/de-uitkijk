# Deployment

## Placement (operator decision, 2026-11-08)

De Uitkijk runs on `503-web-ubuntu` (`10.0.0.171`, Proxmox node `server503`), next to the other homelab applications. It is deliberately **not** on the Frigate VM (`502-media-nvr-ubuntu`): live video must keep working when Frigate or its host is down. It needs no GPU because streams are passed through without transcoding. Measured load is small (go2rtc ~1–5 % of one core, ~100 MiB for all three containers).

Accepted trade-off: if `server503` or the VM is down, the dashboards have no video. The hardware NVR keeps recording independently.

## Access (operator decision, 2026-11-08)

One address for everybody: `https://uitkijk.mrmevius.nl`, through SWAG (`uitkijk.subdomain.conf` → `de-uitkijk:8081` on `swag_default`), with login everywhere. At home the name resolves to the public address and the router forwards it back to SWAG (hairpin NAT), so viewing at home needs a working internet connection. A local DNS rewrite to `10.0.0.171` was tried on 2026-11-08 and removed again: SWAG only listens on host port 1443 (the router maps WAN 443 to it), so local clients reached nothing on port 443. Offline viewing at home needs SWAG to also listen on `10.0.0.171:443` before such a rewrite is re-added. `http://10.0.0.171:8088` remains only for deployctl's health check; it applies the same login rules. Details are in [security.md](security.md).

The SWAG vhost must disable response buffering (`proxy_buffering off`). Otherwise the dashboard's server-sent events never arrive and the page stays on "Verbinden met De Uitkijk…". The edge also passes the backend's `X-Accel-Buffering: no` on.

TVs: log in once in the kiosk browser. The session does not expire, and the dashboard renews the cookie daily.

Phones: verified on an iPhone (Brave, which uses WebKit) on 2026-11-08: all four cameras play live through `ManagedMediaSource`; iOS 17.1 or later is needed. On a portrait screen the tiles stack vertically below the date bar. Android phones depend on the device's H.265 decoding in Chrome. The layout is made for a 16:9 screen, so a phone works best in landscape.

## Delivery

`deployctl` on the host deploys `main` (pull-based), after the GitHub checks `test` and `docker` succeed. It builds `server` and `web`, starts the three runtime services, checks `http://10.0.0.171:8088/api/health` and rolls back on failure. The root `VERSION` file names the release. Every release also adds an entry at the top of `CHANGELOG.md` (`## <version> — <date>`, a few Dutch bullets on main points); it is shown on Beheer → Change log (named Wijzigingen in 0.24.0; at the bottom of the menu since 0.24.1), and a test fails when the top entry does not match `VERSION`.

| Item | Location on `503-web-ubuntu` |
| --- | --- |
| Deploy configuration | `/etc/deployctl/projects/de_uitkijk/deploy.yml` |
| Timer | `deployctl@de_uitkijk.timer` |
| Runtime environment (no secrets) | `/etc/de-uitkijk/runtime.env`, mode 600 |
| go2rtc configuration including camera credentials | `/etc/de-uitkijk/go2rtc.yaml`, mode 600 |
| Frigate viewer account and pinned certificate | `/etc/de-uitkijk/frigate-auth.json`, mode 600, mounted read-only into the backend only |
| Accounts and sessions (SQLite) | Docker volume `de-uitkijk_data` |
| SWAG route | `/opt/docker/swag/appdata/nginx/proxy-confs/uitkijk.subdomain.conf` |
| Releases / state | `/srv/de_uitkijk/`, `/var/lib/deployctl/de_uitkijk/` |

deployctl gives the same environment file to every service. The camera credentials are therefore **not** in that file. They live only in the go2rtc configuration file, which is mounted read-only into the go2rtc container (`GO2RTC_CONFIG_PATH`). It is `go2rtc/live.example.yaml` with the placeholders filled in.

`runtime.env` contains:

```sh
UITKIJK_MODE=live
UITKIJK_CAMERA_FILE=cameras.json
UITKIJK_BIND=10.0.0.171
UITKIJK_PORT=8088
UITKIJK_PUBLIC_URL=https://uitkijk.mrmevius.nl
UITKIJK_EDGE_NETWORK=swag_default
UITKIJK_EDGE_NETWORK_EXTERNAL=true
FRIGATE_URL=https://10.0.0.161:8971
FRIGATE_AUTH_HOST_FILE=/etc/de-uitkijk/frigate-auth.json
GO2RTC_CONFIG_PATH=/etc/de-uitkijk/go2rtc.yaml
```

## Unattended TVs (since 0.7.0)

The dashboard reloads itself every night at 04:00 (Europe/Amsterdam), and within five minutes after a new release is live (it compares its built-in version with `/api/health`). It never reloads during an active alert; then it retries a few minutes later. Reloads are at least ten minutes apart, so a mismatch cannot cause a reload loop.

## Monitoring (since 0.7.0)

`http://10.0.0.171:8088/api/health/detail` (LAN listener only; the public listener answers 404) reports:

- the version, Frigate alert source and go2rtc status;
- per camera whether go2rtc delivered a picture in the last check (one JPEG frame per camera every 5 minutes through go2rtc's internal `/api/frame.jpeg`; it reuses a running camera session while someone watches);
- the last successful highlight import;
- the AI status.

Zabbix polls it; the items and triggers are in the homelab repository (`operations/noc-de-uitkijk-monitoring.md`).

## Admin page (since 0.9.0)

`/beheer` has tabs; the active tab is in the URL fragment (`/beheer#ai`).

| Tab | Content | Who |
| --- | --- | --- |
| Overzicht | go2rtc, picture per camera, Frigate alerts, highlight import with counts, AI, users, version; refreshes every 30 s | admins |
| Vragen | Questions and suggestions from the system ([questions.md](questions.md)) | admins |
| Gebruikers | Users, roles, one-time links, removal | admins |
| Highlights | The archive (also at `/archief`) | everyone |
| AI | AI status and the household facts | admins |
| Mijn account | Change the own password (other sessions end), log out | everyone |

## Operations

- Status: `deployctl status`, or `curl http://10.0.0.171:8088/api/health`.
- Add a kiosk: point Chrome in kiosk mode at `https://uitkijk.mrmevius.nl/?profile=shop` (or `bedroom`) and log in once, preferably with a dedicated viewer account per TV, so it can be removed separately.
- Changes to `runtime.env` take effect with the next deployment (deployctl recreates the containers).
- Change camera credentials: edit `/etc/de-uitkijk/go2rtc.yaml` and restart the go2rtc container.
- Rollback: deployctl rolls back automatically on a failed health check. Manual removal: stop and remove the timer and the three containers; nothing else on the host depends on De Uitkijk.
- First administrator or lost admin password: `cd /srv/de_uitkijk/current && docker compose -p de-uitkijk exec server node apps/server/src/cli.ts admin-link <name>` (or `docker exec de-uitkijk-server-1 node apps/server/src/cli.ts admin-link <name>`). It prints a one-time link.
- Backup: the only application state is the SQLite database `/data/uitkijk.db` in the `de-uitkijk_data` volume. Besides accounts it holds everything the system learned: highlights, answers, AI facts, the household register and the AI log. Since 0.27.0 the server makes a consistent copy every night after 03:30 Europe/Amsterdam (`VACUUM INTO`, gzip) in `/data/backups/uitkijk-<date>.db.gz`, keeping 30 daily, 12 weekly and 12 monthly copies (OPS-3; about 5 MB each). The full-VM backup at 04:00 takes them off the host, together with the two files under `/etc/de-uitkijk/`. Beheer → Overzicht shows the last copy ("Back-up database"); it is also in `/api/health/detail` under `backup`. The clip cache is not backed up (video stays in Frigate).
- Restore a copy: `docker compose -p de-uitkijk stop server`, then in the volume `gunzip -c backups/uitkijk-<date>.db.gz > uitkijk.db` and remove `uitkijk.db-wal` and `uitkijk.db-shm`, then start the server. Keep the current file aside first (`mv uitkijk.db uitkijk.db.before-restore`).
