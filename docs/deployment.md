# Deployment

## Placement (operator decision, 2026-11-08)

De Uitkijk runs on `503-web-ubuntu` (`10.0.0.171`, Proxmox node `server503`), next to the other homelab applications. It is deliberately **not** on the Frigate VM (`502-media-nvr-ubuntu`): live video must keep working when Frigate or its host is down. It needs no GPU because streams are passed through without transcoding. Measured load is small (go2rtc ~1–5 % of one core, ~100 MiB for all three containers).

Accepted trade-off: if `server503` or the VM is down, the dashboards have no video. The hardware NVR keeps recording independently.

## Access until phase 3 (operator decision, 2026-11-08)

There is no login yet and the LAN is flat. The edge therefore only serves clients listed in `UITKIJK_ALLOW_FROM` (space-separated addresses or CIDRs): the TV kiosk(s) with a DHCP reservation and the management VM. Other clients get `403`. `/api/health` stays open; it returns status only. Accounts, TV pairing and stream tickets (phase 3, [security.md](security.md)) replace this allowlist. Do not route the dashboard through SWAG before then.

## Delivery

`deployctl` on the host deploys `main` (pull-based), after the GitHub checks `test` and `docker` succeed. It builds `server` and `web`, starts the three runtime services, checks `http://10.0.0.171:8088/api/health` and rolls back on failure. The root `VERSION` file names the release.

| Item | Location on `503-web-ubuntu` |
| --- | --- |
| Deploy configuration | `/etc/deployctl/projects/de_uitkijk/deploy.yml` |
| Timer | `deployctl@de_uitkijk.timer` |
| Runtime environment (no secrets) | `/etc/de-uitkijk/runtime.env`, mode 600 |
| go2rtc configuration including camera credentials | `/etc/de-uitkijk/go2rtc.yaml`, mode 600 |
| Releases / state | `/srv/de_uitkijk/`, `/var/lib/deployctl/de_uitkijk/` |

deployctl gives the same environment file to every service. The camera credentials are therefore **not** in that file. They live only in the go2rtc configuration file, which is mounted read-only into the go2rtc container (`GO2RTC_CONFIG_PATH`). It is `go2rtc/live.example.yaml` with the placeholders filled in.

`runtime.env` contains:

```sh
UITKIJK_MODE=live
UITKIJK_CAMERA_FILE=cameras.json
UITKIJK_BIND=10.0.0.171
UITKIJK_PORT=8088
UITKIJK_ALLOW_FROM=<kiosk address> 10.0.0.172
FRIGATE_URL=http://10.0.0.161:5000
GO2RTC_CONFIG_PATH=/etc/de-uitkijk/go2rtc.yaml
```

## Operations

- Status: `deployctl status`, or `curl http://10.0.0.171:8088/api/health`.
- Add a kiosk: give it a DHCP reservation, add its address to `UITKIJK_ALLOW_FROM`, then recreate the web container from the current release (`cd /srv/de_uitkijk/current` and run the deployctl-generated compose command, or let the next deployment pick it up).
- Change camera credentials: edit `/etc/de-uitkijk/go2rtc.yaml` and restart the go2rtc container.
- Rollback: deployctl rolls back automatically on a failed health check. Manual removal: stop and remove the timer and the three containers; nothing else on the host depends on De Uitkijk.
- Backup: the application has no state of its own. The two files under `/etc/de-uitkijk/` are covered by the VM backup.
