# Development

## Requirements

- Docker with Compose v2.24 or newer, for the full stack.
- Node.js 24 or newer with npm, for tests and hot-reload development.

No cameras, Frigate or internet access are needed in mock mode, apart from pulling images and packages.

## Quick start (mock mode)

```bash
docker compose up --build
```

- Dashboard: <http://127.0.0.1:8080>, with display profiles `/?profile=shop` and `/?profile=bedroom`.
- Scenario panel: <http://127.0.0.1:8080/dev>. Switch scenarios while the dashboard is open in another window or TV.
- Health: <http://127.0.0.1:8080/api/health>.

The default scenario `demo` loops through single, multiple and re-activated alerts. Nine cameras:

```bash
UITKIJK_CAMERA_FILE=cameras-9.mock.json UITKIJK_MOCK_SCENARIO=nine-cameras docker compose up --build
```

Mock video comes from go2rtc (`go2rtc/mock.yaml`): a test pattern with stream name and wall-clock time, started only while somebody watches. `*_sub` streams are H.264 640x360 at 6 fps and play in every browser. `*_main` streams are H.265 1280x720, useful for checking HEVC support.

## Hot-reload development

```bash
npm install
docker compose up -d go2rtc          # mock video only
npm run dev:server                   # backend on :3000 (mock mode, demo scenario)
npm run dev:web                      # Vite on http://127.0.0.1:5173, proxies /api and /stream/ws
```

go2rtc has no host port in `compose.yaml`. For hot reload, publish it on localhost with an override file (not committed):

```yaml
# compose.override.yaml
services:
  go2rtc:
    ports: ["127.0.0.1:1984:1984"]
```

Server environment variables (all optional in mock mode):

| Variable | Default | Meaning |
| --- | --- | --- |
| `UITKIJK_MODE` | `mock` | `mock` or `live` |
| `UITKIJK_CAMERA_CONFIG` | `config/cameras.json` | Camera list; array order is the shared order |
| `UITKIJK_MOCK_SCENARIO` | `demo` | Start scenario (mock) |
| `UITKIJK_DEV_API` | `true` in mock | Set `false` to disable `/api/dev/*` |
| `UITKIJK_HOLD_MS` | `15000` | Focus hold per camera |
| `FRIGATE_URL` | – | Required in live mode, without credentials |
| `FRIGATE_POLL_MS` | `2000` | Review poll interval (minimum 1000) |
| `FRIGATE_MAX_ALERT_AGE_S` | `1800` | Ignore open alerts older than this |
| `GO2RTC_URL` | – | Internal go2rtc URL for the health probe |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Listen address |

## Live mode (trusted development network only)

1. `cp .env.example .env` and fill in `UITKIJK_MODE=live`, `FRIGATE_URL`, `GO2RTC_CONFIG=live.yaml`, the camera account and the camera host addresses.
2. `cp go2rtc/live.example.yaml go2rtc/live.yaml`. It contains only `${VAR}` references.
3. `docker compose up --build`.

Live mode reads Frigate (read-only) for alerts, camera availability and camera-name validation. go2rtc connects to the cameras directly. Both `.env` and `go2rtc/live.yaml` are git-ignored.

Alerts only, without video: leave `GO2RTC_CONFIG=mock.yaml`. Tiles then show mock video while focus follows real Frigate alerts.

## Camera configuration

`config/cameras.json`:

```json
{ "cameras": [ { "id": "oprit", "name": "Oprit / Pad", "frigateCamera": "Vriezenveen_oprit",
                 "streams": { "main": "oprit_main", "sub": "oprit_sub" } } ] }
```

- `id`: stable, `[a-z0-9_]`, never derived from the name.
- `streams.*`: go2rtc stream names; the only stream reference a browser sees.
- At most nine cameras. Changing the order changes it for every client.

## Display profiles

Defined in `packages/shared/src/display.ts` (`default`, `shop`, `bedroom`) and selected with `?profile=`. A profile sets overlay scale, stream quality, minimum size of non-focused tiles and tile gap. Per-device configuration from the backend comes with TV pairing.

## Useful commands

```bash
npm test              # all automated tests (shared, server, web)
npm run typecheck     # TypeScript, all workspaces
npm run build         # production build of the dashboard
docker compose logs -f server
docker compose down
```
