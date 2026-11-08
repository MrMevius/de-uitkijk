# Deployment

## Placement (operator decision, 2026-11-08)

De Uitkijk runs on `503-web-ubuntu` (`10.0.0.171`, Proxmox node `server503`), next to the other homelab applications. It is deliberately **not** on the Frigate VM (`502-media-nvr-ubuntu`): live video must keep working when Frigate or its host is down. It needs no GPU because streams are passed through without transcoding. Measured load is small (go2rtc ~1–5 % of one core, ~100 MiB for all three containers).

Accepted trade-off: if `server503` or the VM is down, the dashboards have no video. The hardware NVR keeps recording independently.

## Access (operator decisions, 2026-11-08)

- **Home LAN:** `http://10.0.0.171:8088`, open to every client including phones, without login.
- **Outside the home:** `https://uitkijk.mrmevius.nl` through SWAG (`uitkijk.subdomain.conf` → `de-uitkijk:8081` on `swag_default`), with login.

Details are in [security.md](security.md).

Phones: iPhones need iOS 17.1 or later (the player falls back to Safari's `ManagedMediaSource`). Android phones depend on the device's H.265 decoding in Chrome. The layout is made for a 16:9 screen, so a phone works best in landscape.

## Delivery

`deployctl` on the host deploys `main` (pull-based), after the GitHub checks `test` and `docker` succeed. It builds `server` and `web`, starts the three runtime services, checks `http://10.0.0.171:8088/api/health` and rolls back on failure. The root `VERSION` file names the release.

| Item | Location on `503-web-ubuntu` |
| --- | --- |
| Deploy configuration | `/etc/deployctl/projects/de_uitkijk/deploy.yml` |
| Timer | `deployctl@de_uitkijk.timer` |
| Runtime environment (no secrets) | `/etc/de-uitkijk/runtime.env`, mode 600 |
| go2rtc configuration including camera credentials | `/etc/de-uitkijk/go2rtc.yaml`, mode 600 |
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
FRIGATE_URL=http://10.0.0.161:5000
GO2RTC_CONFIG_PATH=/etc/de-uitkijk/go2rtc.yaml
```

## Operations

- Status: `deployctl status`, or `curl http://10.0.0.171:8088/api/health`.
- Add a kiosk: point Chrome in kiosk mode at `http://10.0.0.171:8088/?profile=shop` (or `bedroom`). A DHCP reservation is useful but not required.
- Changes to `runtime.env` take effect with the next deployment (deployctl recreates the containers).
- Change camera credentials: edit `/etc/de-uitkijk/go2rtc.yaml` and restart the go2rtc container.
- Rollback: deployctl rolls back automatically on a failed health check. Manual removal: stop and remove the timer and the three containers; nothing else on the host depends on De Uitkijk.
- First administrator or lost admin password: `cd /srv/de_uitkijk/current && docker compose -p de-uitkijk exec server node apps/server/src/cli.ts admin-link <name>` (or `docker exec de-uitkijk-server-1 node apps/server/src/cli.ts admin-link <name>`). It prints a one-time link.
- Backup: the only application state is the SQLite database in the `de-uitkijk_data` volume (accounts and sessions). It is covered by the full-VM backup, together with the two files under `/etc/de-uitkijk/`. If it were lost, recreate the administrator with the CLI.
