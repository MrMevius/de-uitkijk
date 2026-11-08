# De Uitkijk

Self-hosted live camera dashboard for TVs, driven by Frigate alerts.

- All cameras live on one Full HD screen, in one shared order.
- Cameras with an active Frigate alert are enlarged automatically, with a 15 s hold per camera after the alert ends.
- Video comes from a standalone go2rtc (H.265 passthrough over MSE). It keeps playing when Frigate or the backend is down.

> **Status:** first increment, a development prototype. There is no authentication; run it only on a trusted network. See [PROJECT.md](PROJECT.md).

## Quick start (no cameras needed)

```bash
docker compose up --build
```

Open <http://127.0.0.1:8080> for the dashboard and <http://127.0.0.1:8080/dev> to switch simulated scenarios.

## Development

```bash
npm install
npm test
npm run typecheck
```

More in [docs/development.md](docs/development.md) and [docs/testing.md](docs/testing.md). Live mode with Frigate and real cameras is described there and in [docs/streaming.md](docs/streaming.md).

## Documentation

[PROJECT.md](PROJECT.md) · [requirements](docs/requirements.md) · [architecture](docs/architecture.md) · [Frigate integration](docs/frigate-integration.md) · [streaming](docs/streaming.md) · [security](docs/security.md)
